import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { Tenant } from '../../entities/tenant.entity';
import { Agent } from '../../entities/agent.entity';
import { AgentApiKey } from '../../entities/agent-api-key.entity';
import { hashKey, keyPrefix } from '../../common/utils/hash.util';
import {
  encrypt,
  decryptWithAny,
  getEncryptionSecret,
  getDecryptionSecrets,
} from '../../common/utils/crypto.util';
import { API_KEY_PREFIX } from '../../common/constants/api-key.constants';
import { AgentKeyAuthGuard } from '../guards/agent-key-auth.guard';

@Injectable()
export class ApiKeyGeneratorService {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
    @InjectRepository(AgentApiKey)
    private readonly keyRepo: Repository<AgentApiKey>,
    private readonly otlpAuthGuard: AgentKeyAuthGuard,
  ) {}

  private generateKey(): string {
    return API_KEY_PREFIX + randomBytes(32).toString('base64url');
  }

  async onboardAgent(params: {
    /** Known tenant (e.g. from an API-key context). Skips owner resolution. */
    tenantId?: string | null;
    /** Owner to resolve (and lazily create) the tenant for, when no tenantId is known. */
    ownerUserId?: string | null;
    agentName: string;
    organizationName?: string;
    email?: string;
    agentDescription?: string;
    displayName?: string;
    agentCategory?: string;
    agentPlatform?: string;
    /** Explicit Autofix choice. Undefined → column default / mode inherit (NULL). */
    autofixEnabled?: boolean;
    /** Explicit recording choice. Undefined → column default (true for new agents). */
    recordMessages?: boolean;
  }): Promise<{ tenantId: string; agentId: string; apiKey: string }> {
    let tenantId: string;
    if (params.tenantId) {
      tenantId = params.tenantId;
    } else if (params.ownerUserId) {
      const existing = await this.tenantRepo.findOne({
        where: { owner_user_id: params.ownerUserId },
      });
      if (existing) {
        tenantId = existing.id;
      } else {
        tenantId = uuidv4();
        await this.tenantRepo.insert({
          id: tenantId,
          // `name` keeps mirroring the owner id until it's repurposed as a
          // display slug; resolution only ever reads owner_user_id.
          name: params.ownerUserId,
          owner_user_id: params.ownerUserId,
          organization_name: params.organizationName ?? null,
          email: params.email ?? null,
          is_active: true,
        });
      }
    } else {
      throw new NotFoundException('No tenant available for agent onboarding');
    }

    const agentId = uuidv4();
    await this.agentRepo.insert({
      id: agentId,
      name: params.agentName,
      display_name: params.displayName ?? null,
      description: params.agentDescription ?? null,
      agent_category: params.agentCategory ?? null,
      agent_platform: params.agentPlatform ?? null,
      // Only set when the caller made an explicit choice. Leaving them out lets
      // the column default / NULL-inherit path apply (Autofix mode default,
      // recording ON for new agents).
      ...(params.autofixEnabled !== undefined ? { autofix_enabled: params.autofixEnabled } : {}),
      ...(params.recordMessages !== undefined ? { record_messages: params.recordMessages } : {}),
      is_active: true,
      tenant_id: tenantId,
    });

    const rawKey = this.generateKey();
    const keyId = uuidv4();
    await this.keyRepo.insert({
      id: keyId,
      key: encrypt(rawKey, getEncryptionSecret()),
      key_hash: hashKey(rawKey),
      key_prefix: keyPrefix(rawKey),
      label: `${params.agentName} ingest key`,
      tenant_id: tenantId,
      agent_id: agentId,
      is_active: true,
    });

    return { tenantId, agentId, apiKey: rawKey };
  }

  async getKeyForAgent(
    tenantId: string,
    agentName: string,
  ): Promise<{ keyPrefix: string; fullKey?: string }> {
    const keyRecord = await this.keyRepo
      .createQueryBuilder('k')
      .leftJoin('k.agent', 'a')
      .where('a.tenant_id = :tenantId', { tenantId })
      .andWhere('a.name = :agentName', { agentName })
      .andWhere('a.deleted_at IS NULL')
      .andWhere('k.is_active = true')
      .getOne();

    if (!keyRecord) {
      throw new NotFoundException('No active API key found for this agent');
    }

    if (keyRecord.key) {
      try {
        const fullKey = decryptWithAny(keyRecord.key, getDecryptionSecrets()).plaintext;
        return { keyPrefix: keyRecord.key_prefix, fullKey };
      } catch {
        return { keyPrefix: keyRecord.key_prefix };
      }
    }

    return { keyPrefix: keyRecord.key_prefix };
  }

  async rotateKey(tenantId: string, agentName: string): Promise<{ apiKey: string }> {
    const agent = await this.agentRepo
      .createQueryBuilder('a')
      .where('a.name = :agentName', { agentName })
      .andWhere('a.tenant_id = :tenantId', { tenantId })
      .andWhere('a.deleted_at IS NULL')
      .getOne();
    if (!agent) throw new NotFoundException('Agent not found or access denied');

    await this.keyRepo.delete({ agent_id: agent.id });
    this.otlpAuthGuard.clearCache();

    const rawKey = this.generateKey();
    const keyId = uuidv4();
    await this.keyRepo.insert({
      id: keyId,
      key: encrypt(rawKey, getEncryptionSecret()),
      key_hash: hashKey(rawKey),
      key_prefix: keyPrefix(rawKey),
      label: `${agent.name} ingest key (rotated)`,
      tenant_id: agent.tenant_id,
      agent_id: agent.id,
      is_active: true,
    });

    return { apiKey: rawKey };
  }
}
