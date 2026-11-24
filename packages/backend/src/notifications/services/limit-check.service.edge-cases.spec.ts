/**
 * Edge-case tests for LimitCheckService — complements limit-check.service.spec.ts.
 *
 * Covers:
 *   1. Concurrent invocations (double-submit race in dedup logic)
 *   2. insertLog() failure leaving the dedup guard unset
 *   3. Graceful degradation when resolveUserEmail returns null
 *   4. Very large numeric consumption values (overflow / precision)
 *
 * Split out from limit-check.service.spec.ts to keep each file under the 300-line cap.
 */
import { LimitCheckService } from './limit-check.service';
import { NotificationRulesService } from './notification-rules.service';
import { NotificationEmailService } from './notification-email.service';
import { EmailProviderConfigService } from './email-provider-config.service';
import { NotificationLogService } from './notification-log.service';
import { ManifestRuntimeService } from '../../common/services/manifest-runtime.service';

const TENANT = 'tenant-1';
const AGENT = 'my-agent';

const BLOCK_RULE = {
  id: 'r1',
  tenant_id: TENANT,
  agent_name: AGENT,
  metric_type: 'tokens' as const,
  threshold: 50000,
  period: 'day' as const,
};

describe('LimitCheckService — edge cases', () => {
  let service: LimitCheckService;
  let mockGetActiveBlockRules: jest.Mock;
  let mockGetConsumption: jest.Mock;
  let mockSendThresholdAlert: jest.Mock;
  let mockGetFullConfig: jest.Mock;
  let mockHasAlreadySent: jest.Mock;
  let mockInsertLog: jest.Mock;
  let mockResolveRecipientEmail: jest.Mock;

  beforeEach(() => {
    mockGetActiveBlockRules = jest.fn().mockResolvedValue([BLOCK_RULE]);
    mockGetConsumption = jest.fn().mockResolvedValue(60000);

    const rulesService = {
      getActiveBlockRules: mockGetActiveBlockRules,
      getConsumption: mockGetConsumption,
    } as unknown as NotificationRulesService;

    mockSendThresholdAlert = jest.fn().mockResolvedValue(true);
    const emailService = {
      sendThresholdAlert: mockSendThresholdAlert,
    } as unknown as NotificationEmailService;

    mockGetFullConfig = jest.fn().mockResolvedValue(null);
    const emailProviderConfig = {
      getFullConfig: mockGetFullConfig,
    } as unknown as EmailProviderConfigService;

    const runtime = {
      getAuthBaseUrl: jest.fn().mockReturnValue('http://localhost:3001'),
    } as unknown as ManifestRuntimeService;

    mockHasAlreadySent = jest.fn().mockResolvedValue(false);
    mockInsertLog = jest.fn().mockResolvedValue(undefined);
    mockResolveRecipientEmail = jest.fn().mockResolvedValue(null);
    const notificationLog = {
      hasAlreadySent: mockHasAlreadySent,
      insertLog: mockInsertLog,
      resolveRecipientEmail: mockResolveRecipientEmail,
    } as unknown as NotificationLogService;

    service = new LimitCheckService(
      rulesService,
      emailService,
      emailProviderConfig,
      runtime,
      notificationLog,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /* ── 1. Concurrent double-submit race ────────────────────────── */

  describe('email notification on block — concurrency', () => {
    it('handles concurrent requests without crashing (race demonstrates dedup gap)', async () => {
      mockResolveRecipientEmail.mockResolvedValue('test@example.com');

      // Fire two concurrent checks before either has resolved insertLog.
      const [a, b] = await Promise.all([
        service.checkLimits(TENANT, AGENT),
        service.checkLimits(TENANT, AGENT),
      ]);
      await new Promise((r) => setTimeout(r, 100));

      // Both calls observe the limit exceeded.
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a!.ruleId).toBe('r1');
      expect(b!.ruleId).toBe('r1');

      // Both pass the dedup check because neither write has committed yet.
      // This pins the documented race: without a transaction or ON CONFLICT
      // guard, both branches call insertLog + sendThresholdAlert.
      expect(mockHasAlreadySent).toHaveBeenCalledTimes(2);
      expect(mockInsertLog).toHaveBeenCalledTimes(2);
      expect(mockSendThresholdAlert).toHaveBeenCalledTimes(2);
    });

    it('subsequent invocation after committed log is deduped', async () => {
      mockResolveRecipientEmail.mockResolvedValue('test@example.com');

      await service.checkLimits(TENANT, AGENT);
      await new Promise((r) => setTimeout(r, 50));
      expect(mockSendThresholdAlert).toHaveBeenCalledTimes(1);

      // Once the log row is persisted, the next call must short-circuit.
      mockHasAlreadySent.mockResolvedValue(true);
      await service.checkLimits(TENANT, AGENT);
      await new Promise((r) => setTimeout(r, 50));

      expect(mockSendThresholdAlert).toHaveBeenCalledTimes(1);
      expect(mockInsertLog).toHaveBeenCalledTimes(1);
    });
  });

  /* ── 2. insertLog failure → dedup guard not updated ──────────── */

  describe('email notification on block — insertLog failure', () => {
    it('re-evaluates rule on next invocation if insertLog throws', async () => {
      // Silence the error logger so the test output stays clean.
      const loggerSpy = jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

      mockResolveRecipientEmail.mockResolvedValue('test@example.com');

      // First call: insertLog fails.
      mockInsertLog.mockRejectedValueOnce(new Error('DB connection lost'));
      await service.checkLimits(TENANT, AGENT);
      await new Promise((r) => setTimeout(r, 50));

      // insertLog was attempted once and failed.
      expect(mockInsertLog).toHaveBeenCalledTimes(1);
      // Dedup guard was consulted once.
      expect(mockHasAlreadySent).toHaveBeenCalledTimes(1);
      // No alert email since insertLog throws before sendThresholdAlert.
      expect(mockSendThresholdAlert).not.toHaveBeenCalled();
      // Error was surfaced via the logger.
      expect(loggerSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to send block notification for rule r1'),
      );

      // Second call: insertLog succeeds.
      mockInsertLog.mockResolvedValueOnce(undefined);
      mockHasAlreadySent.mockResolvedValueOnce(false);
      await service.checkLimits(TENANT, AGENT);
      await new Promise((r) => setTimeout(r, 50));

      // Both insertLog attempts were made (one fail, one succeed).
      expect(mockInsertLog).toHaveBeenCalledTimes(2);
      // Rule was re-evaluated: hasAlreadySent called twice total.
      expect(mockHasAlreadySent).toHaveBeenCalledTimes(2);
      // Second attempt makes it to the email send.
      expect(mockSendThresholdAlert).toHaveBeenCalledTimes(1);
    });
  });

  /* ── 3. Graceful degradation: config exists but email is null ── */

  describe('email notification on block — null email fallback', () => {
    it('skips email but still logs when notificationEmail is null and user has no email', async () => {
      // Provider config exists but provides no override.
      mockGetFullConfig.mockResolvedValue({
        provider: 'resend',
        apiKey: 'key',
        notificationEmail: null,
      });
      // User row exists but has no email either.
      mockResolveRecipientEmail.mockResolvedValue(null);

      const result = await service.checkLimits(TENANT, AGENT);
      await new Promise((r) => setTimeout(r, 50));

      // Rule still triggers the block.
      expect(result).not.toBeNull();

      // No email was sent — nothing to send to.
      expect(mockSendThresholdAlert).not.toHaveBeenCalled();

      // But the log row IS recorded so we don't retry every cron tick.
      expect(mockInsertLog).toHaveBeenCalledTimes(1);
      expect(mockInsertLog).toHaveBeenCalledWith(
        expect.objectContaining({
          ruleId: 'r1',
          actualValue: 60000,
          thresholdValue: 50000,
          metricType: 'tokens',
          agentName: AGENT,
        }),
      );

      // resolveUserEmail was invoked with the null override, exercising the
      // full fallback path inside notification-log.service.
      expect(mockResolveRecipientEmail).toHaveBeenCalledWith(TENANT, null);
    });
  });

  /* ── 4. Very large numeric consumption values ────────────────── */

  describe('numeric edge cases for consumption / threshold comparison', () => {
    it('handles MAX_SAFE_INTEGER consumption against finite threshold', async () => {
      mockGetConsumption.mockResolvedValue(Number.MAX_SAFE_INTEGER);
      mockResolveRecipientEmail.mockResolvedValue('test@example.com');

      const result = await service.checkLimits(TENANT, AGENT);

      expect(result).not.toBeNull();
      expect(result!.actual).toBe(Number.MAX_SAFE_INTEGER);
      expect(result!.threshold).toBe(50000);
      // Comparison is well-defined for safe integers.
      expect(result!.actual >= result!.threshold).toBe(true);
    });

    it('handles 999_999_999 tokens without precision loss', async () => {
      mockGetActiveBlockRules.mockResolvedValue([{ ...BLOCK_RULE, threshold: 999_999_999 }]);
      mockGetConsumption.mockResolvedValue(999_999_999);
      mockResolveRecipientEmail.mockResolvedValue('test@example.com');

      const result = await service.checkLimits(TENANT, AGENT);
      await new Promise((r) => setTimeout(r, 50));

      expect(result).not.toBeNull();
      expect(result!.actual).toBe(999_999_999);
      expect(result!.threshold).toBe(999_999_999);
      expect(mockSendThresholdAlert).toHaveBeenCalledWith(
        'test@example.com',
        expect.objectContaining({
          actualValue: 999_999_999,
          threshold: 999_999_999,
        }),
        undefined,
      );
    });

    it('handles very large cost values (999999.99) without precision loss', async () => {
      const costRule = {
        ...BLOCK_RULE,
        metric_type: 'cost' as const,
        threshold: 999_999.99,
        period: 'month' as const,
      };
      mockGetActiveBlockRules.mockResolvedValue([costRule]);
      mockGetConsumption.mockResolvedValue(999_999.99);
      mockResolveRecipientEmail.mockResolvedValue('test@example.com');

      const result = await service.checkLimits(TENANT, AGENT);

      expect(result).not.toBeNull();
      expect(result!.metricType).toBe('cost');
      expect(result!.actual).toBe(999_999.99);
      expect(result!.threshold).toBe(999_999.99);
      expect(result!.period).toBe('month');
    });

    it('does not trigger when consumption is just below threshold (boundary)', async () => {
      mockGetActiveBlockRules.mockResolvedValue([
        { ...BLOCK_RULE, threshold: Number.MAX_SAFE_INTEGER },
      ]);
      mockGetConsumption.mockResolvedValue(Number.MAX_SAFE_INTEGER - 1);

      const result = await service.checkLimits(TENANT, AGENT);
      await new Promise((r) => setTimeout(r, 50));

      expect(result).toBeNull();
      expect(mockSendThresholdAlert).not.toHaveBeenCalled();
      expect(mockInsertLog).not.toHaveBeenCalled();
    });
  });
});
