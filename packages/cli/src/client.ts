import { CliError } from './errors';
import { CLI_USER_AGENT } from './version';

export interface ClientOptions {
  origin: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}

export interface RequestOptions {
  query?: Record<string, string | undefined>;
  body?: unknown;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Thin HTTP client for the Manifest management API. All paths are relative
 * to `/api/v1`. Failures become CliError with the server's message when one
 * exists — the raw API key never appears in any error.
 */
export class ApiClient {
  constructor(private readonly opts: ClientOptions) {}

  async request(method: string, apiPath: string, options: RequestOptions = {}): Promise<unknown> {
    const url = new URL(`/api/v1${apiPath}`, this.opts.origin);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      const response = await this.opts.fetchImpl(url.toString(), {
        method,
        // `manual` makes a redirect a response, not a follow: the Fetch spec
        // strips Authorization/Cookie on cross-origin hops but leaves custom
        // headers, so X-API-Key would follow to another origin. The 3xx is
        // rejected below with a message that names the redirect.
        redirect: 'manual',
        headers: {
          'X-API-Key': this.opts.apiKey,
          'User-Agent': CLI_USER_AGENT,
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        throw new CliError(
          'redirect_not_allowed',
          `The server redirected ${method} ${url.pathname} (HTTP ${response.status})`,
          'Manifest does not follow API redirects; point --url at the final origin',
          response.status,
        );
      }
      // Read the body inside the abort scope too: a server that sends headers
      // then stalls would otherwise hang forever after the timer was cleared.
      const text = await response.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }

      if (!response.ok) {
        throw this.toError(response.status, parsed);
      }
      return parsed;
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(
        'network_error',
        `Could not reach ${this.opts.origin}: ${error instanceof Error ? error.message : String(error)}`,
        'Check the URL and that the Manifest server is running',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private toError(status: number, body: unknown): CliError {
    const record =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    // The server echoes request context in some errors. Make sure our own
    // credential can never ride back out through an error message.
    const redact = (value: string): string =>
      this.opts.apiKey ? value.replaceAll(this.opts.apiKey, '[REDACTED]') : value;
    // Nest error shape: { statusCode, message: string | string[], error }
    const rawMessage = record['message'];
    const message = redact(
      Array.isArray(rawMessage)
        ? rawMessage.join('; ')
        : typeof rawMessage === 'string'
          ? rawMessage
          : `Request failed with HTTP ${status}`,
    );
    const code =
      typeof record['error'] === 'string' ? slugify(redact(record['error'])) : 'http_error';
    const hint =
      status === 401
        ? 'Run mnfst login, or set MANIFEST_API_KEY'
        : status === 404
          ? 'Check the resource name — see mnfst agent list / mnfst provider list'
          : undefined;
    return new CliError(code, message, hint, status);
  }
}

function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'http_error'
  );
}
