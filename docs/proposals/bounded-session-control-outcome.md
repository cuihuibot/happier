# Bounded session control: outcome and acceptance proposal

**Initiative:** HAP-STALL-20261007

**Record:** HAP-STALL-OUTCOME-01

**State:** proposal for review; implementation and operational approval pending

**Source evidence baseline:** `2e8026935c7ed412a5c43b9bdf1a4c8477d9fc02`

**Design:** [Generation-fenced session control](bounded-session-control-design.md)

This is a documentation-only proposal. It does not implement a fix, approve
timing defaults, assign employees, authorize experiments, or permit deployment
or recovery operations. The project owner must confirm an accountable outcome
owner and the technical/operational review route.

## Problem and intended outcome

An investigation reproduced waits before provider dispatch and Stop paths that
wait for bookkeeping before physical termination. During separately authorized
target-only recovery, the old runner exited but Resume timed out without a
replacement. Source inspection found that existing-session Resume joins the
previous in-flight Stop promise.

These observations establish plausible blocking mechanisms, not the exact
awaited operation in the original live incident.

| Measure | Observed mechanism | Proposed outcome |
| --- | --- | --- |
| Prompt preparation | Snapshot or override waits can remain pending | Shared preparation deadline; explicit rejection and no dispatch after cancellation/timeout |
| Stop latency | Recovery, outbox or metadata work precedes physical termination | Bounded proof of lifecycle authority and owned-process absence, independent of cleanup |
| Resume availability | Resume joins unfinished Stop | Bounded admission based on authority and absence proof, not cleanup settlement |
| Respawn safety | In-memory stop checks can be invalidated by recovery/restart | Durable generations checked at the actual launch/effect boundary |
| Status honesty | Liveness or an earlier completed turn can mask a new stalled input | Correlated preparation failure, incomplete Stop, cleanup debt and Resume disposition |
| Isolation | Sessions share a daemon | Unrelated runners and cancellation lifetimes remain unaffected |

## Proposed timing contract

These values require review. Small prototype budgets demonstrate mechanisms,
not suitable production defaults. Process/event-loop suspension precludes a
real-time guarantee.

| Symbol | Draft value | Measurement boundary |
| --- | --- | --- |
| `D_read` | Existing `sessionControlHttpTimeoutMs`, currently 60,000 ms | Logical request start through complete body, including retries/fallback |
| `D_prepare` | 60,000 ms total | One input's snapshot and override preparation, not a new budget per await |
| `D_abort` | 1,000 ms | Cancellation to observable rejection and cooperative transport cancellation |
| `D_fence` | 2,000 ms | Admission acquisition through verified durable fence publication |
| `D_physical` | 8,000 ms | Confirmed fence through exact owned-process absence |
| `D_stop` | 12,000 ms total | Accepted Stop through bounded receipt, including scheduling margin |
| `D_stop_client` | At least `D_stop + 3,000 ms` | Client/RPC/bridge observation; the ordinary 10-second daemon timeout is insufficient |
| `D_resume` | Existing 75,000 ms outer request budget | Resume receipt or actionable admission refusal; no indefinite join |
| `J_test` | 250 ms | Controlled-test allowance with a responsive event loop |

Timeout observation does not prove that an uncooperative operation stopped.
Interactive provider turns and genuine human permission waits are not covered
indiscriminately by the preparation timeout.

## Acceptance scenarios

These are proposed production acceptance criteria, not completed integration
claims. Prototype evidence is partial as described below.

