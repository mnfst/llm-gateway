const ORIGINAL_ENCRYPTION_KEY = process.env['MANIFEST_ENCRYPTION_KEY'];
process.env['MANIFEST_ENCRYPTION_KEY'] ??= 'test-recording-secret-at-least-32-characters';
afterAll(() => {
  if (ORIGINAL_ENCRYPTION_KEY === undefined) delete process.env['MANIFEST_ENCRYPTION_KEY'];
  else process.env['MANIFEST_ENCRYPTION_KEY'] = ORIGINAL_ENCRYPTION_KEY;
});

import { decodeRequestRecording } from '../../common/utils/request-recording-codec';
import type { StoredAttemptRecording } from './attempt-recording.types';
import { AttemptRecordingService } from './attempt-recording.service';

describe('AttemptRecordingService', () => {
  const update = jest.fn().mockResolvedValue({ affected: 1 });
  const repository = { update };
  const storage = {
    backend: 'filesystem' as 'filesystem' | null,
    objectKey: jest.fn(
      (tenantId: string, requestId: string, attemptId: string) =>
        `request-recordings/v1/tenants/${tenantId}/requests/${requestId}/attempts/${attemptId}.json.gz`,
    ),
    put: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const service = new AttemptRecordingService(repository as never, storage as never);
  const payload: StoredAttemptRecording = {
    version: 1,
    wire_format: 'anthropic_messages',
    request_body: { messages: [{ role: 'user', content: 'hello' }] },
    response_body: { type: 'json', body: { output_text: 'hi' } },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    storage.backend = 'filesystem';
    storage.put.mockResolvedValue(undefined);
    storage.delete.mockResolvedValue(undefined);
    update.mockResolvedValue({ affected: 1 });
  });

  it('reports whether external recording storage is available', () => {
    expect(service.available).toBe(true);
    storage.backend = null;
    expect(service.available).toBe(false);
  });

  it('stores the payload externally and writes only its key to the Provider Attempt', async () => {
    await service.save('tenant-1', 'request-1', 'attempt-1', payload);

    const key =
      'request-recordings/v1/tenants/tenant-1/requests/request-1/attempts/attempt-1.json.gz';
    const encoded = storage.put.mock.calls[0][1] as Buffer;
    expect(storage.put).toHaveBeenCalledWith(key, expect.any(Buffer));
    await expect(decodeRequestRecording(encoded)).resolves.toEqual(payload);
    expect(update).toHaveBeenCalledWith(
      {
        id: 'attempt-1',
        tenant_id: 'tenant-1',
        request_id: 'request-1',
      },
      { recording_key: key },
    );
    expect(update.mock.calls[0]![1]).not.toHaveProperty('request_body');
    expect(update.mock.calls[0]![1]).not.toHaveProperty('response_body');
  });

  it('stores large recordings completely rather than truncating them', async () => {
    const largePayload: StoredAttemptRecording = {
      ...payload,
      request_body: { input: 'x'.repeat(2 * 1024 * 1024) },
    };

    await service.save('tenant-1', 'request-1', 'attempt-large', largePayload);

    await expect(decodeRequestRecording(storage.put.mock.calls[0][1] as Buffer)).resolves.toEqual(
      largePayload,
    );
  });

  it('does not update the attempt when object storage rejects the write', async () => {
    storage.put.mockRejectedValue(new Error('offline'));

    await expect(service.save('tenant-1', 'request-1', 'attempt-1', payload)).rejects.toThrow(
      'offline',
    );

    expect(update).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('deletes an orphaned object when the attempt pointer cannot be updated', async () => {
    update.mockResolvedValue({ affected: 0 });

    await expect(service.save('tenant-1', 'request-1', 'missing-attempt', payload)).rejects.toThrow(
      'no longer exists',
    );

    expect(storage.delete).toHaveBeenCalledWith(
      'request-recordings/v1/tenants/tenant-1/requests/request-1/attempts/missing-attempt.json.gz',
    );
  });
});
