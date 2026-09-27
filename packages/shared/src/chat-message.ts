export type Role = 'system' | 'user' | 'assistant' | 'tool' | 'unknown';

export interface ToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: unknown };
}

export interface ChatMessage {
  role?: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ChatTool {
  type?: string;
  function?: { name?: string; description?: string; parameters?: unknown };
}

export interface RecordedResponseBody {
  type?: 'json' | 'stream';
  body?: unknown;
  raw_sse?: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeRole(role: unknown): Role {
  if (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') return role;
  if (role === 'model') return 'assistant';
  return 'unknown';
}

export function coerceContentToText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!isRecord(part)) return typeof part === 'string' ? part : '';
        if (typeof part.text === 'string') return part.text;
        if (part.type === 'image_url' || part.type === 'input_image' || part.type === 'image') {
          return '[image]';
        }
        if (part.type === 'tool_result' && part.content != null) {
          return coerceContentToText(part.content);
        }
        if (isRecord(part.functionResponse)) {
          return prettyCompact(part.functionResponse.response);
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return prettyCompact(content);
}

function prettyCompact(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function systemMessages(value: unknown): ChatMessage[] {
  const content = coerceContentToText(value);
  return content ? [{ role: 'system', content }] : [];
}

function anthropicMessage(message: JsonRecord): ChatMessage[] {
  const role = typeof message.role === 'string' ? message.role : 'unknown';
  // Callers only route array-form Anthropic content here.
  const content = message.content as unknown[];
  const toolCalls: ToolCall[] = [];
  const normalContent: unknown[] = [];
  const toolResults: ChatMessage[] = [];

  for (const block of content) {
    if (!isRecord(block)) {
      normalContent.push(block);
      continue;
    }
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: typeof block.id === 'string' ? block.id : undefined,
        type: 'function',
        function: {
          name: typeof block.name === 'string' ? block.name : undefined,
          arguments: block.input,
        },
      });
    } else if (block.type === 'tool_result') {
      toolResults.push({
        role: 'tool',
        tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
        content: block.content,
      });
    } else {
      normalContent.push(block);
    }
  }

  const result: ChatMessage[] = [];
  if (normalContent.length > 0 || toolCalls.length > 0) {
    result.push({
      role,
      content: normalContent.length > 0 ? normalContent : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }
  return [...result, ...toolResults];
}

function responsesItem(item: JsonRecord, defaultRole: string): ChatMessage[] {
  if (item.type === 'function_call') {
    return [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id:
              typeof item.call_id === 'string'
                ? item.call_id
                : typeof item.id === 'string'
                  ? item.id
                  : undefined,
            type: 'function',
            function: {
              name: typeof item.name === 'string' ? item.name : 'unknown',
              arguments: item.arguments ?? '{}',
            },
          },
        ],
      },
    ];
  }
  if (item.type === 'function_call_output') {
    return [
      {
        role: 'tool',
        tool_call_id: typeof item.call_id === 'string' ? item.call_id : undefined,
        content: item.output ?? '',
      },
    ];
  }
  if (item.type && item.type !== 'message') return [];
  return [
    {
      role: typeof item.role === 'string' ? item.role : defaultRole,
      content: item.content,
    },
  ];
}

