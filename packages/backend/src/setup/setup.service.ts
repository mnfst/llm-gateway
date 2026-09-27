import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CreateAdminDto } from './dto/create-admin.dto';
import { OLLAMA_HOST } from '../common/constants/ollama';
import { getContainerHostAlias, isSelfHosted } from '../common/utils/detect-self-hosted';
import { isEmailConfigured } from '../notifications/services/email-providers/send-email';
import { mcpAvailability } from '../auth/mcp-availability';

/**
 * Postgres advisory lock key reserved for the first-run setup wizard.
 * A random-ish constant — collisions only matter if another call site
 * uses the same key, which we control.
 */
const SETUP_ADVISORY_LOCK_KEY = 9001;

@Injectable()
export class SetupService {
  private readonly logger = new Logger(SetupService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Returns true when running in the self-hosted version.
   * Auto-detects Docker containers; can be overridden via MANIFEST_MODE env var.
   */
  isSelfHosted(): boolean {
    return isSelfHosted();
  }

  /**
   * Returns the hostname the backend should use to reach host-installed
   * LLM servers. Inside Docker the container reaches the host via
   * `host.docker.internal`; under Podman it's `host.containers.internal`.
   * On a native install `localhost` resolves correctly.
   */
  getLocalLlmHost(): string {
    return getContainerHostAlias();
  }

  /**
   * Returns the list of social OAuth providers that have both
   * CLIENT_ID and CLIENT_SECRET configured in the environment.
   */
  getEnabledSocialProviders(): string[] {
    const providers: string[] = [];
    if (process.env['GOOGLE_CLIENT_ID'] && process.env['GOOGLE_CLIENT_SECRET'])
      providers.push('google');
    if (process.env['GITHUB_CLIENT_ID'] && process.env['GITHUB_CLIENT_SECRET'])
      providers.push('github');
    if (process.env['DISCORD_CLIENT_ID'] && process.env['DISCORD_CLIENT_SECRET'])
      providers.push('discord');
    return providers;
  }

  /**
   * Returns true when a transactional email provider is configured, meaning the
   * email-based password reset flow can actually deliver a link. The reset page
   * reads this to warn (and point to Change Password) instead of silently
   * pretending an email was sent on installs with no provider wired in.
   */
  isEmailConfigured(): boolean {
    return isEmailConfigured();
  }

  /**
   * Returns true when MCP is enabled for this install — the same decision the
   * boot made, not a liveness probe. MCP is left unregistered on installs
   * served over plain HTTP from a non-loopback host (the OAuth resource must
   * be HTTPS) and on installs that set `MCP_ENABLED=false`, so the dashboard
   * hides its setup page rather than handing out an endpoint that answers 404.
   */
  isMcpEnabled(): boolean {
    return mcpAvailability().enabled;
  }

  /**
   * Pings the Ollama server and returns true if it responds.
   */
  async isOllamaAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: controller.signal });
      clearTimeout(timeout);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Returns true when no Better Auth user exists yet. The login flow uses
   * this to redirect visitors to the setup wizard instead of showing the
   * login form on a fresh install.
   */
  async needsSetup(): Promise<boolean> {
    const rows = await this.dataSource.query<{ count: string }[]>(
      `SELECT COUNT(*) AS count FROM "user"`,
    );
    const count = Number(rows[0]?.count ?? 0);
    return count === 0;
  }

  /**
   * Creates the first admin user via Better Auth and marks them
   * `emailVerified = true` so they can log in immediately without an
   * email provider.
   *
   * Why not wrap this in `this.dataSource.transaction(...)`:
   * `auth.api.signUpEmail()` runs against Better Auth's own `pg.Pool`,
   * not the TypeORM connection. A TypeORM rollback after signUpEmail
   * succeeds would NOT undo the user insert, leaving the account
   * created but unverified and blocking subsequent retries with a 409.
   *
   * Instead we hold a session-level Postgres advisory lock (not
   * transaction-level) across the whole sequence so concurrent setup
   * attempts serialize, and we add a recovery branch: if the only
   * existing user is unverified and matches the DTO email, we treat the
   * previous attempt as partial and complete the verification step.
   */
  async createFirstAdmin(dto: CreateAdminDto): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await queryRunner.query(`SELECT pg_advisory_lock($1)`, [SETUP_ADVISORY_LOCK_KEY]);
      try {
        const rows = (await queryRunner.query(`SELECT COUNT(*) AS count FROM "user"`)) as Array<{
          count: string;
        }>;
        const count = Number(rows[0]?.count ?? 0);

        if (count > 0) {
          // Recovery branch: a previous attempt may have created the user
          // but crashed before setting emailVerified. If there's exactly
          // one user, it's unverified, and its email matches the DTO,
          // finish the verification step instead of returning 409.
          if (count === 1) {
            const unverified = (await queryRunner.query(
              `SELECT email FROM "user" WHERE "emailVerified" = false AND email = $1`,
              [dto.email],
            )) as Array<{ email: string }>;
            if (unverified.length === 1) {
              await queryRunner.query(`UPDATE "user" SET "emailVerified" = true WHERE email = $1`, [
                dto.email,
              ]);
              this.logger.log(`First-run setup recovery — completed verification for ${dto.email}`);
              return;
            }
          }
          throw new ConflictException('Setup already completed — an admin user exists');
        }

        // Lazy-require so jest unit and e2e tests that don't exercise
        // this path don't have to load Better Auth's ESM bundle.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { auth } = require('../auth/auth.instance');
        await auth.api.signUpEmail({
          body: {
            email: dto.email,
            password: dto.password,
            name: dto.name,
          },
        });

        await queryRunner.query(`UPDATE "user" SET "emailVerified" = true WHERE email = $1`, [
          dto.email,
        ]);

        this.logger.log(`First-run setup complete — admin user created: ${dto.email}`);
      } finally {
        await queryRunner.query(`SELECT pg_advisory_unlock($1)`, [SETUP_ADVISORY_LOCK_KEY]);
      }
    } finally {
      await queryRunner.release();
    }
  }
}
