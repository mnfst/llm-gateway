import { Injectable, Logger } from '@nestjs/common';
import { isSelfHosted } from '../common/utils/detect-self-hosted';
import { CompleteDiscoveryDto } from './dto/complete-discovery.dto';

const DEFAULT_DISCOVERY_ENDPOINT = 'https://blue.manifest.build/v1/self-hosted/discovery';
const DISCOVERY_SYNC_TIMEOUT_MS = 10_000;

@Injectable()
export class DiscoverySyncService {
  private readonly logger = new Logger(DiscoverySyncService.name);

  async submit(submission: CompleteDiscoveryDto): Promise<void> {
    if (!isSelfHosted() || process.env['NODE_ENV'] !== 'production') return;
    if (!hasContent(submission)) return;

    try {
      const endpoint = process.env['DISCOVERY_ENDPOINT']?.trim() || DEFAULT_DISCOVERY_ENDPOINT;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(submission),
        signal: AbortSignal.timeout(DISCOVERY_SYNC_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(`Discovery sync returned ${response.status}`);
      }
    } catch (error) {
      this.logger.warn(`Discovery sync failed: ${String(error)}`);
    }
  }
}

function hasContent(submission: CompleteDiscoveryDto): boolean {
  return Object.values(submission).some(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );
}
