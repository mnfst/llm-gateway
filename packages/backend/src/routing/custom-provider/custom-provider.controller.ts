import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { TenantCtx, TenantContext } from '../../common/decorators/tenant-context.decorator';
import { CustomProviderService } from './custom-provider.service';
import { ProviderService } from '../routing-core/provider.service';
import { ResolveAgentService } from '../routing-core/resolve-agent.service';
import {
  CreateCustomProviderDto,
  ProbeCustomProviderDto,
  UpdateCustomProviderDto,
} from '../dto/custom-provider.dto';
import { AgentNameParamDto } from '../dto/routing.dto';

@Controller('api/v1/routing')
export class CustomProviderController {
  constructor(
    private readonly customProviderService: CustomProviderService,
    private readonly providerService: ProviderService,
    private readonly resolveAgentService: ResolveAgentService,
  ) {}

  @Get(':agentName/custom-providers')
  async list(@TenantCtx() ctx: TenantContext, @Param() params: AgentNameParamDto) {
    // Resolve for authz — the tenant must own the agent. Custom providers are
    // tenant-global, so the listing itself is scoped to the tenant, not the agent.
    // allowPlayground: true — the Playground page reads custom providers for the
    // reserved Playground agent; all mutation endpoints remain blocked.
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, params.agentName, {
      allowPlayground: true,
    });
    const [providers, tenantProviders] = await Promise.all([
      this.customProviderService.list(agent.tenant_id),
      this.providerService.getProviders(agent.tenant_id),
    ]);
    if (providers.length === 0) return [];

    return providers.map((cp) => {
      const provKey = CustomProviderService.providerKey(cp.id);
      const up = tenantProviders.find((u) => u.provider === provKey);
      return {
        id: cp.id,
        name: cp.name,
        alias: cp.alias,
        base_url: cp.base_url,
        api_kind: cp.api_kind,
        has_api_key: !!up?.api_key_encrypted,
        models: cp.models,
        created_at: cp.created_at,
      };
    });
  }

  @Post(':agentName/custom-providers/probe')
  async probe(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Body() body: ProbeCustomProviderDto,
  ) {
    // Resolve for authz — the tenant must own the agent before the server
    // probes anything on its behalf.
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    // Edit-mode fallback: the form has no plaintext key when re-opened
    // (list() only exposes has_api_key:bool), so it forwards provider_id
    // and we decrypt the stored key here. Tenant-scoped, so a forged id
    // from another tenant simply misses and degrades to an unauth probe.
    // A user-typed apiKey always wins so new keys can be verified pre-save.
    const apiKey =
      body.apiKey ??
      (body.provider_id
        ? await this.customProviderService.loadStoredApiKey(agent.tenant_id, body.provider_id)
        : undefined);
    const models = await this.customProviderService.probeModels(
      body.base_url,
      apiKey,
      body.api_kind,
      body.provider_name,
    );
    return { models };
  }

  @Post(':agentName/custom-providers')
  async create(
    @TenantCtx() ctx: TenantContext,
    @Param() params: AgentNameParamDto,
    @Body() body: CreateCustomProviderDto,
  ) {
    // allowPlayground: true — creating a custom provider from the Playground page is
    // additive (tenant-global resource); the playground agent is a valid owner context.
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, params.agentName, {
      allowPlayground: true,
    });
    const cp = await this.customProviderService.create(agent.tenant_id, body, ctx.userId);
    const provKey = CustomProviderService.providerKey(cp.id);
    const up = (await this.providerService.getProviders(agent.tenant_id)).find(
      (u) => u.provider === provKey,
    );

    return {
      id: cp.id,
      name: cp.name,
      alias: cp.alias,
      base_url: cp.base_url,
      api_kind: cp.api_kind,
      has_api_key: !!up?.api_key_encrypted,
      models: cp.models,
      created_at: cp.created_at,
    };
  }

  @Put(':agentName/custom-providers/:id')
  async update(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Param('id') id: string,
    @Body() body: UpdateCustomProviderDto,
  ) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    const cp = await this.customProviderService.update(id, agent.tenant_id, body, ctx.userId);
    const provKey = CustomProviderService.providerKey(cp.id);
    const up = (await this.providerService.getProviders(agent.tenant_id)).find(
      (u) => u.provider === provKey,
    );

    return {
      id: cp.id,
      name: cp.name,
      alias: cp.alias,
      base_url: cp.base_url,
      api_kind: cp.api_kind,
      has_api_key: !!up?.api_key_encrypted,
      models: cp.models,
      created_at: cp.created_at,
    };
  }

  @Delete(':agentName/custom-providers/:id')
  async remove(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Param('id') id: string,
  ) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    await this.customProviderService.remove(agent.tenant_id, id, ctx.userId);
    return { ok: true };
  }
}
