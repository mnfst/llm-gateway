/**
 * Integration-style tests for the full alert + block flow.
 *
 * Scenarios:
 * 1. Cost alert (notify only) → email sent once, no block
 * 2. Token alert (notify only) → email sent once, no block
 * 3. Cost alert + block (both) → email sent once + proxy blocked with message
 * 4. Token alert + block (both) → email sent once + proxy blocked with message
 * 5. No alert defined → no email, no block
 */
import { HttpException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { NotificationCronService } from './notification-cron.service';
import { LimitCheckService } from './limit-check.service';
import { NotificationRulesService } from './notification-rules.service';
import { NotificationEmailService } from './notification-email.service';
import { EmailProviderConfigService } from './email-provider-config.service';
import { NotificationLogService } from './notification-log.service';
import { ManifestRuntimeService } from '../../common/services/manifest-runtime.service';

/* ── Shared helpers ──────────────────────────────── */

const TENANT = 'tenant-1';
const AGENT = 'my-agent';
const EMAIL = 'alerts@example.com';

function makeRule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1',
    tenant_id: TENANT,
    agent_name: AGENT,
    metric_type: 'tokens' as const,
    threshold: 50000,
    period: 'day' as const,
    ...overrides,
  };
}

/* ── 1 & 2: Email-only alerts (cost / tokens) ───── */

describe('Alert scenarios — email only (notify)', () => {
  let cronService: NotificationCronService;
  let mockGetAllActiveRules: jest.Mock;
  let mockGetConsumption: jest.Mock;
  let mockSendThresholdAlert: jest.Mock;
  let mockHasAlreadySent: jest.Mock;
  let mockInsertLog: jest.Mock;
  let mockResolveRecipientEmail: jest.Mock;
  let mockGetFullConfig: jest.Mock;

  beforeEach(async () => {
    mockGetAllActiveRules = jest.fn().mockResolvedValue([]);
    mockGetConsumption = jest.fn().mockResolvedValue(0);
    mockSendThresholdAlert = jest.fn().mockResolvedValue(true);
    mockHasAlreadySent = jest.fn().mockResolvedValue(false);
    mockInsertLog = jest.fn().mockResolvedValue(undefined);
    mockResolveRecipientEmail = jest.fn().mockResolvedValue(EMAIL);
    mockGetFullConfig = jest.fn().mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationCronService,
        {
          provide: NotificationRulesService,
          useValue: {
            getAllActiveRules: mockGetAllActiveRules,
            getActiveRulesForTenant: jest.fn().mockResolvedValue([]),
            getConsumption: mockGetConsumption,
          },
        },
        {
          provide: NotificationEmailService,
          useValue: { sendThresholdAlert: mockSendThresholdAlert },
        },
        {
          provide: EmailProviderConfigService,
          useValue: { getFullConfig: mockGetFullConfig },
        },
        {
          provide: NotificationLogService,
          useValue: {
            hasAlreadySent: mockHasAlreadySent,
            insertLog: mockInsertLog,
            resolveRecipientEmail: mockResolveRecipientEmail,
          },
        },
        {
          provide: ManifestRuntimeService,
          useValue: {
            getAuthBaseUrl: jest.fn().mockReturnValue('http://localhost:3001'),
          },
        },
      ],
    }).compile();

    cronService = module.get(NotificationCronService);
  });

  it('cost alert (notify) — sends email once when cost threshold exceeded', async () => {
    const rule = makeRule({ metric_type: 'cost', threshold: 10, action: 'notify' });
    mockGetAllActiveRules.mockResolvedValue([rule]);
    mockGetConsumption.mockResolvedValue(15.5);

    const triggered = await cronService.checkThresholds();

    expect(triggered).toBe(1);
    expect(mockSendThresholdAlert).toHaveBeenCalledTimes(1);
    expect(mockSendThresholdAlert).toHaveBeenCalledWith(
      EMAIL,
      expect.objectContaining({
        agentName: AGENT,
        metricType: 'cost',
        threshold: 10,
        actualValue: 15.5,
        period: 'day',
        alertType: 'soft',
      }),
      undefined,
    );
    expect(mockInsertLog).toHaveBeenCalledTimes(1);
  });

  it('cost alert (notify) — does not send email twice in the same period', async () => {
    const rule = makeRule({ metric_type: 'cost', threshold: 10, action: 'notify' });
    mockGetAllActiveRules.mockResolvedValue([rule]);
    mockGetConsumption.mockResolvedValue(15.5);

    await cronService.checkThresholds();
    expect(mockSendThresholdAlert).toHaveBeenCalledTimes(1);

    // Second run: already sent
    mockHasAlreadySent.mockResolvedValue(true);
    const triggered2 = await cronService.checkThresholds();
    expect(triggered2).toBe(0);
    expect(mockSendThresholdAlert).toHaveBeenCalledTimes(1);
  });

  it('token alert (notify) — sends email once when token threshold exceeded', async () => {
    const rule = makeRule({ metric_type: 'tokens', threshold: 50000, action: 'notify' });
    mockGetAllActiveRules.mockResolvedValue([rule]);
    mockGetConsumption.mockResolvedValue(60000);

    const triggered = await cronService.checkThresholds();

    expect(triggered).toBe(1);
    expect(mockSendThresholdAlert).toHaveBeenCalledTimes(1);
    expect(mockSendThresholdAlert).toHaveBeenCalledWith(
      EMAIL,
      expect.objectContaining({
        agentName: AGENT,
        metricType: 'tokens',
        threshold: 50000,
        actualValue: 60000,
        period: 'day',
        alertType: 'soft',
      }),
      undefined,
    );
    expect(mockInsertLog).toHaveBeenCalledTimes(1);
  });

  it('token alert (notify) — does not send email twice in the same period', async () => {
    const rule = makeRule({ metric_type: 'tokens', threshold: 50000, action: 'notify' });
    mockGetAllActiveRules.mockResolvedValue([rule]);
    mockGetConsumption.mockResolvedValue(60000);

    await cronService.checkThresholds();
    expect(mockSendThresholdAlert).toHaveBeenCalledTimes(1);

    mockHasAlreadySent.mockResolvedValue(true);
    const triggered2 = await cronService.checkThresholds();
    expect(triggered2).toBe(0);
    expect(mockSendThresholdAlert).toHaveBeenCalledTimes(1);
  });
});

