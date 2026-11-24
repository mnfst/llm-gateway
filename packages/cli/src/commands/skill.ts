import * as fs from 'fs';
import * as path from 'path';
import { CliIo, printJson } from '../context';
import { CliError } from '../errors';
import { parseArgs } from '../args';
import { configFilePath } from '../config';
import { detectAgentRuntime, resolveHomePath } from '../agent-runtime';
import { SKILL_MD, SKILL_VERSION } from '../skill-content.gen';

/** The one-liner that tells an agent this CLI carries its own operating guide. */
export const SKILL_NUDGE = 'AI agent operating this install? mnfst skill install';

const DEFAULT_SKILLS_DIR = '~/.claude/skills';
const AGENTS_SKILLS_DIR = '~/.agents/skills';

/** `<dir>/mnfst-cli/SKILL.md` — the only file this command ever writes. */
function skillFileIn(dir: string): string {
  return path.join(dir, 'mnfst-cli', 'SKILL.md');
}

/**
 * Print the embedded skill as raw markdown. This is the second command that
 * does not emit JSON (the first is `agent env`), and deliberately so: the
 * output is meant to be read or piped into a file, not parsed.
 */
export async function skillShow(io: CliIo, argv: string[]): Promise<void> {
  parseArgs(argv, { maxPositionals: 0 });
  io.stdout(SKILL_MD);
}

/**
 * Where the skill goes, in precedence order: an explicit flag, then the
 * detected agent runtime's own skills directory (installing into a directory
 * the running agent does not read would be theatre), then `~/.claude/skills`.
 */
function resolveTarget(
  io: CliIo,
  args: ReturnType<typeof parseArgs>,
): {
  dir: string;
  target: string;
} {
  const agentsDir = Boolean(args.booleans['agents-dir']);
  const project = Boolean(args.booleans['project']);
  if (agentsDir && project) {
    throw new CliError('invalid_flag', 'Pass one destination: --agents-dir or --project, not both');
  }
  if (project) return { dir: path.join(process.cwd(), '.claude', 'skills'), target: 'flag' };
  if (agentsDir) return { dir: resolveHomePath(io.env, AGENTS_SKILLS_DIR), target: 'flag' };
  const runtime = detectAgentRuntime(io.env);
  if (runtime) {
    return { dir: resolveHomePath(io.env, runtime.skillsDir), target: `detected:${runtime.id}` };
  }
  return { dir: resolveHomePath(io.env, DEFAULT_SKILLS_DIR), target: 'default' };
}

/**
 * Install the skill as `<dir>/mnfst-cli/SKILL.md`. Idempotent: a byte-identical
 * file is reported as `updated: false` and left untouched, so a wrapper can run
 * this on every invocation.
 */
export async function skillInstall(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, { booleans: ['agents-dir', 'project'], maxPositionals: 0 });
  const { dir, target } = resolveTarget(io, args);
  const file = skillFileIn(dir);

  if (readIfPresent(file) === SKILL_MD) {
    printJson(io, { path: file, updated: false, target, version: SKILL_VERSION });
    return;
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, SKILL_MD);
  } catch (error) {
    throw new CliError(
      'write_failed',
      `Could not write ${file}: ${error instanceof Error ? error.message : String(error)}`,
      'Check the directory is writable, or pass --project to install into the current repo',
    );
  }
  printJson(io, { path: file, updated: true, target, version: SKILL_VERSION });
}

function readIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null; // absent or unreadable — callers treat both as "not installed"
  }
}

/**
 * Every place the skill could already be installed, detected runtime first.
 * Used by `doctor` to answer "does the agent driving me have the guide?".
 * When a runtime is detected, ONLY its own skills directory counts — a guide
 * in another runtime's directory is one that runtime will never read.
 */
export function installedSkillPath(io: CliIo): string | null {
  const runtime = detectAgentRuntime(io.env);
  if (runtime) {
    const file = skillFileIn(resolveHomePath(io.env, runtime.skillsDir));
    return fs.existsSync(file) ? file : null;
  }
  const candidates = [
    resolveHomePath(io.env, DEFAULT_SKILLS_DIR),
    resolveHomePath(io.env, AGENTS_SKILLS_DIR),
    path.join(process.cwd(), '.claude', 'skills'),
  ];
  return candidates.map(skillFileIn).find((file) => fs.existsSync(file)) ?? null;
}

interface NudgeState {
  shown?: Record<string, string>;
}

function nudgeStatePath(io: CliIo): string {
  return path.join(path.dirname(configFilePath(io.env)), 'skill-nudge.json');
}

/**
 * Tell a detected agent, exactly once per runtime, that the operating guide
 * exists. It fires only after a command SUCCEEDED (a failing command's stderr
 * belongs to the failure), never for the skill commands themselves, and never
 * when the skill is already installed. Everything here is best-effort: a
 * nudge that throws would turn a working command into a broken one, so every
 * failure path is swallowed.
 */
export function maybeNudgeSkill(io: CliIo, commandKey: string): void {
  try {
    if (commandKey === 'skill' || commandKey.startsWith('skill ')) return;
    const runtime = detectAgentRuntime(io.env);
    if (!runtime) return;
    if (fs.existsSync(skillFileIn(resolveHomePath(io.env, runtime.skillsDir)))) return;

    const statePath = nudgeStatePath(io);
    const raw = readIfPresent(statePath);
    let state: NudgeState = {};
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) state = parsed as NudgeState;
      } catch {
        /* corrupt state — treat as "never shown" and rewrite below */
      }
    }
    if (state.shown?.[runtime.id]) return;

    io.stderr(
      `hint: ${runtime.name} detected — run 'mnfst skill install' to load the mnfst operating ` +
        'guide (fake-200 detection, hollow connections, tier auditing). Shown once.',
    );
    const next: NudgeState = {
      shown: { ...state.shown, [runtime.id]: new Date().toISOString() },
    };
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(statePath, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  } catch {
    /* a nudge must never affect the command */
  }
}
