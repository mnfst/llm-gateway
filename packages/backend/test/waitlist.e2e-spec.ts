import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { createTestApp } from './helpers';

let app: INestApplication;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  const ds = app.get(DataSource);
  await ds.query(`DELETE FROM waitlist_claims`);
});

describe('POST /api/v1/waitlist/pivot/claim', () => {
  it('stores a claim with a normalized email and the declared cloud source', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/waitlist/pivot/claim')
      .send({ email: '  Jane@Example.COM ', source: 'cloud' })
      .expect(200)
      .expect({ ok: true });

    const ds = app.get(DataSource);
    const rows = await ds.query(`SELECT email, source FROM waitlist_claims`);
    expect(rows).toEqual([{ email: 'jane@example.com', source: 'cloud' }]);
  });

  it('defaults a sourceless claim to self-hosted', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/waitlist/pivot/claim')
      .send({ email: 'a@b.co' })
      .expect(200);

    const ds = app.get(DataSource);
    const rows = await ds.query(`SELECT source FROM waitlist_claims`);
    expect(rows).toEqual([{ source: 'self-hosted' }]);
  });

  it('infers cloud for a sourceless same-origin claim', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/waitlist/pivot/claim')
      .set('Host', 'claims.test')
      .set('Origin', 'http://claims.test')
      .send({ email: 'stale@b.co' })
      .expect(200);

    const ds = app.get(DataSource);
    const rows = await ds.query(`SELECT source FROM waitlist_claims`);
    expect(rows).toEqual([{ source: 'cloud' }]);
  });

  it('never overwrites a website row, while still answering ok', async () => {
    const ds = app.get(DataSource);
    await ds.query(
      `INSERT INTO waitlist_claims (email, source, claimed_at) VALUES ($1, $2, now() - interval '1 day')`,
      ['site@b.co', 'website'],
    );

    await request(app.getHttpServer())
      .post('/api/v1/waitlist/pivot/claim')
      .send({ email: 'site@b.co', source: 'cloud' })
      .expect(200)
      .expect({ ok: true });

    const rows = await ds.query(
      `SELECT source, claimed_at < now() - interval '1 hour' AS untouched FROM waitlist_claims`,
    );
    expect(rows).toEqual([{ source: 'website', untouched: true }]);
  });

  it('rejects a source outside cloud/self-hosted', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/waitlist/pivot/claim')
      .send({ email: 'a@b.co', source: 'website' })
      .expect(400);
  });

  it('dedupes by email on a second claim', async () => {
    const server = app.getHttpServer();
    await request(server).post('/api/v1/waitlist/pivot/claim').send({ email: 'a@b.co' });
    await request(server).post('/api/v1/waitlist/pivot/claim').send({ email: 'A@b.co' });

    const ds = app.get(DataSource);
    const rows = await ds.query(`SELECT email FROM waitlist_claims`);
    expect(rows).toHaveLength(1);
  });

  it('lets the latest claim overwrite the source of an already-registered email', async () => {
    const ds = app.get(DataSource);
    await ds.query(
      `INSERT INTO waitlist_claims (email, source, claimed_at) VALUES ($1, $2, now() - interval '1 day')`,
      ['old@b.co', 'self-hosted'],
    );

    await request(app.getHttpServer())
      .post('/api/v1/waitlist/pivot/claim')
      .send({ email: 'old@b.co', source: 'cloud' })
      .expect(200);

    const rows = await ds.query(
      `SELECT email, source, claimed_at > now() - interval '1 hour' AS refreshed FROM waitlist_claims`,
    );
    expect(rows).toEqual([{ email: 'old@b.co', source: 'cloud', refreshed: true }]);
  });

  it('rejects an invalid email with 400 and stores nothing', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/waitlist/pivot/claim')
      .send({ email: 'not-an-email' })
      .expect(400);

    const ds = app.get(DataSource);
    const rows = await ds.query(`SELECT email FROM waitlist_claims`);
    expect(rows).toHaveLength(0);
  });

  it('rejects unknown fields with 400', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/waitlist/pivot/claim')
      .send({ email: 'a@b.co', newsletter: true })
      .expect(400);
  });

  it('keeps the legacy autofix claim as a storing-nothing no-op', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/waitlist/autofix/claim')
      .send({ email: 'a@b.co' })
      .expect(200)
      .expect({ ok: true });

    const ds = app.get(DataSource);
    const rows = await ds.query(`SELECT email FROM waitlist_claims`);
    expect(rows).toHaveLength(0);
  });
});
