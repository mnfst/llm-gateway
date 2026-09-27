import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { createTestApp } from './helpers';

let app: INestApplication;

beforeAll(async () => {
  app = await createTestApp();

  // Better Auth migrations don't run in these E2E tests, so the "user"
  // table doesn't exist by default. Create a minimal stub so SetupService
  // queries resolve. The happy path (real Better Auth signUpEmail) is
  // covered by the unit tests in setup.service.spec.ts.
  const ds = app.get(DataSource);
  await ds.query(
    `CREATE TABLE IF NOT EXISTS "user" (
       id VARCHAR PRIMARY KEY,
       email VARCHAR,
       "emailVerified" BOOLEAN
     )`,
  );
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  // Reset the user table between tests so needsSetup swings back to true.
  const ds = app.get(DataSource);
  await ds.query(`DELETE FROM "user"`);
});

describe('First-run setup wizard', () => {
  describe('GET /api/v1/setup/status', () => {
    it('returns needsSetup=true when user table is empty', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/setup/status').expect(200);
      expect(res.body).toMatchObject({ needsSetup: true });
      expect(res.body).toHaveProperty('socialProviders');
      expect(res.body).toHaveProperty('isSelfHosted');
      expect(res.body).toHaveProperty('localLlmHost');
      expect(res.body).toHaveProperty('ollamaAvailable');
      expect(res.body).toHaveProperty('emailConfigured');
    });

    it('returns needsSetup=false after a user has been inserted', async () => {
      const ds = app.get(DataSource);
      await ds.query(`INSERT INTO "user" (id, email, "emailVerified") VALUES ($1, $2, true)`, [
        'test-user-id',
        'founder@example.com',
      ]);

      const res = await request(app.getHttpServer()).get('/api/v1/setup/status').expect(200);
      expect(res.body).toMatchObject({ needsSetup: false });
    });

    it('is a public endpoint (no auth required)', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/setup/status');
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/v1/setup/admin', () => {
    it('rejects with 409 when a user already exists', async () => {
      const ds = app.get(DataSource);
      await ds.query(`INSERT INTO "user" (id, email, "emailVerified") VALUES ($1, $2, true)`, [
        'existing-admin',
        'admin@example.com',
      ]);

      const res = await request(app.getHttpServer()).post('/api/v1/setup/admin').send({
        email: 'founder@example.com',
        name: 'Founder',
        password: 'secret-password',
      });

      expect(res.status).toBe(409);
    });

    it('rejects when email is missing', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/setup/admin')
        .send({ name: 'Founder', password: 'secret-password' })
        .expect(400);
      expect(res.body.message).toBeDefined();
    });

    it('rejects when password is too short', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/setup/admin')
        .send({ email: 'founder@example.com', name: 'Founder', password: 'short' })
        .expect(400);
      expect(res.body.message).toBeDefined();
    });

    it('rejects when email is not a valid email', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/setup/admin')
        .send({ email: 'not-an-email', name: 'Founder', password: 'secret-password' })
        .expect(400);
      expect(res.body.message).toBeDefined();
    });

    // Email format edge cases — class-validator's @IsEmail() wraps
    // validator.js's isEmail with default options (require_tld: true,
    // allow_display_name: false, ignore_max_length: false). These tests
    // pin the validator behaviour so an upstream change can't silently
    // accept malformed addresses on the first-run setup endpoint.
    it.each([
      ['test@', 'missing domain'],
      ['test@.com', 'domain starts with dot'],
      ['test @example.com', 'space in local part'],
      ['a@b', 'single-label domain (no TLD)'],
      ['@example.com', 'missing local part'],
      ['plainaddress', 'no @ symbol at all'],
    ])('rejects email %p (%s)', async (email) => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/setup/admin')
        .send({ email, name: 'Founder', password: 'secret-password' })
        .expect(400);
      expect(res.body.message).toBeDefined();
    });

    it('rejects email exceeding the 254-character MaxLength', async () => {
      // Total > 254 triggers @MaxLength(254). validator.js also enforces
      // a 254-char default cap (ignore_max_length: false) — either layer
      // is sufficient to reject this address; we want both to keep it out.
      const longEmail = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`;
      expect(longEmail.length).toBeGreaterThan(254);

      const res = await request(app.getHttpServer())
        .post('/api/v1/setup/admin')
        .send({ email: longEmail, name: 'Founder', password: 'secret-password' })
        .expect(400);
      expect(res.body.message).toBeDefined();
    });

    // Valid-format emails: the DTO validation must pass them through to
    // the service. We assert this indirectly: with a user already in the
    // table, the service throws ConflictException (409) — which is only
    // reachable AFTER ValidationPipe has accepted the body.
    it.each([
      ['founder+label@example.com', 'plus addressing'],
      ['founder.tag@sub.example.co.uk', 'dotted local + multi-label TLD'],
    ])('accepts valid email %p (%s) past DTO validation', async (email) => {
      const ds = app.get(DataSource);
      await ds.query(`INSERT INTO "user" (id, email, "emailVerified") VALUES ($1, $2, true)`, [
        'blocking-admin',
        'admin@example.com',
      ]);

      const res = await request(app.getHttpServer())
        .post('/api/v1/setup/admin')
        .send({ email, name: 'Founder', password: 'secret-password' });

      // 409 (not 400) proves validation passed and the request reached
      // SetupService, which rejected due to the existing user.
      expect(res.status).toBe(409);
    });

    it('rejects when name is missing', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/setup/admin')
        .send({ email: 'founder@example.com', password: 'secret-password' })
        .expect(400);
      expect(res.body.message).toBeDefined();
    });

    it('rejects an unknown field with 400 (forbidNonWhitelisted)', async () => {
      // With the global ValidationPipe's forbidNonWhitelisted, a body carrying
      // a property that isn't on the DTO is rejected outright rather than
      // silently stripped — the user table is empty here, so a non-strict pipe
      // would otherwise let this reach the service.
      const res = await request(app.getHttpServer())
        .post('/api/v1/setup/admin')
        .send({
          email: 'founder@example.com',
          name: 'Founder',
          password: 'secret-password',
          role: 'superadmin',
        })
        .expect(400);
      expect(res.body.message).toBeDefined();
    });
  });
});
