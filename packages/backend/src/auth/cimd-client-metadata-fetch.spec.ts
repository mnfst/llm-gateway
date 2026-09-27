import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { fetchClientMetadataResource } from './cimd-client-metadata-fetch';

jest.mock('@better-auth/core/utils/host', () => ({
  isPublicRoutableHost: jest.fn(() => true),
}));
jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('node:https', () => ({ request: jest.fn() }));

const { isPublicRoutableHost } = jest.requireMock('@better-auth/core/utils/host') as {
  isPublicRoutableHost: jest.Mock;
};
const { lookup } = jest.requireMock('node:dns/promises') as { lookup: jest.Mock };
const { request } = jest.requireMock('node:https') as { request: jest.Mock };

function fakeRequest(
  cb: (response: Readable & { statusCode: number; headers: Record<string, string> }) => void,
  statusCode = 200,
  body = '{"ok":true}',
) {
  const req = new EventEmitter() as EventEmitter & { end: jest.Mock; destroy: jest.Mock };
  req.end = jest.fn();
  req.destroy = jest.fn((err: Error) => req.emit('error', err));
  process.nextTick(() => {
    const stream = Readable.from([Buffer.from(body)]) as Readable & {
      statusCode: number;
      headers: Record<string, string>;
      statusMessage?: string;
    };
    stream.statusCode = statusCode;
    stream.headers = { 'content-type': 'application/json' };
    cb(stream);
  });
  return req;
}

