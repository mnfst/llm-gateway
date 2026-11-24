# Manifest Agent Guidelines

## Domain Terminology

Manifest terminology is directional:

- A **Manifest Request** is one logical request from an agent to Manifest and lives in `requests`.
- A **Provider Attempt** is one request from Manifest to an AI provider and lives in `agent_messages`.
- A **Tenant** is a user's data boundary. It is created from `user.id` on first agent creation.
- An **Agent** is an AI agent owned by a tenant. The dashboard labels agents **Harnesses** (nav under `/harnesses`; legacy `/agents/*` URLs redirect) — this is UI copy only; backend code, database tables, and API routes still say *agent*.

[`docs/glossary.md`](docs/glossary.md) is the canonical contract for statuses, ordering, recovery, database mapping, and counting rules. Do not duplicate those definitions in agent guides.
