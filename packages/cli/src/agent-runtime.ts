import * as os from 'os';
import * as path from 'path';
import { Env } from './config';

export interface AgentRuntime {
  id: string;
  name: string;
  /** Where that runtime looks for skills, `~`-relative — resolved at use site. */
  skillsDir: string;
}

/**
 * Coding agents export marker variables into the shells they spawn, so a
 * command run BY an agent is distinguishable from one a human typed. The table
 * is explicit on purpose: no heuristics, no sniffing parent processes — adding
 * a runtime is one line, and a wrong guess is worse than no detection because
 * the only thing detection drives is an unsolicited stderr line.
 */
const AGENT_RUNTIMES: ReadonlyArray<AgentRuntime & { markers: readonly string[] }> = [
  {
    markers: ['CLAUDECODE'],
    id: 'claude-code',
    name: 'Claude Code',
    skillsDir: '~/.claude/skills',
  },
  { markers: ['CURSOR_TRACE_ID'], id: 'cursor', name: 'Cursor', skillsDir: '~/.agents/skills' },
  {
    markers: ['CODEX_SANDBOX', 'CODEX_HOME'],
    id: 'codex',
    name: 'Codex CLI',
    skillsDir: '~/.agents/skills',
  },
];

/** The agent driving this CLI, or null when a human (or plain script) is. */
export function detectAgentRuntime(env: Env): AgentRuntime | null {
  for (const { markers, ...runtime } of AGENT_RUNTIMES) {
    if (markers.some((marker) => env[marker])) return runtime;
  }
  return null;
}

/**
 * Expand a leading `~`. HOME wins over os.homedir() for the same reason POSIX
 * does it that way — it is the documented way to point a process at a
 * different home, and it keeps this testable without mocking the os module.
 */
export function resolveHomePath(env: Env, dir: string): string {
  const home = env['HOME'] || os.homedir();
  return dir.startsWith('~/') ? path.join(home, dir.slice(2)) : dir;
}
