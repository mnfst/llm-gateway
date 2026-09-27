import { describe, it, expect } from 'vitest';
import { render } from '@solidjs/testing-library';
import { providerIcon, customProviderLogo } from '../../src/components/ProviderIcon';

const KNOWN_PROVIDERS = [
  'openai',
  'anthropic',
  'bedrock',
  'byteplus',
  'cerebras',
  'copilot',
  'commandcode',
  'gemini',
  'gemini-free',
  'groq',
  'kiro',
  'deepseek',
  'mistral',
  'xai',
  'nvidia',
  'qwen',
  'moonshot',
  'openrouter',
  'vertex',
  'ollama',
  'ollama-cloud',
  'pioneer',
  'minimax',
  'xiaomi',
  'zai',
  'opencode-go',
  'opencode-zen',
];

describe('providerIcon', () => {
  for (const provider of KNOWN_PROVIDERS) {
    it(`returns an SVG for "${provider}"`, () => {
      const { container } = render(() => <div>{providerIcon(provider)}</div>);
      const svg = container.querySelector('svg');
      expect(svg).not.toBeNull();
    });
  }

  it('returns the branded <img> for "manifest"', () => {
    const { container } = render(() => <div>{providerIcon('manifest')}</div>);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('/icons/manifest.svg');
    expect(img?.getAttribute('alt')).toBe('Manifest');
  });

  it('returns the Meta logo image for "meta"', () => {
    const { container } = render(() => <div>{providerIcon('meta', 24)}</div>);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('/icons/providers/meta.svg');
    expect(img?.getAttribute('width')).toBe('24');
    expect(img?.getAttribute('height')).toBe('24');
  });

  it('returns an SVG for "llamacpp"', () => {
    const { container } = render(() => <div>{providerIcon('llamacpp')}</div>);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
  });

  it('returns the Kilo logo image for "kilo"', () => {
    const { container } = render(() => <div>{providerIcon('kilo', 24)}</div>);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/icons/kilocode.svg');
    expect(img!.getAttribute('width')).toBe('24');
    expect(img!.getAttribute('height')).toBe('24');
  });

  it('returns the Hugging Face logo image for "huggingface"', () => {
    const { container } = render(() => <div>{providerIcon('huggingface', 24)}</div>);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/icons/huggingface.svg');
    expect(img!.getAttribute('width')).toBe('24');
    expect(img!.getAttribute('height')).toBe('24');
  });

  it('returns the NousResearch logo image for "nous"', () => {
    const { container } = render(() => <div>{providerIcon('nous', 24)}</div>);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/icons/providers/nousresearch.svg');
    expect(img!.getAttribute('width')).toBe('24');
    expect(img!.getAttribute('height')).toBe('24');
  });

  it('returns the ClinePass logo image for "cline-pass"', () => {
    const { container } = render(() => <div>{providerIcon('cline-pass', 24)}</div>);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/icons/providers/cline-pass.png');
    expect(img!.getAttribute('width')).toBe('24');
    expect(img!.getAttribute('height')).toBe('24');
  });

  it('returns null for unknown provider', () => {
    const { container } = render(() => <div>{providerIcon('unknown-provider')}</div>);
    const svg = container.querySelector('svg');
    expect(svg).toBeNull();
  });

  it('uses custom size when provided', () => {
    const { container } = render(() => <div>{providerIcon('openai', 32)}</div>);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.style.width).toBe('32px');
    expect(svg!.style.height).toBe('32px');
  });

  it('uses default size of 20 when size not provided', () => {
    const { container } = render(() => <div>{providerIcon('openai')}</div>);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.style.width).toBe('20px');
    expect(svg!.style.height).toBe('20px');
  });
});

