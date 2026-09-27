type JsonRecord = Record<string, unknown>;

interface CallIdItem {
  index: number;
  type: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Some agents and adapters mint turn-local tool ids such as `terminal:0`. When
 * the caller resubmits its accumulated Responses history, the same id then
 * carries several `function_call` / `function_call_output` pairs, and a strict
 * Responses provider rejects the request with `Duplicate function_call_output
 * for call_id '...'` before the model runs.
 *
 * Give every repeated pair a request-unique `call_id`. Only ids whose calls and
 * outputs alternate one for one are rewritten: an unmatched call, an output
 * before its call, or two calls in a row is ambiguous, so that id is left as
 * the caller sent it. Item order, tool names, arguments and outputs never
 * change, and a history whose ids are already unique is returned untouched.
 */
export function deduplicateCallIds(input: unknown[]): unknown[] {
  const byCallId = new Map<string, CallIdItem[]>();
  const takenCallIds = new Set<string>();

  input.forEach((item, index) => {
    if (!isRecord(item)) return;
    const callId = typeof item.call_id === 'string' ? item.call_id : '';
    if (!callId) return;
    takenCallIds.add(callId);
    if (item.type !== 'function_call' && item.type !== 'function_call_output') return;
    const items = byCallId.get(callId) ?? [];
    items.push({ index, type: item.type });
    byCallId.set(callId, items);
  });

  const rewrites = new Map<number, string>();
  for (const [callId, items] of byCallId) {
    // Two entries are a single call/output pair, so there is nothing to split.
    if (items.length <= 2 || !isAlternatingPairs(items)) continue;
    for (let pair = 1; pair * 2 < items.length; pair += 1) {
      const replacement = uniqueCallId(callId, pair, takenCallIds);
      rewrites.set(items[pair * 2].index, replacement);
      rewrites.set(items[pair * 2 + 1].index, replacement);
    }
  }
  if (rewrites.size === 0) return input;

  return input.map((item, index) => {
    const replacement = rewrites.get(index);
    return replacement === undefined ? item : { ...(item as JsonRecord), call_id: replacement };
  });
}

/** True when the items read `function_call`, `function_call_output`, repeated. */
function isAlternatingPairs(items: CallIdItem[]): boolean {
  if (items.length % 2 !== 0) return false;
  return items.every((item, position) =>
    position % 2 === 0 ? item.type === 'function_call' : item.type === 'function_call_output',
  );
}

/** Deterministic replacement id, extended until it collides with nothing. */
function uniqueCallId(callId: string, pair: number, taken: Set<string>): string {
  let candidate = `${callId}-mnfst-${pair + 1}`;
  while (taken.has(candidate)) candidate += '-x';
  taken.add(candidate);
  return candidate;
}