/* ── 3 & 4: Email + block (both) ────────────────── */

describe('Alert scenarios — email + block (both)', () => {
  let limitCheckService: LimitCheckService;
  let mockGetActiveBlockRules: jest.Mock;
  let mockGetConsumption: jest.Mock;
  let mockSendThresholdAlert: jest.Mock;
  let mockHasAlreadySent: jest.Mock;
  let mockInsertLog: jest.Mock;
  let mockResolveRecipientEmail: jest.Mock;

  beforeEach(() => {
    mockGetActiveBlockRules = jest.fn().mockResolvedValue([]);
    mockGetConsumption = jest.fn().mockResolvedValue(0);
    mockSendThresholdAlert = jest.fn().mockResolvedValue(true);
    mockHasAlreadySent = jest.fn().mockResolvedValue(false);
    mockInsertLog = jest.fn().mockResolvedValue(undefined);
    mockResolveRecipientEmail = jest.fn().mockResolvedValue(EMAIL);

    limitCheckService = new LimitCheckService(
      {
        getActiveBlockRules: mockGetActiveBlockRules,
        getConsumption: mockGetConsumption,
      } as unknown as NotificationRulesService,
      {
        sendThresholdAlert: mockSendThresholdAlert,
      } as unknown as NotificationEmailService,
      {
        getFullConfig: jest.fn().mockResolvedValue(null),
      } as unknown as EmailProviderConfigService,
      {
        getAuthBaseUrl: jest.fn().mockReturnValue('http://localhost:3001'),
      } as unknown as ManifestRuntimeService,
      {
        hasAlreadySent: mockHasAlreadySent,
        insertLog: mockInsertLog,
        resolveRecipientEmail: mockResolveRecipientEmail,
      } as unknown as NotificationLogService,
    );
  });

  it('cost alert + block — sends email, blocks agent, returns formatted message', async () => {
    const rule = makeRule({ metric_type: 'cost', threshold: 10, action: 'both' });
    mockGetActiveBlockRules.mockResolvedValue([rule]);
    mockGetConsumption.mockResolvedValue(12.5);

    // 1. LimitCheck returns exceeded
    const exceeded = await limitCheckService.checkLimits(TENANT, AGENT);
    expect(exceeded).not.toBeNull();
    expect(exceeded!.metricType).toBe('cost');
    expect(exceeded!.threshold).toBe(10);
    expect(exceeded!.actual).toBe(12.5);
    expect(exceeded!.period).toBe('day');

    // 2. Email is sent (async, wait a tick)
    await new Promise((r) => setTimeout(r, 50));
    expect(mockSendThresholdAlert).toHaveBeenCalledTimes(1);
    expect(mockSendThresholdAlert).toHaveBeenCalledWith(
      EMAIL,
      expect.objectContaining({
        agentName: AGENT,
        metricType: 'cost',
        threshold: 10,
        actualValue: 12.5,
        alertType: 'hard',
      }),
      undefined,
    );

    // 3. Proxy would format the error message like this
    const fmt = `$${Number(exceeded!.actual).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const threshFmt = `$${Number(exceeded!.threshold).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const errorMessage = `Limit exceeded: ${exceeded!.metricType} usage (${fmt}) exceeds ${threshFmt} per ${exceeded!.period}`;
    expect(errorMessage).toContain('cost');
    expect(errorMessage).toContain('$');
    expect(errorMessage).toContain('per day');

    const error = new HttpException(
      { error: { message: errorMessage, type: 'rate_limit_exceeded', code: 'limit_exceeded' } },
      429,
    );
    expect(error.getStatus()).toBe(429);
    const body = error.getResponse() as Record<string, unknown>;
    expect((body.error as Record<string, string>).message).toContain('Limit exceeded');
  });

  it('cost alert + block — email sent only once per period', async () => {
    const rule = makeRule({ metric_type: 'cost', threshold: 10, action: 'both' });
    mockGetActiveBlockRules.mockResolvedValue([rule]);
    mockGetConsumption.mockResolvedValue(12.5);

    await limitCheckService.checkLimits(TENANT, AGENT);
    await new Promise((r) => setTimeout(r, 50));
    expect(mockSendThresholdAlert).toHaveBeenCalledTimes(1);

    // Second check — already sent
    mockHasAlreadySent.mockResolvedValue(true);
    const exceeded2 = await limitCheckService.checkLimits(TENANT, AGENT);
    await new Promise((r) => setTimeout(r, 50));

    // Still blocked
    expect(exceeded2).not.toBeNull();
    // But email not sent again
    expect(mockSendThresholdAlert).toHaveBeenCalledTimes(1);
  });

  it('token alert + block — sends email, blocks agent, returns formatted message', async () => {
    const rule = makeRule({ metric_type: 'tokens', threshold: 50000, action: 'both' });
    mockGetActiveBlockRules.mockResolvedValue([rule]);
    mockGetConsumption.mockResolvedValue(62000);

    // 1. LimitCheck returns exceeded
    const exceeded = await limitCheckService.checkLimits(TENANT, AGENT);
    expect(exceeded).not.toBeNull();
    expect(exceeded!.metricType).toBe('tokens');
    expect(exceeded!.threshold).toBe(50000);
    expect(exceeded!.actual).toBe(62000);
    expect(exceeded!.period).toBe('day');

    // 2. Email is sent
    await new Promise((r) => setTimeout(r, 50));
    expect(mockSendThresholdAlert).toHaveBeenCalledTimes(1);
    expect(mockSendThresholdAlert).toHaveBeenCalledWith(
      EMAIL,
      expect.objectContaining({
        agentName: AGENT,
        metricType: 'tokens',
        threshold: 50000,
        actualValue: 62000,
        alertType: 'hard',
      }),
      undefined,
    );

    // 3. Proxy would format the error message like this
    const fmt = Number(exceeded!.actual).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const threshFmt = Number(exceeded!.threshold).toLocaleString(undefined, {
      maximumFractionDigits: 0,
    });
    const errorMessage = `Limit exceeded: ${exceeded!.metricType} usage (${fmt}) exceeds ${threshFmt} per ${exceeded!.period}`;
    expect(errorMessage).toContain('tokens');
    expect(errorMessage).toContain('per day');

    const error = new HttpException(
      { error: { message: errorMessage, type: 'rate_limit_exceeded', code: 'limit_exceeded' } },
      429,
    );
    expect(error.getStatus()).toBe(429);
  });

  it('token alert + block — email sent only once per period', async () => {
    const rule = makeRule({ metric_type: 'tokens', threshold: 50000, action: 'both' });
    mockGetActiveBlockRules.mockResolvedValue([rule]);
    mockGetConsumption.mockResolvedValue(62000);

    await limitCheckService.checkLimits(TENANT, AGENT);
    await new Promise((r) => setTimeout(r, 50));
    expect(mockSendThresholdAlert).toHaveBeenCalledTimes(1);

    mockHasAlreadySent.mockResolvedValue(true);
    const exceeded2 = await limitCheckService.checkLimits(TENANT, AGENT);
    await new Promise((r) => setTimeout(r, 50));

    expect(exceeded2).not.toBeNull();
    expect(mockSendThresholdAlert).toHaveBeenCalledTimes(1);
  });

  it('block — subsequent proxy calls are also blocked', async () => {
    const rule = makeRule({ metric_type: 'tokens', threshold: 50000, action: 'both' });
    mockGetActiveBlockRules.mockResolvedValue([rule]);
    mockGetConsumption.mockResolvedValue(62000);

    const first = await limitCheckService.checkLimits(TENANT, AGENT);
    expect(first).not.toBeNull();

    // Agent tries again — still blocked (consumption hasn't reset)
    const second = await limitCheckService.checkLimits(TENANT, AGENT);
    expect(second).not.toBeNull();
    expect(second!.ruleId).toBe('rule-1');
  });
});

/* ── 5: No alert defined ────────────────────────── */

describe('Alert scenarios — no rules defined', () => {
  let cronService: NotificationCronService;
  let limitCheckService: LimitCheckService;
  let mockGetAllActiveRules: jest.Mock;
  let mockGetActiveBlockRules: jest.Mock;
  let mockSendThresholdAlert: jest.Mock;

  beforeEach(async () => {
    mockGetAllActiveRules = jest.fn().mockResolvedValue([]);
    mockGetActiveBlockRules = jest.fn().mockResolvedValue([]);
    mockSendThresholdAlert = jest.fn().mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationCronService,
        {
          provide: NotificationRulesService,
          useValue: {
            getAllActiveRules: mockGetAllActiveRules,
            getActiveRulesForTenant: jest.fn().mockResolvedValue([]),
            getConsumption: jest.fn().mockResolvedValue(999999),
          },
        },
        {
          provide: NotificationEmailService,
          useValue: { sendThresholdAlert: mockSendThresholdAlert },
        },
        {
          provide: EmailProviderConfigService,
          useValue: { getFullConfig: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: NotificationLogService,
          useValue: {
            hasAlreadySent: jest.fn().mockResolvedValue(false),
            insertLog: jest.fn().mockResolvedValue(undefined),
            resolveRecipientEmail: jest.fn().mockResolvedValue(EMAIL),
          },
        },
        {
          provide: ManifestRuntimeService,
          useValue: {
            getAuthBaseUrl: jest.fn().mockReturnValue('http://localhost:3001'),
          },
        },
      ],
    }).compile();

    cronService = module.get(NotificationCronService);

    limitCheckService = new LimitCheckService(
      {
        getActiveBlockRules: mockGetActiveBlockRules,
        getConsumption: jest.fn().mockResolvedValue(999999),
      } as unknown as NotificationRulesService,
      {
        sendThresholdAlert: mockSendThresholdAlert,
      } as unknown as NotificationEmailService,
      {
        getFullConfig: jest.fn().mockResolvedValue(null),
      } as unknown as EmailProviderConfigService,
      {
        getAuthBaseUrl: jest.fn().mockReturnValue('http://localhost:3001'),
      } as unknown as ManifestRuntimeService,
      {
        hasAlreadySent: jest.fn().mockResolvedValue(false),
        insertLog: jest.fn().mockResolvedValue(undefined),
        resolveRecipientEmail: jest.fn().mockResolvedValue(EMAIL),
      } as unknown as NotificationLogService,
    );
  });

  it('no email is sent when no rules are defined', async () => {
    const triggered = await cronService.checkThresholds();
    expect(triggered).toBe(0);
    expect(mockSendThresholdAlert).not.toHaveBeenCalled();
  });

  it('no block occurs when no rules are defined', async () => {
    const result = await limitCheckService.checkLimits(TENANT, AGENT);
    expect(result).toBeNull();
    expect(mockSendThresholdAlert).not.toHaveBeenCalled();
  });
});
