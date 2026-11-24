import { fetchJson, fetchMutate } from './core.js';

export function getAgents(includePlayground = false) {
  // includePlayground surfaces the reserved Playground (is_playground) agent — the
  // Messages filter opts in so the log can be filtered to Playground runs.
  return fetchJson(includePlayground ? '/agents?includePlayground=true' : '/agents');
}

export interface AgentInfo {
  agent_name: string;
  display_name: string;
  agent_category: string | null;
  agent_platform: string | null;
}

export function getAgentInfo(agentName: string): Promise<AgentInfo | null> {
  // Backend returns { agent: null } for missing agents (200), so we don't need
  // to swallow errors here. Network/server failures should propagate to the
  // caller rather than masquerade as "agent not found".
  return fetchJson<{ agent: AgentInfo | null }>(`/agents/${encodeURIComponent(agentName)}`).then(
    (data) => data?.agent ?? null,
  );
}

export function getAgentKey(agentName: string) {
  return fetchJson<{ keyPrefix: string; apiKey?: string }>(
    `/agents/${encodeURIComponent(agentName)}/key`,
  );
}

export function rotateAgentKey(agentName: string) {
  return fetchMutate<{ apiKey: string }>(`/agents/${encodeURIComponent(agentName)}/rotate-key`, {
    method: 'POST',
  });
}

export function updateAgent(
  currentName: string,
  fields: {
    name?: string;
    agent_category?: string;
    agent_platform?: string;
  },
) {
  return fetchMutate<Record<string, unknown>>(`/agents/${encodeURIComponent(currentName)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
}

export function renameAgent(currentName: string, newName: string) {
  return updateAgent(currentName, { name: newName });
}

export function deleteAgent(agentName: string) {
  return fetchMutate(`/agents/${encodeURIComponent(agentName)}`, { method: 'DELETE' });
}

export interface CreateAgentParams {
  name: string;
  agent_category?: string;
  agent_platform?: string;
  autofix_enabled?: boolean;
  record_messages?: boolean;
}

export interface DuplicateAgentPreview {
  copied: {
    providers: number;
    tierAssignments: number;
    specificityAssignments: number;
    modelParams: number;
  };
  suggested_name: string;
}

export function getDuplicatePreview(sourceName: string): Promise<DuplicateAgentPreview> {
  return fetchJson<DuplicateAgentPreview>(
    `/agents/${encodeURIComponent(sourceName)}/duplicate-preview`,
  ) as Promise<DuplicateAgentPreview>;
}

export interface DuplicateAgentResult {
  agent: { id: string; name: string; display_name: string };
  apiKey: string;
  copied: DuplicateAgentPreview['copied'];
}

export function duplicateAgent(sourceName: string, name: string) {
  return fetchMutate<DuplicateAgentResult>(`/agents/${encodeURIComponent(sourceName)}/duplicate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function createAgent(params: CreateAgentParams) {
  return fetchMutate<{
    agent: {
      id: string;
      name: string;
      display_name: string;
      agent_category: string | null;
      agent_platform: string | null;
    };
    apiKey: string;
  }>('/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}
