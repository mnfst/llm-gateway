import { CliIo, clientFromFlags, printJson } from '../context';
import { CliError } from '../errors';
import { parseArgs, requirePositional, requireString, requireYes } from '../args';
import { readCredential } from '../secrets';
import { resolveDiscoveryAgent } from './provider';

/**
 * Custom providers: any OpenAI- or Anthropic-compatible endpoint (LiteLLM,
 * vLLM, a corporate gateway) registered as a tenant-global provider. `add`
 * probes the endpoint first — the server fetches its model list — and
 * registers it with the discovered models, exactly like the dashboard flow.
 */
export const providerCustom = {
  add: async (io: CliIo, argv: string[]): Promise<void> => {
    const args = parseArgs(argv, {
      strings: ['url', 'agent', 'name', 'endpoint', 'api', 'credential-env'],
      booleans: ['credential-stdin'],
      maxPositionals: 0,
    });
    const name = requireString(args, 'name');
    const baseUrl = requireString(args, 'endpoint');
    const apiKind = args.strings['api'];
    if (apiKind !== undefined && apiKind !== 'openai' && apiKind !== 'anthropic') {
      throw new CliError('invalid_flag', '--api must be "openai" or "anthropic"');
    }
    const hasCredential =
      Boolean(args.booleans['credential-stdin']) || Boolean(args.strings['credential-env']);
    const apiKey = hasCredential
      ? await readCredential(
          io,
          Boolean(args.booleans['credential-stdin']),
          args.strings['credential-env'],
          'credential',
        )
      : undefined;
    const agent = await resolveDiscoveryAgent(io, args);
    const { client } = clientFromFlags(io, args);

    const probe = (await client.request(
      'POST',
      `/routing/${encodeURIComponent(agent)}/custom-providers/probe`,
      {
        body: {
          base_url: baseUrl,
          provider_name: name,
          ...(apiKind ? { api_kind: apiKind } : {}),
          ...(apiKey !== undefined ? { apiKey } : {}),
        },
      },
    )) as { models?: Array<{ model_name?: string } | string> };
    const models = (probe.models ?? [])
      .map((m) => (typeof m === 'string' ? { model_name: m } : m))
      .filter((m): m is { model_name: string } => typeof m?.model_name === 'string');
    if (models.length === 0) {
      throw new CliError(
        'probe_empty',
        `${baseUrl} answered but exposed no models`,
        "Check the endpoint serves the provider's models endpoint (/v1/models for openai, /v1/models with an anthropic-version header for anthropic) and the credential is right",
      );
    }

    const created = await client.request(
      'POST',
      `/routing/${encodeURIComponent(agent)}/custom-providers`,
      {
        body: {
          name,
          base_url: baseUrl,
          ...(apiKind ? { api_kind: apiKind } : {}),
          ...(apiKey !== undefined ? { apiKey } : {}),
          models,
        },
      },
    );
    printJson(io, { agent, probed_models: models.length, provider: created });
  },

  list: async (io: CliIo, argv: string[]): Promise<void> => {
    const args = parseArgs(argv, { strings: ['url', 'agent'], maxPositionals: 0 });
    const agent = await resolveDiscoveryAgent(io, args);
    const { client } = clientFromFlags(io, args);
    printJson(
      io,
      await client.request('GET', `/routing/${encodeURIComponent(agent)}/custom-providers`),
    );
  },

  remove: async (io: CliIo, argv: string[]): Promise<void> => {
    const args = parseArgs(argv, {
      strings: ['url', 'agent'],
      booleans: ['yes'],
      maxPositionals: 1,
    });
    const nameOrId = requirePositional(args, 0, '<name-or-id>');
    const agent = await resolveDiscoveryAgent(io, args);
    const { client } = clientFromFlags(io, args);
    const rows = (await client.request(
      'GET',
      `/routing/${encodeURIComponent(agent)}/custom-providers`,
    )) as unknown;
    const list = (Array.isArray(rows) ? rows : []).filter(
      (r): r is { id?: string; name?: string } => typeof r === 'object' && r !== null,
    );
    const needle = nameOrId.toLowerCase();
    const hit = list.find(
      (r) => r.id === nameOrId || (typeof r.name === 'string' && r.name.toLowerCase() === needle),
    );
    if (!hit?.id) {
      throw new CliError(
        'not_found',
        `No custom provider "${nameOrId}"`,
        'See mnfst provider custom list',
        404,
      );
    }
    requireYes(args, `remove custom provider "${hit.name ?? hit.id}" (tenant-wide)`);
    printJson(
      io,
      await client.request(
        'DELETE',
        `/routing/${encodeURIComponent(agent)}/custom-providers/${encodeURIComponent(hit.id)}`,
      ),
    );
  },
};
