import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getProviderParamSpecs, type ProviderParamSpecCatalog } from 'manifest-shared';
import { RouteModelParamsService } from '../route-model-params.service';

const AGENT = 'agent-1';
const catalog: ProviderParamSpecCatalog = [
  {
    provider: 'openai',
    authType: 'api_key',
    model: 'gpt-5',
    params: [
      {
        path: 'reasoning.effort',
        type: 'enum',
        label: 'Reasoning effort',
        description: 'How hard the model thinks.',
        values: ['low', 'medium', 'high'],
        group: 'reasoning',
      },
      {
        path: 'temperature',
        type: 'number',
        label: 'Temperature',
        description: 'Sampling temperature.',
        range: { min: 0, max: 2 },
        group: 'sampling',
      },
      {
        path: 'max_tokens',
        type: 'integer',
        label: 'Max tokens',
        description: 'Output cap.',
        group: 'generation_length',
        applicability: { except: { 'reasoning.effort': 'high' } },
      },
    ],
  },
];
const gpt5Specs = getProviderParamSpecs(catalog, 'openai', 'api_key', 'gpt-5');

const PRIMARY = { provider: 'openai', authType: 'api_key', model: 'gpt-5' };
const FALLBACK = { provider: 'anthropic', authType: 'subscription', model: 'claude-sonnet' };

