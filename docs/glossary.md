# Analytics glossary and metric definitions

This document is the canonical contract for Manifest analytics terminology and metrics. Schema, API, analytics, and UI code must use these definitions consistently. It defines the concepts and counting rules only; it does not specify page layout or frontend behavior.

## The two worlds

Manifest analytics live in two distinct worlds. Mixing them produces totals that answer different questions.

**The Request world (agent side).** An agent makes one logical Request to Manifest. Manifest may try several providers to serve it, but the agent sees one outcome. Requests belong to agents and to the global Overview. Recovery is a Request-level concept.

**The Attempt world (provider side).** Every provider call is a Provider Attempt. A Request has zero or more Attempts. Attempts belong to providers, Provider Connections, and models. An Attempt may be triggered by fallback or Autofix, but that context does not change its status.

## Glossary

### Manifest Request

One logical request from an agent to Manifest.

- Direction: agent → Manifest
- Database table: `requests`
- Primary key: `requests.id`
- Status: `requests.status`
- A Request ultimately has one caller-visible outcome and may have one or many Provider Attempts.

### Provider Attempt

One route evaluation while serving a Manifest Request. Most Attempts call an AI provider; Manifest-local failures are also retained as failed Attempts so the full routing chain is visible.

- Direction: Manifest → AI provider, or internal when Manifest rejects the route locally
- Database table: `agent_messages` (the physical legacy name is retained for safe rolling deploys)
- Parent Request: `agent_messages.request_id → requests.id`
- Order within the Request: `agent_messages.attempt_number`
- Status: `agent_messages.status`

Every provider call counts as an Attempt, including failed calls, fallback attempts, and Autofix retries. Manifest-local failures such as a route skipped during provider cooldown also count as failed Attempts, but their Manifest error origin keeps them out of provider-reliability metrics.

### Status

Requests and newly written Provider Attempts use the same canonical status values:

| Value       | Meaning                                            | UI label  |
| ----------- | -------------------------------------------------- | --------- |
| `pending`   | The operation has no terminal outcome yet.         | Pending   |
| `cancelled` | The caller disconnected before a provider outcome. | Cancelled |
| `success`   | The operation completed successfully.              | Success   |
| `failed`    | The operation completed without succeeding.        | Failed    |

`cancelled`, `success`, and `failed` are terminal. Outcome metrics use only `success` and `failed`; caller cancellations do not count as provider or Manifest errors. In this document, **completed** means a terminal outcome included in metrics (`success` or `failed`); it is not a separate status value.

Historical `agent_messages` rows may retain the legacy physical values `ok`, `error`, `fallback_error`, or `rate_limited`. Analytics readers normalize `ok` to `success` and the legacy failure values to `failed`. Writers must use the canonical values above.

Manifest creates a Request with `pending` status when it accepts the Request and creates an Attempt with `pending` status when it starts the provider call. Each transitions to one terminal status. If the caller disconnects first, active rows transition to `cancelled` without error fields.

Every newly written `failed` Request and Attempt has a non-empty `error_message`. Machine classification remains in the `error_origin`, `error_class`, and `error_http_status` fields; the message is the human-readable explanation.

A successful Request has `requests.status = 'success'`. A successful newly written Attempt has `agent_messages.status = 'success'`; a historical successful Attempt may retain `ok`. `requests.status` is authoritative for the caller-visible outcome.

When a Request with at least one Attempt succeeds, its Last Attempt must also be successful. A failed Request may have no Attempt at all, and `requests.status` remains authoritative if a Request-level failure happens outside the provider call.

### Last Attempt

The Last Attempt is the final Provider Attempt within a Request: the Attempt with the highest `attempt_number`. For a completed Request, it is also the Attempt that concluded the Request: the successful Attempt when the Request succeeded, otherwise the terminal non-superseded failure. A zero-attempt Request has no Last Attempt.

Attempt numbers are positive, unique within their Request, and increase in the order Manifest evaluates routes. Do not derive Attempt order from timestamps. `agent_messages.timestamp` records the real route-evaluation or provider-call start time, and `agent_messages.duration_ms` records measured elapsed time once the Attempt is terminal. Neither may be fabricated to create an ordering. Superseded Attempts are never the Last Attempt of a completed Request.

