# Proposal: bounded preparation and generation-fenced Stop/Resume

**Initiative:** HAP-STALL-20261007

**Record:** HAP-STALL-DESIGN-01

**State:** design review input; no production implementation or operation

**Evidence baseline:** `2e8026935c7ed412a5c43b9bdf1a4c8477d9fc02`

**Outcome:** [Acceptance and timing proposal](bounded-session-control-outcome.md)

## Decision summary and classification

Propose coordinated preparation deadlines/cancellation and independent durable
lifecycle authority. Stop must establish authority and physical absence before
slow bookkeeping; Resume must use bounded proof rather than inherit unfinished
cleanup. A process kill or client timeout alone cannot solve late launch/kill
effects or the existing prior-Stop join.

This is architectural defect remediation, not a timeout-only patch: it crosses
transport sharing, input custody, provider overrides, process ownership,
Stop/Resume, recovery/outbox/metadata stores and strict public schemas.

Observed source paths:

```text
Prompt: input -> await snapshot -> await override flush -> provider dispatch
Stop: mark stop -> await recovery/outbox/metadata -> physical stop
Resume: coalesce spawn -> await prior Stop -> validate identity -> spawn/adopt
```

Streaming was a proven possible trigger for an inactivity timeout, not an
observed property of the original incident. The exact live await remains
unconfirmed. See E1-E4 and AC-01 through AC-18 in the outcome record.

## Proposed change map

All surfaces and behavior below are proposals, not implemented changes.

| Change | Owner/surface | Behavior | Acceptance |
| --- | --- | --- | --- |
| C-01 | S1 transport and compatibility fallback | One logical absolute deadline; cancellation through body/fallback; retain inactivity limit | AC-01, AC-02, AC-05 |
| C-02 | S2-S4 snapshot/client/preparation | Shared budget and cancellation; generation-safe retirement and late-update guards; audit every override flush | AC-02 through AC-05, AC-15 |
| C-03 | Proposed `apps/cli/src/daemon/sessions/sessionLifecycleFence.ts`; review S11 reuse | Durable per-domain generations, immutable targets, final admission/claims and retained cleanup debt | AC-06 through AC-13, AC-18 |
| C-04 | S5 Stop; S12-S14 clients/contracts | Fence and exact owned termination before cleanup; bounded proof-bearing receipt and observation budgets | AC-06, AC-07, AC-11, AC-12, AC-14 |
| C-05 | S5 Resume; S8-S10 controls/snapshot | Bounded prior-Stop decision; fresh authorized grant only after safe absence; early nonce disposition | AC-08, AC-10, AC-11, AC-14, AC-16 |
| C-06 | S5-S7 recovery/respawn/store effects | Final generation checks and immutable cleanup targets; forced recovery cannot erase Stop | AC-08, AC-09, AC-12, AC-18 |
| C-07 | S8, S12-S13 CLI/bridge/UI projections | Separate physical absence, fence confidence, cleanup debt and supersession; typed bounded diagnostics | AC-03, AC-06, AC-10, AC-14, AC-16 |
| C-08 | S10 identity eligibility and canonical snapshot helpers | Separately gated P1 fallback, only after exact identity/serviceability validation | AC-17 |

C-08 is not a prerequisite for safe explicit Resume and has no proven fallback
prototype. Review it separately rather than silently expanding the P0 scope.

## Preparation and transport

Start one logical read deadline before transport work. Include response body,
compatibility fallback, retries and relevant queueing. Snapshot and override
preparation share `D_prepare`; pass remaining time, not a fresh allowance.
Do not apply that timeout to ordinary interactive turns or human permission waits.

S1 already bypasses sharing for caller-owned signals; preserve that isolation.
Any retained coalescing needs operation-owned cancellation/deadline semantics.
One reader must not cancel another reader's work merely because their session
matches.

Each shared entry/client synchronization needs an owned generation or equivalent
identity. Retirement must not let an old `finally` delete its successor.
Before applying a late snapshot, verify update ownership and that the client is
still open. Cooperative transport must be aborted and observed settled.

An uncooperative override stays quarantined until actual settlement or a proven
safe lifecycle transition. A deadline is not cancellation proof. Do not dispatch
conflicting input, apply twice or claim readiness while its effect is uncertain.

Reuse existing provider-input rejection/custody semantics, including
`provider_unavailable_before_acceptance` where valid. Do not acknowledge delivery
before acceptance or lose persisted pending input. Deadline failures must be
typed and visible rather than swallowed by ordinary best-effort snapshot catches.
Cached refresh behavior may remain only where its existing contract permits it.

## Durable lifecycle authority

Use a stable authenticated supervision-domain identity, not daemon incarnation
or timestamp ordering. A versioned private record, keyed by canonical
domain/session identity, holds monotonic intent generation, desired state,
accepted operation provenance, launch claim, exact process creation/provider
identity, proof disposition and generation-scoped cleanup debt.

