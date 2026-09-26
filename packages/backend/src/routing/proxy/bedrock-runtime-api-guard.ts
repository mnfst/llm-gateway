import { HttpStatus } from '@nestjs/common';
import { ManifestError } from '../../common/errors/manifest-error';
import { isBedrockProvider, isBedrockRuntimeModel } from '../bedrock-region';
import {
  bedrockRuntimeSupportsApi,
  getBedrockRuntimeCapabilities,
} from '../bedrock-runtime-capabilities';
import type { ProxyApiMode } from './proxy-types';

/** Reject an unsupported Runtime API before credentials or provider transport are touched. */
export function assertBedrockRuntimeApiSupported(
  provider: string,
  model: string,
  apiMode: ProxyApiMode,
): void {
  if (!isBedrockProvider(provider) || !isBedrockRuntimeModel(model)) return;
  if (bedrockRuntimeSupportsApi(model, apiMode)) return;

  const capabilities = getBedrockRuntimeCapabilities(model);
  const supportedApis = capabilities?.apis
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
    supportedApis: supportedApis?.join(', ') || 'none',
  });
}
