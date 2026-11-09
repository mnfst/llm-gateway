/**
 * Shared helpers for the ChatGPT Responses API adapter.
 */

import { randomUUID } from 'crypto';

import { OpenAIMessage } from './proxy-types';

export const DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.';

export function convertAssistantToolCalls(toolCalls: unknown[]): Record<string, unknown>[] {
  return toolCalls.flatMap((toolCall) => {
    if (!isObjectRecord(toolCall) || !isObjectRecord(toolCall.function)) return [];
    return [
      {
        type: 'function_call',
        call_id: typeof toolCall.id === 'string' ? toolCall.id : randomUUID(),
        name: typeof toolCall.function.name === 'string' ? toolCall.function.name : 'unknown',
        arguments:
          typeof toolCall.function.arguments === 'string' ? toolCall.function.arguments : '{}',
      },
    ];
  });
}

export function convertTools(tools: Record<string, unknown>[]): Record<string, unknown>[] {
  return tools.map((tool) => {
    if (tool.type === 'function' && isObjectRecord(tool.function)) {
      return {
        type: 'function',
        name: tool.function.name,
        ...(tool.function.description !== undefined && { description: tool.function.description }),
        ...(tool.function.parameters !== undefined && { parameters: tool.function.parameters }),
        ...(tool.function.strict !== undefined && { strict: tool.function.strict }),
      };
    }
    return tool;
  });
}

export function convertContent(content: unknown, role: string): unknown {
  const partType = role === 'assistant' ? 'output_text' : 'input_text';

  if (content === null || content === undefined) {
    return [{ type: partType, text: '' }];
  }

  if (typeof content === 'string') {
    return [{ type: partType, text: content }];
  }

  if (!Array.isArray(content)) return content;

  return content.map((part) => {
    if (!isObjectRecord(part)) return part;
    if (part.type === 'text') return { ...part, type: partType };
    if (part.type === 'image_url' && role !== 'assistant') {
      const imageUrl = extractImageUrl(part.image_url);
      if (imageUrl) {
        return { type: 'input_image', image_url: imageUrl, ...extractImageDetail(part) };
      }
    }
    return part;
  });
}

function extractImageUrl(imageUrl: unknown): string | null {
  if (typeof imageUrl === 'string') return imageUrl;
  if (!isObjectRecord(imageUrl) || typeof imageUrl.url !== 'string') return null;
  return imageUrl.url;
}

function extractImageDetail(part: Record<string, unknown>): { detail?: string } {
  const nested = isObjectRecord(part.image_url) ? part.image_url.detail : undefined;
  const detail = typeof part.detail === 'string' ? part.detail : nested;
  return typeof detail === 'string' ? { detail } : {};
}

export function extractInstructions(messages: OpenAIMessage[]): string {
  const instructions = messages
    .filter((message) => message.role === 'system' || message.role === 'developer')
    .map((message) => extractTextContent(message.content))
    .filter((content): content is string => Boolean(content))
    .map((content) => content.trim())
    .filter(Boolean)
    .join('\n\n');

  return instructions || DEFAULT_INSTRUCTIONS;
}

export function extractTextContent(content: unknown): string | null {
  if (typeof content === 'string') return content || null;
  if (!Array.isArray(content)) return null;

  const text = content
    .filter(isObjectRecord)
    .map((part) => {
      if (!isTextPart(part.type) || typeof part.text !== 'string') return '';
      return part.text;
    })
    .join('');

  return text || null;
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isTextPart(type: unknown): boolean {
  return type === 'text' || type === 'input_text' || type === 'output_text';
}

export function safeParse(str: string): Record<string, unknown> | null {
  try {
    return JSON.parse(str) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function formatSSE(
  choice: Record<string, unknown>,
  model: string,
  usage?: Record<string, unknown>,
): string {
  const payload: Record<string, unknown> = {
    id: `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 29)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, ...choice }],
  };
  if (usage) payload.usage = usage;
  return `data: ${JSON.stringify(payload)}\n\n`;
}
