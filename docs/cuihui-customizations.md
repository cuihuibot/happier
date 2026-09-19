# Cuihui Happier customizations

This page is the public technical contract for behavior intentionally maintained
on `custom/cuihui` outside `happier-dev/happier`. It describes reusable product
behavior, implementation ownership, compatibility limits, and test guidance.
Environment inventory, installed artifact identities, rollout status, acceptance
records, and recovery readiness belong in an operator-controlled deployment
repository; see [Repository boundary for custom deployments](repository-boundary.md).

## Source status

### Unified source candidate (September 19, 2026)

`release/unified-happier-arm64-20260919` is a source-only candidate branched
from the exact `custom/cuihui` head
`2e8026935c7ed412a5c43b9bdf1a4c8477d9fc02`. Product candidate
`835b980c613b16e5724e36162784eff324d5d70f` has that commit as its direct
parent, so it carries the maintained continuation, cancellation,
completion/citation, Copilot steering, native-worker lifecycle, remote setup,
and daemon spawn-compatibility behavior documented below.

The candidate adds two changes on top of that source line:

- the five-file nonblocking-guidance overlay: the two prompt owners and their
  tests under `packages/protocol/src/prompts/`, plus the matching
  `docs/cli-architecture.md` contract text;
- Copilot GitHub connected-service authentication, described under
  [Copilot connected-service authentication](#copilot-connected-service-authentication).

At initial authoring on September 19, 2026, this was a candidate branch awaiting
merge, release, and independent approval. That timestamped source status does
not assert current artifact, installation, deployment, or machine-validation
state; those transient facts belong in the operator-controlled deployment
record.

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

### Copilot regular-session steering

The Copilot ACP runtime enables the shared steering delivery path in
`apps/cli/src/backends/copilot/acp/runtime.ts`. This is the maintained interim
behavior, not a claim of non-interrupting steering: live comparisons with
Copilot CLI 1.0.86 found that a second `session/prompt` aborts the active task in
both regular sessions and managed execution runs, even when Happier sends no
`session/cancel`. The replacement instruction and a subsequent ordinary message
were answered, but cancellation/lifecycle presentation remains imperfect.
Proper non-interrupting behavior is tracked in
[cuihuibot/happier#20](https://github.com/cuihuibot/happier/issues/20).

Steering support is advertised separately from availability: delivery is
available only during an active turn and remains subject to the shared
permission and payload checks. Queueing and explicit interrupt-and-send
(`send_now` for a busy regular session, `delivery: interrupt` for a managed run)
retain their existing routes. No SDK migration is selected automatically.

The Copilot SDK offers a separate `session.send` mode, `immediate`, for
non-interrupting delivery. A direct SDK 1.0.13 / CLI 1.0.86 control test preserved
a running 20-second MCP tool and produced one changed answer after completion.
This establishes provider capability, not integration into Happier: its SDK
runtime remains experimental and is not automatically selected for ACP sessions.
Shell tools need a separate check because native immediate delivery can move a
shell wait into the background without killing the command.

The PR workflow's CLI lane runs the named **Copilot steering regression** step.
Its failure fails the CLI job and CI aggregate. The regression prevents silently
removing the provider opt-in, verifies active/idle availability, and covers late
steering errors without failing a newer turn. It does not prove that a provider
version preserves running tools.

Run the same check locally:

```bash
yarn workspace @happier-dev/cli test:copilot-steering
```

Before deploying to another environment, repeat the disposable real-provider
check and record runtime versions, actual cancellation behavior, replacement
answer, completion events, and ordinary follow-up. The interim contract permits
interruption; a future non-interrupting implementation must instead preserve the
original task without lost output or duplicate completion.

Rollout requires rebuilding and updating the Happier CLI on each target machine,
updating version-pinned daemon entrypoints, and starting fresh or restarted
session runners. This PR does not itself update running machines.

### Copilot connected-service authentication

Copilot advertises the `github` connected service with the `token` kind only.
When a GitHub token profile is selected for a new session, Happier materializes
exactly one environment key, `COPILOT_GITHUB_TOKEN`, into the spawned Copilot
process. Nothing is written to disk, and the token value is not persisted in
session metadata.

- No profile selection keeps Copilot on its native authentication: ambient
  `GH_TOKEN`/`GITHUB_TOKEN`, local `gh auth token`, or stored Copilot
  credentials. The materializer returns `null` rather than projecting a key.
- A non-token GitHub credential fails closed through
  `requireConnectedServiceTokenCredentialRecord`; Happier does not silently fall
  back to another credential.
- `COPILOT_GITHUB_TOKEN_ENV_KEYS` in
  `apps/cli/src/backends/copilot/auth/copilotGithubTokenEnv.ts` is the single
  owner of the GitHub token key order. Both local auth detection and the
  connected-service projection read it, so detection and materialization cannot
  drift apart.
- Writing only the highest-precedence key lets a selected profile win over
  ambient variables and stored Copilot credentials without rewriting the
  environment that `gh` reads.

The key order is anchored to GitHub Copilot CLI 1.0.86 `copilot help
environment`.

Primary implementation:

- `apps/cli/src/backends/copilot/auth/copilotGithubTokenEnv.ts`
- `apps/cli/src/backends/copilot/connectedServices/createCopilotConnectedServicesMaterializer.ts`
- `apps/cli/src/backends/copilot/index.ts`
- `packages/agents/src/manifest.ts`

Focused regression:

```bash
cd apps/cli
yarn vitest run \
  src/backends/copilot/connectedServices/createCopilotConnectedServicesMaterializer.test.ts \
  src/session/actions/options/spawnConnectedServiceDiscovery.test.ts \
  src/backends/copilot/cli/auth/copilotCliAuthSpec.test.ts
yarn typecheck
```

At initial authoring on September 19, 2026, this behavior was
development-source only and had not been included in a published release.
Current publication and machine-rollout status belongs in the
operator-controlled deployment record.

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

### Unified `darwin-arm64` artifact promotion

After the unified source receives the required approvals, its operating contract
is build once and deploy identical bytes:

1. Freeze the exact final Git commit and build one immutable `darwin-arm64` CLI
   artifact from that commit.
2. Sign the artifact and record its checksum before distribution.
3. Copy that same artifact to each approved target Mac. Verify its signature and
   checksum before each installation; do not rebuild or modify it per machine.
4. Install and validate each machine independently. Local credentials, settings,
   and state remain local and are not copied between machines.

Source approval does not establish artifact identity, and one successful
installation does not establish another. The environment-specific deployment
record must bind each installation to the final source commit and the one
artifact checksum, then record machine-local validation separately.

Rollback is not ready until the operator-controlled deployment record identifies
the previous known-good immutable artifact and its checksum, confirms that it is
available, records the currently installed artifact and daemon entrypoint, and
contains an independently validated stop, install, restart, and acceptance
procedure. The compatibility review must also confirm that rolling back the CLI
does not require a state migration. Rollback must preserve each machine's local
credentials, settings, and state rather than replacing them from another
machine.

Artifact build, signing, checksum, copy, installation, deployment, validation,
and rollback-readiness status are transient operator facts rather than reusable
product contracts. Machine identities, exact artifact pins, installation
results, and recovery evidence belong in the operator-controlled deployment
repository described in
[Repository boundary for custom deployments](repository-boundary.md).

## Experimental Copilot SDK runtime (opt-in)

The original authoring record was prepared on September 10, 2026 against
candidate `952e5a6bec06f7006a51c4ce3867cc342e8f3475` (tree `8720128714`).
That candidate and the later operator-route and observability changes are
ancestors of the `custom/cuihui` base used by the unified candidate, so the
unified source contains the SDK runtime described below. The historical
author-side evidence remains scoped to its recorded candidate; ancestry does
not make it current validation or show that the runtime is released, deployed,
independently approved, or at parity with ACP.

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

### Persistent daemon operator route (current source)

The unified source includes a persisted operator route for the background
service. It entered the source line after candidate `952e5a6b`, so do not read
this later behavior back into that historical candidate.

- Use an installed Happier binary that already includes the
  `service copilot-sdk-experiment` command and the service-definition refresh
  logic. This route lives in the Happier CLI binary that manages the service.
- Enable the flight with
  `happier service copilot-sdk-experiment enable --cli-path <absolute-native-Copilot-executable>`.
  The command persists the setting and requires a non-empty absolute path. It
  does **not** prove that the file exists or that the executable is usable; path
  syntax and runtime usability are distinct checks.
- `happier service copilot-sdk-experiment status` reports the **saved**
  configuration from settings. It is not proof that a running daemon has already
  reloaded that configuration.
- Apply a saved enable or disable with `happier service restart`. For the
  installed background service, this is the authoritative re-apply step. On
  macOS, restart compares the installed launchd plist to the expected template
  generated from current settings and rewrites the definition before lifecycle
  commands when it has drifted; it is not just a `kickstart` of a stale
  definition.
- Disable with `happier service copilot-sdk-experiment disable`, then run
  `happier service restart`. This returns **new unbound** Copilot sessions
  launched by this machine's background service to ACP while retaining the
  native Copilot CLI path needed to reopen sessions that are already bound to
  the SDK backend.
- A never-configured service stays on the ACP default. Existing ACP sessions are
  not migrated. Scope is this machine's daemon-launched **new Copilot sessions**
  only; this is not a per-user, per-account, or mobile-device toggle.
- The supported rollback here keeps the SDK-capable Happier binary in place and
  clears only the new-session opt-in. Do **not** recommend downgrading to a
  pre-SDK Happier binary after SDK sessions exist as though affinity or native
  resume were preserved.
- Do **not** use `happier daemon restart --restart-session-runners`,
  `happier daemon restart --kill-sessions`, or
  `happier daemon stop --kill-sessions` for this toggle. Those are separate
  manual-daemon controls, not the background-service configuration apply path.

Current source basis for this operator route: `apps/cli/src/cli/commands/service.ts:5,10-14`,
`apps/cli/src/cli/commands/serviceCopilotSdkExperiment.ts:11-13,25-31,54-85`,
`apps/cli/src/settings/copilotSdkExperimentSettings.ts:45-66,77-80,108-136`,
`apps/cli/src/daemon/service/cli.ts:1774-1785,1915-1917`,
`apps/cli/src/cli/commands/daemon.ts:82-90`.

### Observing which backend a session selected

The older `952e5a6b` references below are historical. The selection and
native-error observability path changed in later source candidate `98700c78`,
which is also an ancestor of the unified base:

- The resolved selection is logged as
  `[copilot] runtime selection resolved kind=<acp|sdk> affinity=<acp|sdk|none> origin=<created|existing|unknown>`
  on the **file-only `info` sink**. Session processes therefore emit it at the
  default file log level `info` without requiring `HAPPIER_LOG_LEVEL=debug`.
  No console `info`, console `warn`, stdout, or stderr signal is added. At
  `HAPPIER_LOG_LEVEL=warn`, the native error warning below remains but this
  selection line is omitted; `silent` suppresses both. Logs are written under
  `$HAPPIER_HOME_DIR/logs/`.
- An opt-in that could not be honored is likewise logged on the file-only
  `info` sink by default:
  `[copilot] Copilot SDK experiment requested but not applied: session launch origin is "<origin>" ...`.
- A native `session.error` is logged on the file-only `warn` sink as
  `[copilot-sdk] native session error: ...`. The logged detail is a bounded
  projection for this sink, not the raw provider body: it passes through the
  canonical `redactBugReportSensitiveText`, strips **C0, DEL, and C1** control
  characters, keeps at most 300 characters of detail after redaction, and
  admits a native `code` token only when it survives the canonical
  `hasNamedCredentialTokenPrefix` rejection plus the owner's additional code
  shape checks. That same bounded file-sink projection, with its explicit
  `warn`/`info`/`debug` severity preserved by the logger rather than inferred
  from timestamped text, is what any already-enabled optional remote log
  forwarding would receive. This is not a claim that all possible secrets or PII
  are always detected, not a general claim that every caller-facing surface is
  redacted, and not an independent security approval.
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