describe('customProviderLogo', () => {
  it('returns an img for a known provider name (cohere)', () => {
    const { container } = render(() => <div>{customProviderLogo('cohere')}</div>);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/icons/cohere.svg');
    expect(img!.getAttribute('alt')).toBe('cohere');
    expect(img!.getAttribute('width')).toBe('16');
    expect(img!.getAttribute('height')).toBe('16');
  });

  it('matches case-insensitively by name', () => {
    const { container } = render(() => <div>{customProviderLogo('Cohere')}</div>);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
  });

  it('returns null for an unknown provider name', () => {
    const { container } = render(() => <div>{customProviderLogo('unknown-provider')}</div>);
    const img = container.querySelector('img');
    expect(img).toBeNull();
  });

  it('uses custom size when provided', () => {
    const { container } = render(() => <div>{customProviderLogo('cohere', 24)}</div>);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('width')).toBe('24');
    expect(img!.getAttribute('height')).toBe('24');
  });

  it('resolves by base URL when name does not match', () => {
    const { container } = render(() => (
      <div>{customProviderLogo('my-cohere', 16, 'https://api.cohere.ai/v1')}</div>
    ));
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/icons/cohere.svg');
  });

  it('resolves Pioneer by base URL when name does not match', () => {
    const { container } = render(() => (
      <div>{customProviderLogo('my-provider', 16, 'https://api.pioneer.ai/v1')}</div>
    ));
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/icons/pioneer.svg');
  });

  it('resolves Vertex AI by base URL when name does not match', () => {
    const { container } = render(() => (
      <div>
        {customProviderLogo(
          'my-provider',
          16,
          'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1',
        )}
      </div>
    ));
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/icons/vertex.svg');
  });

  it.each(['vertex', 'google-vertex', 'vertex-ai', 'Vertex AI'])(
    'resolves %s to the branded inline Vertex icon via the shared registry',
    (name: string) => {
      const { container } = render(() => <div>{customProviderLogo(name)}</div>);
      expect(container.querySelector('svg')).not.toBeNull();
    },
  );

  it('falls back to the Vertex logo image for an unregistered Vertex name', () => {
    const { container } = render(() => <div>{customProviderLogo('Google Vertex AI')}</div>);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/icons/vertex.svg');
  });

  it('resolves Azure by name', () => {
    const { container } = render(() => <div>{customProviderLogo('Microsoft Azure')}</div>);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/icons/azure.svg');
  });

  it('resolves Azure by base URL', () => {
    const { container } = render(() => (
      <div>{customProviderLogo('my-provider', 16, 'https://my-instance.openai.azure.com/v1')}</div>
    ));
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/icons/azure.svg');
  });

  it('returns null when base URL does not match any pattern', () => {
    const { container } = render(() => (
      <div>{customProviderLogo('custom', 16, 'https://api.example.com/v1')}</div>
    ));
    const img = container.querySelector('img');
    expect(img).toBeNull();
  });

  it('returns null when no base URL and name is unknown', () => {
    const { container } = render(() => <div>{customProviderLogo('random')}</div>);
    const img = container.querySelector('img');
    expect(img).toBeNull();
  });

  it.each([
    ['llama.cpp', 'llamacpp'],
    ['llama-cpp', 'llamacpp'],
    ['LM Studio', 'lmstudio'],
    ['lm-studio', 'lmstudio'],
    ['Ollama', 'ollama'],
  ])(
    'resolves %s to the branded local-LLM logo via the shared registry',
    (name: string, expectedSrcMatch: string) => {
      const { container } = render(() => <div>{customProviderLogo(name)}</div>);
      const img = container.querySelector('img');
      // Ollama renders as an inline SVG via providerIcon('ollama'), so it
      // won't produce an <img>. The others have PNG icons.
      if (img) {
        expect(img.getAttribute('src')).toContain(expectedSrcMatch);
      } else {
        expect(container.querySelector('svg')).not.toBeNull();
      }
    },
  );

  it("returns the branded gemini icon (shared registry match) for provider name 'Gemini'", () => {
    // "Gemini" normalizes to the shared provider id `gemini`, which has a
    // branded SVG from `providerIcon`. Custom providers with a canonical
    // shared name now prefer the branded icon over the legacy <img>.
    const { container } = render(() => <div>{customProviderLogo('Gemini')}</div>);
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('resolves gemini logo by googleapis base URL', () => {
    const { container } = render(() => (
      <div>
        {customProviderLogo(
          'my-provider',
          16,
          'https://generativelanguage.googleapis.com/v1beta/openai/',
        )}
      </div>
    ));
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/icons/gemini.svg');
  });

  it("resolves gemini logo by model name containing 'gemini'", () => {
    const { container } = render(() => (
      <div>{customProviderLogo('custom', 16, 'https://example.com', 'gemini-2.5-pro')}</div>
    ));
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/icons/gemini.svg');
  });

  it('returns null when model name does not match any pattern', () => {
    const { container } = render(() => (
      <div>{customProviderLogo('custom', 16, 'https://example.com', 'gpt-4o')}</div>
    ));
    const img = container.querySelector('img');
    expect(img).toBeNull();
  });

  it('resolves qwen logo by model name prefix', () => {
    const { container } = render(() => (
      <div>{customProviderLogo('custom', 16, undefined, 'qwen/qwen3.6-plus:free')}</div>
    ));
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/icons/qwen.svg');
  });

  it('resolves nvidia logo by model name prefix', () => {
    const { container } = render(() => (
      <div>
        {customProviderLogo('custom', 16, undefined, 'nvidia/nemotron-3-super-120b-a12b:free')}
      </div>
    ));
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/icons/nvidia.svg');
  });

  it('falls back to provider name when model prefix has no logo', () => {
    const { container } = render(() => (
      <div>{customProviderLogo('Kilo Code', 16, undefined, 'stepfun/step-3.5-flash:free')}</div>
    ));
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/icons/kilocode.svg');
  });

  it('resolves kilo code logo by provider name', () => {
    const { container } = render(() => <div>{customProviderLogo('Kilo Code')}</div>);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/icons/kilocode.svg');
  });

  it('resolves canonical kilo logo by provider name', () => {
    const { container } = render(() => <div>{customProviderLogo('Kilo')}</div>);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/icons/kilocode.svg');
  });

  it('resolves kilo code logo by base URL', () => {
    const { container } = render(() => (
      <div>{customProviderLogo('custom', 16, 'https://api.kilo.ai/api/gateway')}</div>
    ));
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/icons/kilocode.svg');
  });

  it('returns null when model prefix matches but no logo and name unknown', () => {
    const { container } = render(() => (
      <div>{customProviderLogo('unknown', 16, undefined, 'corethink:free')}</div>
    ));
    const img = container.querySelector('img');
    expect(img).toBeNull();
  });
});
