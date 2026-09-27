import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { TierController } from './tier.controller';
import { TierService } from './routing-core/tier.service';
import { ResolveAgentService } from './routing-core/resolve-agent.service';
import { Agent } from '../entities/agent.entity';
import { InstallMetadata } from '../entities/install-metadata.entity';
import { AutofixService } from './autofix/autofix.service';
import type { TenantContext } from '../common/decorators/tenant-context.decorator';
import { AgentRecordingConfigService } from '../common/services/agent-recording-config.service';
import type { Cache } from 'cache-manager';

const ORIGINAL_MANIFEST_MODE = process.env.MANIFEST_MODE;

describe('TierController', () => {
  afterAll(() => {
    if (ORIGINAL_MANIFEST_MODE === undefined) delete process.env.MANIFEST_MODE;
    else process.env.MANIFEST_MODE = ORIGINAL_MANIFEST_MODE;
  });

  const ctx: TenantContext = { tenantId: 'tenant-1', userId: 'user-1' };
  const agent = {
    id: 'agent-1',
    name: 'demo',
    tenant_id: 'tenant-1',
    complexity_routing_enabled: true,
    autofix_enabled: false,
    record_messages: false,
  };
  let tierService: jest.Mocked<Partial<TierService>>;
  let resolveAgentService: {
    resolve: jest.Mock;
    invalidate: jest.Mock;
    invalidateTenant: jest.Mock;
  };
  let agentRepo: jest.Mocked<Partial<Repository<Agent>>>;
  let autofixService: {
    resolveEnabled: jest.Mock;
  };
  let controller: TierController;
  let cacheDel: jest.Mock;
  let recordingConfig: { isRecording: jest.Mock };
  let installMetadataRepo: {
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };

  beforeEach(() => {
    // Pin cloud mode: a dev shell exporting MANIFEST_MODE=selfhosted must not
    // flip the consent gate under the cloud-behavior tests below.
    process.env.MANIFEST_MODE = 'cloud';
    tierService = {
      getTiers: jest.fn().mockResolvedValue([]),
      setOverride: jest.fn(),
      clearOverride: jest.fn().mockResolvedValue(undefined),
      resetAllOverrides: jest.fn().mockResolvedValue(undefined),
      getFallbacks: jest.fn().mockResolvedValue([]),
      setFallbacks: jest.fn().mockResolvedValue([]),
      clearFallbacks: jest.fn().mockResolvedValue(undefined),
    };
    resolveAgentService = {
      resolve: jest.fn().mockResolvedValue(agent),
      invalidate: jest.fn(),
      invalidateTenant: jest.fn(),
    };
    agentRepo = {
      update: jest.fn().mockResolvedValue(undefined),
    };
    autofixService = {
      // Mirror the real resolver: explicit flag wins, NULL inherits a default.
      resolveEnabled: jest.fn((stored: boolean | null) => stored ?? false),
    };
    recordingConfig = { isRecording: jest.fn().mockResolvedValue(false) };
    installMetadataRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn().mockReturnValue({
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        orUpdate: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(undefined),
      }),
    };
    const cacheManager = { del: jest.fn().mockResolvedValue(undefined) };
    cacheDel = cacheManager.del;
    controller = new TierController(
      tierService as unknown as TierService,
      resolveAgentService as unknown as ResolveAgentService,
      agentRepo as unknown as Repository<Agent>,
      installMetadataRepo as unknown as Repository<InstallMetadata>,
      autofixService as unknown as AutofixService,
      recordingConfig as unknown as AgentRecordingConfigService,
      cacheManager as unknown as Cache,
    );
  });

  it('GET /tiers returns tier rows for the agent', async () => {
    (tierService.getTiers as jest.Mock).mockResolvedValue([{ tier: 'simple' }]);
    const rows = await controller.getTiers(ctx, { agentName: 'demo' });
    expect(rows).toEqual([{ tier: 'simple' }]);
    expect(tierService.getTiers).toHaveBeenCalledWith('agent-1', 'tenant-1');
  });

  it('PUT /tiers/:tier accepts the default slot', async () => {
    (tierService.setOverride as jest.Mock).mockResolvedValue({
      tier: 'default',
      override_model: 'm',
    });
    const out = await controller.setOverride(ctx, 'demo', 'default', { model: 'm' });
    expect(out).toEqual({ tier: 'default', override_model: 'm' });
    expect(tierService.setOverride).toHaveBeenCalledWith(
      'agent-1',
      'tenant-1',
      'default',
      'm',
      undefined,
      undefined,
      undefined,
    );
  });

  it('PUT /tiers/:tier rejects unknown slots', async () => {
    await expect(
      controller.setOverride(ctx, 'demo', 'nonsense', { model: 'm' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tierService.setOverride).not.toHaveBeenCalled();
  });

  it('DELETE /tiers/:tier clears the override for valid slots', async () => {
    const out = await controller.clearOverride(ctx, 'demo', 'default');
    expect(out).toEqual({ ok: true });
    expect(tierService.clearOverride).toHaveBeenCalledWith('agent-1', 'default');
  });

  it('DELETE /tiers/:tier rejects unknown slots', async () => {
    await expect(controller.clearOverride(ctx, 'demo', 'bogus')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('POST /tiers/reset-all clears every override', async () => {
    const out = await controller.resetAllOverrides(ctx, { agentName: 'demo' });
    expect(out).toEqual({ ok: true });
    expect(tierService.resetAllOverrides).toHaveBeenCalledWith('agent-1');
  });

  it('GET/PUT/DELETE /tiers/:tier/fallbacks validate the slot', async () => {
    (tierService.getFallbacks as jest.Mock).mockResolvedValue(['m1']);
    expect(await controller.getFallbacks(ctx, 'demo', 'default')).toEqual(['m1']);

    (tierService.setFallbacks as jest.Mock).mockResolvedValue(['m1', 'm2']);
    expect(await controller.setFallbacks(ctx, 'demo', 'default', { models: ['m1', 'm2'] })).toEqual(
      ['m1', 'm2'],
    );

    expect(await controller.clearFallbacks(ctx, 'demo', 'default')).toEqual({ ok: true });

    await expect(controller.getFallbacks(ctx, 'demo', 'bogus')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      controller.setFallbacks(ctx, 'demo', 'bogus', { models: ['m'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.clearFallbacks(ctx, 'demo', 'bogus')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('GET complexity/status returns the current flag', async () => {
    const result = await controller.getComplexityStatus(ctx, 'demo');
    expect(result).toEqual({ enabled: true });
  });

  it('POST complexity/toggle flips the flag and invalidates cache', async () => {
    const result = await controller.toggleComplexity(ctx, 'demo');
    expect(result).toEqual({ enabled: false });
    expect(agentRepo.update).toHaveBeenCalledWith('agent-1', {
      complexity_routing_enabled: false,
    });
    expect(resolveAgentService.invalidate).toHaveBeenCalledWith('tenant-1', 'demo');
  });

  it('GET autofix returns the enabled flag', async () => {
    // Cloud mode: no consent gate, so `consented` is always true.
    expect(await controller.getAutofix(ctx, 'demo')).toEqual({ enabled: false, consented: true });
  });

  it('GET autofix resolves the mode default via the service when the flag is unset (null)', async () => {
    // A NULL stored flag is handed to the service, which resolves the
    // deployment-mode default (here stubbed to ON).
    resolveAgentService.resolve.mockResolvedValueOnce({ ...agent, autofix_enabled: null });
    autofixService.resolveEnabled.mockReturnValueOnce(true);
    expect(await controller.getAutofix(ctx, 'demo')).toEqual({ enabled: true, consented: true });
    expect(autofixService.resolveEnabled).toHaveBeenCalledWith(null);
  });

  it('PATCH autofix updates the enabled flag and invalidates the agent lookup', async () => {
    const out = await controller.updateAutofix(ctx, 'demo', { enabled: true });
    expect(out).toEqual({ enabled: true, consented: true });
    expect(agentRepo.update).toHaveBeenCalledWith('agent-1', { autofix_enabled: true });
    expect(resolveAgentService.invalidate).toHaveBeenCalledWith('tenant-1', 'demo');
    // Cloud: no consent to record, and no backfill requested.
    expect(installMetadataRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(resolveAgentService.invalidateTenant).not.toHaveBeenCalled();
    // The workspace status the sidebar reads is cached per tenant; both
    // `any_enabled` and `consented` just changed, so it has to be dropped or
    // the CTA keeps prompting for the dashboard TTL.
    expect(cacheDel).toHaveBeenCalledWith('tenant-1:/api/v1/autofix/status');
  });

  it('PATCH autofix leaves the workspace status cache alone on a no-op', async () => {
    await controller.updateAutofix(ctx, 'demo', {});
    expect(cacheDel).not.toHaveBeenCalled();
  });

  it('PATCH autofix with an empty body is a no-op and echoes the current value', async () => {
    const out = await controller.updateAutofix(ctx, 'demo', {});
    expect(out).toEqual({ enabled: false, consented: true });
    expect(agentRepo.update).not.toHaveBeenCalled();
    expect(resolveAgentService.invalidate).not.toHaveBeenCalled();
  });

  it('PATCH autofix treats a null enabled as a no-op (never resets the flag to null)', async () => {
    // @IsOptional() lets `{"enabled": null}` past validation; the controller must
    // not write null (which would wipe the stored flag) nor echo `enabled: null`.
    const out = await controller.updateAutofix(ctx, 'demo', {
      enabled: null as unknown as boolean,
    });
    expect(out).toEqual({ enabled: false, consented: true });
    expect(agentRepo.update).not.toHaveBeenCalled();
    expect(resolveAgentService.invalidate).not.toHaveBeenCalled();
  });

  describe('self-hosted consent + backfill', () => {
    let savedMode: string | undefined;
    beforeEach(() => {
      savedMode = process.env.MANIFEST_MODE;
      process.env.MANIFEST_MODE = 'selfhosted';
      installMetadataRepo.findOne.mockReset();
    });
    afterEach(() => {
      if (savedMode === undefined) delete process.env.MANIFEST_MODE;
      else process.env.MANIFEST_MODE = savedMode;
    });

    it('reports consented=false until the install consents', async () => {
      installMetadataRepo.findOne.mockResolvedValue(null);
      expect(await controller.getAutofix(ctx, 'demo')).toEqual({
        enabled: false,
        consented: false,
      });
    });

    it('reports consented=true once the install consented', async () => {
      installMetadataRepo.findOne.mockResolvedValue({
        id: 'singleton',
        autofix_consented_at: new Date().toISOString(),
      });
      expect(await controller.getAutofix(ctx, 'demo')).toEqual({
        enabled: false,
        consented: true,
      });
    });

    it('records the once-consent when enabling', async () => {
      installMetadataRepo.findOne.mockResolvedValue(null);
      await controller.updateAutofix(ctx, 'demo', { enabled: true });
      expect(installMetadataRepo.createQueryBuilder).toHaveBeenCalled();
    });

    it('does not record consent again once it exists', async () => {
      installMetadataRepo.findOne.mockResolvedValue({
        id: 'singleton',
        autofix_consented_at: new Date().toISOString(),
      });
      await controller.updateAutofix(ctx, 'demo', { enabled: true });
      expect(installMetadataRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('does not record consent on a disable, but still busts the status cache', async () => {
      // Consent means "I agree to turn Autofix on" — switching an agent off
      // must never mint it. The write still changes `any_enabled`, so the
      // cached workspace status has to be dropped like on an enable.
      installMetadataRepo.findOne.mockResolvedValue(null);
      const out = await controller.updateAutofix(ctx, 'demo', { enabled: false });
      expect(out).toEqual({ enabled: false, consented: false });
      expect(agentRepo.update).toHaveBeenCalledWith('agent-1', { autofix_enabled: false });
      expect(installMetadataRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(cacheDel).toHaveBeenCalledWith('tenant-1:/api/v1/autofix/status');
    });
  });

  it('GET recording returns the per-agent opt-in flag', async () => {
    expect(await controller.getRecording(ctx, 'demo')).toEqual({ enabled: false });
    expect(recordingConfig.isRecording).toHaveBeenCalledWith('agent-1');
  });

  it('PATCH recording updates the flag and invalidates the agent lookup', async () => {
    expect(await controller.updateRecording(ctx, 'demo', { enabled: true })).toEqual({
      enabled: true,
    });
    expect(agentRepo.update).toHaveBeenCalledWith('agent-1', { record_messages: true });
    expect(resolveAgentService.invalidate).toHaveBeenCalledWith('tenant-1', 'demo');
  });

  it('PATCH recording with no boolean is a no-op', async () => {
    expect(await controller.updateRecording(ctx, 'demo', {})).toEqual({ enabled: false });
    expect(agentRepo.update).not.toHaveBeenCalled();
    expect(recordingConfig.isRecording).toHaveBeenCalledWith('agent-1');
  });

  it('PATCH response-mode sets the mode for a valid tier', async () => {
    tierService.setResponseMode = jest
      .fn()
      .mockResolvedValue({ tier: 'standard', response_mode: 'buffered' });
    const out = await controller.setResponseMode(ctx, 'demo', 'standard', {
      response_mode: 'buffered',
    });
    expect(out).toEqual({ tier: 'standard', response_mode: 'buffered' });
    expect(tierService.setResponseMode).toHaveBeenCalledWith('agent-1', 'standard', 'buffered');
  });

  it('PATCH response-mode rejects a missing response_mode', async () => {
    await expect(controller.setResponseMode(ctx, 'demo', 'standard', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  // P1-A: tier write endpoint must 404 for the reserved "Playground" agent
  it('PUT /tiers/:tier throws NotFoundException when resolve rejects the Playground agent', async () => {
    resolveAgentService.resolve.mockRejectedValueOnce(
      new NotFoundException('Agent "Playground" not found'),
    );
    await expect(
      controller.setOverride(ctx, 'Playground', 'default', { model: 'm' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tierService.setOverride).not.toHaveBeenCalled();
  });
});
