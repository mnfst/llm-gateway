/**
 * MCP OAuth scopes. A leaf module on purpose: guards and tools import these
 * constants without pulling in the Better Auth instance (which is ESM-only and
 * cannot be loaded by Jest on Node 22).
 */
export const MCP_READ_SCOPE = 'mcp:read';
export const MCP_WRITE_SCOPE = 'mcp:write';
export const MCP_SCOPES = [MCP_READ_SCOPE, MCP_WRITE_SCOPE] as const;