function geminiContents(contents: unknown[]): ChatMessage[] {
  return contents.filter(isRecord).map((content) => {
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const toolCalls: ToolCall[] = [];
    const normalContent: unknown[] = [];

    for (const part of parts) {
      if (!isRecord(part) || !isRecord(part.functionCall)) {
        normalContent.push(part);
        continue;
      }
      const call = part.functionCall;
      toolCalls.push({
        id: typeof call.id === 'string' ? call.id : undefined,
        type: 'function',
        function: {
          name: typeof call.name === 'string' ? call.name : undefined,
          arguments: call.args,
        },
      });
    }

    return {
      role:
        content.role === 'model'
          ? 'assistant'
          : typeof content.role === 'string'
            ? content.role
            : 'user',
      content: normalContent.length > 0 ? normalContent : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  });
}

export function extractRequestMessages(
  requestBody: Record<string, unknown> | null | undefined,
): ChatMessage[] {
  if (!requestBody) return [];
  if (isRecord(requestBody.request) && Array.isArray(requestBody.request.contents)) {
    requestBody = requestBody.request;
  }
  const messages: ChatMessage[] = [];

  if (requestBody.system != null) messages.push(...systemMessages(requestBody.system));
  if (typeof requestBody.instructions === 'string' && requestBody.instructions.trim()) {
    messages.push({ role: 'system', content: requestBody.instructions });
  }
  if (isRecord(requestBody.systemInstruction)) {
    messages.push(...systemMessages(requestBody.systemInstruction.parts));
  }

  if (Array.isArray(requestBody.messages)) {
    for (const message of requestBody.messages) {
      if (!isRecord(message)) continue;
      if (Array.isArray(message.content)) messages.push(...anthropicMessage(message));
      else messages.push(message as ChatMessage);
    }
    return messages;
  }

  if (typeof requestBody.input === 'string') {
    messages.push({ role: 'user', content: requestBody.input });
  } else if (Array.isArray(requestBody.input)) {
    for (const item of requestBody.input) {
      if (typeof item === 'string') messages.push({ role: 'user', content: item });
      else if (isRecord(item)) messages.push(...responsesItem(item, 'user'));
    }
  } else if (Array.isArray(requestBody.contents)) {
    messages.push(...geminiContents(requestBody.contents));
  }

  return messages;
}

export function extractRequestTools(
  requestBody: Record<string, unknown> | null | undefined,
): ChatTool[] {
  if (!Array.isArray(requestBody?.tools)) return [];
  return requestBody.tools.filter(isRecord).map((tool) => {
    if (isRecord(tool.function)) {
      return {
        type: typeof tool.type === 'string' ? tool.type : 'function',
        function: {
          name: typeof tool.function.name === 'string' ? tool.function.name : undefined,
          description:
            typeof tool.function.description === 'string' ? tool.function.description : undefined,
          parameters: tool.function.parameters,
        },
      };
    }
    return {
      type: typeof tool.type === 'string' ? tool.type : 'function',
      function: {
        name: typeof tool.name === 'string' ? tool.name : undefined,
        description: typeof tool.description === 'string' ? tool.description : undefined,
        parameters: tool.input_schema ?? tool.parameters,
      },
    };
  });
}

function extractJsonResponse(body: JsonRecord): ChatMessage[] {
  if (Array.isArray(body.choices)) {
    const choice = body.choices.find(isRecord);
    return choice && isRecord(choice.message) ? [choice.message as ChatMessage] : [];
  }
  if (Array.isArray(body.output)) {
    return body.output.filter(isRecord).flatMap((item) => responsesItem(item, 'assistant'));
  }
  if (body.type === 'message' && Array.isArray(body.content)) {
    return anthropicMessage({ role: body.role ?? 'assistant', content: body.content });
  }
  if (Array.isArray(body.candidates)) {
    const candidate = body.candidates.find(isRecord);
    return candidate && isRecord(candidate.content)
      ? geminiContents([{ ...candidate.content, role: 'model' }])
      : [];
  }
  return [];
}

function extractStreamResponse(rawSse: string): ChatMessage[] {
  let text = '';
  const toolCalls: ToolCall[] = [];
  type MutableToolCall = ToolCall & {
    function: { name?: string; arguments?: unknown };
  };
  const callsByKey = new Map<string, MutableToolCall>();

  const callFor = (key: string): MutableToolCall => {
    const existing = callsByKey.get(key);
    if (existing) return existing;
    const call: MutableToolCall = { type: 'function', function: {} };
    callsByKey.set(key, call);
    toolCalls.push(call);
    return call;
  };

  const appendArguments = (call: MutableToolCall, fragment: string) => {
    const current = call.function.arguments;
    call.function.arguments = `${typeof current === 'string' ? current : ''}${fragment}`;
  };

  for (const line of rawSse.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const payload = JSON.parse(data) as JsonRecord;
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const choice = choices.find(isRecord);
      const delta = choice && isRecord(choice.delta) ? choice.delta : undefined;
      if (typeof delta?.content === 'string') text += delta.content;
      if (Array.isArray(payload.candidates)) {
        const content = extractJsonResponse(payload)[0]?.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (isRecord(part) && typeof part.text === 'string') text += part.text;
          }
        }
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const rawCall of delta.tool_calls) {
          if (!isRecord(rawCall)) continue;
          const index = typeof rawCall.index === 'number' ? rawCall.index : 0;
          const call = callFor(`chat:${index}`);
          if (typeof rawCall.id === 'string') call.id = rawCall.id;
          if (typeof rawCall.type === 'string') call.type = rawCall.type;
          if (isRecord(rawCall.function)) {
            if (typeof rawCall.function.name === 'string') {
              call.function.name = `${call.function.name ?? ''}${rawCall.function.name}`;
            }
            if (typeof rawCall.function.arguments === 'string') {
              appendArguments(call, rawCall.function.arguments);
            }
          }
        }
      }
      if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
        text += payload.delta;
      }
      if (
        (payload.type === 'response.output_item.added' ||
          payload.type === 'response.output_item.done') &&
        isRecord(payload.item) &&
        payload.item.type === 'function_call'
      ) {
        const item = payload.item;
        const itemKey =
          typeof item.id === 'string'
            ? item.id
            : typeof item.call_id === 'string'
              ? item.call_id
              : String(payload.output_index ?? 0);
        const call = callFor(`response:${itemKey}`);
        call.id =
          typeof item.call_id === 'string'
            ? item.call_id
            : typeof item.id === 'string'
              ? item.id
              : call.id;
        if (typeof item.name === 'string') call.function.name = item.name;
        if (typeof item.arguments === 'string') call.function.arguments = item.arguments;
      }
      if (
        payload.type === 'response.function_call_arguments.delta' &&
        typeof payload.delta === 'string'
      ) {
        const itemKey =
          typeof payload.item_id === 'string' ? payload.item_id : String(payload.output_index ?? 0);
        appendArguments(callFor(`response:${itemKey}`), payload.delta);
      }
      if (
        payload.type === 'content_block_start' &&
        isRecord(payload.content_block) &&
        payload.content_block.type === 'tool_use'
      ) {
        const block = payload.content_block;
        const call = callFor(`anthropic:${String(payload.index ?? 0)}`);
        if (typeof block.id === 'string') call.id = block.id;
        if (typeof block.name === 'string') call.function.name = block.name;
        if (block.input != null) call.function.arguments = block.input;
      }
      if (payload.type === 'content_block_delta' && isRecord(payload.delta)) {
        if (typeof payload.delta.text === 'string') text += payload.delta.text;
        if (
          payload.delta.type === 'input_json_delta' &&
          typeof payload.delta.partial_json === 'string'
        ) {
          appendArguments(
            callFor(`anthropic:${String(payload.index ?? 0)}`),
            payload.delta.partial_json,
          );
        }
      }
    } catch {
      // Keep parsing later events when one provider emits a non-JSON line.
    }
  }
  return text || toolCalls.length > 0
    ? [
        {
          role: 'assistant',
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      ]
    : [];
}

export function extractResponseMessages(
  responseBody: RecordedResponseBody | null | undefined,
): ChatMessage[] {
  if (responseBody?.type === 'stream' && responseBody.raw_sse) {
    return extractStreamResponse(responseBody.raw_sse);
  }
  return responseBody?.type === 'json' && isRecord(responseBody.body)
    ? extractJsonResponse(responseBody.body)
    : [];
}

export function extractResponseToolCalls(
  responseBody: RecordedResponseBody | null | undefined,
): ToolCall[] {
  return extractResponseMessages(responseBody).flatMap((message) => message.tool_calls ?? []);
}

export function extractRecordedConversationMessages(
  requestBody: Record<string, unknown> | null | undefined,
  responseBody: RecordedResponseBody | null | undefined,
): ChatMessage[] {
  return [...extractRequestMessages(requestBody), ...extractResponseMessages(responseBody)];
}
