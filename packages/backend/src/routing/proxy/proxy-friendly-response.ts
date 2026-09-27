import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { Response as ExpressResponse } from 'express';
import { Tier } from '../../scoring/types';
import type { ResponseMode } from 'manifest-shared';
import type { ManifestErrorCode } from '../../common/errors/error-codes';

export interface FriendlyForward {
  response: Response;
  isGoogle: false;
  isAnthropic: false;
  isChatGpt: false;
}

export interface FriendlyResult {
  forward: FriendlyForward;
  meta: {
    tier: Tier;
    model: string;
    provider: string;
    confidence: number;
    reason: string;
    response_mode: ResponseMode;
    /**
     * Set when this 200 envelope is really a Manifest error dressed as an
     * assistant message. The controller reads it to record the row through
     * recordManifestBlockedRequest instead of the success path.
     */
    manifest_error_code?: ManifestErrorCode;
    /** The rendered `[🦚 Manifest M100] …` text, persisted verbatim as error_message. */
    manifest_error_message?: string;
  };
}

export type DashboardSection = 'routing' | 'limits';

export function getDashboardUrl(
  config: ConfigService,
  agentName?: string,
  section?: DashboardSection,
): string {
  const baseUrl =
    config.get<string>('app.betterAuthUrl') ||
    `http://localhost:${config.get<number>('app.port', 3001)}`;
  if (!agentName) return baseUrl;
  const suffix = section ? `/${section}` : '';
  return `${baseUrl}/agents/${encodeURIComponent(agentName)}${suffix}`;
}

export function buildFriendlyResponse(
  content: string,
  stream: boolean,
  reason = 'manifest_internal_error',
  errorCode?: ManifestErrorCode,
): FriendlyResult {
  const id = `chatcmpl-manifest-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  const meta: FriendlyResult['meta'] = {
    tier: 'simple' as Tier,
    model: 'manifest',
    provider: 'manifest',
    confidence: 1,
    reason,
    response_mode: stream ? 'stream' : 'buffered',
    manifest_error_code: errorCode,
    manifest_error_message: content,
  };

  if (stream) {
    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: 'manifest',
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }],
    };
    const ssePayload = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(ssePayload));
        controller.close();
      },
    });
    return {
      forward: {
        response: new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      },
      meta,
    };
  }

  const responseBody = {
    id,
    object: 'chat.completion',
    created,
    model: 'manifest',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };

  return {
    forward: {
      response: new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    },
    meta,
  };
}

/**
 * Sends a friendly chat completion response directly to the Express response.
 * Used by the exception filter where we don't return a ProxyResult.
 */
export function sendFriendlyResponse(res: ExpressResponse, content: string, stream: boolean): void {
  const id = `chatcmpl-manifest-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: 'manifest',
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }],
    };
    const ssePayload = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.status(200).send(ssePayload);
  } else {
    const responseBody = {
      id,
      object: 'chat.completion',
      created,
      model: 'manifest',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(responseBody);
  }
}
