import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  getManagedFreeLiteLlmKeyGenerateUrl,
  getManagedFreeLiteLlmMasterKey,
  getManagedFreeLiteLlmMaxBudgetUsd,
  getManagedFreeProviderConfig,
  isManagedFreeLiteLlmAutoEligible,
  ManagedFreeProviderConfig,
} from '../../common/constants/managed-free-providers';
import { TenantProvider } from '../../entities/tenant-provider.entity';
import { ModelDiscoveryService } from '../../model-discovery/model-discovery.service';
import { ProviderService } from '../routing-core/provider.service';

export interface ManagedFreeEnsureResult {
  connected: boolean;
  connection_id: string | null;
  source: 'existing' | 'auto' | 'manual' | 'none';
  auto_available: boolean;
}

const MANAGED_FREE_KEY_GENERATE_TIMEOUT_MS = 5_000;

@Injectable()
export class ManagedFreeProviderService {
  private readonly logger = new Logger(ManagedFreeProviderService.name);

  constructor(
    @InjectRepository(TenantProvider)
    private readonly providerRepo: Repository<TenantProvider>,
    private readonly providerService: ProviderService,
    private readonly discoveryService: ModelDiscoveryService,
  ) {}

  private getConfig(providerId: string): ManagedFreeProviderConfig {
    const config = getManagedFreeProviderConfig(providerId);
    if (!config) {
      throw new NotFoundException(`Unknown managed free provider: ${providerId}`);
    }
    return config;
  }

  async findConnection(
    config: ManagedFreeProviderConfig,
    tenantId: string,
  ): Promise<TenantProvider | null> {
    const rows = await this.providerRepo.find({
      where: {
        tenant_id: tenantId,
        provider: config.id,
        auth_type: 'api_key',
      },
    });
    return rows.find((row) => row.is_active) ?? rows[0] ?? null;
  }

  async ensureConnection(
    providerId: string,
    opts: {
      tenantId: string;
      userId: string | null;
      userEmail: string | null | undefined;
      apiKey?: string;
    },
  ): Promise<ManagedFreeEnsureResult> {
    const config = this.getConfig(providerId);
    const { tenantId, userId, userEmail, apiKey } = opts;
    const autoAvailable = isManagedFreeLiteLlmAutoEligible(userEmail);

    const existing = await this.findConnection(config, tenantId);
    if (existing?.is_active) {
      return {
        connected: true,
        connection_id: existing.id,
        source: 'existing',
        auto_available: autoAvailable,
      };
    }

    const trimmedKey = apiKey?.trim();
    if (trimmedKey) {
      const row = await this.persistKey(config, tenantId, userId, trimmedKey);
      return {
        connected: true,
        connection_id: row.id,
        source: 'manual',
        auto_available: autoAvailable,
      };
    }

    // An inactive row records an explicit disconnect. Do not silently mint a
    // replacement key when the provider list is fetched later.
    if (existing) {
      return {
        connected: false,
        connection_id: null,
        source: 'none',
        auto_available: autoAvailable,
      };
    }

    if (!autoAvailable) {
      return {
        connected: false,
        connection_id: null,
        source: 'none',
        auto_available: false,
      };
    }

    const minted = await this.mintVirtualKey(config, tenantId, userEmail);
    const row = await this.persistKey(config, tenantId, userId, minted);
    return {
      connected: true,
      connection_id: row.id,
      source: 'auto',
      auto_available: true,
    };
  }

  private async persistKey(
    config: ManagedFreeProviderConfig,
    tenantId: string,
    userId: string | null,
    apiKey: string,
  ): Promise<TenantProvider> {
    const existing = await this.findConnection(config, tenantId);
    if (existing?.is_active) {
      throw new BadRequestException(
        `${config.displayName} already has a connection for this workspace`,
      );
    }

    const { provider } = await this.providerService.upsertProvider(
      null,
      tenantId,
      config.id,
      apiKey,
      'api_key',
      undefined,
      undefined,
      userId,
    );

    try {
      await this.discoveryService.discoverModels(provider);
    } catch (error) {
      this.logger.warn(
        `${config.displayName} model discovery failed after connect: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return provider;
  }

  private async mintVirtualKey(
    config: ManagedFreeProviderConfig,
    tenantId: string,
    userEmail: string | null | undefined,
  ): Promise<string> {
    const masterKey = getManagedFreeLiteLlmMasterKey();
    if (!masterKey) {
      throw new BadRequestException('LiteLLM master key is not configured');
    }

    const body = {
      models: [...config.litellmModels],
      max_budget: getManagedFreeLiteLlmMaxBudgetUsd(config),
      key_alias: `${config.id}:${tenantId}`,
      metadata: {
        source: config.id,
        tenant_id: tenantId,
        user_email: userEmail ?? null,
      },
    };

    let response: Response;
    try {
      response = await fetch(getManagedFreeLiteLlmKeyGenerateUrl(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${masterKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(MANAGED_FREE_KEY_GENERATE_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error(
        `LiteLLM /key/generate request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new BadRequestException(`Failed to create ${config.displayName} key`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      this.logger.error(`LiteLLM /key/generate failed (${response.status}): ${text.slice(0, 300)}`);
      throw new BadRequestException(`Failed to create ${config.displayName} key`);
    }

    const json = (await response.json()) as { key?: string; token?: string };
    const key = json.key ?? json.token;
    if (!key || typeof key !== 'string') {
      throw new BadRequestException('LiteLLM did not return a virtual key');
    }
    return key;
  }
}
