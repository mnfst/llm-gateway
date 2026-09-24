# manifest

## 6.26.1

### Patch Changes

- ce10922: Stop adding five-minute cache breakpoints to Anthropic Messages requests that already use one-hour breakpoints (Claude Code), which Anthropic rejected with a 400, and explain in the Claude Code setup card how to get a 1M context window through the gateway.

## 6.26.0

### Minor Changes

- cff25d5: Read and set model params (reasoning effort, temperature, …) per tier and model from the CLI (`mnfst routing params get|set`) and the MCP server (`manifest_routing_params_get|set`).

### Patch Changes

- ddb7e76: Autofix no longer counts a healed streaming retry as recovered when its stream never delivers data and a fallback serves the request instead.
- 95e45b0: A provider that sends response headers and then times out or drops the connection mid-body on a non-streaming request now falls back to the next route and is recorded as a provider 503/504, instead of an M500 with no fallback. Manifest errors raised after routing (M500) now keep their tier, specificity and header-tier fields, so tier filters find them.
- abd760e: Cancel every pending provider attempt when the caller disconnects mid fallback chain, not only the last one.
- 8c3b4c3: Make harness-scoped Requests filters (status, error origin) fast on a cold cache: the harness index now covers the columns they test, so a large harness no longer reads one row per request in range.
- 5fbcf53: Refreshing or listing providers through the MCP tools now reports a custom provider's real model count. It always showed 0, which looked like the refresh had wiped the models entered by hand; they were never touched.
- bc7f9c4: You can now disconnect, rename, or refresh a provider connection when the workspace has no harness. The connection page used to refuse with "Create at least one harness before disconnecting a provider."
- 11971a7: Fallback routes now get the same stream warm-up as the primary, so a fallback that returns 200 and never streams a byte moves on to the next route.
- 70dc9c8: Keep chat models without tool calling (e.g. Groq's allam-2-7b) in provider catalogs; discovery now drops only models that cannot take or return text.
- dbef439: M101 now says a harness has no model to route to and links to picking a default model. It used to say "no providers are set up yet", which was wrong for a new harness whose providers were connected but had no default model selected.
- 107dfac: Stop overlapping deployments from deadlocking on a concurrent index build: a deployment waiting for the migration lock now polls for it instead of holding a database snapshot while it waits.
- 298a5a3: Make Requests log filters fast on a cold cache: harness, status, origin, trigger, provider, and model filters no longer scan every request in range one heap page at a time.
- 7226cec: Remove the public usage stats endpoints (`/api/v1/public/usage`, `/free-models`, `/provider-tokens`, `/agent-tokens`, `/free-providers`). They scanned the whole Provider Attempt table for minutes on every refresh. The public error pages endpoint and `MANIFEST_PUBLIC_STATS` are unchanged.
- 478b069: Setting a route or fallback now accepts every name Manifest publishes for a model: the id shown in `/v1/models` (including a custom provider's alias), a custom model's bare name next to its provider, or the internal id. Before, a brand-new harness rejected valid custom-provider and OpenRouter models with an unrelated "choose from" list; that hint now lists the named provider's own models.
- da49b80: A subscription token that a provider rejects with a 401 before its expiry is now actually refreshed and retried. Before, the refresh was skipped because the stored token had not expired yet, so every request failed on the dead token and fell back. A credential that still gets a 401 (refresh rejected, account refused, or a revoked API key) is now skipped for five minutes instead of being retried on every request, and reconnecting or replacing it is picked up at once.
- 48b5277: Stop offering new Google (Gemini) subscription connections, which Google now refuses, and point users to a Gemini API key instead. Existing Google subscription connections are untouched and stay manageable. OAuth paste forms now show the server's actual error.

## 6.25.5

### Patch Changes

- 22c9525: Precompute daily harness usage so the harness list no longer aggregates raw request history after rollout.
- e78d3a8: Keep daily usage backfill transactions below the database timeout on large histories.
- ebd6568: Load Overview and Harness Overview usage from daily rollups for long ranges, without blocking the page on raw model and recent-request queries.
- f87fba4: Fix remote MCP connections stalling in Claude Code. `subscriptions/listen` is served over SSE whatever the response mode says, and buffering that body held back the acknowledgement the client waits for, so every listen attempt hung until the client timed out and the connection handshake stalled behind it. Stream those responses instead, and stop advertising `tools.listChanged`, which a per-request server can never send.
- 013d285: Brand the dashboard as Manifest LLM Gateway: new logo sized by height, and the sidebar card now links to Manifest at dashboard.manifest.build instead of the closed waiting list.

  The gateway cloud is app.manifest.build again: CLI and n8n defaults, email links, share previews and the OTLP migration message use it instead of gateway.manifest.build.

- c99e02e: Index Autofix Provider Attempts so filtered Requests loads avoid reading unrelated attempts.
- 0e84ab5: Index recorded provider attempts so the nightly request-recording retention job reads a short index range instead of scanning the whole attempts table.
- 83e427c: Switch dashboard usage reads to daily rollups automatically after backfill catch-up.

## 6.25.4

### Patch Changes

- 6727c89: Faster first paint of the dashboard: sessions are validated from a signed cookie (Better Auth cookie cache, 5 minute max age) instead of a database round trip on every request, and the plan lookup no longer waits behind the session probe. A failed plan lookup is no longer remembered for the session.
- 5c206d7: Fix self-hosted HTTP deployments failing to start after remote MCP became mandatory. `@better-auth/mcp` rejects a non-loopback HTTP resource URL while the plugin is constructed, so an install with a plain-HTTP `BETTER_AUTH_URL` (a LAN or tailnet hostname) exited before listening. Manifest now runs without the MCP surface on such an origin instead of refusing to boot, and `MCP_ENABLED=false` switches MCP off explicitly.
- 2d80449: Speed up the first Overview load: the notification bell no longer refetches the workspace Autofix status on every gateway request and polls once a minute instead of every 15 seconds, and a partial index over unlinked provider attempts (`request_id IS NULL`) stops the Overview and Autofix analytics from scanning ~300 MB of the `agent_messages` heap twice per call.

## 6.25.3

### Patch Changes

- c494805: Fix the per-harness Overview and Requests pages being slow on workspaces with a lot of traffic. The filter that hides Playground traffic re-read the agents table once per row, which on a busy harness meant tens of thousands of sequential scans. It now reads it once per query. Measured on production, the timeseries behind the Overview went from 24.7s to 0.3s and the requests chart from 26.2s to 0.7s, with identical results.
- 5f4c69c: Lead with Allow on the remote MCP consent screen and move Deny below it as a secondary button.
- 0f5ba81: Name gateway models correctly: OpenCode Go models that the underlying vendor's catalog does not list (e.g. `deepseek-v4.1-flash`) now read their name and capabilities from the gateway's own models.dev catalog instead of falling back to the raw model id, the Requests log resolves gateway ids through the pricing catalogue so it matches the routing page, the model picker hides an OpenCode Go id only when a published one already stands for the same model, and a promotional OpenCode Go quota row is parsed instead of skipped.

## 6.25.2

### Patch Changes

- a782be5: Replace the CLI npm README with a public quick start and remove development-only details.
- c140bd1: Fix the CLI npm publish, which failed on provenance because the package did not declare public access.
- 77792bc: Forward the caller's `anthropic-beta` header on native Messages requests to Anthropic instead of dropping it. Manifest builds the upstream header set from scratch, so a beta flag the caller sent never arrived: the API-key path sent no flag at all and the subscription path sent a fixed list. A request whose body used a beta-gated field was then validated against the non-beta schema and rejected. The caller's flags are now appended to Manifest's own, on the primary forward, the Autofix retry and fallback hops.

  Scope is deliberately narrow. Only `POST /v1/messages` to Anthropic itself, including a custom provider row pointed at it. Translated OpenAI-shaped requests are excluded, because their responses come back through converters that understand only known content blocks. The Anthropic-compatible third parties (Bedrock, BytePlus, CommandCode, MiniMax, Kimi, OpenCode Go) are excluded too.

- 0c2273f: Show an email verification recovery path when social sign-in finds an unlinked account.
- 099e20d: Make MCP OAuth registration and callback errors actionable, and resume signed authorization after login.
- 0d44d41: Point every repository URL at `mnfst/llm-gateway` after the rename. The GitHub stars endpoint, the self-hosted update check, the `docker/install.sh` download source and the Docker image source label no longer rely on GitHub's redirect from the old name.
- 5438859: Restore app.manifest.build as the default Cloud setup URL while keeping gateway.manifest.build available for existing MCP clients.
- 8cbf2bf: Resolve the Better Auth `baseURL` per request when the dashboard and the API answer on more than one host. The OAuth `redirect_uri` and the session cookie are pinned to `baseURL`, so with a single static origin a sign-in started on `app.manifest.build` returned to `gateway.manifest.build` and set the cookie there — an origin the dashboard cannot read, which stranded the user. Allowed hosts are derived from `BETTER_AUTH_URL`, `CORS_ORIGIN`, and the optional `BETTER_AUTH_ALLOWED_HOSTS`; unknown hosts fall back to the canonical `BETTER_AUTH_URL`, and development keeps the static origin.

## 6.25.1

### Patch Changes

- e765308: Publish the CLI as `mnfst-gateway-cli` instead of `@mnfst/gateway-cli`. The scoped publish failed because the `@mnfst` npm organization does not exist. Install with `npm i -g mnfst-gateway-cli`; the command is still `mnfst`.

## 6.25.0

### Minor Changes

- e1de563: Fallback-exhausted responses now say what the provider said. The error message leads with the primary provider's own sentence followed by a one-line summary of every attempt, `source` is always `provider` (the exhaustion is a routing outcome, carried by a new `fallback_exhausted: true` flag and the existing `X-Manifest-Fallback-Exhausted` header, not an error class), and `code` holds only the provider's own code. Each `attempted_fallbacks` entry now carries its sanitized `message`, `code` and `auth_type`, plus a request-scoped `autofix` summary (`applied`, `original_status`, `retry_status`) on the primary and on any hop where Phoenix was consulted. The provider-error parsers also understand FastAPI-style `{detail}` bodies (how ChatGPT Codex rejects an unsupported model) and bare `{"error":"…"}` strings, so those messages are no longer collapsed to a generic "Bad request to upstream provider".
- 1dbd49f: Add an Integrations section to the dashboard sidebar with pages for the MCP server and the CLI. The MCP page shows this install's own endpoint and copy-paste setup for Claude Code, Codex and OpenCode; the CLI page shows the npm install and a login command that carries the host on self-hosted.
- b43f461: Publish the management CLI to npm as `@mnfst/gateway-cli`. Install it with `npm i -g @mnfst/gateway-cli` instead of building the monorepo; the command is still `mnfst`. Its version tracks the Manifest release it ships with.
- 81e6cb5: Requests log: filter by model, and isolate cancelled requests. The Model filter is multi-select and matches any provider attempt on the request, so filtering by the primary of a fallback chain still finds the request it was recovered on; a request Manifest blocked before any provider call matches on its requested model, which is what the Model column shows for those rows. `Cancelled` becomes its own status instead of being counted as `Failed`. The Min/Max $ inputs are gone — filtering by an absolute cost threshold required already knowing the distribution you were trying to find.

### Patch Changes

- c1b2d32: Fix the Release workflow, which failed on every merge to main after the CLI publishing change. Stamping the CLI version during the version PR made changesets look for a changelog the CLI does not have.
- aca3257: Forward the caller's `anthropic-beta` header to Anthropic instead of dropping it. Manifest built the upstream header set from scratch, so a beta flag the caller sent never arrived: the API-key path sent no flag at all and the subscription path sent a fixed list that goes stale whenever Anthropic ships a new beta. Body fields those betas gate (`output_config`, `context_management`, `diagnostics`, `speed`, `thinking.adaptive`) then came back as `<field>: Extra inputs are not permitted`. The caller's flags are now appended to Manifest's own, sanitized and bounded, on the primary forward, the Autofix retry and fallback hops. Anthropic-compatible third parties (Bedrock, BytePlus, CommandCode, MiniMax, Kimi, OpenCode Go) are unaffected.
- b02d350: Use gateway.manifest.build for cloud dashboard links and share previews. Build email image URLs from the configured dashboard URL so self-hosted installations use their own assets.

  Use gateway.manifest.build for n8n and management CLI API defaults and the deprecated OTLP migration message. Generate SDK examples from the current dashboard origin.

  Send self-hosted pivot waitlist submissions to gateway.manifest.build and allow that origin in the dashboard content security policy.

- a50e129: Keep harness type selectors within compact dialogs by stacking category groups in two columns, switching to one column on mobile, and scrolling long menus. Share the option rendering between the creation dropdown and settings dialog.
- 11b3942: The pivot waiting-list modal describes the new product and lists its three advantages.
- 006e904: Show custom tiers in the Requests Tier filter. The log spans every harness unless one is picked, but the filter only listed custom tiers of a selected harness, so on the default view there were none to pick. Tier options now come from the tenant-scoped filter metadata, and same-named tiers on different harnesses share one option that matches all of them.

## 6.24.0

### Minor Changes

- b415978: Run Autofix on failed **fallback** attempts, not just the primary. Previously a fallback that failed with a repairable request-side 4xx (for example an unsupported `response_format`) was recorded as a dead hop even when Phoenix already had a patch for that model. Each failed fallback is now handed to Phoenix and its patched body is retried on the same fallback transport, so a request can be recovered without burning the rest of the chain. Consent is unchanged: Autofix only runs for agents that opted in.
- f0b9432: Add a remote MCP server at `POST /api/v1/mcp` with OAuth 2.1. Better Auth's MCP plugin provides the authorization server (PKCE, resource-bound JWT access tokens, CIMD client identity, RFC 8414/9728 discovery), and `requireMcpAuth` gates the route. Tools reuse the same services as the REST API and CLI — agents, provider connections (including custom providers), routing (status, fallbacks, Autofix, recording, custom/header tiers), models, pricing, the request ledger, and a dependency-ordered `doctor`. Read tools require `mcp:read`; write tools are hidden unless the token carries `mcp:write`. Adds a `/consent` page.
- f7f07b4: Add the mnfst management CLI (packages/cli) and a GET /api/v1/me identity endpoint. One login with a global API key, then agents, providers, routing, and analytics are manageable from the terminal without the dashboard.

### Patch Changes

- 97d7b05: Fix Anthropic server tools (web_search, bash, computer, etc.) being forwarded to non-Anthropic providers with no `parameters` field, which some providers reject with a 400.
- b940f39: Harden the mnfst CLI auth and command edges: refuse HTTP redirects so the workspace API key cannot leak cross-origin, strip inherited `MANIFEST_AGENT_KEY`/`MANIFEST_API_KEY` (and variant casing) from `mnfst run` children, require the requested `--auth-type` on `agent configure`'s primary model so an unroutable route is rejected before any write, and report clearer errors for a raced key file, an array-valued config, and a JSON `null` token response.
- 5eb95bd: The mnfst CLI no longer sends a telemetry request per command. Commands are recorded in a local spool (`~/.config/manifest/telemetry-spool.jsonl`, mode 0600) and shipped in one anonymous request per install per day to `/v1/cli-report`, matching the self-hosted install report. The first command ever flushes immediately so a new install is counted the day it appears; the spool is capped at 500 events and a failed send is retried at most hourly. The wire payload is reshaped into one envelope per request: `schema_version`, `anon_id`, `cli_version`, and `os` now sit on the envelope with an `events` array beneath it (each event keeps `command`, `ok`, `duration_ms`, `agent_runtime`, plus a minute-precision `at`). No new data is collected, and the `MANIFEST_TELEMETRY_DISABLED=1` opt-out is unchanged.
- 1d03ae2: The mnfst CLI's daily telemetry batch now carries `target`: `cloud` or `self-hosted`, the class of Manifest the install points at (same precedence as command resolution: `MANIFEST_URL`, then the active config host, then Cloud). Never the URL. Lets Peacock's CLI usage page split the two populations. Opt-out unchanged.
- 326ecb5: The remote MCP endpoint answers GET and DELETE with 405 + `Allow: POST` as the Streamable HTTP spec requires for a stateless JSON transport, instead of a 404 that clients logged on every connect. `mnfst routing test` now sends `User-Agent: mnfst-cli/<version>` so the gateway's caller attribution can tell CLI test traffic apart.
- 62433aa: Fix OpenAI subscription model discovery so newer Codex CLI models (e.g. `gpt-6-astra`) appear. OpenAI gates `gpt-6-astra` behind Codex CLI `0.153.0`+, and the `/backend-api/codex/models` endpoint silently returns the older model subset for older `client_version` values. Bump `CODEX_CLI_VERSION` from `0.128.0` to `0.154.0`.
- 148c7f7: Speed up the harness and global Overview Autofix cards. The request window is now scanned once for both the current and previous period instead of twice, halving the heaviest query behind the reliability KPIs.
- 073d55a: Kiro requests record real token usage instead of always logging zeros. Live `GenerateAssistantResponse` streams carry no per-token counts (only `assistantResponseEvent` content and a credit-based `meteringEvent`), so usage is estimated from the request conversation and the emitted text and marked `estimated: true`. When Kiro does send an explicit `tokenUsage` block it is used verbatim, and the cache read/write breakdown is preserved so `cache_read_tokens` / `cache_creation_tokens` populate the request log. Unknown Kiro event types are logged at debug.
- abc0183: Return `M302` ("model not available") instead of `M101` ("no providers configured") when a pinned routing override names a model its connection no longer offers and no fallback route resolves. Only applies while the override's provider connection still exists, so a genuinely unconfigured agent keeps the neutral `M101`.
- 4f674c9: Drop the unsupported `thinking` parameter before forwarding requests to NVIDIA Nemotron models served through OpenRouter (e.g. `nvidia/nemotron-3-ultra-550b-a55b`), which validate params strictly and otherwise reject it with a 400. The strip is scoped to the Nemotron family via the bare model id, so the general OpenRouter passthrough for Gemma, DeepSeek, Kimi, etc. is unchanged.
- a5de1c2: Refresh the Google Code Assist subscription model catalog. Add the current Generally Available `gemini-3.5-flash` (the model the latest Gemini/Antigravity CLI defaults to) and drop the retired `gemini-3.1-flash-lite-preview` preview alias. Gemini Code Assist does not expose a `/models` endpoint, so this curated list is what the routing UI offers; models outside it 404 at chat time. Also correct the provider tile and README, which advertised a non-existent "Gemini 3.6 Flash" and a "Gemini 3.1 Pro" the subscription does not offer.
- b630d2c: Self-hosted telemetry now reports CLI and remote-MCP adoption: `mnfst login` key counts and 7-day actives, plus MCP OAuth client, consent, and 24h access-token counts, with client names whitelisted to known MCP hosts. All fields are additive aggregates read from existing tables; no per-call counter or new table.

## 6.23.4

### Patch Changes

- 483d6c1: Close object schemas in Anthropic structured output. Every `type: object` node in `output_config.format.schema` now gets `additionalProperties: false` (unless the author set it), on both the chat-completions → Anthropic translation and the native `/v1/messages` pass-through, so Anthropic no longer rejects requests with "For 'object' type, 'additionalProperties' must be explicitly set to false".
- 8f4fd02: Fix Kiro agent loops. When a request ends on a tool result with no new user text, leave the current Kiro turn empty instead of synthesizing `continue` (or leaving the system prompt there). Kiro read that fabricated text as a fresh instruction and dropped the in-flight task, so tool-calling agents (opencode et al.) lost context immediately after the first tool call. The system prompt now rides the conversation's first user turn so it still reaches the model.

## 6.23.3

### Patch Changes

- 5f02d11: Leave model-specific provider corrections to Autofix. Keep provider-level protocol strips (OpenAI-only fields, OpenRouter and Ollama dialect fields) so traffic does not regress when Autofix is off.
- 07a962b: Fix Kiro tool calling. Forward OpenAI tool definitions as Kiro tool specifications, map assistant `tool_calls` and `tool` role messages into Kiro `toolUses`/`toolResults`, and return Kiro `toolUseEvent` frames as OpenAI `tool_calls` (with `finish_reason: tool_calls`) in both streaming and non-streaming responses.

## 6.23.2

### Patch Changes

- 6b0bbc9: Fix DeepSeek thinking-mode 400s by replaying `reasoning_content` under the scoped session key and covering non-tool assistant turns in tool conversations.
- 340628f: Give repeated tool call ids unique values when converting a Chat Completions request to Responses, so reused ids no longer trip a strict Responses provider's "Duplicate function_call_output for call_id".
- 922fefd: Give repeated tool call ids unique values before forwarding a Responses history, so strict Responses providers stop rejecting resubmitted turns with "Duplicate function_call_output for call_id".

## 6.23.1

### Patch Changes

- b2edaaa: Stop the internal CRM metrics feed timing out over long windows by dropping the provider breakdown it no longer needs.
- 3c8ffb6: Bill DeepSeek V4.1 Flash at the published peak/off-peak rates, and switch `deepseek-v4-pro` onto that card from 2026-09-14 04:00 UTC.
- b60eeb4: Recognize n8n community node requests from User-Agent so request details can show the node as the caller.
- 3efbe8e: Keep streaming requests as success when the caller closes after a terminal provider event.

## 6.23.0

### Minor Changes

- 8076d88: Add OpenAI Codex as a coding-assistant agent platform. Codex shows up in the agent picker with a copy-ready `~/.codex/config.toml` setup panel that points Codex CLI and Desktop at Manifest over the Responses API (`wire_api = "responses"`) and authenticates with your `mnfst_` key. Two upstream-compatibility fixes make Codex work against non-OpenAI providers: Responses-API `role: "developer"` instruction messages are folded into `system`, and OpenAI-hosted tools (`web_search`, `file_search`, …) are dropped on the Chat Completions path. Native Responses upstreams keep developer roles and hosted tools untouched.

  Preserve streamed function calls and namespaced client tools through non-OpenAI providers, including parallel calls and tool-result replay.

- f1a50eb: Add an internal, secret-guarded feed of the users whose requests Autofix repaired, so outreach can reach them with their real repair counts.

### Patch Changes

- 8ccecc8: Remove the $25 Gemini credit user-discovery banner and modal from the Overview page.

## 6.22.0

### Minor Changes

- 5b5eac7: Custom providers now have an alias, the readable prefix their models are published under in `/v1/models` (`vercel-ai-gateway/alibaba/qwen-3-14b` instead of `custom:<uuid>/alibaba/qwen-3-14b`). The alias defaults to the provider name, is editable at creation and later, and the proxy accepts both the alias form and the internal `custom:<uuid>/…` form in the `model` field, so existing client configs keep working. Existing custom providers are backfilled on upgrade.
- e86c83a: Add an Automation harness category with n8n as its first platform, including n8n credential setup guidance in the harness creation flow.
- 142d082: Add `GET /api/v1/version` for self-hosted installs: reports the running version, the latest GitHub release, and changelog/upgrade links so the dashboard can show a "new version available" badge. Checks once a day, never in cloud mode, and can be turned off with `MANIFEST_UPDATE_CHECK_DISABLED=1`.

### Patch Changes

- ed8ac04: Adapt the provider connection page, the Overview KPI cards, and the app header to phone-sized screens

## 6.21.1

### Patch Changes

- b974b60: Send the `x-opencode-session` header on every OpenCode Go/Zen request — hashed per-conversation id when the caller provides `x-session-key`, stable per-agent fallback otherwise — ahead of OpenCode's 09/06 enforcement deadline.
- 30ecba8: Stop listing OpenRouter `:batch` model variants in model discovery. These variants are only served through OpenRouter's asynchronous Batch API and always fail with a 404 on the synchronous chat completions proxy.
- 51fa1b8: Security: bump fast-uri to 3.1.6 (fixes GHSA-5jgf-p345-68v8, GHSA-fph4-wmhf-6fwf, GHSA-f65p-4m7j-42xc, GHSA-jqff-g426-hqxp) and refresh Docker base images.

## 6.21.0

### Minor Changes

- ae39136: Encrypt stored request recordings with the at-rest encryption key. Existing gzip-only recordings remain readable.
- 760e21c: Add MANIFEST_ENCRYPTION_KEY_PREVIOUS and a boot-time re-encryption pass so the at-rest key can be introduced or rotated without losing stored provider credentials.

### Patch Changes

- 6b88368: Route an explicit bare model id to the subscription connection when both a subscription and an api_key connection of the same provider serve it, instead of silently metering the key.
- 39fdbe0: Add claude-fable-5-1 to the Anthropic subscription model catalog so Claude Max / Pro connections can serve it instead of silently falling through to an API key
- 478c64b: Strip inline base64 images from stored request recordings and Phoenix observations.
- 15998da: Remove the self-hosted loopback auto-login. Requests from 127.0.0.1 without a session are no longer treated as a signed-in local user.
- 686656a: The routing model picker now window-renders long catalogs so scrolling stays in place instead of lagging or jumping back to the top.
- 9534911: Scrub provider credentials from upstream error bodies before they are written to logs.
- 65e318b: Waiting-list claims now record where they were made (cloud or self-hosted) instead of a generic label, and a repeat claim updates the attribution to the latest origin.

## 6.20.0

### Minor Changes

- b7d5368: New self-hosted users now see a one-time optional discovery form (name, email, project type, company size) right after signup, before reaching the dashboard. Submitting or skipping persists the choice, and the step never appears on Manifest Cloud or for existing users.
- 54a6356: The sidebar now announces that Manifest is becoming the self-healing layer for APIs, with a modal to join the waiting list using a prefilled but editable email. The old Autofix sidebar card is retired since notifications cover it.
- b3bd178: Add grok-4.6 to the Grok subscription known-models list so xAI subscription connections can select it.
- 1f6e851: Limit the Grok subscription catalog to grok-4.6 and grok-4.5, the models Grok Build actually offers, and advertise their 500k context window.

### Patch Changes

- 4de42c1: Open Anthropic subscription popups before the OAuth request so adding another account is not blocked by the browser.
- 597d183: Allow custom provider models to use streaming response mode.
- 4b824d7: Stop serializing tool_result images as base64 text on OpenAI-compatible routes (a single screenshot inflated to 100K+ input tokens and could overflow the provider context window), and return deterministic ChatGPT Codex context errors as HTTP 400 instead of 502.
- e0105a2: Keep configured subscription context windows current without replacing provider values.
- 5cd26a1: Fix fallback drag-and-drop reordering below the second position.
- 3c5af56: Allow deployments to configure the per-tenant concurrent request limit with `MANIFEST_CONCURRENCY_MAX`.
- 29f0316: Keep Phoenix model remaps provider-native while preserving subscription routing and legacy Autofix compatibility.
- eb0992c: Pin Better Auth to 1.6.25 to restore upgrades from populated 1.6 databases.
- c86273b: Translate Anthropic user metadata when routing Messages requests to OpenAI.

## 6.19.1

### Patch Changes

- 196f3b9: Stop accepting rotated or deleted agent API keys immediately across backend replicas.
- 810319e: Make Auto-fix setting changes take effect immediately across all backend replicas.
- 2fac033: Apply hard-limit rule and usage changes immediately across backend replicas.
- f9eecad: Apply message-recording setting changes immediately across backend replicas.
- 94e3f9f: Fix the harness sidebar rendering after creation in Safari.

## 6.19.0

### Minor Changes

- 44cb47b: Add Meta Model API support for Muse Spark 1.1, Muse Spark 1.2, and the Contributor route.
- f83ba4f: Support the full Kimi Coding Plan model lineup for Moonshot subscriptions using the wire-format ids the api.kimi.com/coding endpoint expects: k3, k3-256k, kimi-for-coding, and kimi-for-coding-highspeed (the previous curated list sent kimi-k3, which the endpoint does not accept). Includes correct per-model context windows (1M for k3, 256k for the rest, with an explicit k3-256k entry so prefix matching cannot inherit the 1M window), curated input modalities (image+video for k3 and both kimi-for-coding variants, image-only for k3-256k), provider inference for the bare k3 ids, and quality-score overrides so the zero-priced k3 models are not mis-tiered as ultra-low in auto-routing.

### Patch Changes

- c40e550: Show the loading skeleton on the Agent Overview page while switching between agents, instead of leaving the previous agent's data on screen until the new fetch resolves.
- 215f863: Rename the "AI agents" harness category to "AI agent" so it matches the other singular category labels
- b27a578: Fix empty non-streaming responses for Bedrock GPT-5.x models (openai.gpt-5.6-luna/sol/terra, gpt-5.5, gpt-5.4). The non-streaming Responses handler assumed the upstream always returns SSE, but the Bedrock mantle /openai/v1/responses endpoint returns a plain JSON Responses object when stream:false, so content came back null with zero usage. The handler now detects the response shape and parses JSON Responses objects directly.
- 87475e2: Route Bedrock GPT-5.4, GPT-5.5, and GPT-5.6 models through the namespaced OpenAI Responses API path.
- 9b2704c: Keep OpenAI subscription requests streaming upstream when clients request buffered responses.
- e821268: Bound dashboard query concurrency and reduce default PostgreSQL pool sizes.
- 6b4bf29: Cap the provider connections list at six and a half rows so the supported-provider catalog below it stays reachable. The card scrolls, and a "Show all" button expands it to full height.
- b24ddcb: Calculate GitHub Copilot request costs from live token prices, including long-context tiers.
- ba1d7b6: Prefer the cost a provider reports over any catalogue estimate. Manifest already read `usage.cost` from responses but only used it for subscription providers, so an exact figure from a gateway such as OpenRouter was captured and then discarded in favour of catalogue arithmetic. Local inference (Ollama, llama.cpp, LM Studio) now records a known `$0` instead of an unknown `null`.
- 2d5fb92: Bill DeepSeek V4 at its real peak/off-peak rates. Pricing entries can now carry time-of-day tiers (the models.dev `cost.tiers` time variant), cost calculation resolves them against the attempt timestamp, and a built-in seed supplies DeepSeek's schedule until the catalog carries it.
- ba1d7b6: Stop billing DeepSeek V4 peak rates on weekends: time-of-day pricing tiers now carry the weekdays they apply on, and DeepSeek's 01:00-04:00 / 06:00-10:00 UTC peak windows are Monday-Friday only. Also prices `deepseek-v4-flash-vision-exp`, which billed at the stale flat catalog rate.
- 061d351: Continue fallback routing when a non-streaming Chat Completions provider returns no output.
- 3330dae: Refresh cached harness message counts when new requests arrive.
- 633455b: Show the Meta logo anywhere the dashboard renders provider icons.
- ab1a544: Keep model parameter specs current: the modelparams catalog now refreshes hourly from the modelparams.dev API (ETag-conditional, validated before swap, stale-on-error) instead of being frozen at the bundled package version, and the bundled fallback is bumped to modelparams 0.0.40.
- 6b04574: Report modalities and capability flags for Ollama Cloud models. `ollama-cloud` was missing from the models.dev provider map, so every lookup missed and `GET /v1/models?capabilities=true` returned no `input_modalities`, `output_modalities`, or `features` for those models. Release tags that models.dev omits from its key (`:preview`, `:0813`) now fall back to the base model.
- 0259c8d: Show refreshed provider metadata immediately after manual model discovery.
- ca21b97: Route OpenCode Go Responses-only models (Grok 4.5, GPT 5.6 Luna, Muse Spark) to `/v1/responses` instead of `/v1/chat/completions`.
- 7b09c5e: Report tool support and modalities for OpenRouter models. OpenRouter reached neither models.dev provider map, so all 323 published models declared only `stream` and never `tools`, and anything reasoning about capability — the dashboard picker, `/v1/models?capabilities=true`, agents choosing a remap target — treated every one of them as tool-incapable. OpenRouter now sits in the capability-only map, so its rates stay with its own live `/models` feed while models.dev supplies the modalities and tool-call flags that feed omits. Routing variants (`:free`, `:nitro`, `:batch`) resolve to their base model's capabilities.
- fe8677e: Cost each request with the price of the provider that actually served it. The pricing cache was keyed by model name alone, so every provider selling a model wrote to the same key and only the last one survived — 24 providers list `deepseek-v4-pro`, and DeepSeek is not the one that won. A request to DeepSeek's own API was billed at OpenCode Zen's resale rate, roughly 3.7x the real price on an agent-shaped token mix.
- 0d244d0: Fix Responses→chat-completions conversion emitting content-less `{"role":"user"}` messages for `reasoning`, `item_reference`, and other non-message input items, which strict OpenAI-compatible providers rejected with 400/422.
- bf7876a: Restore the $25 Gemini credit user-discovery banner and modal on the Overview page
- 6c29c71: Sanitize tool_use ids emitted on /v1/messages responses so non-Anthropic upstream ids (e.g. `Edit:0`) no longer poison session histories against Anthropic's id pattern
- ecb3c8d: Spell Autofix without a hyphen across the dashboard, notifications, and emails.
- 549bece: Stop advertising Gemini 3.1 Pro Preview and Gemini 3 Flash Preview for Google Code Assist subscriptions because the Code Assist API returns model-not-found responses for both routes.
- 7b09c5e: Report modalities and capability flags for Kilo, Pioneer, Cline Pass and Xiaomi models. These providers publish no modality data on their own `/models` endpoints, and models.dev may not price them: they list resold vendor models under the vendor's own ID, so their rates would overwrite the real vendor price in the shared cache. A new capability-only provider map carries them, separate from the map that grants pricing authority.

## 6.18.0

### Minor Changes

- f9eb3d8: Enable hosted Auto-fix for self-hosted installs: one-time consent with an option to turn it on for every existing agent, identified by the anonymous install id.
- 1e4cac8: Add opt-in Provider Attempt message recording with tenant-scoped durable filesystem or S3-compatible storage.

### Patch Changes

- 1b633b6: Fix horizontal overflow in request drawer: error, autofix and fallback context cards now span full width, long error messages wrap instead of scrolling horizontally, and the tabs bar uses a muted background.
- 59f0e37: Enable automatic prompt caching for Anthropic API keys and OpenRouter Claude models.
- 205e25c: Auto-fix retries a healed model on the original provider transport when routing cannot resolve it (stale tenant model cache), instead of synthesizing a 502
- 31eaa75: Auto-fix always closes the evidence loop with Phoenix: a retry that dies mid-flight is reported as a synthetic 499 instead of leaving the heal attempt pending, and a dropped outcome report is resent before giving up
- f299e4b: Route Bedrock OpenAI and Anthropic models through their compatible Responses and Messages API surfaces.
- d040011: Stop blocking `/billing/status` and free-tier admission on the historical request-usage baseline scan; return the live counter immediately and finish the baseline in the background. Dashboards no longer wait on billing at all: the plan is resolved once at login via the new light `GET /api/v1/billing/plan` and read synchronously, so Overview, Global Overview, and the Requests log fetch each chart exactly once at the right range.
- 42a750b: Open routing model pickers from cached provider models and refresh stale catalogs only once per browser session each day.
- 95c17cf: Cache provider usage aggregates and coalesce live dashboard refreshes.
- f8cbfd8: Classify Anthropic subscription extra-usage errors as billing without sending them to Auto-fix.
- 89de9cd: Keep the routing page mounted while refreshed model data loads.
- 060b42b: Preserve GPT-5.6 reasoning summaries on inbound Chat Completions: map the standard `reasoning_effort` param onto the Responses `reasoning` object (with `summary: auto`) for OpenAI endpoints so the model actually reasons, prefix-match Responses reasoning-summary delta events instead of an exact-name allowlist, and backfill `reasoning_content` from the terminal `response.completed`/`response.incomplete` output when no summary deltas streamed.
- fb8beb2: Prepare DeepSeek reasoning tool turns once before each provider attempt.
- 6ac0908: Keep subscription model availability scoped to provider discovery and curated model lists.
- 3ed45a4: Enable message recording by default for newly created harnesses without changing existing harness settings.
- e56afee: Forward explicit uncatalogued models to connected providers so real model errors can reach Auto-fix.
- b4f85dd: Load paginated requests before aggregating attempts and refresh exact totals separately.
- 01a6966: Keep provider-cooldown skips and successful fallbacks as separate ordered Attempts in Request timelines.
- 934416d: Reject billing-enabled Cloud startup when request quota and process timezones differ.
- b6b5db5: Add a Gemini Free provider with Gemini-scoped keys and a reusable managed free-provider
  configuration. Use the existing managed gateway by default.
- ca18aad: Prevent headerless Codex subscription requests from sharing token-wide cache affinity.
- fa15665: Preserve native Responses and Anthropic Messages requests until cross-protocol conversion is required.
- 6d49e02: Record provider cache-write usage consistently across response formats.
- 06b0715: Make Auto-fix available to every tenant and retire the early-access waitlist.
- cdb9028: Preserve OpenRouter input and output modalities during model discovery.
- ecc29b6: Preserve redacted structured provider error details in proxy responses.
- 04710be: Simplify model parameter requests with a prefilled GitHub issue.
- 538d021: Improve request message drawer: markdown rendering, JSON syntax highlighting, gear icon for tool calls, wider drawer, Tools tab shows called and available tools separately.
- e4b6e6c: Remove the legacy Auto-fix tenant rollout columns after general availability.
- bd4b560: Honor requested model routes on the Anthropic Messages endpoint.
- d1d2ea7: Scope proxy replay caches and routing momentum to their owning tenant and agent.
- 4c42c24: Scope provider prompt cache affinity to explicit tenant and agent sessions.
- eaa4026: Show actual Provider Attempt tool calls instead of available tool definitions in recorded message details.
- 3f7f7cf: Show complete Gemini request messages, including system instructions.
- 1ee0634: Show recorded Gemini streaming responses in Provider Attempt message details.
- a0834db: Record Manifest-authored routing failures, including provider cooldown skips, as failed Attempts so the Request drawer shows the full routing chain.
- df19e6e: Keep the routing model picker open while refreshed model data loads.
- 064e462: Keep `reasoning_content` on OpenCode Zen requests. The reasoning dialect is now decided by the models.dev reasoning capability instead of a model-family regex, so Zen's DeepSeek and codename reasoning models replay their thinking while Claude/GPT/Gemini/Grok slugs keep stripping it.

## 6.17.1

### Patch Changes

- ba9db64: In Cloud, replace repeated monthly request COUNT scans with an exact counter, lazy baseline, and fail-fast deploy cutover.

## 6.17.0

### Minor Changes

- c7243c9: Auto-fix now gets a chance to heal requests naming an unavailable model (M302). When an explicit `model` resolves to no connected model and the agent has Auto-fix enabled, the failure is handed to the healing service as a synthetic model-not-found 404; a successful patch re-resolves routing and serves the repaired request, recording the real provider retry without inventing a provider attempt for the Manifest-blocked original. Agents without Auto-fix keep the friendly M302 response unchanged.
- ca55f79: Expose model input and output costs in USD per million tokens from `GET /v1/models?cost=true`, while keeping the default response unchanged.
- 8b07c7f: Add Hugging Face Inference Providers as a first-class API-key provider with dynamic model discovery and OpenAI-compatible chat routing.
- 43cf52b: Invite users to a short discovery call: a one-time modal on the dashboard and a persistent banner offer $10 of Gemini credit for 30 minutes of feedback.

### Patch Changes

- f1e0dc7: Clean up request drawer when no provider attempts: hide the sidebar, show "-" for blank provider/model fields in attempt details, and show "No provider" in the attempt list.
- ebf49fd: Add Claude Opus 5 to the Anthropic subscription model catalog.
- 6f649fc: Route streaming provider timeouts through configured fallbacks instead of returning M500.
- 24174dd: Report provider-native failed request parameters and response bodies directly to Phoenix diagnostics.
- 4e9a09c: Record streaming timeouts, protocol errors, incomplete streams, and caller cancellations with explicit terminal outcomes.
- ed712ab: Refresh the model lists shown on provider tiles and in the README so they match the catalogs providers actually serve today
- 3caacde: Stop silently discarding successful requests from the Messages log. A heuristic
  deduplicator treated two distinct successes as the same completion whenever they
  hit the same agent and model with identical input/output token counts inside a
  30s window — which an agent looping over one model satisfies routinely — and
  dropped the second one. It was added to suppress double-writes when the old OTLP
  telemetry pipeline and the proxy both recorded a request; that second writer has
  since been removed, so every match it could still find was a false positive.
- 92430b1: Raise the per-provider credential safety ceiling from 5 to 50 connections.
- cf5d6d8: Send native Google provider failures through Auto-fix with their exact request and response bodies.
- cc0da80: When primary credentials fail to resolve, treat it as a failed attempt and enter the normal fallback chain instead of hard-failing with M100. Dead subscription OAuth (refresh/unwrap failed) now surfaces as M102 rather than the misleading "no API key" M100.
- 10a17a7: Add real-Postgres e2e coverage for the subscription OAuth credential lock (row-lock serialization, savepoint retry, lock_timeout bound).
- cc0da80: Serialize OAuth subscription token refreshes with a DB row lock (`SELECT … FOR UPDATE` on `tenant_providers`) so multi-replica backends cannot rotate the same refresh token concurrently
- a31dae6: Preserve configured reasoning effort when forwarding requests to native DeepSeek V4 models.
- 08404f2: Refresh provider model lists on the first routing model picker opened each day.
- e3bb269: Self-hosting fixes. The install script now resumes instead of failing when the install directory already exists, so a run that died at `docker compose up` can be retried without losing the generated secret. Adds `--port` for installing on a port other than 2099, and generates `MANIFEST_ENCRYPTION_KEY` so provider credentials are no longer encrypted with the session-signing secret by default. The bundled compose file now forwards 16 documented variables it was silently dropping, including `TELEMETRY_ENDPOINT` and `MANIFEST_DISABLE_HSTS`. Blank values for `TELEMETRY_ENDPOINT` and the provider OAuth client IDs fall back to their defaults instead of being treated as an override.
- a0bfab8: Security: bump transitive dependency `seroval` 1.5.1 → 1.5.6, fixing a critical deserialization advisory (`fromJSON()` Promise resolver type confusion, GHSA — patched in 1.5.3).
- fd1dd88: Request-params snapshots are now derived from the raw request body: caller-sent parameters the model catalog has no spec for (scalars and small structured knobs, content excluded) are recorded, so failure evidence shows the exact knob a provider rejected instead of silently omitting it.
- 0a1ee2c: Scope a harness's Overview to that harness's own routing: requests where the caller pinned an explicit model in the request body (`direct`) no longer appear in its Recent Messages, charts, cost breakdown or summary cards. They stay fully visible on the global Overview and the Messages log, so total spend still reconciles.

## 6.16.0

### Minor Changes

- c1e7717: Separate caller requests from provider attempts in storage, analytics, and the dashboard.
- c1e7717: Expose provider-attempt and fallback aggregate analytics.
- c7e0be7: Expose structured model capability metadata (input/output modalities, endpoint features, supported endpoints) from `GET /v1/models?capabilities=true`, keeping the default response unchanged, resolved through the same pipeline as the routing model picker. Curated modality facts identify `gpt-5.3-codex-spark` as text-only input and mainline ChatGPT subscription models as image-capable in both the API and the picker.

### Patch Changes

- c1e7717: Add an `auto_fixed` count to the `GET /api/v1/errors/breakdown` response (number of requests healed by Auto-fix in the window), plus a typed `getErrorBreakdown()` frontend API wrapper — so a dashboard can surface auto-fixed alongside errors.
- 2c81871: Report the exact provider-facing request body to Phoenix and retry healed bodies through the already-resolved transport without reapplying routing parameter merges or protocol translations.
- 1943921: Clarify offline tunnel errors and keep HTML error pages out of message records.
- d24cd21: Extend the dashboard covering index with the columns the request-first dashboard reads (key label, status, request id) and add a partial index for the skills panel, restoring index-only scans on the Overview and Provider Usage endpoints for large installs
- 275fbfa: Limit request backfill refreshes to parents linked by the current batch.
- 4e6e74a: Treat empty ChatGPT Codex streams as provider failures so routing can use fallbacks. Self-hosted deployments can tune the semantic-output wait with `CODEX_SEMANTIC_OUTPUT_TIMEOUT_MS`.
- ae1213e: Strip legacy `budget_tokens` from Anthropic adaptive thinking requests.
- 0b91ff3: Update OpenRouter logo to the current brand mark
- 79856bc: Block built-in local providers on Manifest Cloud.
- 26b0635: Prepare request history in the background before the request-level dashboard rollout.
- aa767db: Refresh every matching provider connection so models returned by an API key are cached for each connected key.
- 8412baf: Surface interrupted upstream streams as terminal SSE errors.
- 6ec0136: Stop request-history tail sweeps after the initial backfill.

## 6.15.2

### Patch Changes

- 2cdaee6: Fix auto routing resolving to a provider the agent never connected. A stale legacy auto-assigned (or promoted fallback) route now reuses the gateway's provider-key lookup before it becomes primary, so an unconfigured provider is skipped without adding a separate model-discovery query. When nothing routable remains, the request returns the neutral `M101` "no providers configured" error. The proxy also treats the resolver's fallback chain as definitive so a fallback promoted to primary is not retried as its own fallback.
- 9cf2571: Bump `modelparams` to 0.0.13 to pick up the new xAI Grok model parameter specs, including `grok-4.5` and subscription entries for the Grok subscription models.
- 6f1345c: Scope Auto-fix parameter repairs by provider authentication type.
- d3d44e3: Add Kimi K3 (`cline-pass/kimi-k3`) to the ClinePass subscription's known models list.
- d8fb0b2: Fix Auto-fix attempt recording so no-patch consultations remain plain provider failures and failed patched retries keep their own outcome.
- 84b2112: The password reset page now detects when no email provider is configured and shows a clear notice (pointing to the authenticated Change Password flow) instead of silently pretending a reset link was sent. Self-hosted installs without an `EMAIL_PROVIDER` no longer dead-end here.
- 6519ea5: Add opt-in Sentry error monitoring. It stays disabled without a `SENTRY_DSN`; request contents, user data, tracing, and profiling remain off.
- 189a6eb: Sync the model parameter catalog to `modelparams@0.0.15`. Adds 24 new model routes (including a new `xiaomi` provider) with no schema changes — the param types, groups, and auth types are unchanged, so the bump is purely additive.
- 89c1757: Preserve xAI reasoning effort when forwarding Chat Completions requests.

## 6.15.1

### Patch Changes

- 970ed63: Show newly created harnesses in the sidebar immediately.

## 6.15.0

### Minor Changes

- 5059bcb: Show every Manifest error in the Messages log, with a documented error code and a link to its docs page. Setup errors are no longer hidden from the log, malformed requests and Manifest internal errors are no longer blamed on your providers, and each rate limit now says which one fired.
- 4c5aed8: Report an agent's request-side 4xx to Phoenix as evidence, carrying the full request body, for agents that have Auto-fix on. Opt-in via `AUTOFIX_REPORT_ALL_4XX=true`; nothing is stored in Manifest.

### Patch Changes

- e7fa0c1: Show a dedicated M302 "model not available" message when an explicit model ID is not available for the agent.
- fccb0e2: Stop failing requests whose `model` isn't a provider-qualified ID. A bare model name now routes to the connection carrying it, an unrecognized one falls back to configured routing instead of erroring with "no providers configured", and a matching custom header tier again outranks the model an SDK names.
- 80f3cb5: Drop two unused indexes on `agent_messages`, reclaiming about 1 GB and removing an index write from every message insert.
- 09ecac0: Store the full provider error envelope on Auto-fix rows. They previously kept only the error's message text, dropping its `type`, `param` and `code` — so re-reading such a row identified the failure differently from the live report of that same failure.
- ff947a6: Open the HTTP port at boot instead of waiting for the provider model registry to load, so a slow database no longer stalls deploy healthchecks.
- ca87016: Attribute public provider-token stats from recorded message providers before falling back to pricing metadata, so ChatGPT subscription usage is not grouped under API-key gateways that expose the same model name.
- ec290d1: Add a Messages dashboard trigger filter for ordinary, fallback, and Auto-fix rows.

## 6.14.0

### Minor Changes

- 7dd4edc: Auto-fix now explains _why_ a request was repaired. Phoenix returns a human-readable explanation with each heal (a one-line summary plus a plain sentence per edit), and the message Auto-fix card renders it — replacing the locally re-derived operation prose, which couldn't describe most fixes. Falls back to the previous phrasing for older healed rows.
- 45420a1: Add Auto-fix: when an agent request fails with a fixable error (bad parameter, wrong format, unknown model), Manifest sends it to a healing service, applies the patched request, and retries before falling back. Opt-in per agent from the Routing page. Each healed request shows as two linked rows in the log: the failed original and the successful retry.
- 6442224: Report the Manifest tenant id to Phoenix on auto-fix heal requests, so failures are attributed to the tenant that hit them.
- e5d4177: Add a post-auth Pro upgrade page and preserve upgrade intent through sign-in and sign-up.
- 29f6cc7: Add support for ClinePass subscription
- e5d4177: Add Stripe billing (cloud only). Free plan request quota comes from shared plan limits. Pro price is read from the configured Stripe Price ID and includes unlimited requests. Free request limits are enforced on the proxy; over-limit requests return a 402 with an upgrade prompt. Self-hosted stays unlimited.

### Patch Changes

- 5aeb106: Split user Limits, Manifest plan quota, and provider billing errors in message error taxonomy.
- e5d4177: Route request-limit upgrade links to the post-auth upgrade page.
- 9514558: Reset the request quota window for the billing rollout.
- e5d4177: Send Manifest billing emails for plan lifecycle changes and monthly request usage milestones, with usage-alert preferences.

## 6.13.5

### Patch Changes

- 46a09a8: Fix waitlist sync reading email from session instead of empty tenant field, rename table to waitlist_claims

## 6.13.4

### Patch Changes

- b2b95f0: Preserve route metadata on streamed provider errors so message logs keep model and provider fields.
- 3dd41a1: fix: Gemini adapter — strip unsupported schema keywords, merge parallel tool responses, and inject missing thought signatures

  The Gemini adapter now strips additional JSON Schema keywords that Google's
  `function_declarations` parameter schema rejects (`propertyNames`,
  `uniqueItems`, `multipleOf`, `contains`/`minContains`/`maxContains`,
  `prefixItems`, `additionalItems`, `readOnly`, `writeOnly`, `deprecated`,
  and `$comment`/`$anchor`/`$dynamicRef`/`$dynamicAnchor`/`$vocabulary`).

  It merges consecutive parallel tool responses into a single Gemini user turn,
  matching Google's requirement that N functionCall parts be answered by exactly
  N functionResponse parts in one turn.

  When a functionCall part has no `thought_signature` from the client or cache
  (e.g. after a fallback from another model), the adapter now injects the
  documented dummy signature so Gemini 3.x does not reject the request with
  "Function call is missing a thought_signature".

- 3b2bbd9: Self-hosted waitlist claims now sync to the cloud instance

## 6.13.3

### Patch Changes

- 4e3fdde: Report Claude Opus 4.8 with a 1M context window for Anthropic subscription routing.
- a0f5549: Preserve Responses reasoning summaries when Copilot responses-only models are used through Chat Completions.
- aafa8d4: Record DeepSeek prompt cache hits from `prompt_cache_hit_tokens`.
- 6ce3a9d: Send Fireworks prompt cache keys from Manifest sessions.
- 4c9335e: Mark MiniMax Coding Plan subscriptions as prompt-cache capable.
- ff48cfb: Send Moonshot prompt cache keys and record Kimi cached tokens.
- 884170d: Preserve author-prefixed Ollama model IDs when proxying requests.
- a4fd8aa: Stop forwarding Anthropic-style thinking params to Ollama endpoints.
- d329f57: Send Qwen cache-control markers and mark Qwen subscriptions cacheable.
- 09d904a: Remove the proxy message-count limit so long agent sessions are bounded by request body limits instead.
- f1a5243: Mark Xiaomi MiMo Token Plan subscriptions as prompt-cache capable.
- 0cc5520: Mark Z.ai Coding Plan subscriptions as prompt-cache capable.

## 6.13.2

### Patch Changes

- 7ca120b: Enable prompt caching support metadata for Anthropic subscriptions and send first-party subscription requests with Anthropic automatic cache control.
- a46c3dc: Mark Gemini subscriptions as supporting prompt caching in shared provider metadata.
- dc3c4a9: Send stable prompt cache keys to Mistral when callers do not provide one.
- abec177: Mark OpenAI subscriptions as supporting prompt caching in shared provider metadata.
- fb63274: Add OpenRouter prompt cache breakpoints for Gemini and Qwen model families.
- 22a15a4: Send prompt cache keys to xAI Responses requests from Manifest session affinity.

## 6.13.1

### Patch Changes

- fef144a: Show explicit SDK model overrides as Direct in Messages.
- 5572692: Update the shipped modal for OpenAI-compatible model discovery and direct model calls.
- f8a5a5d: Lead README, Docker docs, and app meta tags with connecting agents to any provider instead of cost savings.

## 6.13.0

### Minor Changes

- 1131013: Add Auto-fix early access card in sidebar and waitlist modal
- 34c0a99: Separate provider errors from Manifest's own errors in the dashboard. Each message now records who caused a failure (provider, transport, or a Manifest setup/limit/internal issue) and what kind, so a provider outage no longer reads the same as a missing API key. The Messages log shows one clear status pill per row (e.g. "Failed: Provider", "Failed: Custom limit"), hides pre-flight setup errors by default, and a new `/api/v1/errors/breakdown` endpoint reports the provider-vs-Manifest split.
- 2eabbf9: Add an opt-in public API that serves curated cross-tenant error-cluster pages for the marketing site. `GET /api/v1/public/error-pages[/:slug]` returns operator-approved clusters (gated by `MANIFEST_PUBLIC_STATS`), and a secret-guarded `POST/DELETE /api/v1/internal/error-pages` lets the Peacock CMS publish or pull pages. Only clusters seen by at least 10 distinct tenants are eligible, and every public sample is run through secret and email scrubbing before storage, so no single tenant's data or credentials can leak.

### Patch Changes

- 060db8f: Stop a wrong or revoked agent key from hammering the database and flooding the logs. Every request bearing a bad `mnfst_` key used to run a fresh indexed DB lookup and emit a warning, so one misconfigured agent in a retry loop sustained DB load and log noise indefinitely. Rejected keys are now cached for 30s (cleared the moment a key is created or rotated), collapsing a storm to one lookup and one log line per window. Separately, the dashboard live-update stream (`/api/v1/events`) no longer counts against the global rate limiter, so heavy dashboard use can't trip a 429 that severs the stream.
- 3e0b517: Support Alibaba Cloud Model Studio compatible-mode endpoint URLs for Qwen API-key connections, including workspace-scoped Frankfurt endpoints.
- 8ef014e: Drop unsigned Anthropic thinking blocks before forwarding native Messages requests to Anthropic.
- bc292b4: Stop a slow memory climb on long-running servers. The global dashboard response cache used cache-manager's default in-memory store, which has no size limit and only drops entries when their exact URL is requested again. High-cardinality dashboard URLs (filters, cursors, time ranges) piled up for the life of the process. It now uses a bounded LRU store with a hard entry cap plus an active sweep of expired entries. Three proxy session caches (Anthropic thinking blocks, Gemini thought signatures, DeepSeek reasoning content) were also uncapped and now evict their oldest entries once a ceiling is reached.
- 926b51a: Add Cerebras as a first-class API-key provider. Manifest can now connect Cerebras keys, discover models from `https://api.cerebras.ai/v1/models`, proxy chat completions through the OpenAI-compatible endpoint, and enrich model metadata from models.dev.
- 75b6518: Public provider stats now include custom-provider usage, grouped under a single "Custom" provider with tenant-scoped endpoint ids scrubbed and rare model names folded into an aggregate bucket
- 16f0cc9: Restore dropped `reasoning_content` on DeepSeek-compatible tool-call follow-up turns, including fallback requests where clients stripped provider-specific reasoning fields. Manifest now caches streamed and non-streamed assistant tool-call reasoning by session and first `tool_call.id`, and replays only exact DeepSeek-style `reasoning_content` for the same tool-call id. If no exact value is recoverable, Manifest injects an empty `reasoning_content` only as a last resort for DeepSeek-compatible assistant tool-call turns. Other reasoning fields such as `reasoning`, `reasoning_text`, and `reasoning_details` are treated as provider-specific and are not translated across formats. Normal assistant turns without tool calls are not cached or replayed by content fingerprint.
- ccfe367: Allow inactive subscription connections to be deleted from the provider detail page, including stale duplicate rows left by upgrades.
- ccb748d: Fix Playground streaming for Gemini subscription responses that use the CodeAssist envelope.
- fbf8160: Allow self-hosted installs to tune the proxy message-count limit with MANIFEST_MAX_MESSAGES.
- bd45672: Fix the dashboard "Messages" totals so every view agrees. The Overview card counted failed requests (including agents that have no provider set up yet) while the per-agent and per-provider views did not, so the headline number could sit ~35% above the sum of its parts. Every "messages" metric now counts the same thing: real messages, excluding error and rate-limited rows. The Messages log still lists failed rows so you can see what went wrong.
- 8df89b7: Show custom and task-specific tiers in the Messages tab Tiers filter when a harness is selected from the global Messages view.
- 3b5c63d: Add a status filter to the Messages dashboard.
- 71d4acc: Add Mistral Vibe as a subscription provider with token setup, Vibe key guidance, and subscription-scoped discovery for the Vibe CLI model.
- 4144e68: Load model parameter specs from the versioned `modelparams` npm package instead of refreshing modelparams.dev at runtime.
- b0a8f66: Add Nous Portal as a subscription provider.
- 4c7d19e: OpenCode Go and Zen model discovery now use the models.dev catalog first, and manual refreshes refresh the models.dev cache before OpenCode Go falls back to its docs catalog.
- 9c36695: Refresh OpenCode Go models from the live OpenCode catalog and clarify per-request subscription values as quota usage instead of extra billing.
- ae7f564: Replace the Overview News card with a full-width social follow banner.
- ea9b422: Add Pioneer as a first-class API-key provider. Manifest can now connect Pioneer keys, discover models and pricing from Pioneer APIs, and proxy chat completions through the OpenAI-compatible endpoint using `X-API-Key` authentication.
- 4aace1b: Return provider context-window errors as OpenAI-compatible `/v1` errors while still letting configured fallbacks try a larger context window.
- 6b2ff17: Expose authenticated agent models from `/v1/models` using the OpenAI-compatible model list shape.
- 687c2b7: Prevent Anthropic signed thinking blocks from being replayed into incompatible fallback attempts. Cached thinking is now scoped to the provider, auth type, and model that produced it, so an incompatible fallback omits stale signatures while a later compatible Anthropic attempt can restore them.
- 2ab748a: Route explicit provider-qualified model IDs from the OpenAI-compatible API.
- 26be5cc: Stop rolling deploys from dropping requests. During a deploy the old replicas got SIGTERM and closed their socket immediately while the Railway edge was still routing to them, so a chunk of requests failed for the length of the deploy window. The server now drains on SIGTERM: the health probe at /api/v1/health reports 503 so the edge deregisters the replica, and the process keeps serving for SHUTDOWN_DRAIN_MS (default 10s) before closing connections. railway.toml gains overlapSeconds and drainingSeconds so the new deployment overlaps the old one and the drain finishes before SIGKILL.

## 6.12.0

### Minor Changes

- 8956f43: Stop storing full message request/response bodies. The Messages page keeps the per-message metadata view (status, model, provider, tokens, cost, routing, request headers, model parameters) but the recorded-body drawer is removed. A migration drops the `message_recordings` table and the unused `llm_calls` / `tool_executions` / `agent_logs` tables, significantly reducing database storage.

### Patch Changes

- b27a16e: Stop index migrations from deadlocking deploys against live traffic. The agent_messages index migrations used blocking DDL (plain CREATE/DROP INDEX), which takes an ACCESS EXCLUSIVE lock and deadlocked against live INSERTs while the previous deployment was still serving — failing every deploy and leaving the schema (and the dashboard perf work) unshipped. Those migrations now run CONCURRENTLY (SHARE UPDATE EXCLUSIVE, which does not conflict with writes) outside a transaction, and the migration runner uses per-migration ('each') transactions. The covering index also builds without a write stall.
- 88a8590: Add a timestamp-leading partial index for cross-tenant error scans. The Cloud control plane's hourly error-insights rollup scans agent_messages by time window across all tenants, but the only error index was tenant-leading — so each run scanned every error row ever recorded (cost growing with total accumulated errors), which turned into multi-minute scans that saturated the database. A timestamp-leading partial index over error rows turns those into windowed range scans (measured 110ms/29k buffers down to 2ms/274 buffers on ~2M error rows). The index stays partial so write amplification on ingest is negligible.
- 29ee8be: Speed up the dashboard, message log, and provider/subscription lists for high-volume tenants. Distinct model/provider lookups now use an index skip-scan instead of scanning a tenant's whole history, and the Overview derives its summary cards from the timeseries it already fetches (one fewer full-range scan). A covering index lets the Overview summary, timeseries, and cost-by-model aggregations run as index-only scans on every install (previously self-hosted had none). Postgres planner defaults (JIT off, larger work_mem, SSD-tuned random_page_cost) plus tighter autovacuum on agent_messages keep those aggregations off the heap, and a redundant index is dropped to lighten ingest.
- 46c88c2: Lazy-load hidden token and cost chart series on agent overview.
- 1591e53: Name the affected agent when provider disconnect is blocked by routing.
- 8fb56c1: Speed up provider disconnect route checks and ignore disabled route rows.
- e266b8e: Support large OpenAI-compatible inline image requests on `/v1/*` with route-scoped body parsing, clear body-size errors, and redacted inline image data for routing and message recordings.
- 49ef687: Start retiring complexity and task-specific routing. Agents that never configured them now see only Default and Custom routing, so the routing page is simpler for new and unconfigured agents. Agents already using complexity tiers or task-specific categories keep everything working and see a banner explaining the change.
- 0501bb0: Improve the agent routing empty state contrast in dark mode.
- 5eec940: Stop deploys from deadlocking on database migrations. Migrations ran on every replica's boot over PgBouncer, so multi-replica deploys with pending migrations could deadlock acquiring locks on agent_messages and fail. Migrations now run once in a pre-deploy step over the direct connection (with an advisory lock so overlapping deploys serialize), before any replica starts. App-boot migration is now configurable (RUN_MIGRATIONS_ON_BOOT, default on for dev and single-instance self-hosted). The migration runner also uses the committed migration list instead of a compiled-file glob, so stale build artifacts from deleted migrations can never run.
- 100a3b4: Run database migrations under a Postgres advisory lock so concurrent runners serialize instead of deadlocking. When more than one process ran migrations at once (overlapping deployments, or replicas across regions), they could deadlock acquiring DDL locks on the high-churn agent_messages table and fail the deploy. The deploy migration step now takes a single advisory lock over the direct migration connection: the first runner applies every pending migration, the rest wait and then find nothing pending. Single-instance and self-hosted deploys are unaffected.
- ca62d7b: Clarify Xiaomi MiMo Basic API-key setup by linking directly to the API Keys console and validating the documented `sk-xxxxx` pay-as-you-go key shape separately from Token Plan `tp-` credentials.

## 6.11.0

### Minor Changes

- e30e0e9: Add global provider pages (ConnectProvider, ProviderDetail, AgentProviders tab) and lift provider connections from per-agent to user-scoped. Remove agent H1 header block from AgentDetail shell.
- 21f0981: Tenant-canonical scoping: every resource now belongs to a tenant instead of a user. The `user_providers` table is renamed to `tenant_providers` (junction column `user_provider_id` → `tenant_provider_id`), `api_keys`, `email_provider_configs`, and `custom_providers` are re-keyed by `tenant_id`, and the remaining `user_id` scope columns are dropped from routing/notification/playground tables (kept only as nullable `created_by_user_id` audit columns). Self-host operators querying the database directly should note the table/column renames; migrations run automatically on boot and abort with a clear message if orphaned rows are found (set `MANIFEST_MIGRATION_FORCE=1` to delete them instead).

### Patch Changes

- e30e0e9: "View more" on a harness's recent messages now opens the global Messages log pre-filtered to that harness.
- e30e0e9: The per-agent Overview now breaks usage down by provider (chart + provider filter), matching the global Overview.
- e30e0e9: Restructure agent detail view into a horizontal-tabbed shell (Overview / Routing / Guardrails / Settings) with back-link navigation. Unify sidebar to a single global nav (Overview / Messages / Agents) rendered identically on every authenticated route; remove the agent-scoped MONITORING/MANAGE/RESOURCES sub-nav.
- 7aa49e5: A newly added provider key no longer shows another key's usage on its connection page — per-connection analytics now attribute every message to the exact connection that served it, instead of grouping by provider, auth type, and label.
- 19b9b9e: Add AWS Bedrock as an API-key provider using Bedrock Mantle's OpenAI-compatible endpoints. Bedrock vendor-prefixed model IDs now resolve model parameters, pricing, and capabilities through the underlying provider metadata while keeping the original Bedrock ID for inference.
- 548a836: Fix Claude Code subscription routing for Anthropic Messages requests by capping Manifest-added `cache_control` markers at Anthropic's four-block limit, enabling the `context_management` beta header expected by recent Claude Code clients, and downgrading `output_config.effort: "xhigh"` when routing resolves to Sonnet.
- e30e0e9: Custom providers now display their name and models consistently across Messages, Overview, graphs and cost tables — the literal "custom:" prefix is gone and names resolve on global pages too (the backend resolves them, so deleted providers degrade gracefully).
- 550d2a4: Restore the "Add custom provider" button on the Usage-based page and use a dedicated modal for creating and editing custom providers
- 30539c2: Deleting a custom provider can no longer leave orphaned key or routing data behind: the link between custom providers and their stored keys is now enforced by the database (with automatic cleanup of any pre-existing orphans), and creating or deleting a custom provider is atomic.
- 8df85b4: Speed up global overview and Messages by collapsing overview usage timeseries queries and letting Messages load rows before exact totals/filter metadata.
- fd5bc63: Connecting a provider right after creating your first agent no longer fails with "Tenant not found" for several minutes — newly created workspaces are now visible to the dashboard immediately. When a database migration fails on startup, the logs now show the real migration error instead of a misleading "Unable to connect to the database" retry loop.
- e30e0e9: Add global dashboard with Overview, Messages, and Agents navigation for tenant-wide usage analytics.
- e30e0e9: Local providers (sidebar tab, page and overview card) are hidden on cloud — they only apply to self-hosted installs.
- 0efdb6b: Add Kiro IAM Identity Center start URL and region options to the subscription login flow.
- e30e0e9: Fix token/cost limits never blocking (or alerting) when the server's timezone isn't UTC. `computePeriodBoundaries`/`computePeriodResetDate` built their window in UTC, but `agent_messages.timestamp` rows are stored in the process's local time — so on a non-UTC host the window's upper bound sat behind the stored rows by the TZ offset and the consumption SUM read ~0, meaning hard limits silently never tripped and threshold alerts never fired. Boundaries are now computed in local time (matching `computeCutoff`), via a new `toLocalSqlTimestamp` helper.
- 2f2c8e1: Harden provider connection attribution and analytics before release. A subscription a user removed is no longer silently brought back by an agent's background re-registration. Pre-upgrade message history now attributes to the right connection for users who had the same provider on multiple agents. The dashboard overview keeps Playground traffic out of every card and chart consistently, and the provider-key cache is no longer bypassed on the proxy path.
- 28dbedb: Provider connections lifted from per-agent keys now get clearer names (e.g. "from Agent A") instead of the bare agent name.
- 3bb50ae: Provider migrations can now be rolled back without dropping connected providers.
- ed58472: Removed the leftover savings/baseline cost tracking (database columns and proxy-side computation) now that the dashboard no longer shows savings.
- e30e0e9: Removed the Subscription Savings card, chart, explainer and its API endpoints.
- 97b401a: Rename the agent_provider_access table to agent_enabled_providers so the database, API routes, and dashboard all use the same "enabled providers" naming. The migration is a pure rename — no data is modified — and rolls back cleanly.
- e30e0e9: Fix the post-create "Set up harness" modal showing the full harness picker instead of the harness you just chose. AgentGuard now refetches the agent list when the viewed agent changes, so a newly created agent's platform reaches the setup modal (previously the stale, source-less list left the platform unset whenever the agent was created from the always-present sidebar while another agent was open).
- 2492e76: Harden the tenant-scoping upgrade for large production databases. The provider-lift migration now skips rows whose agent was already deleted instead of aborting the whole upgrade with a foreign-key error, and the multi-million-row agent-message attribution backfill runs as a throttled, resumable post-deploy job (`npm run backfill:message-providers`) instead of inside the boot transaction — so upgrading no longer holds a long lock on `agent_messages`.
- d6748ad: Close a cross-tenant read path in message-detail logs (the llm_calls/agent_logs/tool_executions child queries are now tenant-scoped), and harden dashboard reliability: reject API keys past their own expiry from the auth cache, stop reporting routing-override saves that didn't persist, keep a demo-seed failure from aborting boot, and add a retryable error state to the connection page.
- 8d7f916: Add a one-time "What we just shipped" dialog for existing users that announces global providers: connect a provider once across all harnesses, scope access per harness, and track subscription vs usage-based spend per provider and harness. Dismissal is remembered locally.

## 6.10.0

### Minor Changes

- a29a705: Add a per-auth-type breakdown to the public `provider-tokens` endpoint. Each provider now carries an `auth_types` array (`{ auth_type, total_tokens, model_count }`) alongside the existing `models` list, so a provider that is used both with an API key and a subscription (e.g. OpenAI API key vs ChatGPT subscription) can be listed once per auth method. Usage with no recorded auth type is counted as `api_key`. The existing `provider`/`total_tokens`/`models` fields are unchanged, so the addition is backwards compatible.
- 43e06c6: Add Xiaomi MiMo as an API-key provider with MiMo Token Plan subscription routing.

### Patch Changes

- 17d7fd5: Fix the Anthropic subscription model catalog. Drop the `claude-*-fast` ids it pulled from the pricing cache — those 404 at `api.anthropic.com` because fast mode is an `anthropic-beta` header on the base Opus model, not a model id. Also add `claude-fable-5` (Claude Fable 5), a new subscription model that didn't match the existing `claude-*-4` prefixes.
- 6eb902d: Forward OpenAI-compatible image inputs as Anthropic image content blocks when routing Chat Completions or Responses requests to Claude.
- abbf574: Inject cache_control prompt-caching breakpoints for Anthropic subscription OAuth requests. The skip dated from a misdiagnosed 400 that was actually caused by the missing Claude Code identity block, so subscription users were re-paying their full prompt prefix in quota on every request.
- 6dc6c07: Filter ChatGPT subscription model discovery to models the Codex backend accepts with a ChatGPT account.
- 00870bf: Make Anthropic Claude Code subscription OAuth and routing match the Claude Code flow: exchange tokens through the Claude Code API host, avoid connect-time probes, and use Claude Code-compatible request headers. Also fix Anthropic OAuth pending-flow consumption so the saved provider keeps the correct agent and user IDs.
- 392efe2: Allow adaptive-only Anthropic thinking mode parameters to be reset to unset from the model parameter dialog.
- 04782c1: Restore prompt-cache hits on the ChatGPT subscription backend: send the session affinity headers the Codex CLI sends (`session-id`/`thread-id`, `x-codex-turn-state` replay, stable `prompt_cache_key`), and forward the caller's `prompt_cache_key` on OpenAI /responses conversions
- 4ea4872: Allow self-hosted installs to tune streaming warmup timeout with STREAM_WARMUP_MS.
- 3f59cc4: Route Copilot subscription models using their advertised supported endpoints so responses-only models use `/responses` directly instead of failing on `/chat/completions`.
- 96eba2d: Resolve subscription provider aliases before checking subscription support so Gemini subscriptions stored or registered as "google" remain usable for routing.
- 09a7379: Strip unsupported `exclusiveMinimum` and `exclusiveMaximum` JSON Schema fields from Google/Gemini tool declarations so function-calling requests do not fail validation.
- 8cbc0da: Forward OpenAI-compatible image inputs as Gemini inline or file data parts when routing requests to Google.
- d018cb4: Fix custom (header) routing tiers keeping stale account pins after disconnecting one of several accounts on the same provider. Provider-reference cleanup only updated complexity and specificity tiers, so disconnecting an account, renaming a key, or deactivating all providers left header-tier routes pointing at a removed account (the account chip then rendered blank). `relabelOverrides`, `cleanupProviderReferences`, and `deactivateAllProviders` now clean `header_tiers` routes the same way.
- cb48cc0: Fix OAuth subscription tokens getting permanently invalidated (#2012). Providers like OpenAI now rotate refresh tokens on every refresh, so the previous "refresh then persist" path could brick an account when parallel proxy requests refreshed the same credential at once, or when the DB write failed after the provider had already rotated. Lazy refreshes are now coordinated per credential: concurrent refreshes coalesce into a single round-trip, the freshest token is re-read from the database before refreshing, and the rotated token is persisted with retries. Applies to all subscription OAuth providers (OpenAI, Gemini, Anthropic, MiniMax, xAI, Kiro).
- 2ee31b3: Route already-resolved OpenAI `o3-deep-research` API-key requests through the Responses endpoint, matching the existing deep-research handling for `o4-mini-deep-research` without adding unavailable models to discovery. Preserve non-streaming mode when forwarding Chat Completions-shaped requests to OpenAI Responses, and surface collected Responses SSE error events as upstream failures instead of empty successful completions.
- 6677b95: Fix the Playground sending MiniMax subscription requests to the default region endpoint. The OAuth `resource_url` (which encodes the chosen region) was only applied for Gemini and dropped for MiniMax; it is now turned into a `minimax-subscription` base-URL override the same way the proxy does, so Playground requests hit the correct region. Follow-up to #2110 (cubic-flagged).
- 4a7e1fa: Normalize provider reasoning stream aliases such as Copilot's `reasoning_text` to OpenAI-compatible `reasoning_content` for chat-completions clients while preserving provider-specific replay safeguards.
- 642b162: Prevent OpenAI Responses-backed subscription streams from ending as interrupted client streams: forward terminal upstream `error` / `response.failed` events as OpenAI-compatible SSE error payloads, convert `response.incomplete` (max_output_tokens / content filter) into a proper `length` / `content_filter` finish chunk, surface upstream stream errors to `/v1/messages` clients as native Anthropic `error` events instead of a fabricated empty `end_turn` message, and stop the provider request timeout from aborting healthy streaming response bodies after headers have arrived.
- 34febf8: Fix the Playground using the wrong endpoint for region-based providers (qwen, zai) and forwarding vendor-prefixed model ids for copilot/zai. The proxy's endpoint + model resolution (region overrides for minimax/qwen/zai, prefix stripping for copilot/minimax/zai, custom-provider endpoints) is now a shared `resolveForwardEndpoint` helper used by both the proxy and the Playground, so the two paths can no longer drift.
- 6154127: Try configured tier fallback routes before the auto-assigned route when a manual override model is unavailable.

## 6.9.2

### Patch Changes

- 2d7541b: Resolve model parameter specs through the providerless modelparams.dev by-model endpoint so gateway routes such as GitHub Copilot can expose the underlying model's thinking and reasoning controls.
- 5006434: Speed up the dashboard and lower proxy overhead: unbuffered SSE streaming, smaller render-blocking CSS, lazy-loaded modals, cached per-agent model lookups, and new indexes for hot queries.
- aad3033: Fix native `/v1/responses` forwarding so typed non-message input items such as `reasoning` and `item_reference` are preserved without a `role`, preventing ChatGPT subscription Codex backend 400 errors on multi-turn Codex requests.

## 6.9.1

### Patch Changes

- e2ec0a6: Add BytePlus ModelArk Coding Plan as a subscription provider.
- 90e7af5: Add Command Code subscription routing with dynamic model discovery and OpenAI/Anthropic Provider API forwarding.
- c78f6fb: Persist refreshed OAuth subscription tokens to the same provider account label that supplied the token.
- 4884967: Add Qwen Token Plan as a subscription option for the Alibaba Cloud provider.
- 6cdd23d: Add a Z.ai GLM Coding Plan endpoint selector for outside-China and China Mainland subscription routing.

## 6.9.0

### Minor Changes

- 50e7ecd: Add OpenCode Zen as an API-key provider. OpenCode Zen exposes an OpenAI-compatible `/v1/models` catalog and `/v1/chat/completions` proxy endpoint, plus a native Anthropic `/v1/messages` endpoint for Claude models. Manifest now discovers Zen models on connect and routes Claude requests through `/v1/messages` (with `x-api-key` auth) and everything else through `/v1/chat/completions` (with Bearer auth).

### Patch Changes

- 0eff607: Keep same-name models from different providers available in the routing model picker.
- d950469: Add Fireworks AI as an official API-key routing provider.
- d439884: Add Kimi Coding Plan subscription routing for Moonshot/Kimi with the `kimi-for-coding` model.
- 31383c5: Refresh OAuth subscription credentials once when the upstream rejects a stored access token.

## 6.8.3

### Patch Changes

- 65bca08: Fix token-cost calculation for providers that report cache-read prompt tokens. Manifest now uses models.dev cache-read/cache-write prices when available, so cached DeepSeek input tokens are billed at the cache-hit rate instead of the full input-token rate.
- 08f9c6f: Fix `/v1/responses` streaming to emit the full OpenAI Responses API event lifecycle when bridging a Chat Completions upstream. The converter now opens a message item and content part (`response.output_item.added` / `response.content_part.added`) before the text deltas and closes them (`response.output_text.done` / `response.content_part.done` / `response.output_item.done`) with a populated `response.completed`, instead of emitting bare `output_text.delta` + `response.completed{output:[]}`. Strict Responses API clients (Pi, OpenClaw-style) previously dropped the deltas and rendered empty assistant messages.

## 6.8.2

### Patch Changes

- c86ab75: Record cumulative Anthropic streamed input and cache token counts when they are reported on `message_delta` events.
- 191170c: fix(charts): pad bar chart x-scale by half a bin so the last bar is fully visible (#1756)
- 3471514: Speed up the dashboard's first load. Heavy code now loads on demand instead of up front: the syntax highlighter is a slim 6-language build, charts load per tab, and the markdown renderer loads when the first message renders. Dev-only tooling no longer ships in production bundles.
- 26f3458: Limit the OAuth callback-URL tutorial video on the provider sign-in screen to OpenAI. Other OAuth providers (Gemini, etc.) no longer show the OpenAI-specific video.
- 72a398b: Separate model selector capabilities from input and output modality columns.
- d3b742f: Fix OpenCode Go reasoning-tier routing by sending qwen3.7 models through the provider's Anthropic-compatible endpoint, keeping Mimo on the OpenAI-compatible endpoint, and hardening streamed reasoning_content caching for tool-call continuations.
- 1a4063d: Replace the Routing page's empty pricing catalog panel with a concise warning toast that avoids naming implementation-specific upstream pricing sources.
- 259951e: Parse provider SSE streams with a spec-compliant parser so keepalive comments remain comments instead of being forwarded as data payloads.
- 3434f64: Close an SSRF hole where a custom provider URL written as an IPv4-mapped IPv6 literal (for example `https://[::ffff:169.254.169.254]`) slipped past the guard and could reach cloud metadata or private hosts. The carrier-grade NAT range (100.64.0.0/10, used by managed Kubernetes and Tailscale) is now blocked too. Separately, MiniMax, Kiro, and Copilot OAuth errors no longer echo refresh tokens or client secrets into logs.
- 690de8d: Request exact token usage for every supported OpenAI-compatible streamed provider by moving `stream_options.include_usage` behind endpoint capability metadata, including Kilo and NVIDIA NIM.

## 6.8.1

### Patch Changes

- ba08e72: Support adding and managing multiple GitHub Copilot subscription accounts.
- 9109d10: Keep connected subscription add-account flows visible for OAuth and device-code providers.

## 6.8.0

### Minor Changes

- 19e2d5b: Kiro subscriptions now connect in Manifest Cloud. Kiro previously used a local-only CLI flow (reading the `kiro-cli` token cache off the backend's own disk), so it only worked when self-hosting. It now uses the AWS SSO OIDC device authorization flow server-side — register → show a user code + verification link → poll for the token — exactly like the GitHub Copilot and MiniMax subscriptions, working identically on a laptop and in the cloud.

### Patch Changes

- 8061e86: Show capability badges for gateway models in the model picker. A gateway model like `opencode-go/glm-5.1` now resolves its capabilities from the underlying provider's models.dev metadata (`zai` / `glm-5.1`) instead of showing "Capabilities unknown". The resolution is gateway-generic — it keys off the shared gateway-prefix abstraction, so any gateway added later inherits it automatically.
- b13ac3d: Add Grok subscription provider support with xAI OAuth login and dynamic xAI model discovery.
- 20c7c40: Add NVIDIA NIM as an official API-key routing provider.
- f71c741: Show OpenCode Go's per-request cost in the model picker and tier cards. OpenCode Go bills a per-request slice of its dollar quota rather than a flat fee, so models with a published cost now display e.g. `$0.0136/req` instead of the generic "Included in subscription" label. The `available-models` API surfaces `cost_per_request` (from the OpenCode Go catalog) for gateway models; flat-fee subscriptions are unchanged.

## 6.7.0

### Minor Changes

- e76e89d: Add Gemini OAuth (gemini-cli / CodeAssist flow). Sign in with a personal
  Google account to route through `cloudcode-pa.googleapis.com` against
  the free-tier Gemini quota. Adds a `Sign in with Google` tile on the
  Routing page and a curated CodeAssist-supported model list, including
  Gemini 3.1 Pro Preview, Gemini 3 Flash Preview, Gemini 3.1 Flash-Lite,
  and the Gemini 2.5 models.

### Patch Changes

- 802869f: Increase the custom provider model catalog limit from 50 to 500 models.
- 9e73856: Surface Anthropic OAuth token exchange rate-limit errors instead of showing the generic expired-code message.
- a446d3e: Show model parameters for gateway models (e.g. OpenCode Go). A model like `opencode-go/deepseek-v4-pro` now resolves its parameters and capabilities from the underlying provider's catalog entry (`deepseek` / `deepseek-v4-pro`), so the params dialog, request snapshot, and outbound param defaults work the same as connecting the provider directly.
- 2509a8c: Add Kilo Gateway as an API-key provider with dynamic model discovery.
- 0e2b471: Add Kiro subscription provider support with dynamic model discovery and proxy forwarding.
- 713b070: Auto-fill custom provider model prices from exact models.dev provider/model matches, and mark exact model-only matches as estimated when no provider match is available.
- 4d1b982: Track real per-request cost for OpenCode Go subscriptions. The OpenCode Go plan is a dollar quota ($12 / 5h) consumed per request, not a flat fee, so each call now records its docs-attributed USD cost (e.g. `$12 / 880 = $0.013636` for GLM-5.1) instead of `$0.00`. Other subscription providers (Claude Max, ChatGPT Plus, GLM Coding, Copilot) continue to record `$0.00`.
- f4c3476: Add model-scoped streaming capabilities and enforce stream response mode in routing.

## 6.6.2

### Patch Changes

- b6920d3: refactor(proxy): forward Anthropic Messages requests to Anthropic upstreams without OpenAI translation

  When a `POST /v1/messages` request resolves to an Anthropic upstream, the
  proxy now forwards the original Anthropic body directly with only additive
  mutations applied (cache_control on the last system block and last tool,
  subscription identity injection for OAuth, default max_tokens, cached
  extended-thinking replay). The OpenAI-shaped `chatBody` is retained for
  the routing/scoring layer but no longer feeds the wire request.

  Closes the lossy-roundtrip class of bugs that previously dropped Anthropic-
  native fields (server-tool `type` discriminators, `top_k`, native
  `stop_sequences` form, future Anthropic-only parameters) through the
  Anthropic → OpenAI → Anthropic translation. Replaces the targeted
  `_anthropicServerTools` stash workaround.

- 07bc952: Set Claude Code setup snippets to use Manifest's `auto` model by default and expose it through `/v1/models`.
- 610c408: Show captured assistant responses as the final turn in recorded OpenAI Chat and Responses API message log conversations.
- 58dd78c: Show configured task-specific and custom tiers in the Messages tier filter and route those selections to the matching message-log filters.
- ebb1e2b: Use modelparams.dev parameter descriptions in the Model parameters dialog instead of local hardcoded hints.
- 534ff60: Refresh the Model parameters dialog with grouped cards, inline descriptions, a compact slider with min/max markers, and a synced number field. Disabled parameters now keep their description and gain a help icon explaining how to enable them, while remembering the last user value for when they become available again.
- 6cd59c7: Resolve modelparams.dev provider aliases such as Z.ai's `z-ai` catalog ID when loading configurable model parameters.
- ec47903: Keep the OpenAI OAuth callback paste field visible while an OAuth flow is active, align the OpenAI authorize request with the current Codex CLI flow, and persist pending OpenAI OAuth exchanges across backend instances.
- 261769d: fix(proxy): re-inject cached reasoning_content for OpenAI-compatible tool turns

  When reasoning providers return `reasoning_content` alongside tool calls, Manifest now caches the field and restores it on the next request if an OpenAI-compatible client dropped it from the assistant history. The replay is guarded to DeepSeek/Kimi/OpenCode Go-compatible targets and strict providers still have the field stripped.

- 130eb3c: Remove the recorded-only filter from the messages dashboard.
- 96cdd40: Persist cached `reasoning_content` for DeepSeek-compatible tool-call turns in Postgres so cloud deployments with multiple backend instances can re-inject the required field on follow-up requests.
- 2bf3734: Render recorded OpenAI Responses API request input in the message log conversation tab instead of falling back to the raw-body hint.
- d061461: fix(proxy): route xAI Responses API requests to xAI's native /v1/responses endpoint

  Adds native xAI Responses API forwarding and routes xAI multi-agent Grok models
  through /v1/responses instead of filtering them out of model discovery.

## 6.6.1

### Patch Changes

- 9d3f743: Stop recording Railway and proxy noise headers on every message. Headers injected by the hosting edge (x-railway-_, x-forwarded-_, x-real-ip, etc.) are dropped before storage, so the message Headers tab only shows headers the agent actually sent.
- 1173e30: Performance: bound the public usage-stats aggregations, add a composite `(key_prefix, is_active)` index for agent-key auth lookups, reuse uPlot chart instances in place on data refresh instead of rebuilding them, and memoize the message log's feedback overrides.

## 6.6.0

### Minor Changes

- 400c195: Add opt-in per-agent message recording. Toggle in Settings → Recording captures the full request body, response body, and response headers for subsequent proxy calls. Recorded rows show a record-dot icon in the Messages log; clicking it opens a formatted modal with Parameters, Conversation turns, Tool calls, Reply, Usage pills, and Headers. Payloads capped at 2 MB and kept out of the hot message-list query via a separate `message_recordings` table. Defaults off; never included in anonymous telemetry.

## 6.5.1

### Patch Changes

- 3b345e7: Fix provider disconnect cleanup so removing an OAuth subscription clears routes pinned to that auth type even when an API-key credential for the same provider remains connected.
- 492cf46: Preserve provider key labels and priorities when duplicating agents.
- 045907d: Preserve native Google `generationConfig` fields when routing requests to Gemini, while keeping existing OpenAI-compatible generation aliases as explicit overrides.
- 9438035: Serve model parameter specs from the MPS catalog API and support scoped per-route defaults.
- 4e780be: Make saved Manifest model parameters authoritative over overlapping client request parameters while preserving client parameters that Manifest does not configure.
- bea267e: Fetch model parameter specs per-model on demand instead of downloading the full MPS catalog on every Routing-page load, and add an ETag conditional GET to the catalog refresh. Keeps the dashboard payload flat as the catalog grows.
- 680feca: Stop slow startup model-catalog syncs from stalling boot past the deploy healthcheck. The OpenRouter, models.dev, GitHub, and modelparameters.dev fetches now run in the background instead of blocking `app.listen()`, and the two that lacked a timeout (OpenRouter, GitHub) now abort after 10s. The pricing cache still warms up with real data once those fetches land.

## 6.5.0

### Minor Changes

- c4571f7: Add Playground page: compare LLM responses from multiple models side by side for cost, output tokens, and latency. Includes request-headers popover, history drawer with replay, and markdown rendering of responses.

### Patch Changes

- f2074dd: Make Anthropic OAuth token exchange diagnostics safe when fields are missing.
- 3ff3087: Persist Anthropic OAuth pending state in Postgres so production exchanges survive reloads, restarts, and multi-instance routing.
- 7913169: Align Anthropic OAuth state handling with the Claude Code PKCE flow.
- ed05898: Add Claude Code-compatible Anthropic OAuth token headers and safe request-shape diagnostics.
- 0421e0a: Fall back to the OAuth state when Anthropic pending verifier data is missing.
- d00e52b: Fix custom providers in the Playground. Selecting a model from a custom (OpenAI/Anthropic-compatible) provider now resolves its endpoint instead of failing with "Provider request failed".
- 2b1c9b5: Hide the misleading empty "tier" label in the Playground model picker. The subtitle now only shows when a real routing tier applies.

## 6.4.0

### Minor Changes

- 24832a3: Add Nanobot to the supported personal AI agents list. The setup screen renders a paste-ready `~/.nanobot/config.json` block that points the `manifest` provider at the Manifest endpoint and selects model `auto` by default.
- d7dc183: Move request body defaults (today: DeepSeek's `thinking` toggle) from tier-scoped storage to per-route storage. Settings now travel with the model identity (`agent_id`, `provider`, `auth_type`, `model_name`) wherever the model appears — default tier primary, specificity fallback, header-tier primary, anywhere. **Behavior change:** Manifest no longer auto-disables DeepSeek's thinking mode on simple/standard/complex tiers. Users who never configured a value will see the provider's natural default (thinking enabled) instead of Manifest's previous cost-saving override. To get the old behavior back, configure thinking explicitly per-model from the Routing page once the frontend ships. Migration backfills the existing per-tier config to every compatible route in the assignment (primary + fallbacks) so no per-model setting is silently lost. Adds new endpoints `GET/PUT/DELETE /api/v1/routing/:agent/model-params` for the upcoming frontend.
- 4cba5b3: Routing UI: every model row (primary chip, fallback row, header-tier primary, header-tier fallback) now exposes the per-model Parameters affordance for any provider whose API consumes a known knob (today: DeepSeek's `thinking`). Settings travel with the model identity wherever it appears — saving DeepSeek's thinking mode on one slot updates every other slot showing the same model. Closes the long-standing gap on the "custom" (header-tier) routing surface, which previously had no params support at all. Wires the new `GET/PUT/DELETE /api/v1/routing/:agent/model-params` endpoints shipped in the backend PR.
- a8e907e: Add full OAuth flow for the Anthropic Claude Pro / Max subscription. Connecting
  your Claude subscription is now a one-click "Sign in with Claude" → paste the
  authorization code, instead of running `claude setup-token` in a separate
  terminal. Tokens auto-refresh through the same blob/refresh path used by OpenAI.

  Internally the OAuth code in `routing/oauth/` was split into shared `core/`
  primitives (PKCE, token-blob storage, pending-state TTL, callback HTML) plus
  per-provider files. The OpenAI service now delegates to the same primitives,
  and a new `oauth/anthropic/` package implements the paste-code flow.

### Patch Changes

- a254c32: Add OpenCode to the Coding Assistant setup flow. The setup screen now renders a paste-ready OpenCode config block for the global or project config, registers Manifest as an OpenAI-compatible provider, and selects `manifest/auto` by default.
- 6f52fdd: Normalize Chat Completions `image_url` parts to Responses API `input_image` parts before forwarding to `/v1/responses`.
- bbcfa50: Stop filtering the canonical `gemini-3.1-flash-lite-preview` (and similar non-dated `flash-lite-preview` aliases) from Gemini model discovery. The previous regex was meant to drop deprecated dated snapshots like `gemini-2.5-flash-lite-preview-09-2025` but over-matched and removed live preview models too. Tightened to require a `-MM-YYYY` date suffix so dated snapshots still get filtered while canonical previews surface.
- 91088e2: Fix "Add another key" button for OAuth subscription providers
- cedeba2: Extract Wingman to a standalone hosted SPA at `wingman.manifest.build`.
  The dashboard's bottom drawer stays dev-only (dead-code-eliminated from
  production / self-hosted bundles) and now embeds the hosted build by
  default. Contributors can still point it at a local Wingman with
  `VITE_WINGMAN_URL`. Dev-mode CORS allow-lists the hosted origin so
  contributors can use the hosted SPA against a local backend; production
  never enables CORS, so nothing Wingman-related ships to self-hosted
  deployments. The `packages/wingman/` workspace is removed; source moves
  to https://github.com/mnfst/wingman.
- abf3c15: Show a small "Last used" badge on the sign-in and sign-up pages so returning visitors can see at a glance which method (email or one of the social providers) they used last time. The hint is stored per-browser in `localStorage` and is best-effort: it falls back silently when storage is unavailable.
- 9b4a586: Accept MiniMax Coding Plan `sk-cp-` tokens on the MiniMax subscription tile alongside the device-code OAuth flow. The region picker now applies to both paths, so CN Coding Plan tokens route to `api.minimaxi.com` for both model discovery and proxied requests. Closes #1467.
- d9e6232: Improve the dashboard layout on phone-sized screens with a compact navigation drawer, tighter header chrome, and mobile-sized chart stats.
- 828812c: Patch five high-severity Dependabot alerts in transitive dependencies.
  - `fast-uri` 3.1.0 → 3.1.2 (path traversal + host confusion, dev-only via `@nestjs/schematics`).
  - `kysely` 0.28.14 → 0.28.17 via `better-auth` 1.4 → 1.6 (JSON-path injection in `JSONPathBuilder`, runtime).
  - `undici` 5.x → 6.25 via `@codecov/vite-plugin` 1 → 2 (HTTP smuggling + CRLF injection, dev/build only).

  No behavior change. Better Auth bump is patch-compatible (1.4 → 1.6) — login, register, OAuth round-trips verified locally.

- 7792ef8: Coerce unknown Anthropic Messages tool types to custom tools instead of forwarding unsupported server-tool tags, and normalize missing array `items` in forwarded tool schemas for OpenAI compatibility.
- 504a7af: Route Anthropic and MiniMax subscription disconnects through provider-specific OAuth cleanup endpoints
- 47d143c: Rename the personal agent category label to "AI agents".
- ee47ba7: Strip adaptive thinking when Anthropic Messages requests are routed to Claude Haiku.
- f4fb104: Preserve OpenCode Go reasoning content for known non-DeepSeek reasoning model families.

## 6.3.0

### Minor Changes

- 74f6fb3: Add `GET /api/v1/public/agent-tokens` public endpoint. Mirrors the shape of `/provider-tokens` but groups daily-token usage by `(agent_category, agent_platform)` instead of by LLM provider, so the marketing site can show per-agent (OpenClaw, Claude Code, OpenAI SDK, etc.) charts alongside the existing per-provider ones. Excludes the `other` platform bucket and `custom:*` models server-side. Gated by `MANIFEST_PUBLIC_STATS` and cached for 24h, same posture as the rest of the public-stats endpoints.

### Patch Changes

- c1fe19a: Fix GitHub Copilot routing for GPT-5 Codex models. Copilot serves Codex variants (`gpt-5-codex`, `gpt-5.2-codex`, `gpt-5.3-codex`) only via `/responses`, so chat-completions requests now swap to that endpoint instead of returning "Unsupported API for model". Also rewrites `max_tokens` to `max_completion_tokens` for the GPT-5 / o-series family on Copilot, fixing the "Unsupported parameter: 'max_tokens'" error reported alongside.
- 786dd76: Preserve Responses stream classification during stream warm-up.
- ae56a30: fix(proxy): preserve Anthropic server tools through /v1/messages double-conversion (#1886)

  Claude Code requests routed through `POST /v1/messages` to an Anthropic upstream
  failed with `tools.N.custom.input_schema: Field required` because server tools
  (web_search, bash, text_editor, computer, code_execution) lost their `type` tag
  during the Anthropic → OpenAI → Anthropic translation and were re-emitted as
  custom tools missing the required `input_schema`. Server tools are now stashed
  on the translated body and re-emitted unchanged when the upstream is Anthropic.

- d25320a: Preserve DeepSeek `reasoning_content` on every follow-up turn, regardless of which provider proxies it (OpenCode Go, custom providers, future aggregators). Fixes a hard failure on OpenCode Go's `deepseek-v4-pro` ("The reasoning_content in the thinking mode must be passed back to the API") — issue #1862.
- e7cdfa1: Strip the non-standard `ref` JSON Schema keyword (no `$` prefix) from Google Gemini tool parameters. Some tool emitters drop the `$` prefix because Protobuf and similar parsers reject dollar-prefixed field names; without this fix Manifest forwarded `ref` verbatim and Google rejected the request with `Invalid JSON payload received. Unknown name "ref"`.
- f21584a: Fix prompt-caching token counters on `/v1/messages`. `cache_control` markers always reached Anthropic (caching was working server-side), but the chat → Anthropic-Messages conversion in `toAnthropicUsage` hardcoded `cache_creation_input_tokens: 0`, and the `parseUsageObject` Anthropic branch read cache reads from the wrong key. Result: client responses lost cache creation counts, and `agent_messages` rows recorded `0` for both cache creation and cache reads even when Anthropic actually hit the cache.

  Also fixes the recorder's duplicate-write detector, which summed `input_tokens + cache_read_tokens + cache_creation_tokens` when computing a row's total prompt tokens — `input_tokens` already stored the chat-shape total, so the sum double-counted caches and caused legitimate duplicates to bypass dedup. And `toAnthropicUsage` now reads OpenAI-compat nested `prompt_tokens_details.cached_tokens` as a fallback so `/v1/messages` requests routed to OpenAI / DeepSeek / Z.AI / MiniMax / Mistral surface their cached-input counts too.

- 9f64594: Update MiniMax "Where to get an API key" link to point to the actual key page (`/user-center/basic-information/interface-key`) instead of the API docs overview.

## 6.2.2

### Patch Changes

- 562d105: Fix Groq model attribution in the routing UI so Groq-served prefixed model IDs stay selectable and show the Groq provider.

## 6.2.1

### Patch Changes

- 00784e3: Show the Model Parameters button on a routing tier when any route in the tier — primary or fallback — uses a params-compatible provider. Previously the button was gated to the primary route only, so a tier with DeepSeek configured as a fallback hid the toggle even though the proxy already applies tier-level `param_defaults` to whichever provider an attempt actually targets. The dialog's provider-default hint follows the first compatible route in the ordered (primary, …fallbacks) list.

## 6.2.0

### Minor Changes

- ef46fa0: Per-assignment request body defaults: each tier and specificity slot now carries an optional `param_defaults` JSONB column that the proxy merges into the outbound provider request before forwarding. Initial knob is DeepSeek's thinking-mode toggle (`{ thinking: { type: 'enabled' | 'disabled' } }`) — fixes empty-content responses on DeepSeek V4 Flash/Pro that consume the `max_tokens` budget on reasoning. Precedence is presence-based: client-supplied fields in the request body always win, so explicit per-call overrides keep working.

  Configure from the routing UI via a new "Parameters" button on each model chip; persisted via `PATCH /api/v1/routing/:agent/tiers/:tier/params` and `…/specificity/:category/params`.

- 085431c: Per-message model parameter telemetry. Each `agent_messages` row now carries a `request_params` JSONB snapshot of the effective request body parameters that hit the provider (today: DeepSeek's `thinking` toggle; future provider knobs and user-defined custom-provider params land here without a schema change). The dashboard's expanded message detail shows a new "Model Parameters" accordion next to Request Headers, with an info tooltip explaining the field. Existing rows stay NULL — back-compat is preserved.
- d3b551f: Per-provider model refresh: a small refresh button next to each provider in the Connect Providers detail view and next to each section header in the model picker. Toasts now report the actual count or upstream error instead of a blanket "Models refreshed" lie. Empty discovery results no longer wipe a non-empty cache, so a transient API hiccup can't silently empty the model list. The model picker subtitle now shows "Default tier" instead of just "tier".

### Patch Changes

- ec7fc12: Restore the per-tier (and per-specificity) Model Parameters dialog that was inadvertently dropped during a stacked-PR merge. The sliders icon is back on every primary model chip in Routing for providers that consume known params (today: DeepSeek's `thinking` toggle). The dialog persists per-assignment, so a single configured value applies to the primary model AND every fallback the proxy tries — without per-route schema changes. Multi-key compatible: pinning a different key on the same route does not affect the stored params, and switching keys mid-flight keeps using whatever the proxy resolved for that iteration.

  Adds back: `PATCH /api/v1/routing/:agent/tiers/:tier/params`, `…/specificity/:category/params`, `TierService.setParamDefaults`, `SpecificityService.setParamDefaults`, frontend `setTierParamDefaults` / `setSpecificityParamDefaults`, and `ModelParamsDialog`.

- c446856: fix(routing): attribute models by their connection's provider, not by model-id prefix

  The routing UI used to derive a model's logo from the prefix of its model id,
  which broke for any provider that redistributes other vendors' models. Most
  visibly, a Groq connection serving `qwen/qwen3-32b` rendered with the Qwen
  logo and Qwen-on-OpenRouter pricing (≈$0.08/$0.24 per 1M) instead of Groq's
  own pricing ($0.29/$0.59).

  Two changes:
  - **Frontend** (`RoutingTierCard.providerIdForModel`): when a model row has a
    stored `provider` that resolves to a registered first-party provider, that
    wins over prefix inference. OpenRouter remains the documented exception
    because its rows really do represent vendor-prefixed models served on behalf
    of those vendors.
  - **Backend** (`ModelDiscoveryService.enrichModel`): `known-model-prices.ts`
    is now consulted _before_ models.dev and the OpenRouter cache, so curated
    per-provider prices win over upstream catalogs that may attribute the same
    model id to a different (cheaper) inference provider. Behaviour change for
    the existing entries (moonshot-v1, gemma-3-1b-it, gemini-pro-latest): they
    become authoritative instead of last-resort, which matches their intent.

  Builds on #1772, which introduced `route.provider` as the routing identity.

## 6.1.0

### Minor Changes

- ab9f0cb: Add an Anthropic Messages-compatible endpoint at `POST /v1/messages`. Anthropic SDK clients (Claude Code, `@anthropic-ai/sdk`) can now point `ANTHROPIC_BASE_URL` at a Manifest gateway and route through Manifest's tier/specificity pipeline like any OpenAI client. The implementation translates Anthropic Messages requests into the internal chat-completions form (and back on the response side), reusing the existing routing, scoring, fallback, and recording machinery.
- 1627493: Add a "Coding Assistant" category in the agent picker and move Claude Code into it. The Connect Agent / Change Agent Type modal now shows three columns instead of two: Personal AI Agent | App AI SDK | Coding Assistant. Claude Code is no longer mis-bucketed under personal agents — it sits in the new column with the existing copper-orange Claude mark. Picker order, icons, and the existing Claude Code setup wizard are unchanged.
- fb7d921: Add support for multiple API keys per provider per agent. Users with several accounts for the same provider (a personal + work OpenAI key, two ChatGPT Plus subscriptions, two Anthropic Pro tokens) can attach all credentials and pin specific tiers or fallback rows to a specific labeled key. Multi-key applies to both `api_key` and `subscription` providers; local providers (Ollama, LM Studio) stay single-row since they don't carry credentials. Cap is 5 active keys per (agent, provider, auth_type). Single-key users see no UI change — the chip + "+ Add another key" affordance only appear once a provider has 2+ active keys.
- c6efb87: Add Wingman, an in-dashboard gateway tester for contributors. Embedded as a half-screen iframe drawer behind a floating action button in dev mode, stripped from Docker / cloud bundles. Lets contributors send one-shot requests at the gateway while impersonating OpenClaw, Hermes, OpenAI SDK, Vercel AI SDK, LangChain, cURL, or Raw — with editable code panels that actually execute via stubbed SDKs.

### Patch Changes

- 9a0e8c3: Fix silent failure when adding a fallback that shares a provider with an existing route. Adding an OpenAI API key model as a fallback to an OpenAI subscription model (or any other same-provider, different-auth combination) now persists correctly instead of showing a success toast and dropping the change. The frontend now sends the explicit `(provider, authType, model)` tuple alongside the model name so the backend can disambiguate when the same model id is offered by two connected providers. Affects both complexity tier and specificity ("custom") routing.
- 30d19ab: Stop silently wiping the saved fallback list when an unresolvable model is added (issue #1790).

  `buildFallbackRoutes()` in `tier`, `specificity`, and `header-tier` services used to return `null` whenever any single model couldn't be resolved to a unique `(provider, authType, model)` tuple. `setFallbacks` then persisted that `null`, so the user's existing `fallback_routes` row was overwritten with `null` and the controller returned `[]`. The toast still said "Fallback added" — the only visible result was the previously-saved fallbacks disappearing.

  PR #1825 already plugged the most common trigger by sending an explicit `routes` payload from the add handlers. This change removes the underlying footgun: `buildFallbackRoutes` now throws `400 Bad Request` instead of returning `null`, so the row is left untouched on resolution failure and the frontend shows the error.

  Scoped strictly to the backend wipe path. Does not change input validation, the `authType !== undefined` guard in the add handlers, or the discovery-fallback shape of `buildFallbackRoutes`.

- 022529a: Fix MiniMax Token Plan activation redirecting to the homepage. The MiniMax `/oauth/code` endpoint returns a `verification_uri` pointing at `https://www.minimax.io/oauth-authorize?...`, which 307-redirects to the homepage with no instructions. The real authorize page lives on `platform.minimax.io` (and `platform.minimaxi.com` for the CN region). The MiniMax OAuth start flow now rewrites the host before returning the URI, so users land on the actual page where their 6-digit code can be entered. Closes #1796.

## 6.0.2

### Patch Changes

- cf98f70: Fix OpenAI subscription model discovery so newer Codex CLI models (e.g. `gpt-5.5`) appear. The hardcoded `client_version=0.99.0` query param made `https://chatgpt.com/backend-api/codex/models` silently return only the older subset; bump it to `0.128.0` and lift Codex/Copilot client identifiers into a shared constants file so future bumps are a one-line change.
- a7a9c3b: Fix fallback success rows recording the primary route's `auth_type` instead of the fallback's, which caused `cost_usd` to be miscomputed on mixed-auth chains (subscription fallbacks were charged, api_key fallbacks were stored as $0).
- be679c4: Strip Codex-unsupported parameters on the OpenAI subscription proxy path. Requests forwarded to `chatgpt.com/backend-api/codex/responses` now drop `temperature`, `top_p`, `max_output_tokens`, `metadata`, `safety_identifier`, `prompt_cache_retention`, and `truncation` before the upstream call, and force `store: false`. Previously these fields propagated through and Codex returned `400 unsupported_parameter`, breaking OpenAI-SDK clients that set sampling defaults. Closes #1791.

## 6.0.1

### Patch Changes

- e8162c3: Security hardening across the build pipeline and runtime: every GitHub Action is now pinned by commit SHA, the awesome-free-llm-apis data feed is pinned to an immutable commit and validated for HTTPS shape before render, the encryption-key cache no longer keeps the raw secret as a Map key, the Google Gemini API key moves from `?key=` query param to the `x-goog-api-key` header (so it stays out of upstream proxy/LB access logs), OpenAI OAuth error logs run through `scrubSecrets`, the OAuth `backendUrl` now prefers `BETTER_AUTH_URL` over the request `Host` header, the dev-loopback agent fallback prefers the seeded tenant over picking the first active key, rejected agent keys log only the fixed `mnfst_` prefix, and migrations log via the TypeORM logger instead of `console.log`. `npm audit fix` resolved vite + postcss CVEs. A boot-time check counts active legacy static-salt API-key hashes and warns if any remain (no forced rotation). `MANIFEST_ENCRYPTION_KEY` is now documented and threaded through `docker-compose.yml`; if unset the runtime still falls back to `BETTER_AUTH_SECRET`.
- f0082d5: Fix: detect Podman and Kubernetes as self-hosted runtimes. Manifest now reads `/run/.containerenv` (Podman) and `KUBERNETES_SERVICE_HOST` in addition to `/.dockerenv`, so rootless Podman and Kubernetes installs no longer fall back to cloud-mode SSRF rules and reject `http://` URLs to local LLM servers.

  Also narrows the cloud-metadata SSRF block to the actual IMDS addresses (`169.254.169.254`, `169.254.169.253`, `100.100.100.200`, `fd00:ec2::254`) instead of the entire `169.254.0.0/16` link-local range, so self-hosted users can reach `host.containers.internal` (which Podman maps to `169.254.x.y` under pasta/slirp4netns). Cloud mode is unchanged: link-local space is still rejected via the private-IP guard.

## 6.0.0

### Major Changes

- d4675ba: Drop the legacy routing identity columns from `tier_assignments`, `specificity_assignments`, and `header_tiers`. The structured `route` shape introduced in #1772 is now the only persistence form.

  Schema: 13 columns dropped (`override_model`, `override_provider`, `override_auth_type`, `fallback_models` from all three tables; `auto_assigned_model` from tier and specificity tables). Migration `1784000000000-DropLegacyRoutingColumns` runs on boot. `down()` re-adds the columns nullable but data is one-way lost — backup before upgrading if you maintain a hot-standby.

  API breaking change: `POST /api/v1/routing/resolve` no longer returns the flat `model`, `provider`, `auth_type`, `fallback_models` fields. External callers must read `route.model`, `route.provider`, `route.authType`, and `fallback_routes` instead.

  Internals: removes the legacy inference cascade in `proxy-fallback.service.ts`, the dual-write paths in routing services, and the `?? legacy` reads throughout. Same model name on different auth types stays correctly distinct (the #1708 fix).

### Minor Changes

- 1ce8ed9: Stable error codes for the proxy. Every user-facing `[🦚 Manifest]` message now embeds an `M###` code (M001–M500) and a docs link at `manifest.build/errors/M###`. Companion encyclopedia pages live in mnfst/docs.
- 1d37134: Routing identity is now backed by a structured `ModelRoute = (provider, authType, model)` shape stored alongside the existing legacy columns on `tier_assignments`, `specificity_assignments`, and `header_tiers`. Reads prefer the new shape and fall back to legacy, so existing rows keep working without intervention. Selecting the same model name under different auth types (e.g. `gpt-4o` on subscription and on api_key) is now correctly treated as two distinct routes — fixes #1708. The `/api/v1/routing/resolve` response gains additive `route` and `fallback_routes` fields without breaking the existing flat shape. Per-fallback-attempt `auth_type` is now recorded on `agent_messages` instead of inheriting the primary's. No UI, API contract, or data is removed in this release; legacy columns and fields stay populated for one cycle before being dropped in a follow-up.

### Patch Changes

- 4e7843a: Recreating an agent with a previously used name now produces a clean slate without losing the deleted agent's history. Agent deletion is soft (the row stays with `deleted_at` set, telemetry rows are preserved) and per-agent analytics scope to the live agent's id, so the new agent starts at zero while the old data remains queryable in storage.
- 2d4a06e: Show the Manifest version in the bottom-right corner of self-hosted Docker installs. Baked into the image at build time, no API call.

## 5.58.0

### Minor Changes

- 992ae47: Add saved cost metric to the Overview dashboard showing how much money routing saves compared to using a single model

### Patch Changes

- 7394235: Mark Manifest's canned setup-prompt and limit responses as Failed in the Messages list. Requests that hit `no_provider`, `no_provider_key`, `limit_exceeded`, or `friendly_error` (the `[🦚 Manifest] …` stubs) now show a red Failed badge with a tooltip explaining why, instead of an ambiguous green Success.
- 4bd4039: Fix two routing regressions caused by agent-wrapped user messages. Strip leading metadata envelopes (e.g. `Sender (untrusted metadata):` blocks emitted by OpenClaw, NanoBot, Hermes) before scoring so simple greetings like "say hello" no longer route to standard/complex (#1766). Tighten coding specificity signals so generic agent tools (`read`, `write`, `edit`, `bash`, etc.) and tiny envelope code fences no longer hijack every prompt to the coding tier (#1767).

## 5.57.0

### Minor Changes

- eacdc3a: Revert combined cloud + self-hosted message count on `/api/v1/public/usage`. The endpoint goes back to reporting cloud-only counts. The self-hosted aggregate fetcher and its `TELEMETRY_AGGREGATE_KEY` env var are removed.

## 5.56.0

### Minor Changes

- 97bfe4e: Public usage API combines cloud and self-hosted message counts. The `/api/v1/public/usage` endpoint now adds the fleet-wide self-hosted total fetched from the peacock control plane (when `TELEMETRY_AGGREGATE_KEY` is configured) to the cloud count, falling back to cloud-only if peacock is unreachable.

### Patch Changes

- 114e684: Fix proxy recording 0 tokens and "—" cost for streaming requests against Mistral, Kimi (Moonshot), MiniMax, DeepSeek, Qwen, xAI, Z.AI, Copilot, OpenCode-Go, and custom OpenAI-compatible providers. The proxy now injects `stream_options.include_usage: true` for all OpenAI-format endpoints so usage data flows back from the upstream.

  Also fix the cache-tokens column staying empty for the same providers: usage extraction now reads `prompt_tokens_details.cached_tokens` (DeepSeek, Z.AI, Mistral, MiniMax, OpenAI shape) in addition to the top-level `cache_read_tokens` and Anthropic-native `input_tokens_details.cached_tokens` keys.

- bdb43df: Strip `reasoning_details` from message history before forwarding to non-OpenRouter providers. Mistral, Groq, and other strict OpenAI-compatible providers were rejecting requests with `extra_forbidden` (422) when conversations contained extended-thinking blocks from a prior turn.

## 5.55.5

### Patch Changes

- 40faabb: fix(dashboard): the OpenClaw setup snippet was generating a config with `api: 'openai-responses'`, but Manifest's cloud proxy speaks Chat Completions. OpenClaw rendered empty assistant bubbles even though tokens were billed correctly. Snippet now writes `api: 'openai-completions'` and the dashboard label reads "OpenAI Chat Completions-compatible". Existing OpenClaw users who pasted the broken snippet need to re-run the updated config block (or flip `models.providers.manifest.api` manually).

## 5.55.4

### Patch Changes

- b2f01c4: Drop bundled `@esbuild/linux-x64` from the Docker image so CVE scanners no longer flag the embedded Go 1.23.12 stdlib (CVE-2025-68121 plus 10 high-severity CVEs). The binary was hoisted into the production `node_modules` despite `npm ci --omit=dev`; adding `--omit=optional` removes it along with other unused platform-specific binaries.

## 5.55.3

### Patch Changes

- 77a1db3: Backend hot-path and dashboard query optimization pass: 60s LRU session cache in SessionGuard, slimmed AgentKeyAuthGuard query with 30min cache, retuned specificity miscategorization index, batched proxy fallback inserts, merged agent-list stats+sparkline into a single query, bounded distinct-models scan to 90 days, plus typed SSE events so dashboard pages only refetch on relevant changes instead of every ingest ping.
- a5f0ef9: Security audit fixes (OWASP review).
  - Auth: SessionGuard and AgentKeyAuthGuard now read `request.socket.remoteAddress` for the loopback bypass decision instead of `request.ip`, which is forgeable via `X-Forwarded-For` when `trust proxy` is enabled. The production `trust proxy` setting is narrowed to `loopback, linklocal, uniquelocal` (override with `TRUST_PROXY` env).
  - Proxy: custom-provider and subscription endpoint URLs are revalidated against the SSRF allowlist immediately before each forward (DNS-rebinding defense). All proxy `fetch()` calls now use `redirect: 'error'` to block redirect-based escalation.
  - Auth rate limiting: added per-endpoint limits for `sign-up`, `forget-password` / `forgot-password` / `reset-password`, and `verify-email` / `send-verification-email` (Better Auth runs outside NestJS so `ThrottlerGuard` doesn't apply).
  - ApiKeyGuard: DB-API-key path now populates `request.user`, so user-scoped controllers no longer crash with a 500. `@CurrentUser()` fails closed with a 401 when no user is attached.
  - Crypto: AES-GCM IV length set to the standard 12 bytes (was 16), scrypt-derived keys cached per (secret, salt) to remove the per-call ~50ms cost on the proxy hot path. Boots warns once when `MANIFEST_ENCRYPTION_KEY` falls back to `BETTER_AUTH_SECRET` in production.
  - OAuth: `backendUrl` is validated against the allowlist at storage time instead of being trusted on the way out.
  - Telemetry: `routing_tier` and `auth_type` buckets are whitelisted against the shared enums; unknown values collapse to `"other"` instead of leaking verbatim.
  - Frontend: 401 responses no longer force a redirect to `/login` for per-endpoint auth failures. Only session-shaped 401s log the user out.
  - HSTS: warns at boot when production runs without HSTS on a non-loopback bind. Silence with `MANIFEST_DISABLE_HSTS=1`.
  - Dev CORS: defaults to a single origin (`http://localhost:3000`); set `CORS_ORIGIN` for anything else.

## 5.55.2

### Patch Changes

- 3173336: Bump Docker runtime to Node 24 LTS (`gcr.io/distroless/nodejs24-debian13`). Active LTS through April 2028, replacing Node 22 (Maintenance LTS, EOL April 2027). Build and prod-deps stages move to `node:24-alpine` and `node:24-slim` to keep install and runtime majors aligned. CI and release workflows updated to Node 24. Dependabot is now pinned to ignore Node major bumps so non-LTS Current releases (Node 23, 25, 27…) won't open noisy PRs — LTS upgrades happen on a deliberate cadence.

## 5.55.1

### Patch Changes

- f5c9af8: Polish auth flow accessibility and a few content fixes from a UX audit. Login, Register, and Reset Password inputs now have proper label/`for` association, `autocomplete` attributes for password-manager autofill, and `aria-describedby` linking errors to inputs. The cooldown intervals on resend buttons clean up on unmount. The Register page now links to real Terms and Privacy URLs (was `href="#"`). Section titles on Settings and Account use `<h2>` instead of `<h3>` to fix a heading hierarchy skip. Dark-variant logos use empty alt text so screen readers don't read "Manifest" twice. The Limits "Create rule" button uses the same plus icon as Workspace's "Connect Agent" button.
- 4664b2d: Fix agent duplication not copying local/custom providers correctly
- cc09e4f: Expose the OpenAI-compatible Responses API proxy at `/v1/responses` and show Responses API setup snippets by default for OpenAI SDK users.
- 0e8035c: Fix agent duplication not copying routing mode, local provider models missing from model picker, and local provider toggle errors

## 5.55.0

### Minor Changes

- 5bafaad: feat(providers): support Anthropic-compatible custom providers

  Custom providers can now speak the Anthropic Messages API (`/v1/messages`) in addition to OpenAI's `/v1/chat/completions`. When adding a custom provider, pick the API format in the new segmented control on the form — Manifest's existing Anthropic adapter handles the translation so agents continue to call the OpenAI-compatible proxy unchanged. Useful for Azure's Anthropic endpoint and any other gateway that exposes the native Anthropic protocol.

### Patch Changes

- d6afa94: Add a llama.cpp provider tile to the API Keys tab in the self-hosted version. Clicking it probes `http://localhost:8080/v1/models` on the default llama-server port, lists every model the server exposes, and lets you connect them in one click. Pre-b3800 llama.cpp builds that don't expose `/v1/models` get a hint to upgrade or fall back to the custom-provider form. Messages and dashboard filters render llama.cpp and LM Studio as first-class providers instead of opaque `custom:<uuid>` rows.

## 5.54.0

### Minor Changes

- 466e4cf: Drop the `Enable routing` relic: remove the empty-state card on the Routing page so tabs and tier cards render by default, drop the `complexity_routing_enabled` column and its endpoints/toggle (complexity scoring is always on), delete the bulk "Disable routing" button, rename cross-page CTAs from "Enable routing" to "Connect provider", and add a Connect-providers CTA inside the model picker's empty state.
- d78828c: Surface local models (Ollama, LM Studio) as their own provider category. New `auth_type: 'local'` joins `api_key` and `subscription`; messages routed to local runners now carry a grey house badge in the message log, routing cards, and cost-by-model table. The Add Provider modal gets a third **Local** tab that appears only on self-hosted installs. Backfill migrations re-tag existing Ollama/LM Studio `user_providers` rows, and custom providers whose display name resolves to a canonical local runner are tagged `local` at insert time. Connecting/disconnecting a local provider works like the Subscription tab — click-to-disconnect flips the toggle and stops routing to it.

## 5.53.0

### Minor Changes

- 039afbe: Duplicate an agent in one click — hover any agent card on the Workspace to reveal a menu with Duplicate and Delete, or use the new "Duplicate agent" button on the Settings page. Creates a new agent with a fresh API key and carries over every provider credential, custom provider, tier override, and specificity override. Messages, logs, and notification rules stay with the original.

### Patch Changes

- 5110901: Polish routing page copy and UX: rewrite tier descriptions, standardize casing and pluralization, always show the "How routing works" help button, toggle tiers by clicking the manage-modal row, and add a pen icon on custom tier cards to open the edit modal directly.
- 91a7467: Low-risk cleanups from the 2026-04-23 OWASP audit that cause no behaviour change for operators or users:
  - Scope agent rename cascades by `tenant_id` on `agent_messages` / `notification_rules` / `notification_logs`. Forward-only fix — no backfill — so any pre-existing row that was mislabelled when slugs collided across tenants stays as-is; new renames no longer touch other tenants' data.
  - Replace `ApiKeyGuard.safeCompare` with `Buffer.from` + length-check + `timingSafeEqual`. Same observable behaviour; cleaner canonical pattern.
  - Add a snapshot test for `ThresholdAlertEmail` against hostile agent names (angle brackets, attribute-context quote payloads) — verifies React's existing escaping, no runtime change.
  - `npm audit fix` for the moderate `@nestjs/core` advisory (11.1.17 → 11.1.19).

  All other findings from the audit are deferred — they required breaking changes or operator action and live in a separate tracking issue.

## 5.52.0

### Minor Changes

- f8e00c9: Make complexity routing optional. New agents now default to a single "Default" tier that handles every request — pick one model and you're routing. Complexity routing (four tiers scored by request content) becomes an opt-in toggle on the Routing page alongside the existing task-specific routing. Existing agents keep complexity routing on with their tier picks preserved.

## 5.51.0

### Minor Changes

- 910b191: Add custom header-triggered routing tiers. Configure a tier keyed to an HTTP header key+value pair (e.g. `x-manifest-tier: premium`) and every matching request routes directly to that tier's model, overriding specificity and complexity. Each tier gets a user-picked name + color that shows as a badge on the message row. The create modal autocompletes the header key from the keys Manifest has already seen in the last 7 days, grouped by the SDK that sent them, with example values. Sensitive headers (`authorization`, `cookie`, …) are blocked from being used as match rules.

## 5.50.1

### Patch Changes

- 37308ea: Fix cost column showing "—" for self-hosted custom provider messages. Prices entered via the custom provider form are now indexed into the shared pricing cache under `custom:<uuid>/<model>` — the same key the proxy writes to `agent_messages.model` — so the cost recorder can look them up when a request is routed. The cache refreshes immediately on create, model edits, and delete, so new prices take effect without waiting for the daily 5am reload. Custom entries are scoped out of the public `/api/v1/model-prices` list so one tenant's providers can't leak into another's. Existing messages recorded with `cost_usd = null` stay null (no price snapshot is stored per message); only new messages benefit.

## 5.50.0

### Minor Changes

- abd9dea: Promote LM Studio to a first-class provider tile alongside Ollama. In the self-hosted version, clicking the LM Studio tile opens a dedicated detail view that probes `http://{localLlmHost}:1234/v1`, lists the loaded chat models, and connects them in one click — no URL typing, no manual pricing. A refresh icon re-probes after the user swaps models on the host. When the probe fails inside Docker, the detail view surfaces a two-path "Fix it" card: GUI toggle (LM Studio → Developer → "Serve on Local Network") and CLI one-liner (`lms server start --bind 0.0.0.0 --port 1234 --cors`) with a Copy button and a "one-time setup" reassurance. Embedding / reranker / moderation models are filtered out of the discovered list so they don't leak into the routing tier picker. Local-only tiles are disabled in cloud mode with an "Only available on self-hosted Manifest" hint. The `customProviderLogo` lookup now normalizes names against the shared registry, so an "LM Studio" custom provider shows the real logo everywhere (tier cards, Messages table, Model Prices, Fallback picker).

## 5.49.3

### Patch Changes

- 40e9f9f: Add `org.opencontainers.image.base.name` and `org.opencontainers.image.base.digest` OCI labels to the Docker image so Docker Scout can evaluate the "No unapproved base images" and "No outdated base images" policies.

  The published image already ships SLSA provenance and SPDX SBOM attestations (the build workflow sets `sbom: true` and `provenance: mode=max`), but Scout's base-image policies key off the OCI base-image labels on the image config and buildkit does not auto-generate them. Without the labels, Scout reports "No data" for both policies and the image is stuck at a B health score even when it has no outstanding CVEs.

  The labels sit next to the matching `FROM … AS runtime` line so a future base-image bump updates both together. No change to build output size, runtime behavior, or the attestation manifests — pure metadata addition on the image config.

## 5.49.2

### Patch Changes

- fec55cf: Bump Docker runtime to `gcr.io/distroless/nodejs22-debian13:nonroot` to clear 9 CVEs (1 CRITICAL / 8 HIGH) that the published image inherited from the older `nodejs22-debian12` base.

  Root cause: Google hasn't rebuilt any tag on `gcr.io/distroless/nodejs22-debian12` since Node 22.22.2 and Debian 12's `openssl 3.0.19-1~deb12u2` shipped. Every `debian12` variant still bakes Node 22.22.0 on top of the vulnerable `openssl 3.0.18-1~deb12u2`, so a digest refresh alone couldn't clear the scan. The `nodejs22-debian13` family already publishes Node v22.22.2 on a newer openssl, so moving the runtime stage to it fixes both CVE sources in a single base-image bump.

  The move is safe: the prod-deps stage runs `npm ci --ignore-scripts`, so no native modules are compiled and the runtime's glibc version is invisible to `node_modules`. `node:22-alpine` and `node:22-slim` digest pins were also refreshed for hygiene — those layers don't ship in the final image.

  **CVEs cleared:**
  - CVE-2025-55130 (CRITICAL, CVSS 9.1) — Node
  - CVE-2025-55131, CVE-2025-59465, CVE-2025-59466, CVE-2026-21637, CVE-2026-21710 (HIGH) — Node
  - CVE-2026-28388, CVE-2026-28389, CVE-2026-28390 (HIGH) — Debian openssl

  **Verification:** Local Trivy scan (`--severity HIGH,CRITICAL --ignore-unfixed`) reports 0 findings post-bump (was 9). `docker compose up -d` passes the healthcheck in ~14s and `/api/v1/health` returns `{"status":"healthy"}`.

## 5.49.1

### Patch Changes

- 19f6b0e: Four small Docker-compose quality-of-life fixes, all verified against an existing install without data loss:
  - **Project name pinned to `mnfst`.** Docker Compose used to infer the project name from the install directory's basename (typically `manifest`), so two unrelated projects both happening to live in a `manifest/` directory would silently share container namespace — the user who reported this saw a `Found orphan containers` warning from a completely unrelated container. Added `name: mnfst` at the top of `docker/docker-compose.yml`. Container names move from `manifest-manifest-1` / `manifest-postgres-1` to `mnfst-manifest-1` / `mnfst-postgres-1`.
  - **`pgdata` volume name pinned to `manifest_pgdata`.** With the project rename, Docker would have created a fresh empty `mnfst_pgdata` volume on next `up`, orphaning every existing self-hoster's database. Pinning `volumes.pgdata.name` to the historical `manifest_pgdata` keeps the new compose file attaching to the existing data. Verified locally: tore down an existing `manifest` stack, booted the new file from a different directory, confirmed the `mnfst-postgres-1` container mounted `manifest_pgdata` with all 51 migrations intact.
  - **Healthcheck `start_period` 45s → 90s.** On a cold first pull, Docker was flipping the container to `unhealthy` before the backend had finished pulling images + running migrations + warming the pricing cache. The 90s grace gives real installs room to boot.
  - **Log rotation.** Default Docker `json-file` logging is unbounded — a long-running install can silently fill the host disk. Both services now cap at 5 × 10 MB per container (~50 MB ceiling each).

  **CI:** added an `install-script` job in `docker-smoke.yml` that runs the actual `docker/install.sh` end-to-end against the PR-built image. Caught the `${p}` healthcheck-escape regression retroactively — and will catch the next one before it ships. The installer now reads its source from `MANIFEST_INSTALLER_SOURCE` (defaults to `main` on GitHub), so the CI job can point it at a local HTTP server serving the branch under test.

- 321a644: **Route OpenAI Codex, `-pro`, `o1-pro`, and deep-research models to `/v1/responses` for API-key users.** Closes #1660.

  OpenAI's `gpt-5.3-codex`, `gpt-5-codex`, `gpt-5.1-codex*`, `gpt-5.2-codex`, `gpt-5-pro`, `gpt-5.2-pro`, `o1-pro`, and `o4-mini-deep-research` only accept `api.openai.com/v1/responses` — they return HTTP 400 "not a chat model" on `/v1/chat/completions`. Manifest's subscription path already routed these correctly via the ChatGPT Codex backend, but API-key users always hit `/v1/chat/completions` and failed. Prod telemetry: 31 distinct users attempting Codex on API keys over the last 90 days, 36% error rate, one user stuck in a 1,400-call retry loop at 98% failure.
  - New `openai-responses` provider endpoint targeting `api.openai.com/v1/responses`, reusing the existing `chatgpt` format (same `toResponsesRequest` / `convertChatGptResponse` converters used by the subscription path — just with a plain `Authorization: Bearer` header instead of the Codex-CLI masquerade).
  - `ProviderClient.resolveEndpoint` swaps `openai` → `openai-responses` at forward time for any model matching the Responses-only regex. Subscription OAuth still routes to `openai-subscription` as before; custom endpoints are never overridden.
  - Model discovery no longer drops Codex/-pro/o1-pro/deep-research — they're kept so users can select them and the proxy routes them transparently. `gpt-image-*` is moved to the non-chat filter (it was only incidentally caught by the old Responses-only filter; it's image generation, not a chat model).
  - `OPENAI_RESPONSES_ONLY_RE` moved to `common/constants/openai-models.ts` with a shared `stripVendorPrefix` helper, so discovery and the proxy read the same source of truth without cross-module coupling.

## 5.49.0

### Minor Changes

- 59bb203: New Docker installs get port **2099** (a nod to the peacock logo) by default. Existing installs keep their current port — no action required on upgrade.

  ### How backward compatibility is preserved
  - The backend's own fallback stays at `3001` (it's `process.env.PORT ?? 3001` everywhere).
  - The Docker Compose file now sets `PORT=${PORT:-2099}` explicitly. New installs from `install.sh` get 2099 end-to-end: backend listens on 2099, compose binds `127.0.0.1:2099:2099`, and `BETTER_AUTH_URL` defaults to `http://localhost:2099`.
  - Existing installs that pull the new image against their unchanged compose file continue to work: no `PORT` env, so the backend falls back to 3001, their old `127.0.0.1:3001:3001` binding still matches, and their `BETTER_AUTH_URL` / reverse proxy / OAuth callbacks all keep working.
  - If a user wants to upgrade their compose file but keep port 3001 (e.g., to avoid reconfiguring OAuth callbacks), they set `PORT=3001` in `.env` and the compose file honours it — both the host binding and the internal listener now read `${PORT:-2099}`.
  - The Dockerfile `HEALTHCHECK` reads `process.env.PORT || 3001` at runtime so it follows whatever port the backend is actually listening on, regardless of which image-version pairs with which compose file.

  ### Install script UX (closes #1643)
  - Default install directory is now `$HOME/manifest` (was `./manifest`), so the one-liner from `install.sh` no longer litters whatever directory you happened to run it in.
  - The confirmation prompt reads from `/dev/tty` when stdin is not a terminal (typical when piping `curl | bash` or running via `bash <(curl ...)`). If there is no terminal at all, the script exits with a clear message pointing at `--yes`.
  - Detects port conflicts up front: if `2099` is already bound, the installer aborts with a pointer to edit `docker-compose.yml`, instead of letting `docker compose up` fail with a less obvious message.
  - Copy fix: "up to a couple of minutes" instead of "about 30 seconds" (the installer itself waits up to 120s).
  - Prints a `curl -sSf http://localhost:2099/api/v1/health` smoke-test line alongside the dashboard URL on success.
  - README now documents `--dir`, `--yes`, `--dry-run` and shows the review-then-run idiom for security-cautious users.

  ### Housekeeping
  - Rename `packages/backend/src/common/utils/sql-dialect.ts` → `postgres-sql.ts`. The file only emits Postgres SQL (no dialect switching), so the old name was misleading. 20 import sites updated.

## 5.48.0

### Minor Changes

- b41c0a2: Connect the Dockerized self-hosted version to local LLM servers on the host. The bundled `--profile ollama` service is gone; the Manifest container now reaches host-installed Ollama, vLLM, LM Studio, llama.cpp, text-generation-webui, and any OpenAI-compatible server at `host.docker.internal:<port>` via a `host-gateway` alias. Custom providers accept `http://` and private/loopback URLs in the self-hosted version (cloud metadata endpoints stay blocked). Adds preset chips for local servers and a server-side `/v1/models` probe that auto-populates the model list. Renames the deployment concept from "local" to "self-hosted" across the codebase (`MANIFEST_MODE=selfhosted`, `isSelfHosted()`); `MANIFEST_MODE=local` is still honored as a legacy alias.
- 7de07d2: Capture incoming request headers on every proxied chat completion and surface them in the message detail drawer, with a new App/SDK meta row sourced from the existing caller attribution. Sensitive headers (authorization, cookie, proxy-authorization, x-api-key) are stripped before storage, and the Request Headers section is collapsed by default.
- 30adc95: Fix web_browsing false positives that misrouted coding sessions. Pruned generic web-dev vocabulary (html, dom, url, http, link, page) from the webBrowsing keyword list, added weighted scoring, URL detection, code-fence/file-path signals, session stickiness across recent turns, a confidence gate, and a "Wrong category?" feedback control in the Messages log that dampens repeatedly-miscategorized categories.

### Patch Changes

- 2051a74: Code quality audit cleanup across backend, frontend, and shared packages:
  - Consolidate the provider registry into a single source of truth at `packages/shared/src/providers.ts` that the backend `PROVIDER_REGISTRY` and frontend `PROVIDERS` both consume, eliminating drift.
  - Drop the vestigial `DbDialect` / `detectDialect` / `portableSql` helpers and the `_dialect` parameter threaded through seven services; Manifest has been Postgres-only for some time.
  - Port `NotificationRulesService` off raw `DataSource.query()` onto TypeORM repositories + QueryBuilder.
  - Remove the unused `TokenUsageSnapshot` / `CostSnapshot` entities (tables remain; no data migration).
  - Extract scattered `if (provider === 'xai' | 'copilot' | ...)` branches into data-driven hooks (`provider-hooks.ts`).
  - Split `scoring/keywords.ts` (949 lines) into one file per specificity category under `scoring/keywords/`.
  - Split `ProxyService.proxyRequest`, `ProxyController.chatCompletions`, `MessagesQueryService.getMessages`, and `ProviderClient.forward` into focused helpers (all previously 130+ lines).
  - Consolidate the frontend API layer: `fetchMutate` now takes a path, and a `routingPath(agentName, suffix)` helper replaces 30+ duplicated `${BASE_URL}/routing/${encodeURIComponent(...)}` literals.
  - Add `recordSafely()` and `buildMessageRow()` helpers in the proxy write path to dedupe seven fire-and-forget `.catch(logger.warn)` blocks and five near-identical message inserts.
  - Remove the deprecated `subscriptionOAuth` flag (use `subscriptionAuthMode === 'popup_oauth'`).
  - Drop the identity `sql()` wrapper in `EmailProviderConfigService` and helpers.

- 4599c47: Shrink the Docker image by switching the runtime stage to distroless Node 22 (`gcr.io/distroless/nodejs22-debian12:nonroot`):
  - Runtime drops the shell, `apk`, and the unused yarn toolchain that `node:22-alpine` bakes in.
  - Production dependencies are now staged on `node:22-slim` so glibc matches the distroless debian12 runtime (all runtime deps are pure JS).
  - Prune `sql.js` from the runtime node_modules — it's an optional TypeORM peer only used by the legacy SQLite local mode, which is never active in Docker.
  - Add `--prefer-offline --no-audit --no-fund` to all npm installs, and pin the two new base images by digest.
  - Result: `423MB → 362MB` on disk (−14.4%), `84.2MB → 71.9MB` compressed pull (−14.6%).

- d5b23dc: Fix custom providers mangling upstream model IDs that contain `/` characters (#1591, #1615). Multi-segment model names like `MiniMaxAI/MiniMax-2.7` or `accounts/fireworks/routers/kimi-k2p5-turbo` are now forwarded to the upstream API unchanged instead of having a legitimate slash segment stripped.
- bb3dc29: Retire residual SQLite / sql.js / "local mode" references left behind after the local-mode path was removed:
  - Drop the dead `isLocal()` branch in `RoutingInstructionModal` (the `/api/v1/health` endpoint never returns `mode`, so the branch was unreachable) and the test that faked a `mode: "local"` health response to exercise it.
  - Tighten the frontend `NotificationRule.is_active` type from `boolean | number` to `boolean`, and drop the `typeof === 'number' ? !!x : x` coercion in `Limits.tsx` and `LimitRuleTable.tsx` (the integer boolean was a SQLite-era shape; the backend returns real booleans).
  - Remove the dead `connection: { options: { type: 'sqlite' } }` mock in `proxy.controller.spec.ts` — no production code reads `ds.connection.options.type`.
  - Remove the stale `vi.mock("../../src/services/local-mode.js", ...)` in `ProviderSelectModal-opencode-go.test.tsx` (module was deleted long ago).
  - Refresh the `packages/backend/src/common/utils/sql-dialect.ts` header (no dialect switching happens — the file is Postgres-only).
  - Fix comment/test-description rot: "dialect" wording in `query-helpers.ts` + spec, "local mode" in `Sidebar.test.tsx` / `session.guard.spec.ts` / `proxy-rate-limiter.ts`, "PG & sql.js" in `costs.e2e-spec.ts`.
  - Update `CLAUDE.md`: drop references to deleted files (`local-bootstrap.service.ts`, `local-mode.ts`, `LocalAuthGuard`), drop the `MANIFEST_DB_PATH` / `MANIFEST_UPDATE_CHECK_OPTOUT` env vars (no-ops per the v2.x breaking changes), drop the "Local mode database uses sql.js" architecture note, and correct the "Better Auth database" section (Postgres always).

  No behaviour change — all four test suites green (backend 4007, frontend 2267, e2e 123) and both packages typecheck clean.

## 5.47.2

### Patch Changes

- 135b9e3: Fix blank dashboard when exposing Manifest on a LAN IP over HTTP. Helmet's default CSP emitted `upgrade-insecure-requests`, which browsers enforce on private IPv4 ranges (10.x, 172.16-31.x, 192.168.x) but relax for localhost — so the JS bundle was rewritten to `https://` and silently failed to load, leaving an empty `<body>`. The directive is now disabled; HTTPS deployments should enforce upgrades via HSTS at the reverse proxy instead.

## 5.47.1

### Patch Changes

- b28f714: Docker hardening Phase 3 follow-ups: add a 64MB cap to the manifest container's `/tmp` tmpfs, raise `pids_limit` from 256 to 512, and switch the healthcheck from BusyBox `wget` to a `node -e fetch(...)` invocation that's guaranteed to exist in the runtime image. Narrow the Dockerfile's `node_modules` `*.md` cleanup to `README*` only so packages that read nested markdown at runtime (e.g. `js-yaml` schema docs) keep working. Gate `/api/v1/public/{usage,free-models,provider-tokens}` behind `MANIFEST_PUBLIC_STATS=true` (default off, returns 404) so self-hosted instances don't leak aggregate stats to unauthenticated callers. Detect non-chat callers in the proxy exception filter and the `chat/completions` catch block via `body.stream === true` / `Accept: text/event-stream`; non-chat clients now receive real `401`/`400`/`500` HTTP statuses with a structured error envelope while chat UIs continue to get the friendly HTTP-200 envelope. Rewrite `og:url` / `og:image` in the SPA's `index.html` from `BETTER_AUTH_URL` at boot so self-hosters' shared link previews show their own URL instead of `app.manifest.build`. Add a `status` query parameter to `/api/v1/messages` (`ok`, `error`, `rate_limited`, `fallback_error`, or `errors` for the union of the three error variants) so the dashboard can offer an "errors only" toggle. Add `.github/workflows/docker-smoke.yml` that boots the production compose stack with `read_only: true`, waits for `/api/v1/health`, and tears down — guards against future code that silently writes to disk.
- b9011ae: Fix deleted custom providers continuing to intercept every request (#1603). Specificity routing now validates that an override model is still available before using it, and deleting a custom provider now also clears orphan references in specificity assignments and fallback-model lists. A one-time migration cleans existing orphaned references from the database so previously affected agents recover automatically.

## 5.47.0

### Minor Changes

- 2493d97: feat: add OpenCode Go as a subscription provider with dynamic model discovery

  OpenCode Go is a low-cost subscription that exposes GLM, Kimi, MiMo, and MiniMax
  models through a unified API. Users sign in at opencode.ai/auth, copy their API
  key, and paste it into the OpenCode Go detail view in the routing UI. The backend
  routes GLM/Kimi/MiMo models through the OpenAI-compatible endpoint and MiniMax
  models through the Anthropic-compatible endpoint — both served from the same
  `https://opencode.ai/zen/go` base URL. The Anthropic endpoint authenticates via
  `x-api-key` (not Bearer), matching the native Anthropic wire protocol.

  The model list is fetched dynamically from the public OpenCode Go docs source
  and cached in memory for one hour, with a last-known-good fallback on fetch
  failures. No hardcoded model list in the codebase.

- 313a332: Add per-message feedback (thumbs up/down) to Messages and Overview pages

### Patch Changes

- 4dda346: Filter internal Azure routing models from GitHub Copilot provider

## 5.46.7

### Patch Changes

- aeb7a54: fix(proxy): capture streaming token usage for Ollama and Ollama Cloud providers

## 5.46.6

### Patch Changes

- 83afc73: fix(docker): auto-detect local mode in Docker containers via /.dockerenv
- 83afc73: fix: show email verification prompt after signup instead of silently reloading

## 5.46.5

### Patch Changes

- 19a1366: Improve local/Docker mode: hide social login buttons when OAuth is not configured, fix per-user data isolation, add optional Ollama via Docker Compose profile, and expose mode/Ollama status in setup endpoint.

## 5.46.4

### Patch Changes

- d6de5d5: Fix Hermes setup instructions to use top-level model section instead of custom_providers

## 5.46.3

### Patch Changes

- 71112c7: Fix dashboard Recent Messages showing the complexity tier (e.g. `STANDARD`) instead of the specificity category (e.g. `CODING`) for messages routed by specificity. The Overview analytics endpoint now projects `specificity_category` alongside `routing_tier`, matching the full Messages log.
- 97dbe29: Rewrite the `[🦚 Manifest] …` friendly error messages the proxy sends back as chat completions so they read less like a system alert and more like a note from a person. Em dashes are gone, "connected successfully" is gone, "this API key wasn't recognized" becomes "I don't recognize this key", limit messages lead with "You hit your ${metric} limit" instead of the clinical "Usage limit hit:", and the auth-header hint now tells users the exact `Bearer mnfst_<your-key>` format to paste. No behavioural change — same triggers, same URLs, same branching; just different copy.
- 43590ad: Route short greetings to the `simple` tier even when the agent attaches tools. The scorer's short-message fast path was gated on `!hasTools`, so personal AI agents like OpenClaw (which always send a `tools` array) skipped it entirely and fell into full scoring, where session momentum could pull a one-word `hi` up to `complex`. Dropping the gate lets short, non-technical prompts short-circuit to `simple` before momentum kicks in. Short technical prompts like `Debug this function` still fall through to full scoring.

## 5.46.2

### Patch Changes

- acd1f9c: Docker release hardening pass: parameterize POSTGRES_PASSWORD and wire `.env.example` through `install.sh`; bind port 3001 to `127.0.0.1` by default; drop stale `MANIFEST_TRUST_LAN` from docs; replace OpenClaw-specific meta tags in the SPA with agent-neutral copy. `/api/v1/routing/:agent/status` now returns a structured `{ enabled, reason }` shape and only claims `enabled: true` when at least one tier resolves to a real model (`reason: no_provider | no_routable_models | pricing_cache_empty`). Provider connect rejects unknown providers and normalises casing. Tier override rejects unknown models with a helpful list. New `GET /api/v1/routing/pricing-health` and `POST /api/v1/routing/pricing/refresh` endpoints plus a Routing-page banner when the OpenRouter pricing cache is empty. Workspace-card and per-agent message counts now exclude error and fallback-error rows.
- 68510a5: Fix the "check your dashboard" links that Manifest embeds in `[🦚 Manifest] …` friendly error messages returned by the OpenAI-compatible proxy. Auth errors (missing / empty / invalid / expired / unrecognized key) used to emit `${baseUrl}/routing`, which 404'd — that path does not exist in the frontend router. They now point at the Workspace landing page. Agent-scoped errors used to drop the user on the agent Overview page; they now deep-link to the section that actually fixes the problem — "No API key set for X" and "Manifest is connected successfully, connect a provider" go to `/agents/:name/routing`, and "Usage limit hit" goes to `/agents/:name/limits`.

## 5.46.1

### Patch Changes

- fc7890f: Remove local mode and harden the Docker deployment.

  Manifest now runs exclusively on PostgreSQL with Better Auth. The self-contained `manifest` OpenClaw plugin (embedded Nest server, SQLite via sql.js, loopback-trust auth) is deprecated and removed from the repository — it will receive no further releases. Self-hosted users should use the Docker image (`manifestdotbuild/manifest`) with the bundled Postgres container via `docker/docker-compose.yml`, or the cloud version at app.manifest.build.

  Docker deployments now default to `NODE_ENV=production`, with migrations controlled by a new `AUTO_MIGRATE=true` env var instead of the previous `NODE_ENV=development` workaround. Production-mode defaults activate: `trust proxy` for reverse-proxied deployments, sanitized upstream error messages, no "Dev" badge in the header, and email verification enforcement when a provider is configured. Self-hosters upgrading must set `BETTER_AUTH_SECRET` via `docker/.env` — the compose file no longer ships a placeholder secret.

  New unified `EMAIL_*` env var scheme (`EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_DOMAIN`, `EMAIL_FROM`) covers both Better Auth transactional emails (signup verification, password reset) and threshold alert notifications. Supports Resend (recommended for self-hosting — no domain setup), Mailgun, and SendGrid. Legacy `MAILGUN_*` env vars still work for backward compatibility.

  Breaking: `MANIFEST_MODE`, `MANIFEST_DB_PATH`, `MANIFEST_UPDATE_CHECK_OPTOUT`, `MANIFEST_TRUST_LAN` env vars are removed (no-op if set). Both the `manifest` and `manifest-model-router` npm packages are deprecated — OpenClaw users should configure Manifest as a generic OpenAI-compatible provider instead (see the setup modal in the dashboard).