Historical Attempts linked during the migration may have a null `attempt_number` when their order could not be reconstructed safely. Readers may use the legacy compatibility ranking (successful outcome, then non-superseded failure, then timestamp and id) to select a representative terminal Attempt, but must not present that inferred position as an Attempt number. All newly recorded Attempts require a positive `attempt_number`.

### Superseded Attempt

A Superseded Attempt is a failed Provider Attempt after which Manifest continued the same Request with another Attempt.

Newly written Superseded Attempts keep `agent_messages.status = 'failed'` and have `agent_messages.superseded = true`; historical rows may retain a legacy failure status such as `fallback_error`. They count in Attempt metrics, but do not determine the Request outcome.

### Recovered Request

A Recovered Request is a successful Request after Manifest continued beyond a failed Attempt by applying Autofix or fallback.

Recovery belongs to Requests only. Providers, Provider Connections, models, and Attempts are never “recovered.” Applying a recovery method is not enough: the Request must ultimately succeed.

Each Request belongs to exactly one outcome category, evaluated in this order:

1. **Pending:** `requests.status = 'pending'`.
2. **Cancelled:** `requests.status = 'cancelled'`.
3. **Failed:** `requests.status = 'failed'`.
4. **Recovered by Autofix:** `requests.status = 'success'` and `requests.autofix_status = 'retry_succeeded'`.
5. **Recovered by fallback:** `requests.status = 'success'`, the Last Attempt has a non-null `agent_messages.fallback_from_model`, and the Request was not recovered by Autofix.
6. **Success:** any other Request with `requests.status = 'success'`.

The ordering makes Autofix the tie-breaker if inconsistent or historical data satisfies both recovery criteria. If an Autofix retry fails and a fallback succeeds, the Request is recovered by fallback because `requests.autofix_status` is not `retry_succeeded`.

### Recovery attempt

A recovery attempt is a recovery method Manifest tried during a Request, whether or not it succeeded. The Requests table lists them in its "Recovery attempts" column and filter. Autofix and fallback fields on Attempts describe what happened in the chain; they do not replace the Request status or recovery category.

### AI Provider and Provider Connection

An **AI Provider** is an upstream platform such as OpenAI or Anthropic. Each Attempt records its Provider in `agent_messages.provider`.

A **Provider Connection** is a tenant's configured connection to one AI Provider. It lives in `tenant_providers`; `tenant_providers.provider` identifies its Provider and `tenant_providers.auth_type` identifies its authentication method. A Provider may have several Connections, while each Connection belongs to one Provider.

An Attempt identifies the Connection it used through `agent_messages.tenant_provider_id → tenant_providers.id`. `agent_messages.auth_type` and `agent_messages.provider_key_label` are historical display snapshots, not Connection identity. Authentication credentials such as API keys or access tokens remain encrypted Connection-level data and must never be copied onto Attempts.

“Connection Attempts” are Provider Attempts filtered by `tenant_provider_id`, not a separate event type or table. The reference may be null for legacy data, local providers, or paths where Manifest could not identify a Connection, so Provider totals may exceed the sum of their Connection totals.

## Request and Attempt data

| Data                            | Canonical source                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| Request identity and scope      | `requests.id`, `requests.tenant_id`, `requests.agent_id`                               |
| Caller-visible status           | `requests.status` and the `requests.error_*` columns                                   |
| End-to-end duration             | `requests.duration_ms`                                                                 |
| Model requested by the agent    | `requests.requested_model`                                                             |
| Autofix outcome                | `requests.autofix_status`                                                              |
| Attempt identity and parent     | `agent_messages.id`, `agent_messages.request_id`                                       |
| Attempt order                   | `agent_messages.attempt_number`                                                        |
| Attempt status                  | `agent_messages.status` and the `agent_messages.error_*` columns                       |
| Provider, model, and Connection | `agent_messages.provider`, `agent_messages.model`, `agent_messages.tenant_provider_id` |
| Attempt usage                   | Token and cost columns on `agent_messages`                                             |
| Routing and recovery context    | `agent_messages.routing_*`, `fallback_*`, `superseded`, and `autofix_*`                |

## Metric definitions and perimeter

