import { HttpStatus } from '@nestjs/common';
import { ManifestError } from '../../common/errors/manifest-error';
import { isBedrockProvider, isBedrockRuntimeModel } from '../bedrock-region';
import { getBedrockRuntimeCapabilities } from '../bedrock-runtime-capabilities';
import type { ProxyApiMode } from './proxy-types';

/**
 * Reject an unsupported Runtime API before credentials or provider transport
 * are touched — but ONLY when the model is in the verified capability catalog
 * and that entry explicitly excludes the requested API. An uncatalogued CRIS
 * profile (e.g. a Bedrock release newer than the catalog, or an explicitly
 * typed `global.`/`us.` profile) is forwarded optimistically so Bedrock stays
 * the authority and the fallback/autofix chain can still recover from a real
 * upstream 4xx. This matches `isBedrockRuntimeModel`'s optimistic contract and
 * avoids aborting requests a later route could serve.
 */
export function assertBedrockRuntimeApiSupported(
  provider: string,
  model: string,
  apiMode: ProxyApiMode,
): void {
  if (!isBedrockProvider(provider) || !isBedrockRuntimeModel(model)) return;

  const capabilities = getBedrockRuntimeCapabilities(model);
  // Not in the catalog: unknown, not unsupported. Forward and let Bedrock decide.
  if (!capabilities) return;
  // Catalogued and the requested API is verified: allow.
  if (capabilities.apis.includes(apiMode)) return;

  const supportedApis = capabilities.apis
    .filter((api) => api === 'chat_completions' || api === 'responses')
    .map((api) => (api === 'chat_completions' ? 'Chat Completions' : 'Responses'));
  const requestedApi =
    apiMode === 'chat_completions'
      ? 'Chat Completions'
      : apiMode === 'responses'
        ? 'Responses'
        : 'Messages';
  throw new ManifestError('M304', HttpStatus.BAD_REQUEST, {
    model,
    api: requestedApi,
    supportedApis: supportedApis.join(', ') || 'none',
  });
}