PID alone is not ownership. Store no credentials, keys, message bodies or native
authentication material. Require owner-only access, atomic durable publication,
validation/readback and ownership-safe locking. S11 reuse must be assessed;
the prototype lock is not a production implementation.

| Transition | Required authority/invariant |
| --- | --- |
| Running N -> stopped N+1 | Accepted explicit Stop; publication and owned termination share admission |
| Stopped N -> stopped N | Same-intent idempotent receipt, not duplicate cleanup |
| Stopped N -> running N+1 | Fresh authenticated Resume observing current generation; prior owned runners absent |
| Running N -> automatic launch N | Current recovery claim and final running-generation check |
| Late cleanup | Immutable generation/attempt/debt target; never a lifecycle transition |
| Missing/corrupt/unsupported authority | Bounded explicit refusal, never inferred running permission or safe-stop success |

A caller-provided `provenance: user_request` string is not authentication.
Expected generation and operation identity must prevent late Stop from targeting
a newer Resume.

Prepare outside admission. Under the shared gate, revalidate ownership and
generation, reserve the claim, and perform final child creation/registration.
A check before an awaited launch is insufficient. Child startup must validate
the claim before provider effects/input acceptance.

Registration failure or crash cannot make an unclaimed child servable.
Discover remnants using proven creation/claim/process markers; terminate only
exact owned targets. Unknown ownership means incomplete, not a guessed kill.
Inventory forced restart, quota/auth recovery, adoption, direct/terminal Resume,
handoff and scheduled respawn. No internal actor may manufacture user Resume.

## Stop, Resume and cleanup

```text
accept Stop and locally suppress recovery
  -> bounded admission -> durable stopped generation and immutable targets
  -> exact owned termination/absence proof -> bounded Stop receipt
  -> independent generation-scoped cleanup
```

Delayed physical-stop callbacks must not look up a newer runner by session ID.
Unconfirmed publication, ownership or absence returns bounded incompleteness.
An unsettled authority transaction retains its ownership barrier until actual
settlement, preventing a newer intent from overtaking its late write.

Coalesce callers around the bounded receipt, not raw cleanup. Limit pending
effects, jobs and caches with explicit backpressure. Stop-specific HTTP/RPC/bridge
observation must exceed `D_stop` with margin: the ordinary 10-second daemon
control default is shorter than the proposed 12-second receipt budget.
Do not enlarge unrelated health/list budgets.

Resume may advance to a fresh authorized generation while cleanup debt remains
only when stopped authority and old-runner absence are confirmed. Otherwise
return a bounded actionable refusal. Reject `race(oldStop, timeout)` followed
by unconditional Resume: the late old Stop could kill the replacement.

Record nonce/operation disposition before long waits. Observer timeout is not
operation cancellation; `not_found` does not prove an old request cannot act.
Replays must coalesce or refuse honestly, not duplicate launches.

Never hold admission while awaiting recovery/outbox/network cleanup. Use
generation/attempt keys and effect-boundary CAS; a pre-await guard is insufficient.
Old cleanup must not mutate newer timers, claims, outbox, runner or metadata.
An integration lacking conditional mutation remains blocked. Retain bounded
cleanup debt across Resume/replacement; the prototype's fence annotation does
not prove cross-store isolation or debt persistence.

## Contracts and compatibility

S12's Stop result variants are strict. Appending even optional fields is not
automatically compatible with unchanged clients. Propose negotiated versioned
receipts using existing capability/control-envelope conventions; exact naming
requires review.

Receipts distinguish operation/generation, physical absence, fence confidence,
cleanup disposition and typed failure/supersession. Update actual CLI, RPC,
bridge, Stop/Resume helpers and UI projections together.

| New state | Legacy requirement |
| --- | --- |
| Confirmed fence/absence, cleanup complete | Existing stopped shape stays schema-valid |
| Confirmed physical Stop with cleanup debt | Conservative existing incomplete result, such as `disposition_in_progress`; UX needs review |
| Ownership/fence/absence unconfirmed | Known incomplete reason; no extra fields or implied proof |
| Superseded operation | Never project stale success onto the current generation |

Missing negotiated proof is not authority. Preserve backend/account/model/
permission and canonical provider/session identity using S9. No generic default,
blank session or silent machine substitution.

## Migration, rollback and validation

No operation here is authorized by the proposal.

Enforce lifecycle capability at actual supervisor/start admission; an ignored
minimum-version marker is not enforcement. Block activation while any
incompatible actor can bypass the fence. Reconcile exact identities and legacy
records without creating running grants for missing/corrupt state.

A separately approved clean daemon boundary is required: new handlers cannot
repair legacy unresolved callbacks by hot-patching around them. Maintenance
remains deferred until safe and explicitly authorized.

