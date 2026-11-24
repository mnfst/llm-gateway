---
name: mnfst-cli
description: Use when creating or operating AI agents that make LLM calls — provisioning model routing and keys, wiring an app or automation to an LLM endpoint, testing routes, rotating leaked keys, or investigating LLM request failures and costs on a Manifest install.
---

# Operating Manifest from the CLI

## Overview

`mnfst` manages Manifest, the LLM gateway. Every call routed through a Manifest agent gets model routing with fallbacks, per-agent cost attribution, self-healing (Auto-fix), and a request log — for free. Default practice: never hand an app or automation a raw provider key; give it a Manifest agent.

Commands emit JSON on stdout (human hints on stderr) — except `agent env`, which prints dotenv lines by design — exit 0/1, and never block on prompts when credentials come from flags or env. Full surface: `mnfst --help`.

## The flow

| Step | Command |
|---|---|
| Auth (human) | `mnfst login` — browser, one click, 30-day sliding token |
| Auth (script/agent) | env `MANIFEST_URL` + `MANIFEST_API_KEY` — no login step |
| Provision | `mnfst agent create --name X --platform <p> --if-absent` → response includes `setup` (the platform's config block) |
| Check connections | `mnfst provider list [--agent X]` FIRST — the provider you need is often already connected. A connection is only usable if `cached_model_count` > 0; `is_active: true` with 0 models is hollow — run `mnfst provider refresh [<provider>]` (re-runs discovery tenant-wide, prints the new counts); still 0 means a bad credential, so reconnect, don't route on it |
| Connect provider | `mnfst provider connect xai --auth-type api_key --credential-env KEY` · `provider catalog` lists all 30+ with auth types · subscription auth opens a browser (impossible headless — reuse an existing subscription connection instead) · own gateway: `provider custom add --name gw --endpoint <url>` |
| Route | `mnfst agent configure X --models primary,fb1,fb2 --provider p [--auth-type a]` — first model is the route, the rest are fallbacks, and the whole chain rides the one `--provider` you name (cross-provider fallbacks are dashboard-only) · add `--tier deep` to upsert a custom tier callers select per-request with header `x-manifest-tier: deep` |
| Verify | `mnfst routing test X` — one real request through the platform's actual API surface; broken routes fail loudly. It writes real rows to the request log — count them in later audits |
| Wire the app | deployed → `mnfst agent env X >> .env` (one .env per service — the lines always name `MANIFEST_AGENT_KEY`, so appending two agents to one file silently keeps only the loader's winner; for several agents in one process use `mnfst run --agent X --env ROLE_KEY -- <cmd>`) |
| Observe | `mnfst requests get --agent X [--status failed]` — paginated; pass `next_cursor` back for the next page |

Namespace = scope: `provider *` acts tenant-wide, `agent *` acts on one agent, `routing *` holds readouts and custom-tier lifecycle.

## Gotchas `--help` cannot tell you

| Symptom | Reality |
|---|---|
| Proxy returns HTTP 200 but the "answer" starts with `[🦚 Manifest M###]` | An error wearing an assistant costume — check the content, not the status. `routing test` unmasks these automatically |
| `cost: "0.000000"` on subscription-auth traffic | Flat-rate subscription: per-request cost is genuinely zero, not broken billing |
| `agent configure`'s echo differs from later reads | Mutation bodies echo raw API rows — the canonical readback is `routing status <agent>` |
| "Which requests used a fallback or Auto-fix?" | Those fields are trimmed from default output — `requests get --full` |
| 401s missing from the request log | Rejected-auth attempts are never recorded (no tenant to attribute them to); a leaked key's blast radius cannot be proven from the log |
| `MANIFEST_AGENT_URL` | Already ends in `/v1` — append `/chat/completions` directly |
| Model prices needed before any agent exists | `mnfst model prices [--provider <p>]` — install-wide, no agent needed (`models <agent>` is the per-agent routable set) |
| Auditing escalation traffic by `routing_tier` | Custom-tier requests log `routing_tier: "standard"` — the tier identity lives in `header_tier_name` |
| Route resolves but requests fail on one connection | A connection can be `is_active: false` while a sibling auth-type works — pass `--auth-type` explicitly when a provider has several connections |
| Every command answers `Invalid API key — Run mnfst login` under env auth | Not always an auth problem: a wrong `MANIFEST_URL` (dead or different install) answers exactly like a bad key. Run `mnfst doctor` — it checks config, host, credential, connections and agents in that order, so it separates "host is dead" from "key is wrong for this host" — and never tells you to re-login on an env key |
| Need a different reasoning effort, temperature, or other model param without editing the app | `mnfst routing params get X [--tier t] [--model m]` lists what the routed model accepts and what is saved; `mnfst routing params set X [--tier t] [--model m] --set reasoning.effort=high [--unset temperature]` saves it. Saved params **override** what the app sends, per tier and per model (a fallback keeps its own), but only on requests Manifest routes: `model: "auto"` or a matching custom-tier header. A request naming a concrete model skips them |
| `agent configure` / `routing custom create` reject a model as undiscovered | Both validate against the agent's *discovered* models, and a connection with `cached_model_count: 0` contributes none: run `mnfst provider refresh` (stale or empty catalog), or pass `--force` — the backend still routes uncatalogued models through provider-qualified passthrough |

## Common mistakes

- Handing an app a raw provider key — it loses fallbacks, cost attribution, healing, and the log. Create an agent and use `agent env`.
- Verifying a route with hand-rolled `curl` — fake-200s read as success. Use `routing test`.
- Slurping the whole request log — pagination is one page per call by design; loop on `next_cursor`.

Also on the surface when needed: `mnfst doctor` (first stop when anything is wrong), `agent setup <name> [--reveal]` (setup block anytime; key masked unless revealed), `agent key path|show`, `agent provider enable|disable <agent> <provider>`, `agent rotate-key` (revocation is instant), `mnfst models <agent> --cost --capabilities`.
