# Dashboard Redesign Brief — Manifest Auto-fix Beta

## Context

Manifest is an LLM proxy/gateway. Developers route their AI requests through
Manifest, which handles model routing, fallbacks, and provider key management.

We are launching **Auto-fix** (powered by Phoenix) to ~100 beta users. When a
provider returns a repairable 4xx error, Manifest automatically patches the
request and retries it. The developer gets a successful response without knowing
an error occurred.

The current dashboard is **consumption-oriented** (cost, tokens, messages). We
need to make it **reliability-oriented** (are requests succeeding? what errors
occur? is auto-fix helping?) without losing the consumption data entirely.

---

## The current dashboard architecture

### Global Overview (`/overview`)

**Header area:**

- Page title "Overview" + subtitle
- Filters (top-right): `By provider` / `By harness` toggle + multi-select
  dropdown (pick which providers/harnesses to show) + range selector
  (24h/7d/30d/90d/365d)

**Main chart card (`ProviderChartCard`):**

- 3 tabs across the top: **Cost** / **Messages** / **Token usage**
- Each tab shows a summary stat (total + trend %) as a clickable header
- Below: a **stacked bar chart** (uPlot) where:
  - X-axis = time buckets (hourly for 24h, daily for 7d+)
  - Y-axis = the tab's metric (dollars, count, tokens)
  - Series (colors) = providers or harnesses (depending on the group-by filter)
- Hover tooltip shows breakdown per series (e.g. "OpenAI: 12.4k tokens")
- The multi-select filter controls which series are visible

**Below the chart:**

- 4 stat cards: Subscriptions / Usage-based / Local / Harnesses (counts + lists)
- Provider connections table (provider, type, usage, sparkline, status)
- Model usage table (model, tokens, share %, cost)
- Harness summary table (harness, usage, messages, sparkline)
- Recent messages table (compact, 5 rows)

### Agent Overview (`/harnesses/:agentName/`)

Same structure as Global but scoped to one agent:

- Same chart card with same 3 tabs (Cost/Messages/Tokens)
- Same range selector
- Filters: `By provider` toggle + provider multi-select
- Provider breakdown, cost by model, recent messages, active skills

### Other relevant pages

- **Messages page** (`/messages`): Full message log with expandable rows. Each
  row shows timestamp, status (ok/error/rate_limited/auto_fixed), model,
  provider, cost, tokens, duration. Expandable to show full request/response.
  Already shows auto-fix details (operations applied, Phoenix IDs, sibling link)
  when autofix_applied=true.

- **Agent Routing page** (`/harnesses/:name/routing`): Model assignment, tier
  config, fallback chains. Shows which providers are connected.

- **Agent Settings page** (`/harnesses/:name/settings`): Includes the Auto-fix
  on/off toggle (per-agent).

- **Provider detail pages** (`/providers/connections/:id`): Per-connection usage,
  model breakdown, agent breakdown, recent messages.

---

## The matrix problem

The current chart card works as a **series x metric** matrix:

```
             Cost      Messages    Token usage
By provider   ok          ok          ok
By harness    ok          ok          ok
```

Every combination makes sense: "show me token usage grouped by provider" or "show
me cost grouped by harness" are both valid questions.

The new data we want to show is **request outcomes by HTTP status** (how many
200s, 400s, 429s, 500s, etc.). This is a **different kind of series** (status
codes instead of providers/harnesses) with its **own metric** (request count).

It does NOT fit in the matrix:

```
                Cost      Messages    Token usage    Requests
By provider      ok          ok          ok           ok (?)
By harness       ok          ok          ok           ok (?)
By HTTP status   ABSURD      meh         ABSURD       ok
```

- "Cost by HTTP status" makes no sense — cost is per-model, not per-status.
- "Token usage by HTTP status" is technically possible but not useful.
- "Requests by HTTP status" is the only combination that works.
- "Requests by provider" is a request-level attribution lens: each logical
  request belongs to its terminal provider once. The Messages log exposes the
  underlying Provider Attempts, so fallbacks and Auto-fix make the views differ.

So the new dimension (HTTP status) is not orthogonal to the existing ones. It
creates invalid cells in the matrix.

---

## What data we have (from the database)

The data is split into two grains. One logical request lives in `requests`; each
upstream provider call lives in the physical `agent_messages` table as a
Provider Attempt. Attempt rows must not be used for request totals.

Request outcomes come from:

| Column                       | Notes                                                              |
| ---------------------------- | ------------------------------------------------------------------ |
| `requests.status`            | Canonical caller-visible `pending`, `success`, or `failed` outcome |
| `requests.error_http_status` | HTTP status for failed requests when one exists                    |
| `requests.error_origin`      | Distinguishes provider, transport, and Manifest failures           |
| `requests.autofix_status`    | Request-level Auto-fix outcome                                     |

Provider Attempt details come from:

| Column                          | Example values                                                                  | Notes                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `status`                        | `pending`, `success`, `failed` (plus legacy values during transition)           | Attempt outcome                                                                   |
| `error_http_status`             | `400`, `401`, `404`, `422`, `429`, `500`, `503`                                 | Failed provider response code; successful rows use status rather than storing 200 |
| `error_class`                   | `rate_limit`, `auth`, `invalid_request`, `server_error`, `timeout`, `not_found` | Manifest's error classification                                                   |
| `error_origin`                  | `provider`, `transport`, `config`, `policy`, `internal`, `request`              | Where the error came from                                                         |
| `provider`                      | `openai`, `anthropic`, `gemini`, `custom:uuid`                                  | Which provider                                                                    |
| `model`                         | `gpt-4o`, `claude-sonnet-4-20250514`                                            | Which model                                                                       |
| `agent_name`                    | `demo-agent`                                                                    | Which harness                                                                     |
| `autofix_applied`               | `true`/`false`                                                                  | Was auto-fix triggered?                                                           |
| `autofix_role`                  | `original`/`retry`/null                                                         | If autofix: the failed request or the patched retry                               |
| `autofix_group_id`              | uuid                                                                            | Links the original and retry rows                                                 |
| `autofix_operations`            | jsonb                                                                           | What Phoenix changed (rename_param, etc.)                                         |
| `autofix_decision`              | jsonb `{status, issueId, patchId, healAttemptId, explanation?}`                 | Entity/API name for the physical `autofix_phoenix` column                         |
| `cost`                          | float                                                                           | Dollar cost of the request                                                        |
| `input_tokens`, `output_tokens` | int                                                                             | Token counts                                                                      |
| `timestamp`                     | datetime                                                                        | When it happened                                                                  |

When Auto-fix heals a request, **two Provider Attempts** are written:

1. `status='failed', autofix_role='original', superseded=true`
2. `status='success', autofix_role='retry'`

Both share the same `autofix_group_id`.

The logical `requests` row is successful and records nullable `autofix_status`: `no_patch`,
`resolving`, `retry_succeeded`, `retry_failed`, or `service_error`.

An HTTP-status chart derives successful requests from `requests.status =
'success'` (displayed as 200 by convention). Failed rows use
`error_http_status`, and provider reliability must split by `error_origin` so
Manifest-generated failures are not blamed on an upstream provider.

---

## What reliability data we want to surface

For the ~100 beta users who have Auto-fix access:

1. **Request health at a glance**: are requests succeeding? What share fails?
2. **Error distribution**: what HTTP statuses are coming back? (the Peacock
   screenshot: stacked bars by status code over time)
3. **Auto-fix value**: how many requests did auto-fix save? What's the coverage?
4. **Error patterns**: what kinds of errors (rate limit, bad request, timeout)?
   Which providers are problematic?

For users WITHOUT Auto-fix access: nothing changes. They see the current
dashboard.

---

## Constraints

1. **SolidJS** — the frontend is SolidJS, not React.
2. **uPlot** — the charting library already in use. Stacked bars, timeseries.
3. **No new dependencies** — the design system is CSS custom properties + BEM.
4. **Conditional display** — the autofix sections are visible only for users with
   access. Feature-gated by tenant access (waitlist/granted).
5. **Existing pages already show some data** — the Messages page shows per-request
   status, the Provider pages show per-provider usage. We should avoid
   duplicating what's already accessible elsewhere.
6. **The range selector** (24h/7d/30d/90d/365d) must control any new chart.
7. **Mobile responsive** — must work at 768px and below.

---

## Design system reference

- **Fonts**: Bricolage Grotesque (headings), DM Sans (body)
- **Accent color**: teal (`hsl(178, 75%, 44%)` / `--success`)
- **Card radius**: 14px (`--radius`)
- **Spacing tokens**: 8/16/24/32/48px scale
- **Charts**: uPlot stacked bars, no chart library beyond uPlot
- **Tabs/segments**: rounded pill toggles with active state shadow

---

## The question for the UX agent

Given:

- A dashboard that currently shows Cost/Messages/Tokens grouped by
  provider or harness
- A need to add reliability data (HTTP status distribution, auto-fix coverage,
  error patterns) that doesn't fit the existing matrix
- Existing pages (Messages, Provider detail) that already show some of this data
  at the per-request or per-provider level
- ~100 beta users who need to see the value of Auto-fix
- The constraint that non-beta users must see an unchanged dashboard

**How should the Global Overview and Agent Overview pages be restructured to
integrate reliability data alongside consumption data?**

Specific sub-questions:

1. Should the existing chart card be modified, replaced, split into two cards, or
   left as-is with a new card alongside/below it?
2. What should the filter/grouping UX be if we have two different kinds of
   series (provider/harness vs HTTP status)?
3. What existing sections (stat cards, provider table, model table, harness
   table) can be removed or moved to make room?
4. How should auto-fix-specific data (coverage rate, saves count, error
   patterns) be presented — as chart data, as summary cards, as inline
   indicators, or something else?
5. How do we avoid duplicating information already on the Messages page and
   Provider detail pages?
6. What is the simplest change that delivers the most value for the beta launch?
