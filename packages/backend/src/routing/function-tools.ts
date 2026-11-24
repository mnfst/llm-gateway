/** True when a Chat Completions `tools` array holds at least one `type: 'function'` tool. */
export function hasFunctionTools(tools: unknown): boolean {
  return (
    Array.isArray(tools) &&
    tools.some((tool) => (tool as { type?: unknown } | null)?.type === 'function')
  );
}
