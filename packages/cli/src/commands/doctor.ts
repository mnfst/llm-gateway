import { ApiClient } from '../client';
import { CliIo, getConfig, printJson, resolveFromFlags } from '../context';
import { CliError } from '../errors';
import { parseArgs } from '../args';
import { detectAgentRuntime } from '../agent-runtime';
import { installedSkillPath } from './skill';

/**
 * One check. `ok: null` means the check never ran because a prerequisite
 * failed — a skipped check is not a failing one, so it does not flip the
 * exit code on its own (the check that broke the chain already did).
 */
interface Check {
  name: string;
  ok: boolean | null;
  detail: string;
  hint?: string;
  skipped?: boolean;
}

interface ConnectionRow {
  label?: unknown;
  is_active?: unknown;
  cached_model_count?: unknown;
}

interface ProviderGroup {
  provider?: unknown;
  auth_type?: unknown;
  connections?: unknown;
}

function skip(name: string, because: string): Check {
  return { name, ok: null, skipped: true, detail: `skipped — ${because}` };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The first command to run when something is wrong. Checks run in dependency
 * order — config, host, auth, providers, agents — because a bad MANIFEST_URL
 * and a bad key look identical from any single command's error. Output is one
 * JSON object; exit is non-zero when any check actually failed.
 */
export async function doctor(io: CliIo, argv: string[]): Promise<number> {
  const args = parseArgs(argv, { strings: ['url'], maxPositionals: 0 });
  const checks: Check[] = [];

  // a. config — which credential is in play, and where the origin came from.
  const target = resolveFromFlags(io, args);
  const originFrom = args.strings['url']
    ? '--url'
    : io.env['MANIFEST_URL']
      ? 'MANIFEST_URL'
      : getConfig(io).activeHost
        ? 'stored login'
        : 'default';
  checks.push({
    name: 'config',
    ok: target.source !== null,
    detail:
      target.source === 'env'
        ? `credential from MANIFEST_API_KEY (env) · origin ${target.origin} (from ${originFrom})`
        : target.source === 'config'
          ? `credential from stored login · origin ${target.origin} (from ${originFrom})`
          : `no credential for ${target.origin} (origin from ${originFrom})`,
    ...(target.source === null
      ? { hint: 'Run mnfst login, or set MANIFEST_URL + MANIFEST_API_KEY' }
      : {}),
  });

  // b. host — the public health endpoint, so it answers even without a key.
  const healthUrl = `${target.origin}/api/v1/health`;
  let hostOk = false;
  try {
    const response = await io.fetchImpl(healthUrl, {
      method: 'GET',
      // Bound the probe: a host that accepts the connection then stalls must
      // not hang doctor forever.
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let status: unknown;
    try {
      status = (JSON.parse(text) as { status?: unknown })?.status;
    } catch {
      /* non-JSON body → reported as unhealthy below */
    }
    hostOk = response.ok && status === 'healthy';
    checks.push({
      name: 'host',
      ok: hostOk,
      detail: hostOk
        ? `${healthUrl} → healthy`
        : `${healthUrl} → HTTP ${response.status}${typeof status === 'string' ? ` (${status})` : ''}`,
      ...(hostOk
        ? {}
        : {
            hint: 'the server answered but is not healthy — check the install is running and not draining',
          }),
    });
  } catch (error) {
    checks.push({
      name: 'host',
      ok: false,
      detail: `${healthUrl} → ${messageOf(error)}`,
      hint: 'host unreachable — is MANIFEST_URL correct?',
    });
  }

  // c. auth — the credential against a real authenticated endpoint. The agent
  // list doubles as the input for check (e).
  let client: ApiClient | null = null;
  let agents: unknown[] | null = null;
  if (!target.apiKey) {
    checks.push(skip('auth', 'no credential resolved'));
  } else if (!hostOk) {
    checks.push(skip('auth', 'host check failed'));
  } else {
    client = new ApiClient({
      origin: target.origin,
      apiKey: target.apiKey,
      fetchImpl: io.fetchImpl,
    });
    try {
      const result = (await client.request('GET', '/agents')) as { agents?: unknown } | null;
      agents = Array.isArray(result?.agents) ? result.agents : [];
      checks.push({ name: 'auth', ok: true, detail: `credential accepted by ${target.origin}` });
    } catch (error) {
      client = null;
      const status = error instanceof CliError ? error.status : undefined;
      // The whole point of running host BEFORE auth: a live host that rejects
      // the credential is a wrong-install / wrong-key problem. Re-logging in
      // fixes nothing when the key came from the environment.
      const hint =
        status === 401
          ? `${target.origin} is alive but this credential is not valid on it — wrong install or wrong key${
              target.source === 'env'
                ? ' (check MANIFEST_API_KEY belongs to this host)'
                : ' (the stored login may have expired — mnfst login re-authenticates)'
            }`
          : error instanceof CliError
            ? error.hint
            : undefined;
      checks.push({
        name: 'auth',
        ok: false,
        detail: messageOf(error),
        ...(hint !== undefined ? { hint } : {}),
      });
    }
  }

  // d. providers — a connection that is active with zero cached models is
  // hollow: routing resolves against discovered models, so it contributes
  // nothing and every route through it fails.
  if (!client) {
    checks.push(skip('providers', 'auth check did not pass'));
  } else {
    try {
      const result = (await client.request('GET', '/providers')) as { providers?: unknown } | null;
      const groups = (Array.isArray(result?.providers) ? result.providers : []).filter(
        (g): g is ProviderGroup => typeof g === 'object' && g !== null,
      );
      const connections = groups.flatMap((g) =>
        (Array.isArray(g.connections) ? g.connections : [])
          .filter((c): c is ConnectionRow => typeof c === 'object' && c !== null)
          .map((c) => ({
            id: `${String(g.provider)}/${String(g.auth_type)}${c.label ? `/${String(c.label)}` : ''}`,
            active: c.is_active === true,
            models: typeof c.cached_model_count === 'number' ? c.cached_model_count : 0,
          })),
      );
      const hollow = connections.filter((c) => c.active && c.models === 0);
      checks.push({
        name: 'providers',
        ok: hollow.length === 0,
        detail: `${connections.length} connection(s) across ${groups.length} provider(s)`,
        ...(hollow.length > 0
          ? {
              hint: `hollow (no discovered models — reconnect with a working credential or run: mnfst provider refresh): ${hollow
                .map((c) => c.id)
                .join(', ')}`,
            }
          : connections.length === 0
            ? { hint: 'nothing to route through yet — mnfst provider connect <provider>' }
            : {}),
      });
    } catch (error) {
      checks.push({ name: 'providers', ok: false, detail: messageOf(error) });
    }
  }

  // e. agents — free of charge from the list check (c) already fetched.
  if (agents === null) {
    checks.push(skip('agents', 'auth check did not pass'));
  } else {
    checks.push({
      name: 'agents',
      ok: true,
      detail: `${agents.length} agent(s)`,
      ...(agents.length === 0
        ? { hint: 'no agent yet — mnfst agent create --name <name> --platform <p>' }
        : {}),
    });
  }

  // f. skill — informational only. A missing operating guide is not a broken
  // install, so this check never fails the run; it just tells an agent the
  // guide exists and where it would land.
  const skillPath = installedSkillPath(io);
  const runtime = detectAgentRuntime(io.env);
  checks.push({
    name: 'skill',
    ok: true,
    detail: skillPath
      ? `installed at ${skillPath}${runtime ? ` · ${runtime.name} detected` : ''}`
      : `not_found${runtime ? ` · ${runtime.name} detected` : ''}`,
    ...(skillPath ? {} : { hint: 'mnfst skill install' }),
  });

  const ok = checks.every((c) => c.ok !== false);
  printJson(io, { ok, checks });
  return ok ? 0 : 1;
}
