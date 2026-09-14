<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/mnfst/manifest/HEAD/.github/assets/logo-white.svg" />
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/mnfst/manifest/HEAD/.github/assets/logo-dark.svg" />
    <img src="https://raw.githubusercontent.com/mnfst/manifest/HEAD/.github/assets/logo-dark.svg" alt="Manifest" height="53" title="Manifest"/>
  </picture>
</p>
<p align="center">
  <a href="https://hub.docker.com/r/manifestdotbuild/manifest"><img src="https://img.shields.io/docker/pulls/manifestdotbuild/manifest?color=2496ED&label=docker%20pulls" alt="Docker pulls" /></a>
  &nbsp;
  <a href="https://github.com/mnfst/manifest/stargazers"><img src="https://img.shields.io/github/stars/mnfst/manifest?style=flat" alt="GitHub stars" /></a>
  &nbsp;
  <a href="https://github.com/mnfst/manifest/blob/main/LICENSE"><img src="https://img.shields.io/github/license/mnfst/manifest?color=blue" alt="license" /></a>
  &nbsp;
  <a href="https://discord.gg/FepAked3W7"><img src="https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
</p>

> ### 🚀 Manifest is becoming the self-healing layer for APIs
>
> We're building a new product that fixes failed API requests on the fly, independently of the gateway.
>
> **This open-source gateway stays available and maintained.**
>
> **[Read more](https://manifest.build/blog/manifest-is-taking-a-new-direction/)**

## What is Manifest?

Manifest is a smart model router for **AI agents** like OpenClaw, Hermes, or anything speaking the OpenAI-compatible HTTP API. It sits between your agents and your providers (API keys, subscriptions, or local models) and sends each request to the right one. Simple questions go to fast, cheap models. Hard problems go to the powerful ones. One endpoint for every provider, and a smaller bill as a bonus.

- One endpoint, every provider: send each request to the right model
- Automatic fallbacks: if a model fails, the next one picks up
- Set limits: don't exceed your budget
- Self-hosted: your requests, your providers, your data

![manifest-gh](https://raw.githubusercontent.com/mnfst/manifest/HEAD/.github/assets/manifest-screenshot.png)

## Table of contents

- [Supported providers](#supported-providers)
- [Manifest vs OpenRouter](#manifest-vs-openrouter)
- [Installation](#installation)
  - [Option 1: Quickstart install script (recommended)](#option-1-quickstart-install-script-recommended)
  - [Option 2: Docker Compose (manual)](#option-2-docker-compose-manual)
  - [Option 3: Docker Run (bring your own PostgreSQL)](#option-3-docker-run-bring-your-own-postgresql)
  - [First request](#first-request)
  - [Verifying the image signature](#verifying-the-image-signature)
  - [Custom port](#custom-port)
  - [Exposing on the LAN](#exposing-on-the-lan)
- [Image tags](#image-tags)
- [Upgrading](#upgrading)
- [Backup & persistence](#backup--persistence)
- [Connecting local LLM servers](#connecting-local-llm-servers)
- [Environment variables](#environment-variables)
- [Links](#links)

## Supported providers

Works with 300+ models across OpenAI, Anthropic, Google Gemini, DeepSeek, xAI, Mistral, Qwen, MiniMax, Kimi, Amazon Nova, Z.ai, OpenRouter, Requesty, Ollama, and any provider with an OpenAI-compatible API. Connect with an API key, or reuse an existing paid subscription (ChatGPT Plus/Pro, Claude Max/Pro, Kimi Coding Plan, GLM Coding Plan, etc.) where supported.

## Manifest vs OpenRouter

|              | Manifest                                          | OpenRouter                                          |
| ------------ | ------------------------------------------------- | --------------------------------------------------- |
| Architecture | Your Manifest instance forwards to your providers | Cloud proxy. All traffic goes through their servers |
| Cost         | Free                                              | 5% fee on every API call                            |
| Source code  | MIT, fully open                                   | Proprietary                                         |
| Data privacy | Self-hosted, no middleman                         | Prompts and responses pass through a third party    |
| Transparency | Open scoring. You see why a model was chosen      | No visibility into routing decisions                |

---

## Installation

Three paths, ordered from fastest to most hands-on. All three end in the same place: a running stack at [http://localhost:2099](http://localhost:2099) where you sign up. The first account you create becomes the admin. No demo credentials are pre-seeded.

> **Heads up on network binding.** The bundled compose file binds port 2099 to `127.0.0.1` only, so the dashboard is reachable on the host machine but not over the LAN. See [Exposing on the LAN](#exposing-on-the-lan) to expose it beyond localhost.

### Option 1: Quickstart install script (recommended)

One command. The installer downloads the compose file, generates the secrets, and brings up the stack. First boot pulls the app image and Postgres, so give it up to a couple of minutes.

```bash
bash <(curl -sSL https://raw.githubusercontent.com/mnfst/manifest/main/docker/install.sh)
```

<details>
<summary><strong>Prefer to review the script before running it?</strong></summary>

Download the script:

```bash
curl -sSLO https://raw.githubusercontent.com/mnfst/manifest/main/docker/install.sh
```

Review it (optional):

```bash
less install.sh
```

Run it:

```bash
bash install.sh
```

</details>

Useful flags: `--dir <path>` to install elsewhere, `--port <n>` to serve on a port other than 2099, `--dry-run` to preview, `--yes` to skip the confirmation prompt.

Re-running the installer against an existing install directory resumes it — the compose file and your generated secrets are left untouched and the stack is brought back up.

### Option 2: Docker Compose (manual)

Same underlying flow as the install script, but you drive it yourself so you can edit the config before booting the stack.

1. Download the compose file and the env template into the same directory:

```bash
curl -O https://raw.githubusercontent.com/mnfst/manifest/main/docker/docker-compose.yml
curl -O https://raw.githubusercontent.com/mnfst/manifest/main/docker/.env.example
cp .env.example .env
```

2. Open `.env` in your editor and set `BETTER_AUTH_SECRET` and
   `MANIFEST_ENCRYPTION_KEY` to two **different** random strings. Generate each with:

```bash
openssl rand -hex 32
```

`MANIFEST_ENCRYPTION_KEY` encrypts the provider API keys, OAuth tokens and
request recordings Manifest stores; the rest of the database is not encrypted
by it. Left unset it falls back to `BETTER_AUTH_SECRET`, which means one leaked
session-signing secret also decrypts every stored credential and recording.
Set it before first boot.
Recordings written under a previous secret are not migrated: after the secret
changes they can no longer be decrypted and the dashboard shows them as
unavailable, while retention removes them on schedule.

(Optional: to use a stronger database password, set BOTH `POSTGRES_PASSWORD` and `DATABASE_URL` in `.env`, they must agree, and any special characters in the password need to be percent-encoded in the URL.)

3. Start the stack:

```bash
docker compose up -d
```

Give it up to a couple of minutes on a cold pull — you can watch startup with `docker compose logs -f manifest`.

4. Open [http://localhost:2099](http://localhost:2099) and sign up. The first account you create becomes the admin.

5. Connect a provider and send your first request — see [First request](#first-request).

To stop:

```bash
docker compose down       # keeps data
docker compose down -v    # deletes everything
```

### Option 3: Docker Run (bring your own PostgreSQL)

If you already have PostgreSQL running, replace `user`, `pass`, and `host` with your actual database credentials, then run this in your terminal:

<details open>
<summary><strong>macOS / Linux (bash, zsh)</strong></summary>

```bash
docker run -d \
  -p 2099:2099 \
  -e DATABASE_URL=postgresql://user:pass@host:5432/manifest \
  -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  -e BETTER_AUTH_URL=http://localhost:2099 \
  manifestdotbuild/manifest
```

</details>

<details>
<summary><strong>Windows (PowerShell)</strong></summary>

```powershell
$secret = -join ((48..57 + 97..122) | Get-Random -Count 64 | ForEach-Object { [char]$_ })

docker run -d `
  -p 2099:2099 `
  -e DATABASE_URL=postgresql://user:pass@host:5432/manifest `
  -e BETTER_AUTH_SECRET=$secret `
  -e BETTER_AUTH_URL=http://localhost:2099 `
  manifestdotbuild/manifest
```

</details>

<details>
<summary><strong>Windows (CMD)</strong></summary>

Generate a 64-character hex secret with any tool you trust, then:

```cmd
docker run -d ^
  -p 2099:2099 ^
  -e DATABASE_URL=postgresql://user:pass@host:5432/manifest ^
  -e BETTER_AUTH_SECRET=<your-64-char-secret> ^
  -e BETTER_AUTH_URL=http://localhost:2099 ^
  manifestdotbuild/manifest
```

</details>

TypeORM migrations run automatically on every boot — fresh installs come up with the schema in place. Then visit [http://localhost:2099](http://localhost:2099) and complete the setup wizard to create your admin account.

### First request

Signing up leaves you with an empty instance. Three steps to a routed request:

1. **Connect a provider.** In the sidebar, **Providers → Usage-based** to paste
   an API key (OpenAI, Anthropic, Gemini, …), **Subscriptions** to reuse a plan
   you already pay for, or **Local** for Ollama / LM Studio / llama.cpp.
   Manifest discovers the available models as soon as the connection is saved.

2. **Copy your agent's key.** Each agent has its own key, shown when you create
   it and under the agent's **Settings**. It starts with `mnfst_`.

3. **Point something at it.** The endpoint is OpenAI-compatible, so any SDK or
   agent that takes a base URL works — use `http://localhost:2099/v1` and the
   `mnfst_` key. To check it end to end:

```bash
curl -X POST http://localhost:2099/v1/chat/completions \
  -H "Authorization: Bearer mnfst_YOUR_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "Hello"}]}'
```

`"model": "auto"` asks Manifest to route. Any other model name is treated as an
explicit choice and falls back to your routing config if it matches nothing.

Errors from Manifest itself carry an `M###` code, a plain-English cause, and a
link to the matching page under
[manifest.build/docs/errors](https://manifest.build/docs/errors) — including
`M100` (no provider connected yet) and `M003`/`M005` (bad or unknown key), the
three you are most likely to hit on a fresh install.

### Verifying the image signature

Published images are signed with cosign keyless signing (Sigstore). Verify before pulling:

```bash
cosign verify manifestdotbuild/manifest:<version> \
  --certificate-identity-regexp="^https://github.com/mnfst/manifest/" \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com"
```

### Custom port

**Compose installs — set `PORT` in `.env`, and nothing else:**

```env
PORT=8080
```

The compose file reads `${PORT:-2099}` for both the published host port and
the backend's internal listener, and `BETTER_AUTH_URL` defaults to
`http://localhost:${PORT:-2099}`, so one line covers all three. No YAML edit.
The install script does this for you with `--port 8080`.

**`docker run` installs** have no `.env`, so pass the mapping and the URL
explicitly. Here the container keeps listening on 2099 and Docker remaps it:

```bash
docker run -d \
  -p 8080:2099 \
  -e BETTER_AUTH_URL=http://localhost:8080 \
  ...
```

`BETTER_AUTH_URL` must match the URL you type in the browser — host and port
both. A mismatch fails the login with "Invalid origin".

### Exposing on the LAN

By default the compose file binds port `2099` to `127.0.0.1` only. The dashboard is reachable from the host but not from other machines on the network. To expose it on the LAN:

1. In `.env`, set `HOST_BIND_ADDRESS=0.0.0.0`. Editing `docker-compose.yml` by hand does not survive an upgrade; `.env` does.
2. In `.env`, set `BETTER_AUTH_URL` to the host you'll reach the dashboard on, e.g. `http://192.168.1.20:2099` or `https://manifest.mydomain.com`. This MUST match the URL in the browser or Better Auth will reject the login with "Invalid origin".
3. `docker compose up -d` to apply.

If you see "Invalid origin" on the login page, `BETTER_AUTH_URL` doesn't match the URL you're accessing the dashboard on. The host matters as much as the port.

If the dashboard loads as a **blank page on a LAN IP on an older image**, pull the latest image (`docker compose pull && docker compose up -d`). Older builds emitted an `upgrade-insecure-requests` CSP directive that made browsers rewrite `/assets/*.js` to HTTPS on private-IP hosts (10.x / 172.16-31.x / 192.168.x), which the server doesn't serve — the JS bundle failed to load and the page never mounted. This directive has been removed.

## Image tags

Every release is published with the following tags:

- `{major}.{minor}.{patch}` - fully pinned (e.g. `6.18.0`)
- `{major}.{minor}` - latest patch within a minor (e.g. `6.18`)
- `{major}` - latest minor+patch within a major (e.g. `6`)
- `latest` - latest stable release
- `sha-<short>` - exact commit for rollback

Images are built for both `linux/amd64` and `linux/arm64`.

## Upgrading

Manifest ships a new image on every release. To upgrade an existing compose install:

```bash
docker compose pull
docker compose up -d
```

Database migrations run automatically on boot, no manual steps. Your data in the `pgdata` volume is preserved across upgrades. Pin to a specific major version (e.g. `manifestdotbuild/manifest:6`) in `docker-compose.yml` if you want control over when major upgrades happen.

The dashboard checks GitHub once a day for the latest release and shows a "new version available" badge linking to the [changelog](https://manifest.build/changelog/). The check only reads the public release list and sends nothing about your install. To turn it off (for example on an air-gapped host), set `MANIFEST_UPDATE_CHECK_DISABLED=1` in `.env`.

## Backup & persistence

PostgreSQL state lives in the `mnfst_pgdata` named volume mounted at `/var/lib/postgresql/data` in the `postgres` service. The Compose install also stores local request recordings in the `mnfst_recordings` volume mounted at `/data/request-recordings`; those recordings are not included in a PostgreSQL dump. For ephemeral hosts or multiple instances, configure durable S3-compatible storage instead.

**Back up** (from the host, with the stack running):

```bash
docker compose exec -T postgres pg_dump -U manifest manifest > manifest-backup-$(date +%F).sql
```

**Restore** into a fresh stack:

```bash
docker compose up -d postgres
cat manifest-backup-2026-04-12.sql | docker compose exec -T postgres psql -U manifest manifest
docker compose up -d
```

To list / remove the volume manually:

```bash
docker volume ls | grep -E 'mnfst_(pgdata|recordings)'
docker compose down -v    # ⚠  destroys all data
```

## Connecting local LLM servers

The self-hosted Manifest container can reach any OpenAI-compatible server running on your host via `host.docker.internal:<port>`. This works on Docker Desktop (macOS/Windows) out of the box, and on Linux with Docker Engine 20.10 or later.

Because the container detects self-hosted mode automatically (via `/.dockerenv`), it lets you add custom providers with `http://` and private/loopback URLs — cloud-metadata endpoints (169.254.169.254, etc.) stay blocked.

### Ollama (built-in tile)

1. Install Ollama from [ollama.com](https://ollama.com) and pull a model:

```bash
ollama pull llama3.1:8b
```

2. In the dashboard, go to Providers → API Keys → click the **Ollama** tile.
3. Manifest reaches Ollama at `http://host.docker.internal:11434` and syncs the available models.

### LM Studio

1. Install LM Studio from https://lmstudio.ai, load at least one chat model, and start the local server. **Bind to `0.0.0.0`** so the Manifest container can reach it:
   - GUI: Developer tab → enable "Serve on Local Network" (LM Studio persists this across restarts).
   - CLI: `lms server start --bind 0.0.0.0 --port 1234 --cors`
2. Providers → API Keys → click the **LM Studio** tile.
3. Manifest probes `http://host.docker.internal:1234/v1`, discovers your loaded models, and connects them in one click.

### llama.cpp

1. Build `llama-server` from the [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) repo (or grab a release binary), then start it with a GGUF model bound to `0.0.0.0` so the Manifest container can reach it:

   ```bash
   ./llama-server -m models/llama-3.1-8b-instruct.Q4_K_M.gguf --host 0.0.0.0 --port 8080
   ```

   `llama-server` only listens on `0.0.0.0` if you pass `--host 0.0.0.0`; the default bind isn't reachable from Docker.

2. Providers → API Keys → click the **llama.cpp** tile.
3. Manifest probes `http://host.docker.internal:8080/v1`, lists the model your server loaded, and connects it in one click. Pre-b3800 builds that don't expose `/v1/models` get a hint to upgrade or fall back to **Add custom provider**.

### Any other OpenAI-compatible server

For vLLM, text-generation-webui, TogetherAI proxies, Azure OpenAI gateways, or anything else that speaks OpenAI's HTTP API:

1. Start your server on the host bound to `0.0.0.0`.
2. Providers → API Keys → **Add custom provider** → type the URL (e.g. `http://host.docker.internal:8000/v1`).
3. Click **Fetch models** to auto-populate the model list from the server's `/v1/models` endpoint.

### Running Ollama on another machine

If Ollama runs on a different host on your LAN, set `OLLAMA_HOST` in `.env` to the full URL (e.g. `http://192.168.1.20:11434`) and restart the stack. Private IPs are allowed in the self-hosted version.

### Podman / rootless containers

Podman doesn't ship `/.dockerenv` or `host.docker.internal`. Manifest still
auto-detects Podman via `/run/.containerenv` and treats the install as
self-hosted, but the canonical hostname for reaching the host from inside
a Podman container is `host.containers.internal` (Podman 4+ exposes this
by default; older versions need `--add-host=host.containers.internal:host-gateway`).
If you run Manifest as one Podman service and your LLM server (llama.cpp,
Ollama, etc.) as another, point Manifest at the service name on the shared
network — e.g. `http://llamacpp:8080/v1` — and **Add custom provider** will
accept it as long as `MANIFEST_MODE=selfhosted` (the bundled compose file
sets this automatically).

## Environment variables

| Variable                           | Required    | Default                                      | Description                                                                                                                                                                                                |
| ---------------------------------- | ----------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                     | Yes         | --                                           | PostgreSQL connection string                                                                                                                                                                               |
| `BETTER_AUTH_SECRET`               | Yes         | --                                           | Session signing secret (min 32 chars)                                                                                                                                                                      |
| `MANIFEST_ENCRYPTION_KEY`          | Recommended | falls back to `BETTER_AUTH_SECRET`           | Separate 32+ char key encrypting stored provider keys and OAuth tokens. The install script generates one; set it before first boot, since introducing it later means re-encrypting what is already stored. |
| `BETTER_AUTH_URL`                  | No          | `http://localhost:${PORT}`                   | Public URL. Must match the URL in the browser                                                                                                                                                              |
| `PORT`                             | No          | `2099`                                       | Dashboard port — sets both the published host port and the internal listener                                                                                                                               |
| `OLLAMA_HOST`                      | No          | `http://host.docker.internal:11434`          | Ollama endpoint for the built-in tile. Override to point at a LAN-hosted Ollama.                                                                                                                           |
| `MANIFEST_MODE`                    | No          | auto (Docker → selfhosted)                   | `selfhosted` or `cloud`. `local` is a legacy alias. Self-hosted mode allows private/http URLs for custom providers.                                                                                        |
| `MANIFEST_DISABLE_HSTS`            | No          | unset                                        | Set `1` to silence the boot warning about serving over plain HTTP on a LAN                                                                                                                                 |
| `THROTTLE_LIMIT` / `THROTTLE_TTL`  | No          | `100` / `60000`                              | Rate limit: requests per window, window in ms                                                                                                                                                              |
| `DB_POOL_MAX` / `AUTH_DB_POOL_MAX` | No          | `10` / `5`                                   | PostgreSQL pool sizes (app pool, Better Auth pool)                                                                                                                                                         |
| `SENTRY_DSN`                       | No          | unset                                        | Opt-in error monitoring. Sentry is not initialised unless set                                                                                                                                              |
| `MANIFEST_TELEMETRY_DISABLED`      | No          | `0`                                          | Set `1` to disable anonymous usage telemetry                                                                                                                                                               |
| `TELEMETRY_ENDPOINT`               | No          | `https://telemetry.manifest.build/v1/report` | Send the usage report to your own collector instead                                                                                                                                                        |
| `AUTOFIX_GLOBAL_ENABLED`           | No          | `true`                                       | Deployment-wide Autofix kill switch. Set `false` to make no calls to the Autofix service at all, boot health check included                                                                                |

`NODE_ENV` and `SEED_DATA` are deliberately fixed by the compose file and are
not knobs here: the image is a production artifact, and the demo-data seeder
refuses to run under `NODE_ENV=production` regardless of `SEED_DATA`. Use the
first-run setup wizard to create your admin account.

Full env var reference:
[manifest.build/docs/reference/environment-variables](https://manifest.build/docs/reference/environment-variables)

## Anonymous usage telemetry

Manifest sends a small anonymous usage report once per 24h so the maintainers
can see how the project is being used. Aggregates only — no prompts, no
message contents, no API keys, nothing that identifies a user. The report is
a random install UUID (generated once, no PII), the Manifest version, and
aggregate counters grouped by provider, routing tier, auth type, agent
platform, OS, and arch.

To disable, set `MANIFEST_TELEMETRY_DISABLED=1` in your `.env` file and
restart the container. The full field list is published at
[manifest.build/docs/self-hosted#telemetry](https://manifest.build/docs/self-hosted#telemetry).

## Autofix privacy and instance identity

Autofix is off by default for every agent in self-hosted Manifest. When you turn
it on for an agent, Autofix calls announce your install's random anonymous ID,
the Manifest version, and the agent platform from a fixed list; custom platform
names are sent as `other`. There is no registration step and no credential: the
ID is announced, not issued, and the healing service records it the first time
it sees it.

**That ID is the same anonymous install UUID the usage report uses.** One
identity per install, so Autofix activity and the aggregate telemetry report can
be linked to the same install by Manifest. Neither carries a user, tenant, or
email. If you want them unlinked, there is no setting for that today — the
identifier is shared by design.

Autofix works by sending a failed request to the healing service so it can
produce a corrected body. The failing request body, provider error, provider,
and API mode are therefore sent after known secrets are scrubbed. Secret
scrubbing does not remove arbitrary personal information from prompts. Successful
traffic is not sent. If `AUTOFIX_REPORT_ALL_4XX=true`, scrubbed bodies for other
request-side 4xx failures are also sent as diagnostic observations (up to
256 KiB), under the same per-agent opt-in.

If no agent has Autofix enabled, no healing call is made and **no ID is ever
created** — it is generated on first use, so an install that never enables
Autofix and never reports telemetry has no identity at all. Only the public,
unauthenticated boot-time health check may contact the service, and it never
creates an identity. Set `AUTOFIX_GLOBAL_ENABLED=false` to disable every Autofix
service call, boot health check included.

The Autofix endpoint itself is not configurable — it is a constant in the image
(`https://autofix.manifest.build`). There is no supported way to point an
install at a different healing service.

`MANIFEST_TELEMETRY_DISABLED=1` stops the aggregate usage report and nothing
else; it does not disable Autofix, and it does not stop Autofix from creating and
announcing the shared ID.

After restoring or cloning a database, you can force a fresh identity:

```sql
DELETE FROM install_metadata;
```

This resets the shared ID, so the next Autofix call and the next usage report
both announce a new one. Your install will look like a new install to both.

## Links

- [GitHub](https://github.com/mnfst/manifest)
- [Website](https://manifest.build)
- [Docs](https://manifest.build/docs)
- [Discord](https://discord.gg/FepAked3W7)

## License

[MIT](https://github.com/mnfst/manifest/blob/main/LICENSE)