| ID / priority | Scenario | Required result | Required evidence |
| --- | --- | --- | --- |
| AC-01 / P0 | Detail response streams indefinitely | Complete/fail within `D_read + J_test`; abort actual request despite continuing traffic | Real HTTP and installed client; partial E1/E2 |
| AC-02 / P0 | Cancel pending snapshot/override preparation | Rejection within `D_abort + J_test`; zero dispatch and no delivery acknowledgement | Public input, persisted rejection and dispatch trace; partial E2 |
| AC-03 / P0 | Preparation exceeds shared deadline | Explicit terminal failure by `D_prepare + J_test`; preserve input custody, without silent loss/success | Queue, materialization and transcript projection; callback-level E2 only |
| AC-04 / P0 | Override ignores cancellation and settles late | Quarantine conflicting effects; no duplicate apply or invalidation of newer state | Real provider control with late settlement; partial E2 |
| AC-05 / P0 | Independent readers cancel/settle at different times | Other reader survives; poisoned entry retires; old response cannot update newer client | Sharing and client-generation tests; partial E2 |
| AC-06 / P0 | Cleanup dependencies stall during Stop | Confirm fence and exact owned-runner absence within `D_stop + J_test`; disclose cleanup debt | Actual daemon Stop with owned runner and stalled dependencies; partial E3 |
| AC-07 / P0 | Concurrent/repeated Stop for one intent | One generation/operation; no duplicate termination or unbounded cleanup jobs | Daemon, durable record and process receipts; partial E3 |
| AC-08 / P0 | Recovery prepared before Stop/newer Resume | Final admission rejects stopped/stale generations; no unauthorized surviving replacement | Actual scheduler/restart/launch; model-level and process E3 only |
| AC-09 / P0 | Old cleanup settles after a newer intent | Cannot cancel, delete, kill or rewrite newer recovery/outbox/runner/metadata state | Real store and metadata CAS; E3 fence annotation only |
| AC-10 / P0 | Physical Stop succeeds but cleanup never settles; Resume requested | Fresh authorized generation if safe, otherwise bounded refusal; never join raw cleanup | Combined daemon Stop -> Resume -> response; not proven |
| AC-11 / P0 | Fence publication fails/stalls/loses ownership | Bounded incomplete receipt; retained unsettled transaction cannot be overtaken | Filesystem faults and admission; partial E3 |
| AC-12 / P0 | Crash between publication and termination/registration | Discover exact owned remnants; block stale launch; require proof before acknowledging absence | Crash injection at each effect boundary; not proven |
| AC-13 / P0 | Replacement loads stopped/corrupt/unsupported authority | Stopped intent survives; unreadable authority fails closed explicitly | Filesystem and replacement; partial E3 |
| AC-14 / P0 | Old strict client and new lifecycle client coexist | Legacy shapes parse; absent proof is not authority; new client distinguishes cleanup debt | Negotiation, roundtrip and CLI/bridge/UI tests; not proven |
| AC-15 / P0 | Healthy flows while another session is active | Preserve identity and normal behavior; unrelated runner and cancellation unchanged | Integrated runtime/provider acceptance; isolated E2/E3 controls only |
| AC-16 / P1 | Observer disconnects/times out during Resume | Correlated operation/nonce exposes disposition; retry cannot duplicate launch | Public control plus disconnect/restart tests; E4 observation gap |
| AC-17 / P1 | Only tracked resume metadata is missing | Separately gated canonical snapshot fallback after exact identity/serviceability validation; no blank session | Restart/inactive-resume tests; no fallback fix proven |
| AC-18 / P1 | Repeated cycles retain old cleanup | Durable bounded debt/cache/jobs with explicit backpressure; no silent loss or unlimited growth | Multi-generation persistence/load tests; not covered by E3 |

## Evidence boundary

Recorded private investigation artifacts are not included in this public proposal.
The table summarizes retained results, not a fresh rerun during publication.
The proposed design includes repository source references that reviewers can
inspect independently.

| Evidence | Recorded result | Limit |
| --- | --- | --- |
| E1: Mechanism reproduction | Nine tests using inspected installed functions and real loopback HTTP | Exact original live awaited stack unknown |
| E2: Deadline/cancellation prototype | Four expected baseline failures; nine green assertions | Includes a deliberate unresolved recovery-persistence limitation |
| E3: Durable fence prototype | Thirteen baseline failures/one healthy control; 14 green tests and three full repeats, covering 40 launch/Stop race iterations | One supervision domain; not actual scheduler/provider, combined control, crash or cross-store proof |
| E4: Target-only recovery | Old runner retired; Resume timed out | Source explains possible prior-Stop join; no instrumented live-stack attribution |

## Constraints, assumptions and decisions

Preserve provider/session identity, backend/account/model/permission selection,
input acceptance, process ownership, metadata CAS and existing logging helpers.
A generation is neither authorization nor a new conversation.

The initial domain is one authenticated account/relay/machine supervisor.
Every actor that can launch or affect its session must participate. Standalone
tools, competing supervisors and old binaries are not covered by assumption.
Cross-store generation isolation is required but not yet demonstrated.

| Decision | Review owner to confirm |
| --- | --- |
| Accountable outcome owner, timing and cleanup-debt UX | Product/project owner |
| Complete actor inventory and final-effect admission | Technical owner, with operational consultation |
| Receipt compatibility, migration and safe rollback | Technical and product owners |
| Combined control, crash, cross-store and bounded-debt proof | Technical owner, with quality support |
| Future experiment caps and maintenance/recovery | Project operational owner |

No automatic retry, watcher or scheduled restart is authorized. Recovery remains
separately deferred; a future operation requires fresh inventory and explicit
approval after other work is safe to interrupt. Implementation planning follows
outcome and design decisions, not publication of this proposal.
