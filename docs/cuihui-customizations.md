# Cuihui Happier customizations

This page is the public technical contract for behavior intentionally maintained
on `custom/cuihui` outside `happier-dev/happier`. It describes reusable product
behavior, implementation ownership, compatibility limits, and test guidance.
Environment inventory, installed artifact identities, rollout status, acceptance
records, and recovery readiness belong in an operator-controlled deployment
repository; see [Repository boundary for custom deployments](repository-boundary.md).

## Source status

The current follow-up documentation candidate is based on
`282040453f75588a4a8864e9415248c40d671210`, the open PR #3 head. Relative to
that source pin, this documentation migration changes no product source,
package, test, build, or runtime file. PR #3 already contains the combined
provider-autonomous continuation and daemon spawn-settlement changes.

This page does not claim that PR #3 is merged, released, deployed, or accepted.
It also does not claim that moving current documentation removes environment
details from earlier public Git history.

## Maintained behavior

### Copilot completion persistence

- A Copilot turn that finishes only through `task_complete` still creates a
  visible assistant transcript message.
- The completion lifecycle event is not published before that fallback message
  is durably committed.
- A failed streamed commit retries with the same segment `localId`, preventing a
  later stream retry or ambiguous acknowledgement from creating a duplicate.
- Copilot tool tracking preserves the canonical `task_complete` name.

Primary implementation:

- `apps/cli/src/agent/acp/runtime/createAcpRuntime.ts`
- `apps/cli/src/api/session/streamedTranscriptWriter/createStreamedTranscriptWriter.ts`
- `apps/cli/src/backends/copilot/acp/transport.ts`
- `apps/cli/src/agent/acp/updates/toolCalls/AcpToolCallTracker.ts`

Focused regression:

```bash
cd apps/cli
yarn vitest run \
  src/agent/acp/runtime/__tests__/createAcpRuntime.modelOutputStreaming.test.ts \
  src/backends/copilot/acp/transport.test.ts
yarn typecheck
```

### Provider-autonomous continuation

Copilot ACP can resolve `session/prompt` with `stopReason: end_turn` and then
continue emitting prompt-turn `session/update` notifications. ACP v1 gives
those notifications a session identity but no request, turn, or generation
identity. Happier therefore treats qualifying post-response output from the
opted-in provider as a provider-owned continuation segment rather than
appending it to a client turn that already ended.

Required behavior:

- A qualifying update after a completed turn opens a new continuation
  generation and persists as its own transcript turn.
- Commentary, plain assistant prose, and a terminal `task_complete` summary
  each remain visible without duplicate rows.
- A continuation keeps the session busy until it ends.
- A queued or newly arriving client prompt cannot silently discard unflushed
  continuation output.
- Only the provider's correlated terminal `task_complete` is successful.
  Timeout, limit exhaustion, cancellation, failure, supersession, and disposal
  remain explicitly incomplete.
- Existing guards for inactive or stale generations, session mismatch,
  cancellation, disposal, and replay remain in force.

Only the Copilot ACP backend opts in through
`providerAutonomousContinuation`. Other ACP providers retain their existing
behavior.

#### Segment lifecycle

`AcpBackend` emits `event/autonomous_continuation` with `started` and `ended`
phases. The ended event carries one of these outcomes:

| Backend outcome | Runtime result |
| --- | --- |
| `completed` | Successful turn with `task_complete` |
| `timed_out` | Aborted, incomplete turn |
| `limit_exceeded` | Failed, incomplete turn; produced text remains persisted |
| `cancelled` | Cancelled, incomplete turn |
| `failed` | Failed, incomplete turn |
| Missing or unknown | Failed, incomplete turn |

The outcome, not a diagnostic reason string, controls runtime projection.
Unknown outcomes fail closed.

The inactivity budget closes an already-visible segment; it does not delay
ordinary turns and does not prove completion. A running continuation tool call
extends that budget only up to the bounded active-tool extension limit. Late
output after a timeout may reopen in another explicitly incomplete segment.

`maxPerTurn` bounds continuation work, not visibility. After the work budget is
spent, one terminal limit segment can persist the next batch and close with
`limit_exceeded`; subsequent output is dropped. The default maximum of eight is
a product judgement, not a protocol guarantee.

#### Final summary preservation

