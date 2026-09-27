import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Tracks shutdown state and, on a real termination signal in production, holds
 * the process open for a drain window before NestJS closes the HTTP server.
 *
 * Why this exists: on a rolling deploy the platform (Railway) sends SIGTERM to
 * an old replica and only then deregisters it from the edge. If the server
 * closes its socket immediately, requests the edge is still routing during that
 * deregistration lag hit a closed connection and surface as 5xx — the spike
 * seen during deploy windows. Keeping the server accepting traffic for a few
 * seconds — while {@link isShuttingDown} flips the health probe to 503 — lets
 * the edge notice and stop routing before any request is dropped.
 *
 * NestJS calls `beforeApplicationShutdown()` after `onModuleDestroy()` and
 * *before* it closes the HTTP server, and TypeORM closes its connection later in
 * `onApplicationShutdown()`, so both the server and the database stay up for the
 * whole drain — requests served during the window behave normally.
 */
@Injectable()
export class ShutdownService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ShutdownService.name);
  private shuttingDown = false;

  constructor(private readonly config: ConfigService) {}

  /** True once a shutdown signal has been received. Read by the health probe. */
  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    // Flip readiness first so the health probe reports 503 immediately, even
    // when the drain itself is skipped below.
    this.shuttingDown = true;

    const drainMs = this.config.get<number>('app.shutdownDrainMs') ?? 0;
    const isProduction = this.config.get<string>('app.nodeEnv') === 'production';

    // Only drain on a real signal in production. A programmatic `app.close()`
    // (signal is undefined, e.g. tests) and dev / self-hosted single-instance
    // restarts have no edge to wait for, so blocking would only slow shutdown.
    if (!signal || !isProduction || drainMs <= 0) {
      return;
    }

    this.logger.log(`Received ${signal} — draining for ${drainMs}ms before closing connections.`);
    await new Promise<void>((resolve) => setTimeout(resolve, drainMs));
  }
}
