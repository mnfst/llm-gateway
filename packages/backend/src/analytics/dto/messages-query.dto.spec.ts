import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { MESSAGE_STATUS_FILTER_VALUES, MessagesQueryDto } from './messages-query.dto';

describe('MessagesQueryDto', () => {
  it('allows omitting all fields', async () => {
    const dto = plainToInstance(MessagesQueryDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts valid string fields', async () => {
    const dto = plainToInstance(MessagesQueryDto, {
      range: '24h',
      provider: 'openai',
      service_type: 'agent',
      cursor: 'abc123',
      agent_name: 'my-bot',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts valid numeric fields', async () => {
    const dto = plainToInstance(MessagesQueryDto, {
      cost_min: 0,
      cost_max: 100,
      limit: 50,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects negative cost_min', async () => {
    const dto = plainToInstance(MessagesQueryDto, { cost_min: -1 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects cost_max over 999999', async () => {
    const dto = plainToInstance(MessagesQueryDto, { cost_max: 1000000 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects limit below 1', async () => {
    const dto = plainToInstance(MessagesQueryDto, { limit: 0 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects limit above 200', async () => {
    const dto = plainToInstance(MessagesQueryDto, { limit: 201 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts each known status value', async () => {
    for (const status of MESSAGE_STATUS_FILTER_VALUES) {
      const dto = plainToInstance(MessagesQueryDto, { status });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects an unknown status value', async () => {
    const dto = plainToInstance(MessagesQueryDto, { status: 'pending' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    const flat = errors.flatMap((e) => Object.values(e.constraints ?? {}));
    expect(flat.join('\n')).toMatch(/status must be one of/);
  });

  it('accepts each known trigger filter value', async () => {
    for (const trigger of ['none', 'fallback', 'autofix']) {
      const dto = plainToInstance(MessagesQueryDto, { trigger });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects an unknown trigger filter value', async () => {
    const dto = plainToInstance(MessagesQueryDto, { trigger: 'manual' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    const flat = errors.flatMap((e) => Object.values(e.constraints ?? {}));
    expect(flat.join('\n')).toMatch(/trigger must be a comma-separated list of/);
  });

  it('rejects an unknown attempts facet value', async () => {
    const dto = plainToInstance(MessagesQueryDto, { attempts: 'has_exploded' });
    const errors = await validate(dto);
    const flat = errors.flatMap((e) => Object.values(e.constraints ?? {}));
    expect(flat.join('\n')).toMatch(/attempts must be a comma-separated list of/);
  });

  it('accepts the attempts facet list', async () => {
    const dto = plainToInstance(MessagesQueryDto, { attempts: 'has_failed,has_succeeded' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts a comma-separated trigger list', async () => {
    const dto = plainToInstance(MessagesQueryDto, { trigger: 'autofix,fallback' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('coerces total and filter-option flags', async () => {
    const dto = plainToInstance(MessagesQueryDto, {
      include_total: 'false',
      cache_total: 'true',
      include_filter_options: '1',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.include_total).toBe(false);
    expect(dto.cache_total).toBe(true);
    expect(dto.include_filter_options).toBe(true);
  });

  it('accepts each known routing_tier value including direct and playground', async () => {
    for (const tier of ['simple', 'standard', 'complex', 'reasoning', 'direct', 'playground']) {
      const dto = plainToInstance(MessagesQueryDto, { routing_tier: tier });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects an unknown routing_tier value', async () => {
    const dto = plainToInstance(MessagesQueryDto, { routing_tier: 'fanciful' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    const flat = errors.flatMap((e) => Object.values(e.constraints ?? {}));
    expect(flat.join('\n')).toMatch(/routing_tier must be one of/);
  });

  it('accepts each known specificity_category value', async () => {
    for (const category of [
      'coding',
      'web_browsing',
      'data_analysis',
      'image_generation',
      'video_generation',
      'social_media',
      'email_management',
      'calendar_management',
      'trading',
    ]) {
      const dto = plainToInstance(MessagesQueryDto, { specificity_category: category });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects an unknown specificity_category value', async () => {
    const dto = plainToInstance(MessagesQueryDto, { specificity_category: 'gardening' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    const flat = errors.flatMap((e) => Object.values(e.constraints ?? {}));
    expect(flat.join('\n')).toMatch(/specificity_category must be one of/);
  });

  it('accepts custom header tier ids', async () => {
    const dto = plainToInstance(MessagesQueryDto, { header_tier_id: 'ht-premium' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts each known origin filter including the manifest shorthand', async () => {
    for (const origin of ['provider', 'transport', 'config', 'policy', 'internal', 'manifest']) {
      const dto = plainToInstance(MessagesQueryDto, { origin });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects an unknown origin value', async () => {
    const dto = plainToInstance(MessagesQueryDto, { origin: 'provider-ish' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    const flat = errors.flatMap((e) => Object.values(e.constraints ?? {}));
    expect(flat.join('\n')).toMatch(/origin must be one of/);
  });

  it('accepts a known error_class value', async () => {
    for (const error_class of ['rate_limit', 'auth', 'server_error', 'no_provider_key']) {
      const dto = plainToInstance(MessagesQueryDto, { error_class });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects an unknown error_class value', async () => {
    const dto = plainToInstance(MessagesQueryDto, { error_class: 'kaboom' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    const flat = errors.flatMap((e) => Object.values(e.constraints ?? {}));
    expect(flat.join('\n')).toMatch(/error_class must be one of/);
  });
});
