import {
  DEFAULT_BEDROCK_REGION,
  detectBedrockRegionFromApiKey,
  getBedrockControlPlaneBaseUrl,
  getBedrockInferenceProfileBaseModelId,
  getBedrockMantleBaseUrl,
  getBedrockRuntimeBaseUrl,
  isBedrockProvider,
  isBedrockRegion,
  normalizeBedrockMantleBaseUrl,
} from './bedrock-region';
import { makeShortTermBedrockKey } from './__tests__/bedrock-fixtures';

describe('bedrock-region', () => {
  it('recognizes Bedrock provider aliases', () => {
    expect(isBedrockProvider('bedrock')).toBe(true);
    expect(isBedrockProvider('aws-bedrock')).toBe(true);
    expect(isBedrockProvider('amazon-bedrock')).toBe(true);
    expect(isBedrockProvider('openai')).toBe(false);
  });

  it('accepts Bedrock Mantle-supported AWS regions', () => {
    expect(isBedrockRegion('us-east-1')).toBe(true);
    expect(isBedrockRegion('eu-west-1')).toBe(true);
    expect(isBedrockRegion('eu-west-3')).toBe(false);
    expect(isBedrockRegion('global')).toBe(false);
    expect(isBedrockRegion('https://example.com')).toBe(false);
  });

  it('builds Bedrock Mantle base URLs from safe regions', () => {
    expect(getBedrockMantleBaseUrl('eu-west-1')).toBe('https://bedrock-mantle.eu-west-1.api.aws');
    expect(getBedrockMantleBaseUrl('bad-region')).toBe(
      `https://bedrock-mantle.${DEFAULT_BEDROCK_REGION}.api.aws`,
    );
  });

  it('normalizes Bedrock Mantle base URLs only', () => {
    expect(normalizeBedrockMantleBaseUrl('https://bedrock-mantle.eu-west-1.api.aws/v1')).toBe(
      'https://bedrock-mantle.eu-west-1.api.aws',
    );
    expect(normalizeBedrockMantleBaseUrl('https://evil.example/v1')).toBeNull();
    expect(normalizeBedrockMantleBaseUrl('http://bedrock-mantle.eu-west-1.api.aws')).toBe(null);
    expect(normalizeBedrockMantleBaseUrl('https://bedrock-mantle.eu-west-1.api.aws:8443')).toBe(
      null,
    );
    expect(
      normalizeBedrockMantleBaseUrl('https://bedrock-mantle.eu-west-1.api.aws?x=1'),
    ).toBeNull();
    expect(
      normalizeBedrockMantleBaseUrl('https://bedrock-mantle.eu-west-1.api.aws#fragment'),
    ).toBeNull();
  });

  it('extracts the region from short-term Bedrock API keys', () => {
    expect(detectBedrockRegionFromApiKey(makeShortTermBedrockKey('eu-west-1'))).toBe('eu-west-1');
  });

  it('ignores short-term Bedrock API key regions that Mantle does not support', () => {
    expect(detectBedrockRegionFromApiKey(makeShortTermBedrockKey('eu-west-3'))).toBeNull();
  });

  it('returns null for opaque or malformed keys', () => {
    expect(detectBedrockRegionFromApiKey('bedrock-api-key-not-base64')).toBeNull();
    expect(detectBedrockRegionFromApiKey('ABSKTWFudGxlQXBpS2V5LWV4YW1wbGU=')).toBeNull();
    expect(detectBedrockRegionFromApiKey('sk-test')).toBeNull();
  });

  it('returns the base model ID of a CRIS profile', () => {
    expect(getBedrockInferenceProfileBaseModelId('us.openai.gpt-6-sol')).toBe('openai.gpt-6-sol');
    expect(getBedrockInferenceProfileBaseModelId('global.moonshotai.kimi-k3')).toBe(
      'moonshotai.kimi-k3',
    );
    expect(getBedrockInferenceProfileBaseModelId('apac.amazon.nova-pro-v1:0')).toBe(
      'amazon.nova-pro-v1:0',
    );
    expect(getBedrockInferenceProfileBaseModelId('bedrock/eu.openai.gpt-6-luna')).toBe(
      'openai.gpt-6-luna',
    );
  });

  it('returns null for model IDs without a geographic scope', () => {
    expect(getBedrockInferenceProfileBaseModelId('openai.gpt-6-sol')).toBeNull();
    expect(getBedrockInferenceProfileBaseModelId('ca.openai.gpt-6-sol')).toBeNull();
    expect(getBedrockInferenceProfileBaseModelId('global.')).toBeNull();
  });

  it('builds Runtime and control-plane URLs for Bedrock regions, defaulting to us-east-1', () => {
    expect(getBedrockRuntimeBaseUrl('eu-west-1')).toBe(
      'https://bedrock-runtime.eu-west-1.amazonaws.com',
    );
    expect(getBedrockRuntimeBaseUrl('eu-west-3')).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com',
    );
    expect(getBedrockControlPlaneBaseUrl('ap-south-1')).toBe(
      'https://bedrock.ap-south-1.amazonaws.com',
    );
    expect(getBedrockControlPlaneBaseUrl(null)).toBe('https://bedrock.us-east-1.amazonaws.com');
  });
});
