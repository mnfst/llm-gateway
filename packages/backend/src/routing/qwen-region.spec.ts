import {
  detectQwenRegion,
  getQwenCompatibleBaseUrl,
  isQwenRegion,
  isQwenResolvedRegion,
  normalizeQwenCompatibleBaseUrl,
} from './qwen-region';

describe('qwen-region', () => {
  it('recognizes valid qwen regions', () => {
    expect(isQwenRegion('auto')).toBe(true);
    expect(isQwenRegion('singapore')).toBe(true);
    expect(isQwenRegion('us')).toBe(true);
    expect(isQwenRegion('beijing')).toBe(true);
    expect(
      isQwenRegion('https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode/v1'),
    ).toBe(true);
    expect(isQwenRegion('moon')).toBe(false);
  });

  it('recognizes resolved qwen regions only', () => {
    expect(isQwenResolvedRegion('singapore')).toBe(true);
    expect(isQwenResolvedRegion('us')).toBe(true);
    expect(isQwenResolvedRegion('beijing')).toBe(true);
    expect(isQwenResolvedRegion('auto')).toBe(false);
  });

  it('returns the correct compatible-mode base url', () => {
    expect(getQwenCompatibleBaseUrl('singapore')).toBe(
      'https://dashscope-intl.aliyuncs.com/compatible-mode',
    );
    expect(getQwenCompatibleBaseUrl('us')).toBe(
      'https://dashscope-us.aliyuncs.com/compatible-mode',
    );
    expect(getQwenCompatibleBaseUrl('beijing')).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode',
    );
    expect(
      getQwenCompatibleBaseUrl(
        'https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode/v1',
      ),
    ).toBe('https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode');
  });

  it('defaults to Beijing when region is unset', () => {
    expect(getQwenCompatibleBaseUrl()).toBe('https://dashscope.aliyuncs.com/compatible-mode');
    expect(getQwenCompatibleBaseUrl(null)).toBe('https://dashscope.aliyuncs.com/compatible-mode');
  });

  it('normalizes and validates allowed qwen base urls', () => {
    expect(
      normalizeQwenCompatibleBaseUrl('https://dashscope-intl.aliyuncs.com/compatible-mode/'),
    ).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode');
    expect(
      normalizeQwenCompatibleBaseUrl(
        'https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/',
      ),
    ).toBe('https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode');
    expect(normalizeQwenCompatibleBaseUrl('https://example.com/compatible-mode')).toBeNull();
    expect(
      normalizeQwenCompatibleBaseUrl(
        'https://workspace-123.eu-central-1.maas.aliyuncs.com.evil.test/compatible-mode',
      ),
    ).toBeNull();
    expect(
      normalizeQwenCompatibleBaseUrl(
        'https://workspace-123.eu-west-3.maas.aliyuncs.com/compatible-mode',
      ),
    ).toBeNull();
  });

  it('accepts Alibaba workspace endpoints in every supported region code', () => {
    for (const regionCode of [
      'cn-beijing',
      'ap-southeast-1',
      'ap-northeast-1',
      'cn-hongkong',
      'eu-central-1',
    ]) {
      expect(
        normalizeQwenCompatibleBaseUrl(
          `https://workspace-123.${regionCode}.maas.aliyuncs.com/compatible-mode/v1`,
        ),
      ).toBe(`https://workspace-123.${regionCode}.maas.aliyuncs.com/compatible-mode`);
    }
  });

  it('rejects malformed Alibaba workspace base urls', () => {
    const invalidUrls = [
      'http://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode',
      'https://user@workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode',
      'https://workspace-123.eu-central-1.maas.aliyuncs.com:8443/compatible-mode',
      'https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode?x=1',
      'https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode#models',
      'https://workspace-123.eu-central-1.maas.aliyuncs.com/not-compatible-mode',
      'https://work_space.eu-central-1.maas.aliyuncs.com/compatible-mode',
      'https://workspace-123.eu-central-1.mars.aliyuncs.com/compatible-mode',
      'https://workspace-123.eu-central-1.maas.aliyuncs.net/compatible-mode',
    ];

    for (const invalidUrl of invalidUrls) {
      expect(normalizeQwenCompatibleBaseUrl(invalidUrl)).toBeNull();
    }
  });

  it('detects the first region whose models endpoint succeeds', async () => {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const region = await detectQwenRegion('sk-test', fetchMock as typeof fetch);

    expect(region).toBe('us');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer sk-test' },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://dashscope-us.aliyuncs.com/compatible-mode/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer sk-test' },
      }),
    );
  });

  it('returns null when no regional endpoint succeeds', async () => {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(new Response('{}', { status: 401 }));

    await expect(detectQwenRegion('sk-test', fetchMock as typeof fetch)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('continues probing when a region request throws', async () => {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await expect(detectQwenRegion('sk-test', fetchMock as typeof fetch)).resolves.toBe('us');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
