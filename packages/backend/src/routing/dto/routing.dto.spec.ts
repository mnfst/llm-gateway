import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  AgentNameParamDto,
  ConnectProviderDto,
  CopilotPollDto,
  ModelRouteDto,
  SetOverrideDto,
  SetResponseModeDto,
  SetFallbacksDto,
  responseModeFromDto,
} from './routing.dto';

function toDto(data: Record<string, unknown>): AgentNameParamDto {
  return plainToInstance(AgentNameParamDto, data);
}

describe('AgentNameParamDto', () => {
  it('should pass with alphanumeric name', async () => {
    const dto = toDto({ agentName: 'myagent123' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should pass with hyphens', async () => {
    const dto = toDto({ agentName: 'my-agent' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should pass with underscores', async () => {
    const dto = toDto({ agentName: 'my_agent' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should pass with mixed valid characters', async () => {
    const dto = toDto({ agentName: 'Agent-01_test' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should pass with single character', async () => {
    const dto = toDto({ agentName: 'a' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should reject empty string', async () => {
    const dto = toDto({ agentName: '' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should reject name with spaces', async () => {
    const dto = toDto({ agentName: 'my agent' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should reject name with special characters', async () => {
    for (const name of ['agent@home', 'agent!', 'agent.name', 'agent/path', 'agent$']) {
      const dto = toDto({ agentName: name });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('should reject missing agentName', async () => {
    const dto = toDto({});
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should reject non-string agentName', async () => {
    const dto = toDto({ agentName: 123 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('ConnectProviderDto', () => {
  function toConnectDto(data: Record<string, unknown>): ConnectProviderDto {
    return plainToInstance(ConnectProviderDto, data);
  }

  it('accepts a known provider id', async () => {
    const dto = toConnectDto({ provider: 'openai', apiKey: 'sk-abcdef' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.provider).toBe('openai');
  });

  it('normalizes provider casing to lowercase', async () => {
    const dto = toConnectDto({ provider: 'OpenAI' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.provider).toBe('openai');
  });

  it('trims whitespace around the provider name', async () => {
    const dto = toConnectDto({ provider: '  anthropic  ' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.provider).toBe('anthropic');
  });

  it('accepts registered aliases (google -> gemini entry)', async () => {
    const dto = toConnectDto({ provider: 'google' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects an unknown provider name', async () => {
    const dto = toConnectDto({ provider: 'made-up-xyz' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    const flat = errors.flatMap((e) => Object.values(e.constraints ?? {}));
    expect(flat.join('\n')).toMatch(/provider must be one of/);
  });

  it('rejects an empty provider', async () => {
    const dto = toConnectDto({ provider: '' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('passes through a non-string provider value without transforming', async () => {
    const dto = toConnectDto({ provider: 42 });
    // Transform preserves non-strings so class-validator can reject via @IsString
    expect(dto.provider).toBe(42 as unknown as string);
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('CopilotPollDto', () => {
  function toPollDto(data: Record<string, unknown>): CopilotPollDto {
    return plainToInstance(CopilotPollDto, data);
  }

  it('should pass with a valid device code', async () => {
    const dto = toPollDto({ deviceCode: 'dc_abc123' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should reject empty deviceCode', async () => {
    const dto = toPollDto({ deviceCode: '' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should reject missing deviceCode', async () => {
    const dto = toPollDto({});
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('SetFallbacksDto', () => {
  function toFallbacksDto(data: Record<string, unknown>): SetFallbacksDto {
    return plainToInstance(SetFallbacksDto, data);
  }

  it('should pass with a single model string', async () => {
    const dto = toFallbacksDto({ models: ['gpt-4o'] });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should pass with up to 100 model strings', async () => {
    const dto = toFallbacksDto({
      models: Array.from({ length: 100 }, (_, i) => `model-${i}`),
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should pass with an empty array', async () => {
    const dto = toFallbacksDto({ models: [] });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should reject an empty string in the array', async () => {
    const dto = toFallbacksDto({ models: ['gpt-4o', ''] });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should reject more than 100 items', async () => {
    const dto = toFallbacksDto({
      models: Array.from({ length: 101 }, (_, i) => `model-${i}`),
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should reject a non-string item in the array', async () => {
    const dto = toFallbacksDto({ models: ['gpt-4o', 42] });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should reject when models property is missing', async () => {
    const dto = toFallbacksDto({});
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('SetResponseModeDto', () => {
  function toResponseModeDto(data: Record<string, unknown>): SetResponseModeDto {
    return plainToInstance(SetResponseModeDto, data);
  }

  it('accepts the response_mode body field', async () => {
    const dto = toResponseModeDto({ response_mode: 'stream' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(responseModeFromDto(dto)).toBe('stream');
  });

  it('accepts the legacy responseMode body field', async () => {
    const dto = toResponseModeDto({ responseMode: 'stream' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(responseModeFromDto(dto)).toBe('stream');
  });

  it('rejects invalid mode values', async () => {
    const dto = toResponseModeDto({ response_mode: 'instant' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('routing.dto decorator transforms', () => {
  it('ModelRouteDto trims keyLabel', () => {
    const dto = plainToInstance(ModelRouteDto, {
      provider: 'openai',
      authType: 'api_key',
      model: 'gpt-4o',
      keyLabel: '  Work  ',
    });
    expect(dto.keyLabel).toBe('Work');
  });

  it('SetOverrideDto trims providerKeyLabel and parses the nested route', () => {
    const dto = plainToInstance(SetOverrideDto, {
      model: 'gpt-4o',
      providerKeyLabel: '  Work  ',
      route: { provider: 'openai', authType: 'api_key', model: 'gpt-4o' },
    });
    expect(dto.providerKeyLabel).toBe('Work');
    expect(dto.route?.model).toBe('gpt-4o');
  });

  it('SetFallbacksDto parses nested routes', async () => {
    const dto = plainToInstance(SetFallbacksDto, {
      models: ['gpt-4o'],
      routes: [{ provider: 'openai', authType: 'api_key', model: 'gpt-4o' }],
    });
    expect(dto.routes).toHaveLength(1);
    expect(await validate(dto)).toHaveLength(0);
  });
});