Rollback must retain an authority reader/denier. Do not downgrade to a binary
that ignores persisted fences, delete tombstones or clear Stop to appear healthy.
Disable new admission, retain/reconcile records and use a compatible approved
rollback or forward repair.

| Gate | Required evidence | Current status |
| --- | --- | --- |
| G-01 | Accountable owner, approved timing/UX, authority and compatibility | Review pending |
| G-02 | Repository types/build, transport/sharing, custody, all preparation sites, lifecycle and protocol tests | Not implemented |
| G-03 | Combined cleanup-hung Stop -> Resume, late cross-store effects, crashes at each effect, bounded debt/load | Separate prototypes only |
| G-04 | Actual installed runtime/provider via public input, Stop, nonce and Resume in a disposable authorized domain | Not run |
| G-05 | Strict legacy roundtrips, old-actor enforcement, crash recovery and compatible rollback rehearsal | Not run |
| G-06 | Separately authorized maintenance, fresh baseline and runner-preservation checks | Deferred |

Extend existing tests, including `sessionsHttp.timeout.test.ts`,
`sessionsHttp.inFlight.test.ts`, `snapshotSync.test.ts`,
`runPermissionModePromptLoop.abortStarvation.test.ts`,
`runPermissionModePromptLoop.providerSubmission.test.ts`,
`sessionRunnerRespawn.test.ts` and `recoveryIntentFileStore.test.ts`.
Their existence is not evidence that new acceptance criteria pass.

Emit bounded sanitized stage/generation/budget, cancellation, late-settlement,
cleanup-debt and veto diagnostics. Never log token-bearing coalescing keys,
encryption material, full metadata or conversations.

Reject/rework the design if an actor launches after a stopped fence, an old effect
mutates/kills a newer generation, cancellation leaks across sessions, missing
proof becomes success, debt disappears on replacement or legacy parsing breaks.

## Alternatives and next decision

Deadlines alone may be an independent first increment, but do not fix lifecycle
deadlock or recovery persistence. Kill-first/cleanup-timeout without authority
is unsafe as a full remedy. Server-owned authority would broaden domain/API/
authentication scope and needs a separate design. A later maintenance restart
is only a workaround, with interruption/adoption risk.

Confirm the outcome owner and timing/UX scope; complete actor, store and crash
proof; approve compatibility/migration; decide C-08 separately. Future experiments
need declared time/cost/process caps and authorization. Then approve design and
prepare an executable implementation plan. Publication is not implementation
approval.

## Source evidence index

Anchors refer to the recorded source baseline, not installed deployment proof.

| ID | Repository path / anchor | Observation |
| --- | --- | --- |
| S1 | `apps/cli/src/session/transport/http/sessionsHttp.ts:55-107,138` | Coalescing, signal bypass, inactivity timeout and compatibility interface |
| S2 | `apps/cli/src/api/session/snapshotSync.ts:20-65` | Snapshot wait retires on settlement |
| S3 | `apps/cli/src/api/session/sessionClient.ts:661,2106-2178,3523` | Shared client sync and best-effort catch |
| S4 | `apps/cli/src/agent/runtime/runPermissionModePromptLoop.ts:202-220,380,387,417,466-469` | Snapshot and multiple override waits |
| S5 | `apps/cli/src/daemon/startDaemon.ts:2977-2980,5555-5597,2805` | Prior-Stop join, cleanup-before-stop and supersession cleanup |
| S6 | `apps/cli/src/daemon/processSupervision/sessionRunnerRespawn.ts:163,283,377-410` | In-memory stop checks and forced restart |
| S7 | `apps/cli/src/daemon/connectedServices/recoveryScheduler/DurableBackoffRecoveryScheduler.ts:380-410,707-727` | Durable cancellation and in-memory versions |
| S8 | `apps/cli/src/daemon/controlServer.ts:1741-1940,2067-2140` | Stop/spawn/nonce controls; no session-only cancellation API |
| S9 | `apps/cli/src/daemon/sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions.ts` | Canonical identity and snapshot composition |
| S10 | `apps/cli/src/daemon/plannedRunnerRestart/restartSessionRunnerOnCurrentRuntime.ts` | Resume eligibility/identity gate |
| S11 | `apps/cli/src/utils/fs/jsonOwnerFileLock.ts` | Existing lock helper to assess for reuse |
| S12 | `packages/protocol/src/sessionStop.ts` | Strict result variants and finite reasons |
| S13 | `apps/cli/src/daemon/sessions/stopSessionContract.ts`; `packages/protocol/src/sessionControl/contract.ts` | Physical-retirement interpretation and envelopes |
| S14 | `apps/cli/src/daemon/controlClient.ts:166-190,822-839,893-929` | Ordinary timeout versus specialized control observation |
