import { OPENCODE_GO_BUDGET_5H_USD, OpencodeGoCatalogService } from './opencode-go-catalog.service';

const BT = String.fromCharCode(96);
const OAI = BT + 'https://opencode.ai/zen/go/v1/chat/completions' + BT;
const ANT = BT + 'https://opencode.ai/zen/go/v1/messages' + BT;
const RESP = BT + 'https://opencode.ai/zen/go/v1/responses' + BT;
const OAI_SDK = BT + '@ai-sdk/openai-compatible' + BT;
const ANT_SDK = BT + '@ai-sdk/anthropic' + BT;
const RESP_SDK = BT + '@ai-sdk/openai' + BT;

const ENDPOINTS_TABLE = [
  '## Endpoints',
  '',
  '| Model        | Model ID     | Endpoint                                         | AI SDK Package              |',
  '| ------------ | ------------ | ------------------------------------------------ | --------------------------- |',
  `| Grok 4.5     | grok-4.5     | ${RESP} | ${RESP_SDK} |`,
  `| GLM-5.1      | glm-5.1      | ${OAI} | ${OAI_SDK} |`,
  `| GLM-5        | glm-5        | ${OAI} | ${OAI_SDK} |`,
  `| Kimi K2.5    | kimi-k2.5    | ${OAI} | ${OAI_SDK} |`,
  `| MiMo-V2-Pro  | mimo-v2-pro  | ${OAI} | ${OAI_SDK} |`,
  `| MiMo-V2-Omni | mimo-v2-omni | ${OAI} | ${OAI_SDK} |`,
  `| Qwen3.7 Max  | qwen3.7-max  | ${ANT} | ${ANT_SDK} |`,
  `| MiniMax M2.7 | minimax-m2.7 | ${ANT} | ${ANT_SDK} |`,
  `| MiniMax M2.5 | minimax-m2.5 | ${ANT} | ${ANT_SDK} |`,
  '',
].join('\n');

const LIMITS_TABLE = [
  '## Usage limits',
  '',
  '| Model              | requests per 5 hour | requests per week | requests per month |',
  '| ------------------ | ------------------- | ----------------- | ------------------ |',
  '| Grok 4.5           | 120                 | 300               | 600                |',
  '| GLM-5.1            | 880                 | 2,150             | 4,300              |',
  '| GLM-5              | 1,150               | 2,880             | 5,750              |',
  '| Kimi K2.5          | 1,850               | 4,630             | 9,250              |',
  '| MiMo-V2-Pro        | 1,290               | 3,225             | 6,450              |',
  '| MiMo-V2-Omni (≤ 256K) | 2,150            | 5,450             | 10,900             |',
  '| Qwen3.7 Max        | 770                 | 1,925             | 3,850              |',
  '| MiniMax M2.7       | 3,400               | 8,500             | 17,000             |',
  '| MiniMax M2.5       | 6,300               | 15,900            | 31,800             |',
  '',
].join('\n');

const SAMPLE_MDX = [
  '---',
  'title: Go',
  'description: Low cost subscription for open coding models.',
  '---',
  '',
  LIMITS_TABLE,
  ENDPOINTS_TABLE,
].join('\n');

