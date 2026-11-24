# Manifest DB footprint evaluation (2026-10-09)

The evaluation itself (§1–§3 and §5) changed nothing in production: it used read-only queries, the Railway metrics API and estimates. After it, two operational changes were made on 2026-10-09, both recorded in §1a: the rollup fix (#3061) and the guarded index rebuild (14 of 20 indexes). Every number carries a source tag:

- **[M-prod]** measured read-only on production (`pg_stat_*`, `pg_stats`, `EXPLAIN`, `SELECT`).
- **[M-rw]** measured from the Railway metrics API (hourly samples, 2026-09-09 → 2026-10-09).
- **[E]** estimated (method stated next to it).

**No copy was built.** Railway cannot restore a backup into a separate service on this project. PITR is not enabled (`volumeInstancePitrRestoreEstimate` returns null), and `volumeInstanceBackupRestore` restores into the source volume, which here is production. Bruno chose estimates only (2026-10-09). So nothing in this report was measured on a copy, and every latency effect is an estimate. `scripts/db-footprint-bench.mjs` is ready for a copy-based check of the shortlist; it was smoke-tested on a local seeded database.

Stats windows: `pg_stat_statements` was reset on 2026-09-19 08:57 UTC. The postmaster started 2026-09-21 11:23 UTC. `pg_stat_database.stats_reset` is NULL, so index scan counts are cumulative since at least 2026-09-21 (at least 18 days) and probably longer. Snapshot taken 2026-10-09 08:45 UTC.

## 1. Verdict

The bill is mostly the memory limit, not the data size.

**RAM is about 80% of the cost, and page cache counts toward it.** Usage sits between a floor of about 4 GB and the 8 GB limit, averaging 6.4 GB **[M-rw]**. The floor is shared_buffers plus backends; the rest is page cache.

**What saves money is lowering the memory ceiling: shared_buffers 2 GB and limit 6 GB, then 5 GB.** That is about **$16–22/month** **[E]**. It is safe only after the cheap fixes below have shrunk the hot set:

- Rebuild the bloated indexes (A). This recovers about **14 GB** of the 28.7 GB of indexes **[E, pg_stats bloat model]**.
- Fix the rollup worker's orphan scan. About 30k rows whose harness is gone make the busiest query (#1 by DB time) walk about 530 MB of bloated index on every run **[M-prod]**.

**Skip most of the rest:**

- **B, dropping indexes: skip almost all.** Every candidate is worth cents per month in disk. The two dead ones are blocked by an unfinished backfill transition.
- **C, retention: rejected (2026-10-09).** Bruno's decision: full retention, no historical requests or attempts are ever deleted. The C rows below are kept for reference only. With full retention the data grows about 6 GB/month, so disk cost rises about $0.9/month each month and the working set keeps growing. Re-check the memory settings monthly.
- **max_connections: free to lower.** It saves almost nothing.

**Expected total: about $18–25/month off a ~$78/month run rate.** Most of it comes from D, and A plus the rollup fix make D safe.

## 1a. What was done on 2026-10-09 (measured)

- **Rollup orphan fix** shipped in #3061. After the deploy, the rollup backlog of about 78k requests (about 30k orphans, plus rows that piled up during the reindex) drained in about 25 minutes, and the rollup completes normally again.
- **Reindex** with `scripts/db-reindex-bloated.sh`: **14 of 20 indexes rebuilt, 8.3 → 4.0 GB**. The database went from 49 to 45 GB **[M-prod]**.

  | Index                                    | Before   | After  |
  | ---------------------------------------- | -------- | ------ |
  | `IDX_agent_messages_agent_usage_pending` | 667 MB   | 2 MB   |
  | `IDX_requests_agent_usage_pending`       | 510 MB   | 2 MB   |
  | `IDX_agent_messages_unlinked_fallback`   | 326 MB   | 1 MB   |
  | `IDX_agent_messages_tenant_timestamp`    | 1,344 MB | 719 MB |
  | `IDX_requests_tenant_status_timestamp`   | 1,077 MB | 607 MB |

  The full list is in the runbook log.

- **Prod is disk-I/O bound.** Any full-table read pushes the proxy's awaited `requests` INSERT from 1–5 ms to 150–400 ms **[M-prod, pg_stat_statements deltas]**:
  - The index builds, with 3 parallel workers and **also with 0**: the latency guard tripped 30 s into a single-worker build at a 336 ms mean, and the next minute without a build measured 1 ms.
  - The same applies to Peacock's cross-tenant scans.

  The remaining 6 large indexes (about 9.8 GB of bloat: `provider_usage`, `b920…`, `request_id`, `tenant_provider`, `requests_tenant_timestamp`, `requests_tenant_agent_timestamp`) were therefore **not** rebuilt. Rebuilding them costs about 8 minutes of slow proxy requests each.

- **Consequence for D:** less cache means more disk reads on the request path. Do D in two guarded steps: first the memory limit only, then shared_buffers.
- **Retention (C) is rejected:** full retention is a hard constraint.

## 2. Baseline

Cost (prices: RAM $10/GB-month, volume and backups $0.15/GB-month):

| Item                          | Value                                                        | $/month       | Source             |
| ----------------------------- | ------------------------------------------------------------ | ------------- | ------------------ |
| RAM, average since 2026-09-26 | 6.38 GB (p5 4.09, p95 7.99, max 8.00), limit 8 GB            | 63.8          | [M-rw]             |
| RAM before 2026-09-21         | 20–27 GB/day, limit 32 GB                                    | (~$230)       | [M-rw]             |
| Volume                        | 61.1 GB, growing about 0.2 GB/day                            | 9.2           | [M-rw]             |
| Backups                       | 6 daily snapshots, sum of `usedMB` 27.6 GB (3.4–7.2 GB each) | 4.1           | [M-rw backup list] |
| CPU                           | 0.03–0.04 vCPU on average                                    | about 0.8     | [M-rw]             |
| **Run rate**                  |                                                              | **about $78** |                    |

**Memory composition [M-rw + M-prod]:**

- shared_buffers is 3 GB. There are 31 backends (25 idle app connections through PgBouncer, plus Peacock and background processes).
- Usage pins at exactly 8.00 GB, then falls to about 3.9–4.5 GB without a restart (postmaster up since 2026-09-21).
- Before the limit was cut it sat at 20–31 GB with the same connection count.
- **Conclusion: Railway's metric includes reclaimable page cache.** Shrinking data does not lower the bill by itself, because the cache refills to whatever the limit allows. The ceiling (the limit) and the floor (shared_buffers plus backends) are what set the bill.

**Disk [M-prod]:**

- Database 49 GB, of which agent_messages is 33.4 GB (13 GB heap, 21 GB indexes) and requests is 15.5 GB (7.6 GB heap, 8.2 GB indexes).
- WAL 0.96 GB. No replication slots, no orphaned relation files, no temp files.
- **About 11 GB of the 61 GB volume is outside the database files** and cannot be explained from SQL: `lost+found` is unreadable.
- Heap bloat is negligible, about 2.5% on both tables. All the bloat is in indexes.

**Backups [M-rw]:** snapshots are incremental, so cost tracks **daily changed blocks (3.4–7.2 GB/day)**, not database size. The churn comes from updates:

- agent_messages had 13.1M updates against 0.95M inserts in the stats window, and only 0.5% were HOT.
- Every attempt row is rewritten non-HOT at least twice: pending → terminal, then `agent_usage_rolled_up_at`, and for recorded rows `recording_key` as well. Each rewrite touches all 25 indexes.

**Where database time goes (`pg_stat_statements`, 20 days, about 583k s) [M-prod].** The call-site map is in the appendix.

| Tag           | Total time | Notes                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DASH          | 150k s     | About 70k s of it is the public-stats endpoints removed in #2982 (2026-09-23). Live dashboard work is about 80k s.                                                                                                                                                                                                                                                                        |
| EXT (Peacock) | 101k s     | Cross-tenant scans. Statements that match Peacock's SQL show up under `peacock_reader` **and under `postgres`**. Peacock's production config now connects as `peacock_reader` (10-minute `statement_timeout` on the role), so the `postgres` copies come from an older config or an ad-hoc session. One query, the Requests feed in `requests-sql.ts:195`, ran 3 times at about 3 h each. |
| BG            | 91k s      | Rollup worker: 71k s, 90k calls, mean 789 ms.                                                                                                                                                                                                                                                                                                                                             |
| HOT           | 91k s      | Pending inserts. The `requests` INSERT is awaited before routing: mean 38 ms, stddev 196 ms, max 12 s.                                                                                                                                                                                                                                                                                    |

**Cache [M-prod, cumulative]:**

- Hit rate in shared_buffers is 91.7% for heap and 95.3% for indexes.
- `IDX_agent_messages_provider_usage` hits only **50.4%**, with 176M block reads (about 1.3 TB).
- The cause is Peacock-style cross-tenant time-range queries. They can only use the tenant-leading indexes by scanning them whole. `EXPLAIN` shows `COUNT(*) … WHERE timestamp >= …` doing a full index-only scan of `IDX_requests_tenant_status_timestamp` or of `provider_usage`.

**HOT path I/O:**

- The `requests` and `agent_messages` inserts read about 2 blocks per insert from outside shared_buffers: 1.43M reads over 738k calls, and 2.35M over 625k **[M-prod]**.
- The I/O delta snapshot (§2a) shows how much of that is still happening now.

**App latency:**

- Railway HTTP logs only reach back to the current deployment (2026-10-09 08:20, about 15 minutes of traffic), so there is no usable p50/p95 history.
- Proxy latency is dominated by upstream LLM time (chat completions p50 8.2 s).
- This report therefore relies on query-level numbers.
- Sampled dashboard p50: `/api/v1/overview` 1.6 s, `/api/v1/messages` 2.6 s, `/api/v1/agents` 0.8 s.

### 2a. Current I/O (snapshot delta)

Window: 2026-10-09 09:37 → 09:59 UTC, 22 min **[M-prod]**.

My own evaluation queries caused most of the block reads in this window: the per-tenant monthly counts did about 235k reads (≈1.8 GB). That is also what `IDX_requests_tenant_status_timestamp` at 29% hit reflects. Peacock-style cross-tenant scans do the same thing to prod. Once these are excluded:

| Statement                                | Calls | Mean   | Reads/call (outside shared_buffers) |
| ---------------------------------------- | ----- | ------ | ----------------------------------- |
| Pending `agent_messages` INSERT (HOT)    | 1,086 | 8.0 ms | 3.7                                 |
| Pending `requests` INSERT (HOT, awaited) | 1,115 | 4.7 ms | 1.9                                 |
| Rollup batch (BG)                        | 22    | 226 ms | 56                                  |
| `recording_key` UPDATE (HOT-tail)        | 909   | 2.1 ms | 0.65                                |

- **HOT inserts still miss shared_buffers on every call**: each touches about 2–4 index leaves that aren't cached. Shrinking indexes (A) helps them; a smaller cache (D) hurts them.
- **This is why D2/D3 must follow A, and must be checked against the insert means above.**
- Heap reads were negligible: 99.8–100% hit.

## 3. Per-change results

Columns: **$ saved** is low / expected / high per month, **[E]** unless marked.

| #    | Change                                                                                                                                      | $ saved                                     | Disk freed                                                   | RAM                                                                               | HOT p95                 | DASH p95                                                                         | Insert cost                              | UX impact                                                                                    | Risk                                                           | Reversible     | Effort                             | Recommendation                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------- | ---------------------------------- | ------------------------------------------------------------------------- |
| A1   | Reindex the 6 near-empty partial indexes (`*_agent_usage_pending` ×2, `recording`, `requests_pending`, `unlinked_fallback`, `direct_usage`) | 0.25 / 0.3 / 0.3                            | 1.99 → 0.08 GB **[E]**                                       | Takes about 1.1 GB of bloat out of shared_buffers (the rollup reads it every run) | none                    | none                                                                             | slightly better                          | none                                                                                         | low                                                            | n/a            | 0.5 h                              | **Do now**                                                                |
| A2   | Reindex the 14 large btrees (extra space 20–64%)                                                                                            | 1.6 / 1.8 / 2.1                             | 25.0 → 12.9 GB fresh; about 11–12 GB stays recovered **[E]** | Indirect: index working set about halves; `provider_usage` 7.3 → 2.6 GB           | equal or better **[E]** | better for range queries **[E]**                                                 | slightly better (fewer leaf misses)      | none                                                                                         | medium (INVALID leftovers, waits on long Peacock transactions) | yes            | 2 h hands-on, about 3 h rebuilding | **Do now** (off-peak)                                                     |
| A3   | Rollup orphan fix (code plus a one-off UPDATE)                                                                                              | ≈0 direct                                   | none                                                         | Removes about 68k buffer touches per run                                          | none                    | none                                                                             | none                                     | none                                                                                         | low                                                            | yes            | 2–3 h                              | **Do now**                                                                |
| B1   | Drop `IDX_agent_messages_unlinked_fallback` (0 scans)                                                                                       | 0.05                                        | 0.32 GB (≈0 after A1)                                        | none                                                                              | none                    | none                                                                             | none                                     | none                                                                                         | low once the backfill transition is final                      | yes (recreate) | 0.5 h                              | **Do later**: v2 transition not finalized (§5)                            |
| B2   | Drop `IDX_requests_pending` (1 scan)                                                                                                        | 0.01                                        | 0.09 GB                                                      | none                                                                              | none                    | none                                                                             | none                                     | none                                                                                         | same as B1                                                     | yes            | 0.5 h                              | **Do later**: same gate                                                   |
| B3   | Drop `IDX_agent_messages_errors_timestamp` (0 scans)                                                                                        | 0.02                                        | 0.13 GB                                                      | none                                                                              | none                    | none                                                                             | tiny                                     | error-trend crons would fall back to scans                                                   | low                                                            | yes            | 0.5 h                              | **Don't**: worth cents, and it is the only timestamp-leading error index  |
| B4   | Drop `IDX_agent_messages_error_origin` (2 scans)                                                                                            | 0.05–0.09                                   | 0.57 GB (0.30 after A)                                       | none                                                                              | none                    | `/errors/breakdown` for big tenants: unmeasured                                  | tiny                                     | none                                                                                         | low–medium                                                     | yes            | 0.5 h plus a copy test             | **Do later**, only after a copy benchmark                                 |
| B5   | Drop `IDX_requests_tenant_status_timestamp`                                                                                                 | 0.09–0.16                                   | 1.05 GB (0.59 after A)                                       | none                                                                              | none                    | exact-status log filter becomes an index-only scan on the covering index **[E]** | about 1/9 fewer index writes per request | Peacock `COUNT` scans read 2.6× more                                                         | medium                                                         | yes            | 0.5 h                              | **Do later**, together with the Peacock fix                               |
| B6   | Drop `IDX_agent_messages_tenant_timestamp` (237M scans)                                                                                     | 0.1–0.2                                     | 1.31 GB                                                      | scans move to the 3.7× wider `provider_usage`                                     | risk +                  | risk +                                                                           | 1/25 fewer index writes                  | none                                                                                         | high                                                           | yes            | —                                  | **Don't**                                                                 |
| C30  | Delete free-plan rows older than 30 days                                                                                                    | 3.8 / 5.6 / 5.6 (disk only after a rebuild) | 37 GB now, about 25 GB after A **[E]**                       | Peacock scans about 4× smaller; hot set unchanged                                 | none                    | log first page unchanged                                                         | none                                     | Free users lose history past 30 days in the Requests log, CLI and MCP; old request links 404 | medium                                                         | **no**         | 3–5 days                           | **Rejected: full retention**                                              |
| C60  | Same, older than 60 days                                                                                                                    | 3.2 / 4.8 / 4.8                             | 31.7 GB                                                      | ≈3× smaller scans                                                                 | none                    | none                                                                             | none                                     | same, 60 days                                                                                | medium                                                         | **no**         | same                               | **Rejected: full retention**                                              |
| C90  | Same, older than 90 days                                                                                                                    | 2.4 / 3.6 / 3.6                             | 24.2 GB                                                      | ≈2× smaller scans                                                                 | none                    | none                                                                             | none                                     | same, 90 days                                                                                | medium                                                         | **no**         | same                               | **Rejected: full retention**                                              |
| C180 | Same, older than 180 days                                                                                                                   | 0.2 / 0.3 / 0.3                             | 1.9 GB                                                       | none                                                                              | none                    | none                                                                             | none                                     | almost none                                                                                  | low                                                            | no             | same                               | **Rejected: full retention**                                              |
| D1   | Memory limit 8 → 6 GB, shared_buffers stays 3 GB                                                                                            | 6 / 12 / 18                                 | —                                                            | average about 5.2 GB **[E]**                                                      | +0–10% **[E]**          | +5–25% **[E]**                                                                   | none                                     | none                                                                                         | medium (OOM if anonymous memory spikes)                        | yes            | 0.5 h                              | Superseded by D2                                                          |
| D2   | shared_buffers 3 → 2 GB **and** limit 6 GB (+ max_connections 100)                                                                          | 10 / 16 / 20                                | —                                                            | average about 4.8 GB **[E]**                                                      | +0–10% **[E]**          | +5–25% **[E]**                                                                   | none                                     | about 1 min restart                                                                          | medium                                                         | yes            | 1 h plus restart                   | **Do after A**                                                            |
| D3   | shared_buffers 2 GB, limit 5 GB                                                                                                             | 15 / 22 / 28                                | —                                                            | average about 4.2 GB **[E]**                                                      | +5–15% **[E]**          | +10–40% **[E]**                                                                  | none                                     | none                                                                                         | medium–high                                                    | yes            | 0.5 h                              | **Do later**: only if the D2 checkpoint holds and Peacock scans are fixed |
| D4   | max_connections 500 → 100                                                                                                                   | 0.3                                         | —                                                            | about 40 MB of shared memory                                                      | none                    | none                                                                             | none                                     | none                                                                                         | low (31 connections in use; PgBouncer pools)                   | yes            | in the D2 restart                  | **Do** (with D2)                                                          |

How the D figures were estimated:

- Since 2026-09-26, usage spends on average 60% of the gap between its floor F and the limit L **[M-rw]**: (6.38 − 4) / (8 − 4).
- The model assumes that fraction holds: average = F + 0.6 × (L − F).
- F is about 4 GB with 3 GB shared_buffers and about 3 GB with 2 GB.
- Latency ranges are judgement, not measurement. Run `scripts/db-footprint-bench.mjs` on a copy before D3.

How the A figures were estimated:

- Bloat comes from the ioguix btree estimate over `pg_stats` with the default fillfactor of 90.
- Rows with a negative estimated bloat are deduplicated low-cardinality indexes. They are already compact and are excluded.
- Regrowth: the indexes lead with `tenant_id`, so new rows split pages mid-tree, and each row is rewritten non-HOT 2–3 times shortly after insert. Recent pages will bloat again at today's rate (about 50–65%).
- Old rows are never updated again, so their recovered space stays recovered. Persistent gain is about 11–12 GB of the 14 GB.

How the C figures were estimated:

- Row counts by plan come from **[M-prod]**: 6 Pro tenants and 3,174 free tenants.
- GB = rows × current bytes per row (heap plus indexes: 2.97 KB per attempt, 1.89 KB per request).

| Cutoff (free plan only) | agent_messages deleted | requests deleted |
| ----------------------- | ---------------------- | ---------------- |
| 30 days                 | 8.51M (76%)            | 6.27M (76%)      |
| 60 days                 | 7.23M (64%)            | 5.39M (66%)      |
| 90 days                 | 5.50M (49%)            | 4.17M (51%)      |
| 180 days                | 0.42M (4%)             | 0.36M (4%)       |

- Pro is excluded: the plan promises 365 days, and the oldest data is from 2026-02-19.
- **Disk only comes back after a rebuild.** Plain `VACUUM` makes the space reusable instead. Deleting 76% of the heap absorbs about 6 months of inserts at 1.4M attempts/month, so the volume stops growing rather than shrinking. Indexes can be compacted without locks using `REINDEX CONCURRENTLY`.
- `VACUUM FULL` takes ACCESS EXCLUSIVE. That blocks the awaited `requests` INSERT on the proxy path for the whole rewrite, about 10–30 min for agent_messages **[E]**, so it would need a maintenance window. Monthly partitioning (§4) is the clean long-term path.

**Product check for C** (from the code map):

| Area                                                  | What it reads today                                                                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Overview, analytics, `/agent/usage`                   | Up to 365 days, plus 730 days for the trend comparison. The free plan is clamped to 7 days **in the frontend only**. |
| Requests log, CLI `mnfst requests`, MCP requests tool | All time by default, **including free users**.                                                                       |
| Message details                                       | Any row by id.                                                                                                       |
| Notifications                                         | Current month.                                                                                                       |
| Plan quota                                            | A counter table. Raw rows are read only for the current-month baseline.                                              |
| Specificity penalty                                   | All-time miscategorized flags (15 rows). Exclude them from deletion.                                                 |
| CRM healed cohort                                     | All-time `autofix_status='retry_succeeded'` requests. Exclude those rows, or accept the change.                      |
| Peacock error discovery                               | All-time volumes.                                                                                                    |

- There is no billing, invoicing or audit need for raw rows; Stripe plans are flat.
- `agent_usage_daily` already keeps per-harness daily totals. Deleted rows must already be rolled up (`agent_usage_rolled_up_at IS NOT NULL`).

## 4. Rollout order

Each step ends with a checkpoint: 3 days of Railway metrics (memory average/p95, disk, backup `usedMB`) compared with §2, plus a `pg_stat_statements` delta for the HOT inserts, the rollup and the dashboard queries.

1. **A3 rollup orphan fix**: code deploy plus a one-off UPDATE. Checkpoint: rollup mean drops from 789 ms to under 50 ms.
2. **A1 + A2 reindex** with `scripts/db-reindex-bloated.sh` (runbook below), one index at a time, smallest first. Done 2026-10-09 for 14 of 20 (§1a).
3. **D1, memory limit only** (8 → 6 GB, shared_buffers stays 3 GB). Checkpoint after 3 days: memory average, no OOM, request INSERT mean at or under about 10 ms in 1-minute windows, dashboard query means within +25%.
4. **D2 + D4, only if step 3 holds**: shared_buffers 2 GB and max_connections 100, in one restart. Same checkpoint.
5. **Peacock fix**: move its cross-tenant analytics to rollups or a read replica. Its production connection already uses `peacock_reader` with a 10-minute timeout; find out who runs the same SQL as `postgres` (start by having Manifest set `application_name`). This is not a DB-footprint change but it is the precondition for step 6.
6. **D3** (limit 5 GB), only if the step-4 checkpoint holds. **B1/B2** once the backfill transition is finalized. **B5** after step 5.
7. ~~C~~: rejected. Full retention is a hard constraint.

## 5. Open questions for Bruno

1. ~~Retention (C)~~: decided 2026-10-09, full retention. Original question: should free-plan raw rows expire, and after how long (30, 60 or 90 days)? Today a free user sees the full Requests log history even though the plan says "7-day dashboard". Any cutoff turns that into "N days", and old request links and CLI/MCP lookups would return nothing. Also: should Peacock's all-time and CRM all-time metrics move to rollups first?
2. **Peacock load.** Its cross-tenant scans (and the 3-hour Requests feed) are the main source of cache churn and long transactions. Long transactions block vacuum and make `REINDEX CONCURRENTLY` wait. Should they get a read replica, rollups, or hard timeouts?
3. **Backfill transition `requests_agent_messages_v2` was never recorded** in `backfill_state` (v1 finished 2026-07-21). The 60 s tail sweep is therefore still running on every replica, and 22k attempts still have `request_id IS NULL`. Should we finalize it? That unblocks B1/B2.
4. **About 11 GB of the volume is outside the database files.** Should we ask Railway, or check from a shell on the service?
5. **Not in scope, worth a ticket:**
   - `request_headers` plus `caller_attribution` (about 575 B per row) are stored on both `requests` and `agent_messages`, about **6 GB of duplicated attempt heap** **[E]**. Message details already prefers the request's copy; only `seen-headers.service.ts` reads the attempt copy.
   - Replacing the per-row `agent_usage_rolled_up_at` flag with a watermark would remove one non-HOT rewrite per row across 25 indexes. That rewrite is the main driver of index bloat and backup churn.
6. **`agent_messages.agent_id` has no foreign key**, so deleting a harness leaves orphans. That is the cause of the rollup scan in A3. Should this be fixed at the source?

## 6. SQL and migrations for the recommended items

### A3: rollup orphan fix

One-off, production, off-peak. These are writes, so they are **not** run as part of this evaluation.

```sql
-- requests: 29,870 rows; agent_messages: 31,707 rows [M-prod]
UPDATE requests r SET agent_usage_rolled_up_at = now()
 WHERE r.agent_usage_rolled_up_at IS NULL AND r.agent_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = r.agent_id);
UPDATE agent_messages m SET agent_usage_rolled_up_at = now()
 WHERE m.agent_usage_rolled_up_at IS NULL AND m.agent_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = m.agent_id);
```

Code change in `analytics/services/agent-usage-daily.service.ts` `processBatch`: stamp selected-but-orphaned rows as rolled up instead of skipping them forever. One way is to move the `EXISTS (agents)` test out of the selection CTE and stamp the non-matching rows. Then the next index walk is a few pages, not about 68k buffers.

### A1/A2: reindex runbook

This is an ops step, not a migration. Self-hosted installs don't need it.

**Always use `scripts/db-reindex-bloated.sh`; never run the `REINDEX` statements by hand.** On prod every build, even with no parallel workers, slowed the proxy's request INSERT from about 1 ms to 150–400 ms (§1a). The script handles that:

- builds one index at a time, with no parallel workers;
- refuses to start while a transaction older than 5 minutes is open;
- runs a guard next to each build that cancels only that build when the request INSERT mean goes above 40 ms, when the build runs past 30 minutes, or when it cannot read `pg_stat_statements` (it fails closed);
- drops the `_ccnew` leftover after any failure.

```bash
DATABASE_URL='postgresql://…direct, not PgBouncer…' scripts/db-reindex-bloated.sh            # default list
DATABASE_URL='…' scripts/db-reindex-bloated.sh IDX_agent_messages_provider_usage            # one index
```

Status after 2026-10-09:

| Group | Indexes                                                                                                                                                                                                                                                                                    | Status                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| A1    | `IDX_requests_pending`, `IDX_agent_messages_direct_usage`, `IDX_agent_messages_recording`, `IDX_agent_messages_unlinked_fallback`, `IDX_requests_agent_usage_pending`, `IDX_agent_messages_agent_usage_pending`                                                                            | Done                                                                                                      |
| A2    | `IDX_agent_messages_errors_timestamp`, `IDX_agent_messages_error_origin`, `PK_requests`, `IDX_agent_messages_fallback_window`, `PK_8c7cdeda30e81dba421925df4fe`, `UQ_agent_messages_request_attempt_number`, `IDX_requests_tenant_status_timestamp`, `IDX_agent_messages_tenant_timestamp` | Done                                                                                                      |
| A2    | `IDX_agent_messages_request_id`, `IDX_agent_messages_tenant_provider`, `IDX_b920481d4d296ccce0647d6a8a`, `IDX_requests_tenant_timestamp`, `IDX_requests_tenant_agent_timestamp`, `IDX_agent_messages_provider_usage`                                                                       | **Excluded on purpose.** Each costs about 8 min of slow proxy requests; rebuild only if that is accepted. |

### D1, then D2 + D4: memory settings

**D1** is the Railway memory limit only (8 → 6 GB), with no SQL. Hold it for 3 days and check it (rollout step 3).

**D2 + D4** come only after D1 holds, and they need a restart:

```sql
ALTER SYSTEM SET shared_buffers = '2GB';
ALTER SYSTEM SET effective_cache_size = '4GB';
ALTER SYSTEM SET max_connections = 100;
-- restart the "Manifest DB (Production)" service (its memory limit is already 6 GB from D1)
```

Before step 4, check that PgBouncer-M21O's `default_pool_size` × the number of databases stays under 100, with a few connections left for `peacock_reader` and admin sessions.

### B1/B2 (later, gated): TypeORM migration

These ship to self-hosters, who do not need the gate's cloud data, so the migration checks `backfill_state` itself.

```ts
export class DropFinishedBackfillIndexes1803200000000 implements MigrationInterface {
  name = 'DropFinishedBackfillIndexes1803200000000';
  transaction = false;
  public async up(q: QueryRunner): Promise<void> {
    const [done] = await q.query(
      `SELECT 1 FROM backfill_state WHERE name = 'requests_agent_messages_v2'`,
    );
    if (!done) return; // tail sweep still needs them
    await q.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_unlinked_fallback"`);
    await q.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_requests_pending"`);
  }
  public async down(q: QueryRunner): Promise<void> {
    // Definitions as they exist on prod (pg_get_indexdef, 2026-10-09).
    await q.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_agent_messages_unlinked_fallback"
      ON "agent_messages" ("fallback_from_model", "timestamp", "tenant_id", "agent_id")
      INCLUDE ("fallback_index", "status", "superseded")
      WHERE "request_id" IS NULL AND "fallback_from_model" IS NOT NULL`);
    await q.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_requests_pending"
      ON "requests" ("id") WHERE "status" = 'pending'`);
  }
}
```

### C: retention (only if approved)

- **Design:** a cloud-only module, registered like `crm-metrics` (`app.module.ts:77`), with an advisory-locked nightly cron (pattern: `request-recording-retention.service.ts`).
- **Config:** `RAW_ROW_RETENTION_FREE_DAYS`, default unset, which means off. Never registered when `isSelfHosted()`.
- **Each batch** deletes 10k `requests` rows of free tenants with `timestamp < now() - N days AND agent_usage_rolled_up_at IS NOT NULL AND autofix_status IS DISTINCT FROM 'retry_succeeded'`. The FK `ON DELETE CASCADE` removes their attempts. A second pass deletes unlinked attempts (`request_id IS NULL`) by the same rule. Add `SET LOCAL statement_timeout`.
- **Volume:** about 6.3M requests the first time **[E]**, or about 630 batches. At an assumed 1–3 s per batch (cascade through `IDX_agent_messages_request_id`), that is 10–30 min of deletes. After that, autovacuum, then the reindex runbook.
- **Long term:** monthly range partitioning of `agent_messages` and `requests` by `timestamp` would make retention a `DETACH`/`DROP PARTITION` with no bloat and no VACUUM FULL.
  - The cost: the PKs become `(id, timestamp)`; the `request_id` FK and `UQ_agent_messages_request_attempt_number` must include `timestamp` or be dropped; every migration-defined index is recreated per partition; and the data moves once (about 49 GB) behind a dual-write or copy-swap.
  - Estimate **[E]**: 1–2 engineer-weeks plus a staged cutover. Worth it only if C is adopted _and_ volume grows again.

## 7. Copy status

**No temporary database copy was created**, so there is nothing to delete. No Railway service, project or volume was created, and no backup was restored.

The only local artifact was a scratch Docker database (`manifest_bench_*` on `postgres_db`), used to smoke-test the benchmark harness. It has been dropped.

## Appendix: call-site map for the heaviest statements

| Query                                                                            | Tag                                    | Call site                                                                              | Total time, mean        |
| -------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------- |
| Rollup batch `WITH selected AS MATERIALIZED …`                                   | BG                                     | `analytics/services/agent-usage-daily.service.ts:353`                                  | 71.3k s, 789 ms         |
| Pending `agent_messages` INSERT                                                  | HOT (runs alongside the provider call) | `routing/proxy/proxy-message-recorder.ts:698`                                          | 34.5k s, 55 ms          |
| Peacock Requests feed (3 calls)                                                  | EXT                                    | peacock `requests-sql.ts:195`, runs as `postgres`                                      | 31.6k s, about 3 h each |
| Pending `requests` INSERT (awaited)                                              | HOT                                    | `proxy-message-recorder.ts:623`, awaited at `proxy.controller.ts:268`                  | 28.1k s, 38 ms          |
| Public-stats aggregates (5 statements)                                           | DASH (removed in #2982)                | `public-stats.service.ts` at `7226cec8b^`                                              | about 58k s             |
| Peacock GMV, active-users, channel-mix, aggregation                              | EXT                                    | peacock `gmv.service.ts`, `recap.service.ts`, etc.                                     | about 60k s             |
| Block-rule `SUM(cost_usd)`                                                       | HOT                                    | `notifications/services/notification-rules.service.ts:112` via `proxy.service.ts:1431` | 9.4k s, 38 ms           |
| Harness grid with sparklines                                                     | DASH                                   | `analytics/services/timeseries-queries.service.ts:371`                                 | 9.1k s, 1.8 s           |
| `custom_providers` full reload                                                   | DASH/BG                                | `model-prices/model-pricing-cache.service.ts:424`                                      | 8.0k s, 10 s            |
| `recording_key` UPDATE (awaited after the response, before the slot is released) | HOT-tail                               | `routing/proxy/attempt-recording.service.ts:33`                                        | 7.6k s, 11 ms           |

The full 103-row map was exported from production to a local file (`query_map.csv`). It is not in the repo.
