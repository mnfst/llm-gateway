import { getMetadataArgsStorage } from 'typeorm';
import { AgentMessage } from './agent-message.entity';

describe('AgentMessage schema mapping', () => {
  it('keeps the legacy physical table and Autofix column names', () => {
    const metadata = getMetadataArgsStorage();
    const table = metadata.tables.find((entry) => entry.target === AgentMessage);
    const autofixDecision = metadata.columns.find(
      (entry) => entry.target === AgentMessage && entry.propertyName === 'autofix_decision',
    );

    expect(table?.name).toBe('agent_messages');
    expect(autofixDecision?.options.name).toBe('autofix_phoenix');
  });

  it('keeps the new request linkage nullable for legacy writers', () => {
    const columns = getMetadataArgsStorage().columns.filter(
      (entry) => entry.target === AgentMessage,
    );
    const column = (propertyName: string) =>
      columns.find((entry) => entry.propertyName === propertyName)?.options;

    expect(column('request_id')?.nullable).toBe(true);
    expect(column('attempt_number')?.nullable).toBe(true);
  });
});