describe('OpencodeGoCatalogService', () => {
  let service: OpencodeGoCatalogService;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    service = new OpencodeGoCatalogService();
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('parse', () => {
    it('extracts every model in the endpoints table', () => {
      const entries = service.parse(SAMPLE_MDX);
      expect(entries.map((e) => e.id)).toEqual([
        'grok-4.5',
        'glm-5.1',
        'glm-5',
        'kimi-k2.5',
        'mimo-v2-pro',
        'mimo-v2-omni',
        'qwen3.7-max',
        'minimax-m2.7',
        'minimax-m2.5',
      ]);
    });

    it('keeps the docs display name verbatim', () => {
      const entries = service.parse(SAMPLE_MDX);
      const labels = Object.fromEntries(entries.map((e) => [e.id, e.displayName]));
      expect(labels['grok-4.5']).toBe('Grok 4.5');
      expect(labels['glm-5.1']).toBe('GLM-5.1');
      expect(labels['kimi-k2.5']).toBe('Kimi K2.5');
      expect(labels['mimo-v2-omni']).toBe('MiMo-V2-Omni');
      expect(labels['qwen3.7-max']).toBe('Qwen3.7 Max');
      expect(labels['minimax-m2.7']).toBe('MiniMax M2.7');
    });

    it('tags docs rows with the endpoint format they declare', () => {
      const entries = service.parse(SAMPLE_MDX);
      const byId = Object.fromEntries(entries.map((e) => [e.id, e.format]));
      expect(byId['grok-4.5']).toBe('responses');
      expect(byId['glm-5.1']).toBe('openai');
      expect(byId['kimi-k2.5']).toBe('openai');
      expect(byId['mimo-v2-pro']).toBe('openai');
      expect(byId['qwen3.7-max']).toBe('anthropic');
      expect(byId['minimax-m2.5']).toBe('anthropic');
      expect(byId['minimax-m2.7']).toBe('anthropic');
    });

    it('never matches the header row (uppercase model ID column fails regex)', () => {
      // The regex anchors the model-id group on [a-z], so "Model ID" in the
      // header row column does not match. No explicit skip needed.
      const entries = service.parse(SAMPLE_MDX);
      expect(entries.find((e) => e.displayName === 'Model')).toBeUndefined();
      expect(entries.find((e) => e.id === 'model id')).toBeUndefined();
    });

    it('returns an empty array when the table is missing', () => {
      expect(service.parse('# Go\n\nNo table here.')).toEqual([]);
    });

    it('deduplicates if a model appears twice', () => {
      const doubled = SAMPLE_MDX + '\n' + SAMPLE_MDX;
      const entries = service.parse(doubled);
      const ids = entries.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('attaches per-request cost derived from the Usage Limits table', () => {
      const entries = service.parse(SAMPLE_MDX);
      const cost = Object.fromEntries(entries.map((e) => [e.id, e.costPerRequestUsd]));
      // $12 / 120 = $0.10
      expect(cost['grok-4.5']).toBeCloseTo(OPENCODE_GO_BUDGET_5H_USD / 120, 12);
      // $12 / 880 = ~0.01364
      expect(cost['glm-5.1']).toBeCloseTo(OPENCODE_GO_BUDGET_5H_USD / 880, 12);
      // $12 / 1150 = ~0.01043
      expect(cost['glm-5']).toBeCloseTo(OPENCODE_GO_BUDGET_5H_USD / 1150, 12);
      // Comma-grouped number — $12 / 6300 = ~0.00190
      expect(cost['minimax-m2.5']).toBeCloseTo(OPENCODE_GO_BUDGET_5H_USD / 6300, 12);
    });

    it('matches names across tables when the limits row has a parenthesized suffix', () => {
      const entries = service.parse(SAMPLE_MDX);
      const omni = entries.find((e) => e.id === 'mimo-v2-omni');
      expect(omni).toBeDefined();
      // "MiMo-V2-Omni" (endpoints) ↔ "MiMo-V2-Omni (≤ 256K)" (limits)
      expect(omni?.costPerRequestUsd).toBeCloseTo(OPENCODE_GO_BUDGET_5H_USD / 2150, 12);
    });

    it('leaves cost null when the Usage Limits table omits a model', () => {
      const onlyEndpoints = ENDPOINTS_TABLE;
      const entries = service.parse(onlyEndpoints);
      expect(entries.every((e) => e.costPerRequestUsd === null)).toBe(true);
    });

    it('ignores Usage Limits rows whose request count is zero or non-positive', () => {
      const broken = [
        '| Bogus | 0 | 0 | 0 |',
        '| GLM-5.1 | 880 | 2,150 | 4,300 |',
        ENDPOINTS_TABLE,
      ].join('\n');
      const entries = service.parse(broken);
      const glm = entries.find((e) => e.id === 'glm-5.1');
      expect(glm?.costPerRequestUsd).toBeCloseTo(OPENCODE_GO_BUDGET_5H_USD / 880, 12);
    });

    it('reads the promoted count when a limits row strikes the old one through', () => {
      // Live docs shape: a temporary multiplier strikes the previous count
      // through and bolds the new one, and annotates the model name with a
      // <small> note. Both cells carry markup the plain number regex misses.
      const promo = [
        '| DeepSeek V4.1 Flash<br /><small>4x \u00b7 Ends Sep 20</small> | ~~6,500~~<br />**26,000** | ~~16,250~~<br />**65,000** | ~~32,500~~<br />**130,000** |',
        '## Endpoints',
        '',
        `| DeepSeek V4.1 Flash | deepseek-v4.1-flash | ${OAI} | ${OAI_SDK} |`,
      ].join('\n');
      const entries = service.parse(promo);
      const flash = entries.find((e) => e.id === 'deepseek-v4.1-flash');
      expect(flash?.displayName).toBe('DeepSeek V4.1 Flash');
      expect(flash?.costPerRequestUsd).toBeCloseTo(OPENCODE_GO_BUDGET_5H_USD / 26000, 12);
    });

    it('reads a limits row that omits its trailing pipe', () => {
      const noTrailingPipe = [
        '| GLM-5.1 | 880 | 2,150 | 4,300',
        '## Endpoints',
        '',
        `| GLM-5.1 | glm-5.1 | ${OAI} | ${OAI_SDK} |`,
      ].join('\n');
      const entries = service.parse(noTrailingPipe);
      expect(entries.find((e) => e.id === 'glm-5.1')?.costPerRequestUsd).toBeCloseTo(
        OPENCODE_GO_BUDGET_5H_USD / 880,
        12,
      );
    });

    it('ignores limits rows whose counts are not numbers', () => {
      const unlimited = [
        '| Union Alpha Free | Unlimited | Unlimited | Unlimited |',
        '## Endpoints',
        '',
        `| Union Alpha Free | union-alpha | ${ANT} | ${ANT_SDK} |`,
      ].join('\n');
      const entries = service.parse(unlimited);
      expect(entries.find((e) => e.id === 'union-alpha')?.costPerRequestUsd).toBeNull();
    });

    it('ignores the token-price table, whose leading cells are dollar amounts', () => {
      const prices = [
        '| GLM-5.1 | $1.40 | $4.40 | $0.26 | - | **$60** |',
        '## Endpoints',
        '',
        `| GLM-5.1 | glm-5.1 | ${OAI} | ${OAI_SDK} |`,
      ].join('\n');
      const entries = service.parse(prices);
      expect(entries.find((e) => e.id === 'glm-5.1')?.costPerRequestUsd).toBeNull();
    });

    it('uses the first occurrence when the limits table contains duplicates', () => {
      const dupLimits = [
        '| GLM-5.1 | 880 | 2,150 | 4,300 |',
        '| GLM-5.1 | 1 | 1 | 1 |',
        ENDPOINTS_TABLE,
      ].join('\n');
      const entries = service.parse(dupLimits);
      const glm = entries.find((e) => e.id === 'glm-5.1');
      // First occurrence (880) wins, not the bogus second row.
      expect(glm?.costPerRequestUsd).toBeCloseTo(OPENCODE_GO_BUDGET_5H_USD / 880, 12);
    });
  });

  describe('getCostPerRequest', () => {
    it('returns null before list() has populated the cache', () => {
      expect(service.getCostPerRequest('glm-5.1')).toBeNull();
    });

    it('returns null for null or empty input', () => {
      expect(service.getCostPerRequest(null)).toBeNull();
      expect(service.getCostPerRequest(undefined)).toBeNull();
      expect(service.getCostPerRequest('')).toBeNull();
    });

    it('resolves both bare and "opencode-go/" prefixed model IDs after list()', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => SAMPLE_MDX,
      } as Response);
      await service.list();
      const bare = service.getCostPerRequest('glm-5.1');
      const prefixed = service.getCostPerRequest('opencode-go/glm-5.1');
      expect(bare).toBeCloseTo(OPENCODE_GO_BUDGET_5H_USD / 880, 12);
      expect(prefixed).toBe(bare);
    });

    it('resolves both bare and prefixed model formats after list()', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => SAMPLE_MDX,
      } as Response);
      await service.list();
      expect(service.getFormat('qwen3.7-max')).toBe('anthropic');
      expect(service.getFormat('opencode-go/qwen3.7-max')).toBe('anthropic');
      expect(service.getFormat('opencode-go/mimo-v2-pro')).toBe('openai');
      expect(service.getFormat('opencode-go/grok-4.5')).toBe('responses');
    });

    it('warms the catalog for async format lookup', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => SAMPLE_MDX,
      } as Response);

      await expect(service.resolveFormat('opencode-go/qwen3.7-max')).resolves.toBe('anthropic');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('returns null for a known model with no published limit', async () => {
      const endpointsOnly = ['---', 'title: Go', '---', '', ENDPOINTS_TABLE].join('\n');
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => endpointsOnly,
      } as Response);
      await service.list();
      expect(service.getCostPerRequest('glm-5.1')).toBeNull();
    });

    it('returns null for an unknown model id', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => SAMPLE_MDX,
      } as Response);
      await service.list();
      expect(service.getCostPerRequest('does-not-exist')).toBeNull();
    });

    it('coalesces concurrent list() calls into a single fetch', async () => {
      let resolveFetch!: (r: Response) => void;
      fetchSpy.mockImplementation(() => new Promise<Response>((res) => (resolveFetch = res)));

      const a = service.list();
      const b = service.list();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      resolveFetch({ ok: true, status: 200, text: async () => SAMPLE_MDX } as Response);
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra).toBe(rb);
    });

    it('refreshes from the live source even when list() has a warm cache', async () => {
      const refreshedMdx = [
        '---',
        'title: Go',
        '---',
        '',
        '| Model | requests per 5 hour | requests per week | requests per month |',
        '| ----- | ------------------- | ----------------- | ------------------ |',
        '| GLM-5.2 | 880 | 2,150 | 4,300 |',
        '',
        '| Model | Model ID | Endpoint | AI SDK Package |',
        '| ----- | -------- | -------- | -------------- |',
        `| GLM-5.2 | glm-5.2 | ${OAI} | ${OAI_SDK} |`,
        '',
      ].join('\n');
      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => SAMPLE_MDX,
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => refreshedMdx,
        } as Response);

      await service.list();
      const refreshed = await service.refresh();

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(refreshed.map((e) => e.id)).toEqual(['glm-5.2']);
      expect(service.getCostPerRequest('glm-5.2')).toBeCloseTo(OPENCODE_GO_BUDGET_5H_USD / 880, 12);
    });

    it('warms the catalog via onModuleInit so the cost index is ready before the first proxy call', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => SAMPLE_MDX,
      } as Response);
      service.onModuleInit();
      // onModuleInit is fire-and-forget; flush the pending list() promise.
      await new Promise((r) => setImmediate(r));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(service.getCostPerRequest('glm-5.1')).not.toBeNull();
    });

    it('onModuleInit failure is swallowed and leaves the cost index empty', async () => {
      fetchSpy.mockRejectedValue(new Error('boom'));
      service.onModuleInit();
      await new Promise((r) => setImmediate(r));
      // No throw, no crash — recorder will record $0 for that one call and
      // catalog will retry after the error-backoff window.
      expect(service.getCostPerRequest('glm-5.1')).toBeNull();
    });

    it('returns null from resolve for null input without ever hitting list()', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => SAMPLE_MDX,
      } as Response);
      const result = await service.resolveCostPerRequest(null);
      expect(result).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('resolves the cost after awaiting list() when the index is still cold', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => SAMPLE_MDX,
      } as Response);
      // No onModuleInit, no prior list() — costByModelId is empty.
      const cost = await service.resolveCostPerRequest('glm-5.1');
      expect(cost).toBeCloseTo(OPENCODE_GO_BUDGET_5H_USD / 880, 12);
      // A second resolution should not re-fetch (cache is warm now).
      const again = await service.resolveCostPerRequest('glm-5.1');
      expect(again).toBe(cost);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('is cleared by resetCache()', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => SAMPLE_MDX,
      } as Response);
      await service.list();
      expect(service.getCostPerRequest('glm-5.1')).not.toBeNull();
      service.resetCache();
      expect(service.getCostPerRequest('glm-5.1')).toBeNull();
    });
  });

  describe('list', () => {
    it('fetches, parses, and caches the catalog', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => SAMPLE_MDX,
      } as Response);

      const first = await service.list();
      expect(first).toHaveLength(9);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const second = await service.list();
      expect(second).toBe(first);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('returns the last good result when a later fetch fails', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => SAMPLE_MDX,
      } as Response);
      const good = await service.list();
      expect(good).toHaveLength(9);

      // Force the success cache to look expired, but keep lastGood populated.
      (service as unknown as { cache: unknown }).cache = null;

      fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
      const afterFailure = await service.list();
      expect(afterFailure).toEqual(good);
    });

    it('backs off after a failure so repeated calls do not hammer the network', async () => {
      // First fetch fails with nothing cached → returns [] and arms the
      // error-backoff window.
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 503 } as Response);
      const first = await service.list();
      expect(first).toEqual([]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Second call within the backoff window reuses the cached fallback and
      // must NOT reach the network.
      const second = await service.list();
      expect(second).toEqual([]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('returns [] when there is no prior cache and the fetch 404s', async () => {
      fetchSpy.mockResolvedValue({ ok: false, status: 404 } as Response);
      const result = await service.list();
      expect(result).toEqual([]);
    });

    it('returns [] when the fetch throws an Error and nothing is cached', async () => {
      fetchSpy.mockRejectedValue(new Error('network down'));
      const result = await service.list();
      expect(result).toEqual([]);
    });

    it('returns [] when the fetch throws a non-Error value', async () => {
      // Exercises the String(err) fallback when something non-Error is thrown.
      fetchSpy.mockRejectedValue('raw string failure');
      const result = await service.list();
      expect(result).toEqual([]);
    });

    it('returns [] (not stale empty) when the docs parse to zero rows', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '# Nothing useful here',
      } as Response);
      const result = await service.list();
      expect(result).toEqual([]);
    });
  });
});
