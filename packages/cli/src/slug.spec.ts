import { slugifyAgentName } from './slug';
import { CliError } from './errors';

// Mirrors the backend's slugify.spec.ts cases — the two implementations must
// stay behaviorally identical (the rules are frozen by existing agent slugs).
describe('slugifyAgentName', () => {
  it.each([
    ['My Cool Agent', 'my-cool-agent'],
    ['my_cool_agent', 'my-cool-agent'],
    ['TestBot', 'testbot'],
    ['agent@home!', 'agenthome'],
    ['my---cool---agent', 'my-cool-agent'],
    ['--my-agent--', 'my-agent'],
    ['My Cool_Agent', 'my-cool-agent'],
    ['John', 'john'],
    ['  padded  ', 'padded'],
  ])('slugifies %j to %j', (input, expected) => {
    expect(slugifyAgentName(input)).toBe(expected);
  });

  it('is idempotent for already-slugged names', () => {
    expect(slugifyAgentName('my-cool-agent')).toBe('my-cool-agent');
  });

  it('rejects input that slugifies to nothing', () => {
    expect(() => slugifyAgentName('!!!')).toThrow(CliError);
    expect(() => slugifyAgentName('   ')).toThrow(
      expect.objectContaining({ code: 'invalid_agent_name' }),
    );
  });
});