function setup(
  overrides: {
    tiers?: unknown[];
    headerTiers?: unknown[];
    saved?: Record<string, unknown> | null;
  } = {},
) {
  const tiers = {
    getTiers: jest.fn().mockResolvedValue(
      overrides.tiers ?? [
        {
          tier: 'default',
          override_route: PRIMARY,
          auto_assigned_route: null,
          fallback_routes: [FALLBACK],
        },
      ],
    ),
  };
  const headerTiers = {
    list: jest
      .fn()
      .mockResolvedValue(
        overrides.headerTiers ?? [
          { id: 'h1', name: 'Deep', override_route: FALLBACK, fallback_routes: [PRIMARY] },
        ],
      ),
  };
  const modelParams = {
    get: jest.fn().mockResolvedValue(overrides.saved === undefined ? null : overrides.saved),
    set: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const specs = {
    getSpecs: jest
      .fn()
      .mockImplementation(async (_p: string, _a: string, model: string) =>
        model === 'gpt-5' ? gpt5Specs : [],
      ),
  };
  const service = new RouteModelParamsService(
    tiers as never,
    headerTiers as never,
    modelParams as never,
    specs as never,
  );
  return { service, tiers, headerTiers, modelParams, specs };
}

describe('RouteModelParamsService.get', () => {
  it('describes the default tier primary route with saved values merged in', async () => {
    const { service, modelParams } = setup({ saved: { reasoning: { effort: 'high' } } });

    const view = await service.get(AGENT, 'default');

    expect(modelParams.get).toHaveBeenCalledWith(
      AGENT,
      'tier:default',
      'openai',
      'api_key',
      'gpt-5',
    );
    expect(view.tier).toBe('default');
    expect(view.route).toEqual(PRIMARY);
    expect(view.models).toEqual(['gpt-5', 'claude-sonnet']);
    expect(view.params.map((p) => [p.path, p.current])).toEqual([
      ['max_tokens', null],
      ['temperature', null],
      ['reasoning.effort', 'high'],
    ]);
    expect(view.params[0]).not.toHaveProperty('provider');
  });

  it('falls back to the auto-assigned route of the default tier', async () => {
    const { service } = setup({
      tiers: [
        { tier: 'standard', override_route: FALLBACK, fallback_routes: null },
        {
          tier: 'default',
          override_route: null,
          auto_assigned_route: PRIMARY,
          fallback_routes: null,
        },
      ],
    });
    const view = await service.get(AGENT);
    expect(view.route).toEqual(PRIMARY);
    expect(view.models).toEqual(['gpt-5']);
  });

  it('addresses a custom tier by name, case-insensitively, under its header scope', async () => {
    const { service, modelParams } = setup();
    const view = await service.get(AGENT, 'deep', 'gpt-5');
    expect(view.tier).toBe('Deep');
    expect(view.route).toEqual(PRIMARY);
    expect(view.models).toEqual(['claude-sonnet', 'gpt-5']);
    expect(modelParams.get).toHaveBeenCalledWith(AGENT, 'header:h1', 'openai', 'api_key', 'gpt-5');
  });

  it('returns an empty param list for a model with no configurable params', async () => {
    const { service } = setup();
    const view = await service.get(AGENT, 'Deep');
    expect(view.route).toEqual(FALLBACK);
    expect(view.params).toEqual([]);
  });

  it('rejects an unknown tier and lists the available ones', async () => {
    const { service } = setup();
    await expect(service.get(AGENT, 'nope')).rejects.toThrow(NotFoundException);
    await expect(service.get(AGENT, 'nope')).rejects.toThrow(/Available tiers: default, Deep/);
  });

  it('rejects a missing default tier row as an unknown tier', async () => {
    const { service } = setup({ tiers: [] });
    await expect(service.get(AGENT)).rejects.toThrow(NotFoundException);
  });

  it('rejects a model the tier does not route to and lists the routed ones', async () => {
    const { service } = setup();
    await expect(service.get(AGENT, 'default', 'gpt-4o')).rejects.toThrow(
      /Model "gpt-4o" is not routed by tier "default". Models: gpt-5, claude-sonnet/,
    );
  });

  it('rejects a tier with no route yet when no model is named', async () => {
    const { service } = setup({
      tiers: [
        { tier: 'default', override_route: null, auto_assigned_route: null, fallback_routes: null },
      ],
    });
    await expect(service.get(AGENT)).rejects.toThrow(/Tier "default" has no model yet/);
  });

  it('rejects a model routed through two different connections', async () => {
    const { service } = setup({
      tiers: [
        {
          tier: 'default',
          override_route: PRIMARY,
          auto_assigned_route: null,
          fallback_routes: [{ ...PRIMARY, authType: 'subscription' }],
        },
      ],
    });
    await expect(service.get(AGENT, 'default', 'gpt-5')).rejects.toThrow(BadRequestException);
    await expect(service.get(AGENT, 'default', 'gpt-5')).rejects.toThrow(
      /more than one connection/,
    );
  });

  it('treats the same model twice on the same connection as one route', async () => {
    const { service } = setup({
      tiers: [
        {
          tier: 'default',
          override_route: PRIMARY,
          auto_assigned_route: null,
          fallback_routes: [{ ...PRIMARY, keyLabel: 'backup' }],
        },
      ],
    });
    const view = await service.get(AGENT, 'default', 'gpt-5');
    expect(view.route).toEqual(PRIMARY);
  });
});

describe('RouteModelParamsService Anthropic short ids', () => {
  const DOTTED = { provider: 'anthropic', authType: 'api_key', model: 'claude-sonnet-4.5' };

  it('saves under the configured id, like the dashboard, and reads specs under the dashed id', async () => {
    const { service, modelParams, specs } = setup({
      tiers: [
        { tier: 'default', override_route: DOTTED, auto_assigned_route: null, fallback_routes: [] },
      ],
    });
    const view = await service.get(AGENT);
    expect(view.route.model).toBe('claude-sonnet-4.5');
    expect(specs.getSpecs).toHaveBeenCalledWith('anthropic', 'api_key', 'claude-sonnet-4-5');
    expect(modelParams.get).toHaveBeenCalledWith(
      AGENT,
      'tier:default',
      'anthropic',
      'api_key',
      'claude-sonnet-4.5',
    );

    modelParams.get.mockResolvedValue({ temperature: 1 });
    await service.update(AGENT, 'default', 'claude-sonnet-4-5', { unset: ['temperature'] });
    expect(modelParams.delete).toHaveBeenCalledWith(
      AGENT,
      'tier:default',
      'anthropic',
      'api_key',
      'claude-sonnet-4.5',
    );
  });
});

describe('RouteModelParamsService.update', () => {
  it('merges set values into the saved params and persists the sanitized result', async () => {
    const { service, modelParams } = setup({ saved: { temperature: 0.3 } });
    modelParams.get
      .mockResolvedValueOnce({ temperature: 0.3 })
      .mockResolvedValueOnce({ temperature: 0.3, reasoning: { effort: 'low' } });

    const view = await service.update(AGENT, 'default', undefined, {
      set: { 'reasoning.effort': 'low' },
    });

    expect(modelParams.set).toHaveBeenCalledWith(
      AGENT,
      'tier:default',
      'openai',
      'api_key',
      'gpt-5',
      { temperature: 0.3, reasoning: { effort: 'low' } },
    );
    expect(view.params.find((p) => p.path === 'reasoning.effort')?.current).toBe('low');
  });

  it('removes unset keys and keeps the rest', async () => {
    const { service, modelParams } = setup({
      saved: { temperature: 0.3, reasoning: { effort: 'low' } },
    });
    await service.update(AGENT, 'default', 'gpt-5', { unset: ['reasoning.effort'] });
    expect(modelParams.set).toHaveBeenCalledWith(
      AGENT,
      'tier:default',
      'openai',
      'api_key',
      'gpt-5',
      { temperature: 0.3 },
    );
  });

  it('deletes the row when the last key is unset', async () => {
    const { service, modelParams } = setup({ saved: { reasoning: { effort: 'low' } } });
    await service.update(AGENT, 'default', undefined, { unset: ['reasoning.effort'] });
    expect(modelParams.set).not.toHaveBeenCalled();
    expect(modelParams.delete).toHaveBeenCalledWith(
      AGENT,
      'tier:default',
      'openai',
      'api_key',
      'gpt-5',
    );
  });

  it('allows unsetting a saved key the catalog no longer lists', async () => {
    const { service, modelParams } = setup({ saved: { legacy_knob: 1, temperature: 0.5 } });
    await service.update(AGENT, 'default', undefined, { unset: ['legacy_knob'] });
    expect(modelParams.set).toHaveBeenCalledWith(
      AGENT,
      'tier:default',
      'openai',
      'api_key',
      'gpt-5',
      { temperature: 0.5 },
    );
  });

  it('rejects an empty change', async () => {
    const { service } = setup();
    await expect(service.update(AGENT, 'default', undefined, {})).rejects.toThrow(
      /Nothing to change/,
    );
    await expect(
      service.update(AGENT, 'default', undefined, { set: {}, unset: [] }),
    ).rejects.toThrow(/Nothing to change/);
  });

  it('rejects a param the model does not accept and lists the accepted ones', async () => {
    const { service, modelParams } = setup();
    await expect(
      service.update(AGENT, 'default', undefined, { set: { top_k: 5 } }),
    ).rejects.toThrow(
      /Unknown param "top_k" for gpt-5. Available: max_tokens, temperature, reasoning.effort/,
    );
    expect(modelParams.set).not.toHaveBeenCalled();
  });

  it('says so when the model has no configurable params at all', async () => {
    const { service } = setup();
    await expect(
      service.update(AGENT, 'Deep', undefined, { set: { temperature: 1 } }),
    ).rejects.toThrow(/claude-sonnet has no configurable params/);
  });

  it('rejects unsetting a param that is neither known nor saved', async () => {
    const { service } = setup();
    await expect(service.update(AGENT, 'default', undefined, { unset: ['top_k'] })).rejects.toThrow(
      /Unknown param "top_k"/,
    );
  });

  it('rejects a malformed or unsafe param path as a client error', async () => {
    const { service, modelParams } = setup({ saved: { temperature: 1 } });
    for (const path of ['__proto__.x', 'a..b', 'constructor']) {
      await expect(service.update(AGENT, 'default', undefined, { unset: [path] })).rejects.toThrow(
        BadRequestException,
      );
      await expect(
        service.update(AGENT, 'default', undefined, { set: { [path]: 1 } }),
      ).rejects.toThrow(/Invalid param path/);
    }
    expect(modelParams.set).not.toHaveBeenCalled();
    expect(modelParams.delete).not.toHaveBeenCalled();
  });

  it('rejects an invalid value', async () => {
    const { service } = setup();
    await expect(
      service.update(AGENT, 'default', undefined, { set: { 'reasoning.effort': 'extreme' } }),
    ).rejects.toThrow(/Invalid value for param "reasoning.effort"/);
  });

  it('rejects a value that does not apply with the other saved settings', async () => {
    const { service, modelParams } = setup({ saved: { reasoning: { effort: 'high' } } });
    await expect(
      service.update(AGENT, 'default', undefined, { set: { max_tokens: 100 } }),
    ).rejects.toThrow(/Param "max_tokens" does not apply with the current settings/);
    expect(modelParams.set).not.toHaveBeenCalled();
  });
});