A successful `task_complete` summary is written as its own durable assistant row
after ordinary streamed prose is flushed. It is omitted when the turn or tool
failed, when the same summary is already visible, or when the turn was
cancelled or aborted. Its deterministic row identity derives from the provider
tool-call id, so replay of the same call does not append another copy.

#### Cancellation and provider-session retirement

ACP v1 cannot correlate autonomous notifications to the client turn that caused
them. A cancelled autonomous goal can otherwise emit later output and have it
misattributed to a newer turn. For an explicit cancellation that can leave
provider-autonomous work running, Happier:

1. retires the provider connection and its process tree;
2. drops callbacks bound to the retired connection epoch;
3. compare-and-clears the retired provider resume id from durable session
   metadata; and
4. opens a fresh provider context for the next prompt while preserving the
   Happier transcript.

The metadata clear is server-acknowledged. Failure is surfaced instead of
reporting a clean stop. A fresh provider context means the provider may not
remember earlier messages even though the Happier transcript still contains
them; the transcript records that consequence.

`RunnerAbortIntent` distinguishes `explicit-cancel` from `shutdown`. The intent
is fixed at each registration site rather than accepted from request payloads.
Shutdown remains the default for unconverted callers and does not discard a
resume pointer. When aborts coalesce, an explicit cancellation arriving behind
a shutdown escalates instead of being swallowed.

Ordinary-mode cooperative cancellation keeps its provider connection and resume
projection. An idle stop is not evidence that autonomous work was abandoned.

#### Continuation limits

- ACP v1 has no continuation lifecycle or turn identity. A provider that stops
  emitting and resumes much later cannot be perfectly attributed; a timeout is
  reported as incomplete rather than successful.
- The terminal limit segment makes the first over-budget output visible, but
  output after that segment is intentionally dropped.
- Retiring a provider session prevents later delivery, republishing, or resume
  of cancelled work; it does not prove the provider stopped computing before
  its process was killed.
- Recovery after retirement starts a fresh provider context and adds restart
  latency.
- Provider-side context restoration is not guaranteed. Happier's transcript is
  the durable user-visible record.

Primary implementation:

- `apps/cli/src/agent/acp/AcpBackend.ts`
- `apps/cli/src/agent/acp/runtime/createAcpRuntime.ts`
- `apps/cli/src/agent/runtime/runPermissionModePromptLoop.ts`
- `apps/cli/src/backends/copilot/acp/backend.ts`
- `apps/cli/src/session/metadata/createVendorResumeIdMetadataPublisher.ts`

Focused regression:

```bash
cd apps/cli
yarn vitest run \
  src/agent/acp/__tests__/AcpBackend.autonomousContinuation.test.ts \
  src/agent/acp/runtime/__tests__/createAcpRuntime.autonomousContinuation.test.ts \
  src/agent/acp/runtime/__tests__/createAcpRuntime.continuationOutcome.test.ts \
  src/agent/acp/runtime/__tests__/createAcpRuntime.continuationCap.test.ts \
  src/agent/acp/runtime/__tests__/createAcpRuntime.sameTurnSummary.test.ts \
  src/agent/acp/__tests__/AcpBackend.cancelForceClose.test.ts \
  src/agent/runtime/runPermissionModePromptLoop.cancellationLivelock.test.ts \
  src/agent/acp/runtime/__tests__/createAcpRuntime.retiredSessionDurability.test.ts \
  src/session/metadata/createVendorResumeIdMetadataPublisher.retirement.test.ts
yarn vitest run src/agent/acp src/backends/copilot src/agent/runtime src/session
yarn typecheck
```

Live acceptance requires a real Copilot-managed session and must cover:

1. commentary followed by one durable final summary;
2. plain continuation prose before completion;
3. a new prompt arriving while a continuation is active;
4. explicit cancellation followed by reuse of the same Happier session, with
   no cancelled marker appearing later;
5. timeout and continuation-budget exhaustion reported as incomplete while
   preserving already-produced text;
6. ordinary and autopilot modes; and
7. comparison of provider events, ACP wire events, and persisted transcript.

A successful session creation or idle send is not sufficient acceptance
evidence.

### Daemon spawn identity settlement

