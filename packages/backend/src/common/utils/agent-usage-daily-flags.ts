let automaticReadsReady = false;

export function setAgentUsageDailyAutomaticReadsReady(ready: boolean): void {
  automaticReadsReady = ready;
}

export function agentUsageDailyReadsEnabled(tenantId: string | null): boolean {
  if (!tenantId) return false;
  if (process.env['AGENT_USAGE_DAILY_READS'] === 'false') return false;
  if (process.env['AGENT_USAGE_DAILY_READS'] === 'true') return true;
  const selected = process.env['AGENT_USAGE_DAILY_READ_TENANTS'];
  if (selected) {
    return selected
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .includes(tenantId);
  }
  return automaticReadsReady;
}
