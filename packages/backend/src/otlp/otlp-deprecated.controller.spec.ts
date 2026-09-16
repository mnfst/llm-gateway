import { Test, TestingModule } from '@nestjs/testing';
import { OtlpDeprecatedController } from './otlp-deprecated.controller';

describe('OtlpDeprecatedController', () => {
  let controller: OtlpDeprecatedController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OtlpDeprecatedController],
    }).compile();
    controller = module.get(OtlpDeprecatedController);
  });

  const expectedResponse = {
    error: {
      message:
        'OTLP telemetry endpoints have been removed. ' +
        'Use the routing proxy at /v1/chat/completions instead. ' +
        'See https://manifest.build/docs/migration for details.',
      type: 'gone',
      status: 410,
    },
  };

  describe('traces', () => {
    it('returns HTTP 410 Gone with migration message', () => {
      const result = controller.traces();
      expect(result).toEqual(expectedResponse);
    });

    it('includes the routing proxy path in the error message', () => {
      const result = controller.traces();
      expect(result.error.message).toContain('/v1/chat/completions');
    });

    it('includes the migration docs URL', () => {
      const result = controller.traces();
      expect(result.error.message).toContain('https://manifest.build/docs/migration');
    });
  });

  describe('metrics', () => {
    it('returns HTTP 410 Gone with full error shape', () => {
      const result = controller.metrics();
      expect(result).toEqual(expectedResponse);
    });

    it('has error type "gone"', () => {
      const result = controller.metrics();
      expect(result.error.type).toBe('gone');
    });
  });

  describe('logs', () => {
    it('returns HTTP 410 Gone with full error shape', () => {
      const result = controller.logs();
      expect(result).toEqual(expectedResponse);
    });

    it('has error type "gone"', () => {
      const result = controller.logs();
      expect(result.error.type).toBe('gone');
    });
  });

  it('all three endpoints return the exact same response object', () => {
    const traces = controller.traces();
    const metrics = controller.metrics();
    const logs = controller.logs();
    expect(traces).toBe(metrics);
    expect(metrics).toBe(logs);
  });

  describe('misrouted OTLP variants', () => {
    const expectedGone = {
      error: expect.objectContaining({
        type: 'gone',
        status: 410,
        message: expect.stringContaining('/v1/chat/completions'),
      }),
    };

    it('misroutedTraces returns 410 with migration message', () => {
      expect(controller.misroutedTraces()).toEqual(expectedGone);
    });

    it('misroutedMetrics returns 410 with migration message', () => {
      expect(controller.misroutedMetrics()).toEqual(expectedGone);
    });

    it('misroutedLogs returns 410 with migration message', () => {
      expect(controller.misroutedLogs()).toEqual(expectedGone);
    });

    it('strippedMetrics returns 410 with migration message', () => {
      expect(controller.strippedMetrics()).toEqual(expectedGone);
    });

    it('strippedTraces returns 410 with migration message', () => {
      expect(controller.strippedTraces()).toEqual(expectedGone);
    });

    it('strippedLogs returns 410 with migration message', () => {
      expect(controller.strippedLogs()).toEqual(expectedGone);
    });
  });

  describe('wrong chat completions path', () => {
    it('returns 404 with redirect hint', () => {
      const result = controller.wrongChatPath();
      expect(result.error.status).toBe(404);
      expect(result.error.message).toContain('/v1/chat/completions');
    });

    it('has invalid_request_error type', () => {
      const result = controller.wrongChatPath();
      expect(result.error.type).toBe('invalid_request_error');
    });

    it('includes the correct baseURL hint', () => {
      const result = controller.wrongChatPath();
      expect(result.error.message).toContain('https://app.manifest.build/v1');
    });
  });
});
