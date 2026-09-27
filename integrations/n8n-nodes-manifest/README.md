# n8n-nodes-manifest

Use [Manifest](https://manifest.build) from n8n workflows. Manifest routes requests through the right AI model behind one OpenAI-compatible API.

This package ships two nodes:

## Manifest Chat Model (recommended)

A language-model sub-node built on [`@n8n/ai-node-sdk`](https://github.com/n8n-io/n8n/tree/master/packages/%40n8n/ai-node-sdk). Connect it to the **AI Agent** or **Basic LLM Chain** node exactly like the OpenAI Chat Model node — Manifest sits between your agent and the providers and routes each request to the cheapest capable model.

- Model list is loaded from your Manifest instance; the default `auto` lets Manifest route every request.
- Supports streaming, tool calling, and (optionally) the OpenAI Responses API.
- Requires an n8n version that ships `@n8n/ai-node-sdk` (2026 releases).

## Manifest (action node)

A regular node for calling Manifest directly from a workflow, without an AI Agent:

- List models from `GET /v1/models`
- Create chat completions with `POST /v1/chat/completions`
- Create Responses API calls with `POST /v1/responses`

### Response output

The action node handles both response formats returned by Manifest:

- Buffered responses are returned as the API's JSON object.
- Streamed responses are returned as parsed server-sent events after the stream completes:

```json
{
  "responseMode": "stream",
  "events": [
    {
      "event": "message",
      "data": { "choices": [{ "delta": { "content": "Hello" } }] }
    },
    { "event": "message", "data": "[DONE]" }
  ]
}
```

The action node waits for a streamed response to finish before passing its parsed events to the next workflow node. Do not set `stream` in **Additional Body**; the node ignores that field so response behavior remains consistent with the route configured in Manifest.

## Credentials

Create a **Manifest API** credential with:

- **Base URL**: `https://app.manifest.build` for Manifest Cloud, or your self-hosted URL.
- **API Key**: an agent API key from Manifest.

The credential sends requests with:

```text
Authorization: Bearer <your Manifest API key>
User-Agent: n8n-nodes-manifest
X-Title: n8n
HTTP-Referer: https://n8n.io
```

Manifest uses those headers to attribute usage to this node on request details.

## Install

In n8n:

1. Go to **Settings** > **Community Nodes**.
2. Select **Install**.
3. Enter `n8n-nodes-manifest`.
4. Confirm the community-node warning and install.

For local development:

```bash
npm install
npm run dev
```

## Release

This package publishes from GitHub Actions with npm provenance (required for
n8n verified community nodes since May 2026). The committed `package.json`
version is the single source of truth — never publish from a local machine.

1. Bump the version in `package.json` (and `package-lock.json`) and add a `CHANGELOG.md` entry.
2. Merge to `main`.

That's it. The `publish-n8n-node.yml` workflow detects the version change,
skips if that version is already on npm, publishes with provenance, and pushes
the matching `n8n-nodes-manifest-v<version>` tag automatically.

Configure npm Trusted Publishing for the workflow, or set an `NPM_TOKEN`
repository secret.
