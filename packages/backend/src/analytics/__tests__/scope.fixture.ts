import { AnalyticsScopeService, AgentScope } from '../services/analytics-scope.service';

/** Existing service/controller tests supply already-resolved fixture identities. */
export function selectedAgent(tenantId: string | null, agentName: string): AgentScope {
  return { tenantId, agentName, agentId: agentName };
}

export function mockScopeResolver(query?: jest.Mock): AnalyticsScopeService {
  return new AnalyticsScopeService({
    query: query ?? jest.fn(async (_sql, [_tenantId, name]) => [{ id: name }]),
  } as never);
}
