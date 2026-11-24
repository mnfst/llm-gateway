import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  CreateCustomProviderDto,
  ProbeCustomProviderDto,
  UpdateCustomProviderDto,
  CustomProviderModelDto,
  CUSTOM_PROVIDER_MODEL_LIMIT,
} from './custom-provider.dto';

function toDto(data: Record<string, unknown>): CreateCustomProviderDto {
  return plainToInstance(CreateCustomProviderDto, data);
}

function toUpdateDto(data: Record<string, unknown>): UpdateCustomProviderDto {
  return plainToInstance(UpdateCustomProviderDto, data);
}

function makeModels(count: number): CustomProviderModelDto[] {
  return Array.from({ length: count }, (_, i) => ({ model_name: `model-${i + 1}` }));
}

describe('alias validation', () => {
  const base = {
    name: 'Vercel AI Gateway',
    base_url: 'https://ai-gateway.vercel.sh/v1',
    models: [{ model_name: 'alibaba/qwen-3-14b' }],
  };

  it('accepts a well-formed alias on create and update', async () => {
    expect(await validate(toDto({ ...base, alias: 'vercel-ai.gw' }))).toHaveLength(0);
    expect(await validate(toUpdateDto({ alias: 'vercel' }))).toHaveLength(0);
  });

  it('normalises the alias to trimmed lowercase before validating', async () => {
    const dto = toDto({ ...base, alias: '  Vercel-GW ' });
    expect(dto.alias).toBe('vercel-gw');
    expect(await validate(dto)).toHaveLength(0);
  });

  it('turns an empty alias into null so it reads as "clear"', async () => {
    const dto = toUpdateDto({ alias: '   ' });
    expect(dto.alias).toBeNull();
    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts an explicit null and an omitted alias', async () => {
    expect(await validate(toDto({ ...base, alias: null }))).toHaveLength(0);
    expect(await validate(toDto(base))).toHaveLength(0);
  });

  it('rejects separators in the wrong place and forbidden characters', async () => {
    for (const alias of ['-vercel', 'vercel-', 'ver//cel', 'vercel gw', 'a--b']) {
      const errors = await validate(toUpdateDto({ alias }));
      expect(errors).toHaveLength(1);
      expect(errors[0].constraints?.matches).toContain('lowercase letters');
    }
  });

  it('rejects an alias longer than 50 chars', async () => {
    const errors = await validate(toUpdateDto({ alias: 'a'.repeat(51) }));
    expect(errors[0].constraints?.maxLength).toBeDefined();
  });

  it('rejects a non-string alias untouched by normalisation', async () => {
    const errors = await validate(toUpdateDto({ alias: 42 }));
    expect(errors[0].constraints?.isString).toBeDefined();
  });
});

describe('CreateCustomProviderDto', () => {
  it('accepts valid input', async () => {
    const dto = toDto({
      name: 'Groq',
      base_url: 'https://api.groq.com/openai/v1',
      apiKey: 'gsk_test123',
      models: [{ model_name: 'llama-3.1-70b' }],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts http URLs for local providers', async () => {
    const dto = toDto({
      name: 'Local OpenAI-compatible',
      base_url: 'http://localhost:8000/v1',
      models: [{ model_name: 'my-model' }],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts optional pricing fields', async () => {
    const dto = toDto({
      name: 'Test',
      base_url: 'https://api.example.com/v1',
      models: [
        {
          model_name: 'model-a',
          input_price_per_million_tokens: 0.5,
          output_price_per_million_tokens: 1.0,
          context_window: 32000,
        },
      ],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects empty name', async () => {
    const dto = toDto({
      name: '',
      base_url: 'https://api.example.com/v1',
      models: [{ model_name: 'model-a' }],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects name with special characters', async () => {
    const dto = toDto({
      name: 'Invalid@Provider!',
      base_url: 'https://api.example.com/v1',
      models: [{ model_name: 'model-a' }],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    const nameError = errors.find((e) => e.property === 'name');
    expect(nameError).toBeDefined();
  });

  it('accepts a dot in the name (e.g. "llama.cpp")', async () => {
    const dto = toDto({
      name: 'llama.cpp',
      base_url: 'http://localhost:8080/v1',
      models: [{ model_name: 'qwen2.5-0.5b-q4.gguf' }],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects name longer than 50 chars', async () => {
    const dto = toDto({
      name: 'a'.repeat(51),
      base_url: 'https://api.example.com/v1',
      models: [{ model_name: 'model-a' }],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects empty models array', async () => {
    const dto = toDto({
      name: 'Test',
      base_url: 'https://api.example.com/v1',
      models: [],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts large custom provider catalogs', async () => {
    const dto = toDto({
      name: 'Mammouth',
      base_url: 'https://api.mammouth.ai/v1',
      models: makeModels(73),
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects custom provider catalogs above the configured limit', async () => {
    const dto = toDto({
      name: 'Too Large',
      base_url: 'https://api.example.com/v1',
      models: makeModels(CUSTOM_PROVIDER_MODEL_LIMIT + 1),
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'models')).toBe(true);
  });

  it('rejects missing base_url', async () => {
    const dto = toDto({
      name: 'Test',
      models: [{ model_name: 'model-a' }],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects negative pricing', async () => {
    const dto = toDto({
      name: 'Test',
      base_url: 'https://api.example.com/v1',
      models: [{ model_name: 'model-a', input_price_per_million_tokens: -1 }],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('UpdateCustomProviderDto', () => {
  it('accepts all fields (same as create)', async () => {
    const dto = toUpdateDto({
      name: 'Updated',
      base_url: 'https://api.example.com/v2',
      apiKey: 'new-key',
      models: [{ model_name: 'model-b' }],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts partial update with only name', async () => {
    const dto = toUpdateDto({ name: 'New Name' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts partial update with only models', async () => {
    const dto = toUpdateDto({
      models: [{ model_name: 'model-a' }],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts large model catalog updates', async () => {
    const dto = toUpdateDto({
      models: makeModels(73),
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts empty object (no fields)', async () => {
    const dto = toUpdateDto({});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects invalid name characters', async () => {
    const dto = toUpdateDto({ name: 'Bad@Name!' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects empty models array', async () => {
    const dto = toUpdateDto({ models: [] });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('api_kind validation', () => {
  it('accepts "openai" and "anthropic" on create', async () => {
    for (const api_kind of ['openai', 'anthropic']) {
      const dto = toDto({
        name: 'Test',
        base_url: 'https://api.example.com/v1',
        api_kind,
        models: [{ model_name: 'm' }],
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects unknown api_kind values on create', async () => {
    const dto = toDto({
      name: 'Test',
      base_url: 'https://api.example.com/v1',
      api_kind: 'google',
      models: [{ model_name: 'm' }],
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'api_kind')).toBe(true);
  });

  it('accepts api_kind on update', async () => {
    const dto = toUpdateDto({ api_kind: 'anthropic' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts api_kind on probe payload', async () => {
    const dto = plainToInstance(ProbeCustomProviderDto, {
      base_url: 'https://api.anthropic.com',
      api_kind: 'anthropic',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects unknown api_kind on probe payload', async () => {
    const dto = plainToInstance(ProbeCustomProviderDto, {
      base_url: 'https://api.example.com',
      api_kind: 'bogus',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'api_kind')).toBe(true);
  });
});