For `SPAWN_HAPPY_SESSION_PROVIDER_SAFE`, a nonblank caller `spawnNonce`
preserves the existing modern response, including accepted-but-pending success.
When the nonce is absent, non-string, empty, or whitespace-only, the handler
uses the same accepted-result settlement adapter as the legacy spawn RPC.

The adapter:

- passes through errors, directory-approval responses, and successes that
  already contain `sessionId`;
- resolves a pending success only from the nonce on that accepted result,
  including a daemon-generated nonce;
- never guesses from the newest session, directory, timestamp, or current
  child;
- does not spawn a second session;
- returns the resolved `sessionId`; and
- preserves boolean `pendingFirstInputAccepted`, including `false`.

Acknowledgement does not prove first-input execution. Existing daemon admission,
coalescing, retry, timeout, and polling behavior is unchanged. Nonce-less calls
do not gain caller-key idempotency, and identical retries are not guaranteed to
create distinct sessions.

The settlement helper defaults to 90 seconds with 250 ms polling. Existing
bounded environment overrides remain supported. A timeout returns
`SESSION_WEBHOOK_TIMEOUT`; it is never converted to success.

Primary implementation:

- `apps/cli/src/api/machine/rpcHandlers.ts`
- `apps/cli/src/session/services/awaitSpawnedSessionId.ts`

Regression coverage belongs in
`apps/cli/src/api/machine/rpcHandlers.test.ts`, including valid caller nonce,
generated nonce, malformed or blank nonce, direct ID, out-of-order settlement,
timeout, and boolean acknowledgement.

### Completion-card rendering

The canonical `task_complete` tool has a dedicated renderer using the existing
safe Markdown path. Summary and full-detail modes show the full multiline
summary; compact mode remains title-only. A nonblank input summary wins, with a
usable result summary as fallback. Missing or malformed content does not produce
invented text, and rendering does not mutate stored rows.

Historical reclassification is narrow: it requires a nonblank input summary,
completion metadata, and a known erroneous `change_title` or generic identity.
Any own `input.title` property prevents that correction. Unrelated canonical
tools remain unchanged.

This renderer cannot recreate text that was never persisted and does not create
a separate final assistant message.

### Opaque citation display

Copilot ACP may supply opaque citation identifiers without URLs. The display
layer converts complete markers to stable, parser-safe numeric references
without inventing hyperlinks. Storage and copy paths retain the original text,
and incomplete trailing markers remain hidden while streaming.

Primary implementation:

- `apps/ui/sources/components/markdown/normalizeOpaqueCitationMarkers.ts`
- `apps/ui/sources/components/markdown/MarkdownView.tsx`
- `apps/ui/sources/components/markdown/rendering/MarkdownViewRenderer.tsx`
- `apps/ui/sources/components/sessions/transcript/MessageView.tsx`

Focused regression:

```bash
cd apps/ui
yarn vitest run \
  sources/components/markdown/MarkdownView.enrichedRenderer.test.tsx \
  sources/components/sessions/transcript/MessageView.streamingMarkdownRender.native.test.tsx \
  sources/components/markdown/enriched/agentTexMathDelimiters.md4c.test.ts
yarn typecheck
```

## Compatibility and rollback

The continuation behavior is additive and provider-gated. Removing
`providerAutonomousContinuation` from `buildCopilotAcpBackendOptions` restores
the earlier drop-after-`end_turn` behavior, but doing so gives up continuation
output and is not a no-impact rollback.

Rolling product code back after an explicit cancellation does not restore a
compare-and-cleared provider resume id. The next turn opens a fresh provider
context; no data migration is required.

The spawn adapter is a prospective coexistence path, not a permanent released
client obligation. Remove it only after evidence shows nonce-omitting callers
are no longer supported or an independently validated replacement covers them.

Deployment rollback is environment-specific. Its readiness depends on current
artifact availability, exact pins, observed pointer state, and an independently
validated recovery procedure. Public product documentation does not claim that
any environment is rollback-ready.

## Experimental Copilot SDK runtime (opt-in)

Verified on September 10, 2026 against candidate
`952e5a6bec06f7006a51c4ce3867cc342e8f3475` (tree `8720128714`), which is **not
merged into this branch**. This branch (`1ffa5f044c`) contains no SDK runtime.
Everything below describes that candidate so operators can read the same rules
the code enforces; it is not a statement that the candidate is released,
independently reviewed, or at parity with ACP.