Dashboard metrics use completed Requests and Attempts within the selected tenant, agent, and time filters:

- Pending and cancelled Requests and Attempts are excluded from totals and success rates.
- Playground traffic is excluded.
- Completed zero-attempt Requests are included in Request metrics.
- During the historical transition, each unlinked legacy Attempt may be represented as one synthetic Request. It counts once in Request metrics and still counts normally in Attempt metrics.

| Metric               | Definition                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| Total Requests       | Count each completed stored Request once, plus each eligible synthetic Request once during transition. |
| Request success rate | Requests with `status = 'success'` divided by completed Requests. No traffic means no rate, not 100%.  |
| Total Attempts       | Count each completed `agent_messages.id`; do not deduplicate by Request.                               |
| Attempt success rate | Attempts with `status = 'success'` divided by completed Attempts.                                      |

Request-level surfaces count Requests; Provider-, Connection-, and model-level surfaces count Attempts. The two totals answer different questions and are not expected to match.

## Autofix outcomes

`requests.autofix_status` is the single Request-level Autofix verdict. `NULL` means Autofix did not record an outcome.

| Value             | Meaning                                            |
| ----------------- | -------------------------------------------------- |
| `no_patch`        | Phoenix was consulted but returned no known patch. |
| `resolving`       | Phoenix is still investigating; no retry was sent. |
| `retry_succeeded` | Manifest applied a patch and the retry succeeded.  |
| `retry_failed`    | Manifest applied a patch but the retry failed.     |
| `service_error`   | The Phoenix service call failed.                   |

Only `retry_succeeded` means the Request was recovered by Autofix.

## Examples

| Scenario                                       | Counted Requests | Counted Attempts | Request status | Attempt statuses              | Recovery |
| ---------------------------------------------- | ---------------: | ---------------: | -------------- | ----------------------------- | -------- |
| Request or Attempt is still in progress        |                0 |                0 | `pending`      | `pending` where applicable    | Excluded |
| Caller disconnects before an outcome           |                0 |                0 | `cancelled`    | `cancelled` where applicable  | Excluded |
| Primary Provider succeeds                      |                1 |                1 | `success`      | `success`                     | None     |
| Manifest rejects before contacting a Provider  |                1 |                0 | `failed`       | None                          | None     |
| Primary Attempt fails, fallback succeeds       |                1 |                2 | `success`      | `failed`, `success`           | Fallback |
| Primary Attempt fails, Autofix retry succeeds |                1 |                2 | `success`      | `failed`, `success`           | Autofix |
| Autofix retry fails, fallback succeeds        |                1 |                3 | `success`      | `failed`, `failed`, `success` | Fallback |
| Every Provider Attempt fails                   |                1 |                N | `failed`       | `failed` × N                  | None     |

The Counted Requests and Counted Attempts columns show how many rows the completed dashboard metrics count for each scenario; pending rows are excluded.

## Reading rules

1. Grouping is a lens, not a filter. Switching the grouping within one chart never changes its total.
2. A Request counts once in Request-world surfaces; an Attempt counts once in Attempt-world surfaces. The totals are not expected to match.
3. “Recovered” only qualifies Requests. Providers, Connections, models, and Attempts have no recovery metric.
4. Autofix and fallback fields on an Attempt describe its trigger or context, never its result. The Attempt's status records its result.
5. A Request-level Provider lens attributes each Request once to its Last Attempt's Provider. Zero-attempt Requests use the Manifest bucket. It must never count every Attempt as a separate Request.
6. Connection and model surfaces remain Attempt-level because one Request may use several Connections or models.

## Legacy naming and statuses

- `agent_messages` remains the physical table for Provider Attempts. The legacy name is retained so old and new application versions can write safely during rolling deploys.
- `AgentMessage`, `/api/v1/messages`, and frontend `Message*` names are legacy code and API names; they do not define the analytics unit.
- The physical Autofix column remains `agent_messages.autofix_phoenix`; the entity and API expose it as `autofix_decision`.
- Legacy `ok` maps to `success`. Legacy `error`, `rate_limited`, `fallback_error`, and `auto_fixed` map to `failed`; their error, fallback, supersession, and Autofix fields preserve the additional context.
