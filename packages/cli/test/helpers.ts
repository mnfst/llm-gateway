import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CliIo } from '../src/context';

export interface TestIo extends CliIo {
  lines: string[];
  errLines: string[];
  configDir: string;
  lastJson(): unknown;
}

export interface TestIoOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  stdin?: string;
  isTTY?: boolean;
  openBrowser?: (url: string) => boolean;
  readSecret?: (promptText: string) => Promise<string>;
  readLine?: (promptText: string) => Promise<string>;
}

/** Hermetic CliIo: temp XDG config dir, captured output, stubbed fetch/stdin. */
export function makeIo(options: TestIoOptions = {}): TestIo {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnfst-cli-test-'));
  const lines: string[] = [];
  const errLines: string[] = [];
  return {
    // Telemetry off by default so command specs' fetch stubs see only
    // their own traffic; telemetry.spec re-enables explicitly.
    env: { XDG_CONFIG_HOME: configDir, MANIFEST_TELEMETRY_DISABLED: '1', ...options.env },
    fetchImpl:
      options.fetchImpl ??
      (async () => {
        throw new Error('unexpected fetch call');
      }),
    stdout: (line) => lines.push(line),
    stderr: (line) => errLines.push(line),
    readStdin: async () => options.stdin ?? '',
    isTTY: options.isTTY ?? false,
    ...(options.openBrowser ? { openBrowser: options.openBrowser } : {}),
    ...(options.readSecret ? { readSecret: options.readSecret } : {}),
    ...(options.readLine ? { readLine: options.readLine } : {}),
    lines,
    errLines,
    configDir,
    lastJson() {
      return JSON.parse(lines[lines.length - 1]);
    },
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** fetch stub recording calls and replying from a queue (last reply sticks). */
export function fetchStub(replies: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const reply = replies.length > 1 ? replies.shift()! : replies[0];
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.body ? { body: String(init.body) } : {}),
    });
    return jsonResponse(reply.status, reply.body);
  }) as typeof fetch;
  return { impl, calls };
}

export function writeConfig(io: TestIo, config: unknown): string {
  const dir = path.join(io.configDir, 'manifest');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}
