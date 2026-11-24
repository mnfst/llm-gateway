const ANTHROPIC_PREFIX = 'anthropic/';
const SHORT_ANTHROPIC_MODEL_RE = /^claude-(opus|sonnet|haiku)-/i;
const DOTTED_MINOR_RE = /-(\d+)\.(\d{1,2})(?=$|-\d{8}$)/g;
const DASHED_MINOR_RE = /-(\d+)-(\d{1,2})(?=$|-\d{8}$)/g;

function splitAnthropicPrefix(model: string): { prefix: string; bare: string } {
  if (model.startsWith(ANTHROPIC_PREFIX)) {
    return {
      prefix: ANTHROPIC_PREFIX,
      bare: model.slice(ANTHROPIC_PREFIX.length),
    };
  }
  return { prefix: '', bare: model };
}

function supportsShortAnthropicMinorVersion(model: string): boolean {
  return SHORT_ANTHROPIC_MODEL_RE.test(model);
}

export function normalizeAnthropicShortModelId(model: string): string {
  const { prefix, bare } = splitAnthropicPrefix(model);
  if (!supportsShortAnthropicMinorVersion(bare)) return model;
  return `${prefix}${bare.replace(DOTTED_MINOR_RE, '-$1-$2')}`;
}

export function buildAnthropicShortModelIdVariants(model: string): string[] {
  const normalized = normalizeAnthropicShortModelId(model);
  const { prefix, bare } = splitAnthropicPrefix(normalized);
  if (!supportsShortAnthropicMinorVersion(bare)) return [model];

  const variants = new Set<string>([model, normalized]);
  variants.add(`${prefix}${bare.replace(DASHED_MINOR_RE, '-$1.$2')}`);
  return [...variants];
}

/**
 * The model id the proxy forwards — and looks model params up under — for a
 * stored route. Anthropic accepts dotted short ids (`claude-sonnet-4.5`) that
 * it only serves in their dashed form.
 */
export function normalizeProviderModel(provider: string, model: string): string {
  return provider.toLowerCase() === 'anthropic' ? normalizeAnthropicShortModelId(model) : model;
}
