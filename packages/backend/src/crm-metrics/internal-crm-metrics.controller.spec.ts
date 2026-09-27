import {
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { InternalCrmMetricsController } from './internal-crm-metrics.controller';
import type { CrmMetricsService } from './crm-metrics.service';
import { isSelfHosted } from '../common/utils/detect-self-hosted';

jest.mock('../common/utils/detect-self-hosted', () => ({ isSelfHosted: jest.fn() }));
const mockedIsSelfHosted = jest.mocked(isSelfHosted);

const SECRET = 'a'.repeat(32);
const IP = '203.0.113.7';

function makeConfig(secret: string | undefined): ConfigService {
  return {
    get: jest.fn((key: string) => (key === 'app.crmMetricsSecret' ? secret : undefined)),
  } as unknown as ConfigService;
}

describe('InternalCrmMetricsController', () => {
  let mockService: {
    getHealedCohort: jest.Mock;
    getConversions: jest.Mock;
    getCorporateSignups: jest.Mock;
  };
  let warn: jest.SpyInstance;

  beforeEach(() => {
    mockService = {
      getHealedCohort: jest.fn(),
      getConversions: jest.fn(),
      getCorporateSignups: jest.fn(),
    };
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    mockedIsSelfHosted.mockReturnValue(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeController(secret: string | undefined): InternalCrmMetricsController {
    return new InternalCrmMetricsController(
      mockService as unknown as CrmMetricsService,
      makeConfig(secret),
    );
  }

  describe('secret rejection', () => {
    it('rejects when the header is missing', async () => {
      const controller = makeController(SECRET);

      await expect(
        controller.cohort(undefined as unknown as string, IP, {}),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mockService.getHealedCohort).not.toHaveBeenCalled();
    });

    it('rejects when the header is wrong', async () => {
      const controller = makeController(SECRET);

      await expect(controller.cohort('b'.repeat(32), IP, {})).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(mockService.getHealedCohort).not.toHaveBeenCalled();
    });

    it('rejects when the header is the right value but the wrong length', async () => {
      const controller = makeController(SECRET);

      await expect(controller.cohort('a'.repeat(31), IP, {})).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(mockService.getHealedCohort).not.toHaveBeenCalled();
    });

    it('leaks neither the configured nor the provided secret when it rejects', async () => {
      // Same length on both sides, so the constant-time compare runs rather
      // than the length shortcut.
      const configured = 'configured-secret'.padEnd(40, 'x');
      const provided = 'provided-secret'.padEnd(40, 'y');

      const error = await makeController(configured)
        .cohort(provided, IP, {})
        .then(
          () => null,
          (thrown: unknown) => thrown as UnauthorizedException,
        );

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(error?.message).toBe('Invalid or missing internal secret');
      const surfaced = `${error?.message} ${JSON.stringify(error?.getResponse())}`;
      expect(surfaced).not.toContain(configured);
      expect(surfaced).not.toContain(provided);
      // The rejection log is the other place a secret could end up.
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain(configured);
      expect(logged).not.toContain(provided);
    });

    it('rejects when no secret is configured', async () => {
      await expect(makeController(undefined).cohort('anything', IP, {})).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      await expect(makeController('').cohort('', IP, {})).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(mockService.getHealedCohort).not.toHaveBeenCalled();
    });

    it('treats a secret shorter than 32 chars as unconfigured, even on an exact match', async () => {
      const weak = 'short-secret';

      await expect(makeController(weak).cohort(weak, IP, {})).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('guards the conversions route too', async () => {
      const controller = makeController(SECRET);

      await expect(controller.conversions('nope', IP, {})).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(mockService.getConversions).not.toHaveBeenCalled();
    });

    it('guards the signups route too', async () => {
      const controller = makeController(SECRET);

      await expect(controller.signups('nope', IP, {})).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(mockService.getCorporateSignups).not.toHaveBeenCalled();
    });

    it('logs the source ip of a rejected attempt', async () => {
      await expect(makeController(SECRET).cohort('nope', IP, {})).rejects.toThrow();

      expect(warn).toHaveBeenCalledWith(`Rejected CRM metrics request from ${IP}`);
    });
  });

  describe('cohort', () => {
    it('defaults to a 7 day window', async () => {
      const users = [{ email: 'a@b.com' }];
      mockService.getHealedCohort.mockResolvedValue(users);

      const result = await makeController(SECRET).cohort(SECRET, IP, {});

      expect(result).toBe(users);
      expect(mockService.getHealedCohort).toHaveBeenCalledWith(7);
    });

    it('passes an explicit window through', async () => {
      mockService.getHealedCohort.mockResolvedValue([]);

      await makeController(SECRET).cohort(SECRET, IP, { days: 30 });

      expect(mockService.getHealedCohort).toHaveBeenCalledWith(30);
    });

    it('propagates an unavailable index instead of answering with an empty cohort', async () => {
      mockService.getHealedCohort.mockRejectedValue(
        new ServiceUnavailableException('IDX_requests_autofix_healed is missing or invalid'),
      );

      // A 503 is the signal the CRM needs to keep yesterday's list; a 200 with
      // `[]` reads as "nobody was healed today".
      await expect(makeController(SECRET).cohort(SECRET, IP, {})).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe('signups', () => {
    it('defaults to the full 365 day history', async () => {
      const signups = [{ email: 'ada@stripe.com' }];
      mockService.getCorporateSignups.mockResolvedValue(signups);

      const result = await makeController(SECRET).signups(SECRET, IP, {});

      expect(result).toBe(signups);
      expect(mockService.getCorporateSignups).toHaveBeenCalledWith(365);
    });

    it('passes an explicit window through', async () => {
      mockService.getCorporateSignups.mockResolvedValue([]);

      await makeController(SECRET).signups(SECRET, IP, { days: 30 });

      expect(mockService.getCorporateSignups).toHaveBeenCalledWith(30);
    });

    it('propagates an unavailable index instead of answering with an empty list', async () => {
      mockService.getCorporateSignups.mockRejectedValue(
        new ServiceUnavailableException('IDX_requests_tenant_timestamp is missing or invalid'),
      );

      await expect(makeController(SECRET).signups(SECRET, IP, {})).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe('conversions', () => {
    it('defaults to a 90 day window', async () => {
      const claims = [{ email: 'a@b.com', source: 'cloud', claimed_at: 'x' }];
      mockService.getConversions.mockResolvedValue(claims);

      const result = await makeController(SECRET).conversions(SECRET, IP, {});

      expect(result).toBe(claims);
      expect(mockService.getConversions).toHaveBeenCalledWith(90);
    });

    it('passes an explicit window through', async () => {
      mockService.getConversions.mockResolvedValue([]);

      await makeController(SECRET).conversions(SECRET, IP, { days: 14 });

      expect(mockService.getConversions).toHaveBeenCalledWith(14);
    });
  });

  describe('self-hosted', () => {
    // app.module.ts normally leaves the module unregistered, but that check
    // runs before ConfigModule loads `.env`. This one resolves at construction,
    // so a bare-metal install carrying MANIFEST_MODE only in `.env` is covered.
    it('answers like an unmounted route on both endpoints', async () => {
      mockedIsSelfHosted.mockReturnValue(true);
      const controller = makeController(SECRET);

      await expect(controller.cohort(SECRET, IP, {})).rejects.toBeInstanceOf(NotFoundException);
      await expect(controller.conversions(SECRET, IP, {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(controller.signups(SECRET, IP, {})).rejects.toBeInstanceOf(NotFoundException);
      expect(mockService.getHealedCohort).not.toHaveBeenCalled();
      expect(mockService.getConversions).not.toHaveBeenCalled();
      expect(mockService.getCorporateSignups).not.toHaveBeenCalled();
    });

    it('checks the mode before the secret, so it never reveals whether one is set', async () => {
      mockedIsSelfHosted.mockReturnValue(true);

      // No secret configured at all: a Cloud install would answer 401 here.
      await expect(makeController(undefined).cohort('anything', IP, {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it('resolves the mode once, at construction', async () => {
      mockedIsSelfHosted.mockReturnValue(false);
      const controller = makeController(SECRET);
      mockService.getHealedCohort.mockResolvedValue([]);
      const callsAfterConstruction = mockedIsSelfHosted.mock.calls.length;
      mockedIsSelfHosted.mockReturnValue(true);

      // A later flip must not change an already-built controller's behaviour,
      // and serving a request must not re-read the mode.
      await expect(controller.cohort(SECRET, IP, {})).resolves.toEqual([]);
      expect(mockedIsSelfHosted.mock.calls).toHaveLength(callsAfterConstruction);
    });
  });
});