### What this is, and what it is not

Copilot runs on ACP by default. The candidate adds a second, experimental
Copilot transport (the Copilot SDK runtime) that a host operator can opt into
for **newly created** sessions only. It is a narrow experiment:

- It is **not** SDK/ACP feature parity, and no parity claim is made anywhere.
- It is **not** provider readiness evidence. Better diagnostics are not proof
  that a provider works.
- Author-side engineering evidence on the exact candidate: typecheck exit 0,
  production build (`yarn workspace @happier-dev/cli build`) exit 0, and 291/291
  targeted regressions. That is exact-candidate engineering evidence, not live
  parity or a passed gate.
- Two failures in `apps/cli/src/session/actions` remain and are disclosed rather
  than fixed: `temporary-throttle retry-now` and
  `delegate run defaults above the caller permission`. Both reproduce with the
  candidate's changes stashed, so they are not unique to it — but no root cause
  is established.
- Live acceptance criteria SDK-AC-02..07 and AC-12 require live provider/device
  work that was not authorized and are **not** marked passed.
- Independent live-safety review and independent documentation review were
  pending when this section was written.

### Operator prerequisites

| Variable | Required | Effect |
| --- | --- | --- |
| `HAPPIER_COPILOT_SDK_EXPERIMENT` | yes, to opt in | Exactly `1` or `true` opts in. Every other value, including empty, `0` and `false`, means ACP. |
| `HAPPIER_COPILOT_SDK_CLI_PATH` | yes, whenever the SDK runtime is selected | Binds the installed Copilot CLI. If it is missing the SDK launch **throws**; there is no fallback to ACP. |
| `HAPPIER_COPILOT_SDK_MODEL` | no | Model override passed to the SDK runtime. |
| `HAPPIER_COPILOT_SDK_CONFIG_DIR` | no | Configuration directory for the native runtime. |
| `HAPPIER_COPILOT_SDK_MAX_CREDITS` | no | Positive integer; rejected loudly if it is not. |
| `HAPPIER_COPILOT_SDK_MAX_MODEL_CALLS` | no | A soft, post-request observational stop for bounded runs. It cannot cancel an in-flight call, bound concurrency, or keep a cap current. It is not an enforcement control. |
| `HAPPIER_COPILOT_SDK_USAGE_SINK` | no | Path for durable sanitized usage accounting. Default off. |

### How a runtime is selected

Precedence is fixed and fail-closed. Durable affinity outranks the flag, so a
session never changes transport underneath itself.

| Durable backend affinity | Launch origin / opt-in | Result |
| --- | --- | --- |
| Recorded `sdk` | any origin, flag on or off | SDK |
| Recorded `acp` | any origin, flag on or off | ACP (the reader accepts this value; see the note below) |
| Recorded but unreadable | any | Launch is **refused** (`copilot_backend_identity_unreadable`); it never guesses |
| None recorded | authoritatively created **and** opted in | SDK |
| None recorded | existing, unknown, or not opted in | ACP, with a diagnostic when an opt-in could not be honored |

Consequences worth stating plainly:

- Only a session the server reports as authoritatively **created** can opt in.
  A missing spawn nonce, session flavor, vendor id, or attachment state is not
  evidence of creation.
- An older server that omits the origin discriminator, and the attach path,
  yield `unknown`. That is an explicit ACP outcome with a logged explanation,
  never a silent SDK selection.
- There is no silent runtime fallback in either direction: a selected runtime
  that does not match the runtime actually constructed raises instead of
  degrading.
- Affinity is persisted at the moment the native session binds, not at
  construction, so a session that never started successfully is not durably
  pinned to the experimental runtime.
- **Only `sdk` is ever written.** In this candidate the affinity record is
  persisted solely by the SDK runtime when its native session binds. An ACP
  session carries no Copilot backend descriptor at all, so it stays on ACP
  because its launch origin on reopen is not `created` — not because a durable
  `acp` record exists. The reader accepts `acp` so a future writer, or a session
  written by a later version, is read rather than refused.

### Where the opt-in actually takes effect

The flag is read from the environment of the **session process**, so selection
is host-side:

- A session launched from a terminal inherits that terminal's environment.
- A daemon-spawned session inherits the daemon process environment plus the
  validated, sanitized environment variables supplied with the spawn request;
  daemon-owned keys are stripped from that caller-supplied set before it is
  merged into the child process environment. This is a pre-existing generic
  spawn mechanism, not something this candidate adds.

