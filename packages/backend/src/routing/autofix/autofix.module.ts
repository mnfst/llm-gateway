import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../../entities/agent.entity';
import { AgentMessage } from '../../entities/agent-message.entity';
import { ManifestRequest } from '../../entities/request.entity';
import { isSelfHosted } from '../../common/utils/detect-self-hosted';
import { readManifestVersion } from '../../telemetry/telemetry.config';
import { TelemetryModule } from '../../telemetry/telemetry.module';
import { AutofixService } from './autofix.service';
import { AutofixHealthProbe } from './autofix-health-probe';
import { resolveHealingUrl } from './autofix-healing-config';
import { HEALING_CLIENT, type HealingClient } from './healing-client';
import { HttpHealingClient } from './http-healing-client';
import { InstallIdService } from '../../telemetry/install-id.service';
import { MockHealingClient } from './mock-healing-client';
import { ObservationReporter } from './observation-reporter';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Wires Autofix. The active healing client is chosen at boot from the
 * environment alone — the healer URL is a constant, not configuration:
 * - production (cloud or self-hosted) talks to hosted Phoenix over HTTP;
 * - dev/test uses the deterministic in-process mock, so local runs and CI
 *   never reach the production healer.
 *
 * Auth is what differs between the two production modes: cloud sends its
 * static `AUTOFIX_HEALING_API_KEY`, self-hosted announces its anonymous
 * install id. `AUTOFIX_GLOBAL_ENABLED=false` disables the feature outright.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Agent, AgentMessage, ManifestRequest]), TelemetryModule],
  providers: [
    AutofixService,
    AutofixHealthProbe,
    ObservationReporter,
    {
      provide: HEALING_CLIENT,
      useFactory: (config: ConfigService, installIds: InstallIdService): HealingClient => {
        const nodeEnv = config.get<string>('NODE_ENV');
        const selfHosted = isSelfHosted();
        const url = resolveHealingUrl(nodeEnv);
        // Digits-only: `Number.parseInt` stops at the first non-digit, so a typo'd
        // `AUTOFIX_TIMEOUT_MS` like `'5abc'` would silently override the timeout with
        // `5`. Require a clean positive integer or fall back to the default.
        const rawTimeout = config.get<string>('AUTOFIX_TIMEOUT_MS')?.trim() ?? '';
        const parsed = /^\d+$/.test(rawTimeout) ? Number.parseInt(rawTimeout, 10) : NaN;
        const timeoutMs = parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
        if (url) {
          // Cloud sends its static key; self-hosted omits it and identifies by
          // install id instead.
          const apiKey = config.get<string>('AUTOFIX_HEALING_API_KEY')?.trim() || undefined;
          // Self-hosted with no static key announces the install's anonymous id,
          // minted lazily (an install that never enables Autofix or reports
          // telemetry never creates one) and memoized for the process lifetime —
          // InstallIdService reads the row on every call, so without this each
          // heal request would do its own lookup. Only successful resolutions
          // are cached: a transient DB failure must not disable Autofix for
          // the rest of the process.
          const instanceId =
            !apiKey && selfHosted
              ? (() => {
                  let cached: Promise<string> | null = null;
                  return async (): Promise<string> => {
                    if (cached) return cached;
                    cached = installIds.getOrCreate().then((i) => i.install_id);
                    try {
                      return await cached;
                    } catch (err) {
                      cached = null;
                      throw err;
                    }
                  };
                })()
              : undefined;
          return new HttpHealingClient(url, timeoutMs, apiKey, instanceId, readManifestVersion());
        }
        return new MockHealingClient();
      },
      inject: [ConfigService, InstallIdService],
    },
  ],
  exports: [AutofixService, ObservationReporter],
})
export class AutofixModule {}