describe('fetchClientMetadataResource', () => {
  beforeEach(() => {
    isPublicRoutableHost.mockReturnValue(true);
    lookup.mockReset();
    request.mockReset();
  });

  it('fetches and returns a metadata document', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    let captured: { lookup: (...a: unknown[]) => void } | undefined;
    request.mockImplementation((_url, opts, cb) => {
      captured = opts as { lookup: (...a: unknown[]) => void };
      return fakeRequest(cb);
    });
    const response = await fetchClientMetadataResource('https://example.com/meta');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');

    // The pinned lookup must return the validated address for both the
    // all-addresses and single-address forms Node may ask for.
    const all = jest.fn();
    captured!.lookup('example.com', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
    const single = jest.fn();
    captured!.lookup('example.com', {}, single);
    expect(single).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });

  it('discards the body for a 204', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    request.mockImplementation((_url, _opts, cb) => fakeRequest(cb, 204, ''));
    const response = await fetchClientMetadataResource('https://example.com/meta');
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('rejects a non-https URL and a non-GET method before any network call', async () => {
    await expect(fetchClientMetadataResource('http://example.com/meta')).rejects.toThrow(/HTTPS/);
    await expect(
      fetchClientMetadataResource('https://example.com/meta', { method: 'POST' }),
    ).rejects.toThrow(/GET and HEAD/);
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects when DNS returns no addresses or a private one', async () => {
    lookup.mockResolvedValueOnce([]);
    await expect(fetchClientMetadataResource('https://example.com/meta')).rejects.toThrow(
      /no DNS addresses/,
    );

    lookup.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    isPublicRoutableHost.mockReturnValueOnce(false);
    await expect(fetchClientMetadataResource('https://example.com/meta')).rejects.toThrow(
      /public-routable/,
    );
  });

  it('rejects on request error', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    request.mockImplementation(() => {
      const req = new EventEmitter() as EventEmitter & { end: jest.Mock; destroy: jest.Mock };
      req.end = jest.fn();
      req.destroy = jest.fn();
      process.nextTick(() => req.emit('error', new Error('network down')));
      return req;
    });
    await expect(fetchClientMetadataResource('https://example.com/meta')).rejects.toThrow(
      /network down/,
    );
  });

  it('rejects on a stalled socket timeout', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    request.mockImplementation(() => {
      const req = new EventEmitter() as EventEmitter & { end: jest.Mock; destroy: jest.Mock };
      req.end = jest.fn();
      req.destroy = jest.fn((err: Error) => req.emit('error', err));
      process.nextTick(() => req.emit('timeout'));
      return req;
    });
    await expect(fetchClientMetadataResource('https://example.com/meta')).rejects.toThrow(
      /timed out/,
    );
  });

  it('flattens array response headers and accepts an IPv6-only resolution', async () => {
    lookup.mockResolvedValue([{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }]);
    request.mockImplementation((_url, _opts, cb) => {
      const req = new EventEmitter() as EventEmitter & { end: jest.Mock; destroy: jest.Mock };
      req.end = jest.fn();
      req.destroy = jest.fn();
      process.nextTick(() => {
        const stream = Readable.from([Buffer.from('{}')]) as Readable & {
          statusCode: number;
          headers: Record<string, string | string[]>;
        };
        stream.statusCode = 200;
        stream.headers = { 'x-multi': ['a', 'b'], 'x-one': 'c' };
        cb(stream as never);
      });
      return req;
    });
    const response = await fetchClientMetadataResource('https://example.com/meta');
    expect(response.headers.get('x-multi')).toBe('a, b');
    expect(response.headers.get('x-one')).toBe('c');
  });

  it('rejects an out-of-range HTTP status instead of throwing', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    request.mockImplementation((_url, _opts, cb) => fakeRequest(cb, 700, ''));
    await expect(fetchClientMetadataResource('https://example.com/meta')).rejects.toThrow(
      /invalid HTTP status/,
    );
  });

  it('rejects a malformed status line instead of throwing', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    request.mockImplementation((_url, _opts, cb) => {
      const req = new EventEmitter() as EventEmitter & { end: jest.Mock; destroy: jest.Mock };
      req.end = jest.fn();
      req.destroy = jest.fn();
      process.nextTick(() => {
        const stream = Readable.from([Buffer.from('{}')]) as Readable & {
          statusCode: number;
          statusMessage: string;
          headers: Record<string, string>;
        };
        stream.statusCode = 200;
        stream.statusMessage = 'bad\nvalue';
        stream.headers = {};
        cb(stream as never);
      });
      return req;
    });
    await expect(fetchClientMetadataResource('https://example.com/meta')).rejects.toThrow(
      /Invalid statusText/,
    );
  });

  it('answers a HEAD probe with no body', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    request.mockImplementation((_url, _opts, cb) => fakeRequest(cb, 200, '{"a":1}'));
    const response = await fetchClientMetadataResource('https://example.com/meta', {
      method: 'HEAD',
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it('allows a private host in self-hosted mode regardless of the public gate', async () => {
    const previous = process.env['MANIFEST_MODE'];
    process.env['MANIFEST_MODE'] = 'selfhosted';
    try {
      isPublicRoutableHost.mockReturnValue(false);
      lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
      request.mockImplementation((_url, _opts, cb) => fakeRequest(cb));
      expect((await fetchClientMetadataResource('https://lan.local/meta')).status).toBe(200);

      // A host.containers.internal-style link-local address is allowed too.
      lookup.mockResolvedValue([{ address: '169.254.1.2', family: 4 }]);
      expect((await fetchClientMetadataResource('https://lan.local/meta')).status).toBe(200);
    } finally {
      if (previous === undefined) delete process.env['MANIFEST_MODE'];
      else process.env['MANIFEST_MODE'] = previous;
    }
  });

  it('blocks cloud-metadata addresses even in self-hosted mode', async () => {
    const previous = process.env['MANIFEST_MODE'];
    process.env['MANIFEST_MODE'] = 'selfhosted';
    try {
      lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
      await expect(fetchClientMetadataResource('https://lan.local/meta')).rejects.toThrow(
        /cloud metadata/,
      );

      // Alibaba/OCI IMDS, covered by the shared classifier.
      lookup.mockResolvedValue([{ address: '100.100.100.200', family: 4 }]);
      await expect(fetchClientMetadataResource('https://lan.local/meta')).rejects.toThrow(
        /cloud metadata/,
      );
    } finally {
      if (previous === undefined) delete process.env['MANIFEST_MODE'];
      else process.env['MANIFEST_MODE'] = previous;
    }
  });

  it('blocks a private host in cloud mode', async () => {
    const previous = process.env['MANIFEST_MODE'];
    process.env['MANIFEST_MODE'] = 'cloud';
    try {
      lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
      isPublicRoutableHost.mockReturnValueOnce(false);
      await expect(fetchClientMetadataResource('https://lan.local/meta')).rejects.toThrow(
        /public-routable/,
      );
    } finally {
      if (previous === undefined) delete process.env['MANIFEST_MODE'];
      else process.env['MANIFEST_MODE'] = previous;
    }
  });

  it('rejects a direct IP literal', async () => {
    await expect(fetchClientMetadataResource('https://127.0.0.1/meta')).rejects.toThrow(
      /IP literal/,
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it('lets a self-hosted lookup failure fall through to the request resolver', async () => {
    const previous = process.env['MANIFEST_MODE'];
    process.env['MANIFEST_MODE'] = 'selfhosted';
    try {
      lookup.mockRejectedValue(new Error('ENOTFOUND'));
      request.mockImplementation((_url, opts, cb) => {
        expect((opts as { lookup?: unknown }).lookup).toBeUndefined();
        return fakeRequest(cb);
      });
      expect((await fetchClientMetadataResource('https://lan.local/meta')).status).toBe(200);
    } finally {
      if (previous === undefined) delete process.env['MANIFEST_MODE'];
      else process.env['MANIFEST_MODE'] = previous;
    }
  });

  it('rejects a protocol upgrade and destroys its socket', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const socket = { destroy: jest.fn() };
    request.mockImplementation(() => {
      const req = new EventEmitter() as EventEmitter & { end: jest.Mock; destroy: jest.Mock };
      req.end = jest.fn();
      req.destroy = jest.fn();
      process.nextTick(() => req.emit('upgrade', {}, socket));
      return req;
    });
    await expect(fetchClientMetadataResource('https://example.com/meta')).rejects.toThrow(
      /upgrade/,
    );
    expect(socket.destroy).toHaveBeenCalled();
  });
});