The candidate introduces **no** SDK-specific picker, no mobile or GUI toggle for
this experiment, no per-user or per-account scoping, and no entry in the
canonical feature catalog. Do not describe the experiment as a user-facing
setting.

### Observing which backend a session selected

- The resolved selection is logged as
  `[copilot] runtime selection resolved kind=<acp|sdk> affinity=<acp|sdk|none> origin=<created|existing|unknown>`
  at **debug** level. Session processes default to file log level `info`, so set
  `HAPPIER_LOG_LEVEL=debug` (or `DEBUG`) for the session process to see it;
  daemon processes already default to `debug`. Logs are written under
  `$HAPPIER_HOME_DIR/logs/`.
- An opt-in that could not be honored is logged at **info** by default:
  `[copilot] Copilot SDK experiment requested but not applied: session launch origin is "<origin>" ...`.
- The durable record lives in session metadata as `agentRuntimeDescriptorV1`
  with `providerId: "copilot"` and `provider.backendMode` of `acp` or `sdk`.
  `copilotSessionId` is the native **vendor** resume identity and is written by
  both runtimes; it never identifies the transport.

### Rollback

Clearing or unsetting `HAPPIER_COPILOT_SDK_EXPERIMENT` returns **subsequent new
sessions** to ACP. It does not, and must not be expected to, move sessions that
already exist:

- A session already bound to the SDK keeps the SDK, because durable affinity
  outranks the flag.
- A session already on ACP stays on ACP. That holds because a reopened session's
  launch origin is not `created`, so the opt-in cannot apply to it; it does not
  depend on any persisted `acp` record, and none is written.
- Do not attempt to migrate an existing SDK session to ACP and do not invalidate
  its native resume id. This candidate defines no supported migration, and doing
  it by hand risks the unreadable-descriptor refusal above.

### Validation constraints

Do not run broad test suites on the shared serving host. Full CLI and E2E lanes
belong on hosted macOS CI; local validation is limited to bounded smoke runs.

### Source references (candidate `952e5a6b`)

| Claim | Source |
| --- | --- |
| Flag name, accepted values, precedence, diagnostic | `apps/cli/src/backends/copilot/sdk/runtimeSelection.ts:24,50-62` |
| No silent fallback | `apps/cli/src/backends/copilot/sdk/runtimeSelection.ts:67-76` |
| Selection seam, debug selection line, unhonored-opt-in info log | `apps/cli/src/backends/copilot/runtimeFactory.ts:40-56` |
| `HAPPIER_COPILOT_SDK_CLI_PATH` required, throws | `apps/cli/src/backends/copilot/runtimeFactory.ts:67,112-118` |
| Optional SDK variables, observational call ceiling | `apps/cli/src/backends/copilot/runtimeFactory.ts:68-99` |
| Durable affinity record, unreadable-descriptor refusal | `apps/cli/src/backends/copilot/sdk/backendAffinity.ts:34-41,80-104` |
| Only `sdk` affinity is written | `apps/cli/src/backends/copilot/sdk/runtime.ts:119-124` (sole `persistCopilotBackendAffinity` call site) |
| Affinity persisted at native bind | `apps/cli/src/backends/copilot/sdk/runtime.ts:106-126` |
| Launch origin sourced only from the server response | `apps/cli/src/agent/runtime/initializeBackendRunSession.ts:435` |
| Session env passed to the runtime | `apps/cli/src/agent/runtime/runStandardAcpProvider.ts:539` |
| Daemon child environment composition | `apps/cli/src/daemon/spawn/resolveSpawnChildEnvironment.ts:29-47,126-153,227-241`, `apps/cli/src/daemon/startDaemon.ts:3639-3646,3664-3668,4151-4157` |
| Log level defaults | `apps/cli/src/ui/logFileLevel.ts:28-35` |

## Synchronizing with upstream

After merging `upstream/dev`, rerun the relevant tests above. Remove a
customization only after equivalent upstream behavior passes the same regression
and applicable live acceptance checks.

Follow [Maintaining the Cuihui customization fork](custom-fork-workflow.md) for
the fetch, merge, validation, and push workflow.
