# Cuihui Happier customizations

This document is the source of truth for behavior intentionally maintained on
`custom/cuihui` outside `happier-dev/happier`.

Technical evidence checkpoint: September 8, 2026.
Closure status updated: September 9, 2026 (user report; no new runtime test).

Repository-integrated documentation candidate, not published. Earlier records below are retained
as history. For the R3 hosted completion-card activation and its scoped recovery,
use [Hosted completion-card rendering: R3](#hosted-completion-card-rendering-r3);
the earlier CLI restart and v2 rollback instructions do not apply to R3 recovery.
The [daemon-spawn compatibility experiment](#daemon-spawn-compatibility-experiment)
is separately deployed experimentally; the user now reports that the original
phone's New Session seems to work, without wire-level verification. Its
daemon-only activation left the hosted R3 UI unchanged. Historical CLI
installation guidance below is not this experiment's operating procedure.

## September 9 closure and recovery status

Record ID: `DSC-CLOSURE-20260909`. At `2026-09-09T08:38+07:00`, the user
reported that New Session on the original phone seems to work. This is the
actual user-reported outcome, not an independently observed request/result
trace. Exact wire correlation, phone native-versus-hosted identity, and a
separate modern nonce-bearing live probe remain unverified.

At `2026-09-09T08:43+07:00`, the user explicitly deferred manual review of the
`task_complete` card and asked to assume it works and finish the remaining
consolidation. That is a deferred, **unverified** check, not a pass or failure.
The explicit bridge `task_complete` attempt at that time returned
`unknown_tool` and produced no card event; this does not prove Copilot native
completion was removed. No new card test or card-rendering outcome is claimed.
The deployed hosted R3 repair remains conditional on an existing stored summary;
separate CLI tool-mislabel and final-assistant-bubble gaps are outside this
closure update, not newly delivered features.

PA reports that both old temporary workspaces, including their `/private/tmp`
aliases, are absent. The cause and any deletion actor are unproven. Old paths
below are historical locators, not currently usable evidence or recovery
commands. The three original DSC-DOC-R3 documents, their author handoff, and
the exact historical documentation and daemon deployment/preservation reports
have been hash-verified and recovered under `recovered-baseline/` in
`/Users/cuihuiai/Work/happier-session-closure-20260909/documentation`;
`recovery-inventory.json` records provenance and hashes. Historical reports
retain only their original scope and do not approve these updated bytes.
The historical review bodies are recovered, but their underlying old test,
typecheck, build and browser log bodies are not. PSWE recovered some exact
host-specific helpers for reference only; the non-exact daemon rollout-helper
reconstructions were discarded. The original daemon receipt and a current
executable recovery procedure have **not** been re-established. Source recovery
does not recover the old payload/archive or establish current rollback
readiness. Old commands below remain historical, not runnable recovery guidance.

PA's approved integration update and PSWE's recovery handoff establish that
all 26 source files are now recovered byte-identically and durably integrated
as an uncommitted working-tree candidate. There is no overlapping source
integration delta between the original UI base and the integration base, or
between the two source changes. The combination still needs fresh independent
product approval; recovered historical reviews do not approve it.

### Durable integration identity

Record ID: `DSC-INTEGRATION-20260909-R1`. Durable root:
`/Users/cuihuiai/Work/happier-session-closure-20260909`.
Paths in this table are relative to that root, not the absent temporary roots.

| Identity or evidence | Current durable binding |
| --- | --- |
| Repository / branch | `repo/`, `exp/spawn-compat-and-completion-card-recovery-r1` |
| Integration base / HEAD / locally recorded `origin/custom/cuihui` | `0d99e21273200b3a43d9508d6878234895f0240a` |
| Source scope | Exactly 26 files: two daemon handler/test files and 24 hosted UI/shared-protocol files; 22 modified and four added |
| Frozen combined source patch | `evidence/implementation/candidate/combined-candidate.patch`, SHA-256 `bb875094ea96fb16f2dbb3f8075ed3cc675fd347a1dd2541a1f11de820573287` |
| Exact 26-path list | `evidence/implementation/candidate/changed-files.txt`, SHA-256 `7b42536a93b780d038461277348feabf2858a1bd3496a373c8fd81a73729237f` |
| Per-source-file byte identities | `evidence/implementation/candidate/file-inventory.txt`, SHA-256 `1749ef20c02744a933bc9094a7a41c848aafda804020124b9a5c11a366fe655c` |
| Source candidate manifest | `evidence/implementation/candidate/sha256-manifest.txt` |
| Recovered original source | `recovery-source/daemon-r1/`, `recovery-source/ui-r3/` |
| Exact original-base patches | `recovery-source/original-base-patches/`; daemon diff `07d3fb50e68030e7a6cd48bf3552297771fb1d8954c978bd3f81ed8dc9806e6e`, UI patch `6a9fe25a0ceb84e81e48110f206b9c8feaf381170a9fda7a413756c3c044f136` |
| Recovery provenance / implementation handoff | `evidence/implementation/RECOVERY-INVENTORY.md`, `evidence/implementation/PSWE-HANDOFF.md` |
| Official documentation candidate | `repo/docs/cuihui-customizations.md`, `repo/docs/cli-architecture.md`, `repo/docs/compatibility.md` |
| Exact documentation handoff / preserved closure predecessor | `documentation/integrated-author-handoff.txt`, `documentation/preserved-closure-20260909-r1/` |

The existing repository baseline and recovered historical records are retained.
The original daemon and hosted source bases in the historical sections below
remain provenance, not the new combined branch identity. The three repository
documents require fresh independent review on their **exact repository bytes**.
Separate fresh source validation is in progress per PA's assignment; this
authoring checkpoint neither consumes nor predicts its result. Fresh product
and documentation approval and publication remain pending.

PA reports the installed daemon/native and hosted UI hashes unchanged; PSWE's
read-only recovery observations match those identities. Production is untouched
by this integration, and this author performed no host or runtime action.
The user requests preservation, consolidation and publication of the fixes,
not an assumed merge, release or redeployment. No commit, push or PR for this
candidate has been created at this checkpoint. No overall compatibility approval
or current rollback-ready claim follows from repository integration.

## Customization inventory

| Commit | Area | Maintained behavior |
| --- | --- | --- |
| `50835935f7` | macOS setup and resume | Hardens remote SSH setup, local daemon installation, session identity durability, Copilot resume coverage, and macOS signing for Bun sidecars. |
| `c11d059fa0` | setup review corrections | Applies the independent review findings for remote setup, identity publication, SSH host trust, and scoped sidecar signing. |
| `ac0fe7965f` | Copilot completion | Preserves canonical `task_complete` identity, persists a task-complete summary when Copilot emits no ordinary assistant message, and keeps spawn routing compatible with legacy requests. |
| `eb432e2af1` | fork operations | Defines the private-fork synchronization and push-safety workflow. |
| `75850ea321` | completion durability and citations | Retries nondurable task-complete summaries with the original stream identity and displays opaque Copilot citation markers safely. |
| _this branch_ | provider-autonomous continuation | Persists Copilot autopilot replies that the provider emits after `session/prompt` already resolved with `stopReason: end_turn`. |

Review the exact maintained delta with:

```bash
git log --oneline upstream/dev..custom/cuihui
git diff --stat upstream/dev...custom/cuihui
```

## Copilot completion persistence

### Required behavior

- A Copilot turn that finishes only through `task_complete` must still create a
  visible assistant transcript message.
- The completion lifecycle event must not be published before that fallback
  message is durably committed.
- A failed streamed commit must retry with the same segment `localId`. Reusing
  the identity prevents a later stream retry or an ambiguous acknowledgement
  from creating a duplicate assistant message.
- Copilot tool tracking must preserve the canonical `task_complete` name rather
  than presenting the operation as `change_title` or an unrelated tool.

### Main implementation

- `apps/cli/src/agent/acp/runtime/createAcpRuntime.ts`
- `apps/cli/src/api/session/streamedTranscriptWriter/createStreamedTranscriptWriter.ts`
- `apps/cli/src/backends/copilot/acp/transport.ts`
- `apps/cli/src/agent/acp/updates/toolCalls/AcpToolCallTracker.ts`

### Regression coverage

```bash
cd apps/cli
yarn vitest run \
  src/agent/acp/runtime/__tests__/createAcpRuntime.modelOutputStreaming.test.ts \
  src/backends/copilot/acp/transport.test.ts
yarn typecheck
```

The live acceptance check must use a real Copilot-managed Happier session:

1. Send a prompt that requires no ordinary assistant prose and completes only
   with a unique `task_complete` summary.
2. Confirm exactly one canonical `task_complete` tool call and one assistant
   message containing the unique summary.
3. Send another turn and confirm the earlier summary still has exactly one
   assistant transcript row.
4. Confirm `pendingCount` and `pendingBlockedCount` both return to zero.

## Provider-autonomous continuation

### Problem

GitHub Copilot CLI 1.0.84-1 exposes an ACP `autopilot` session mode. In that
mode the agent resolves `session/prompt` with `stopReason: end_turn` and then
*keeps working*, emitting further prompt-turn `session/update` notifications for
the same session. ACP protocol version 1 has no notification that starts or
ends such a continuation and carries no turn identity on `session/update`.

Happier closes the dispatched turn generation when the prompt RPC resolves, so
the global dispatch guard rejected every later update with
`Dropping prompt-turn session/update outside an active dispatched generation`.
The provider's final answer was therefore permanently absent from the
transcript. Captured on 2026-09-08: the prompt resolved at `10:47:57.674Z` and
the `task_complete` summary arrived at `10:47:59.193Z`, 1.5 s after the turn had
already been finalized.

### Required behavior

- A prompt-turn `session/update` that arrives after a *completed* turn outcome,
  from an opted-in provider, for the matching session, must open a new
  provider-owned turn generation and be persisted.
- The continuation is projected as its own transcript turn. Stage-one
  commentary from the client turn and a stage-two `task_complete` summary from
  the continuation must each persist exactly once.
- Plain assistant prose emitted during a continuation must persist, not only
  `task_complete` summaries.
- Busy/completion lifecycle must stay coherent: the session must not be
  reported idle while a continuation is still producing output, and a queued or
  newly arriving client prompt must not silently discard unflushed continuation
  output.
- **A completion may only be reported when the provider actually completed.**
  Only the provider's own correlated terminal `task_complete` produces a
  successful turn. An inactivity safety stop, a user cancellation, a superseding
  client prompt, a backend failure and a disposal are interruptions and must be
  projected as explicitly incomplete turns that still keep the text the provider
  already produced.
- Every existing protection is retained unchanged: the global
  outside-active-generation guard, cancellation, closed or stale generations,
  session-id mismatch, disposal, and `loadSession` replay.

### Design constraints deliberately honored

- **No arbitrary grace sleep as lifecycle proof.** The turn is not held open
  after `end_turn` waiting to see whether a continuation arrives. The arrival of
  a real prompt-turn notification is itself the signal to reopen. Nothing is
  delayed on turns that have no continuation.
- **The deterministic close is the provider's own terminal signal.** Copilot
  announces the tool name on `tool_call` and reports the terminal status on a
  later status-only `tool_call_update`, so the terminal detector correlates the
  completion by `toolCallId`. Every observed autopilot run closes on that
  signal rather than on a timer.
- **The stall budget only closes, never gates, and never claims success.**
  `stallMs` (default 30 s) is a safety cap for a provider that never reports
  `task_complete`. It closes a segment whose output has *already* been
  projected, so it cannot drop or withhold output, and it is **not** evidence
  that the provider finished. It is deliberately far longer than an ordinary
  pause between reasoning and prose: a short budget ends the run mid-work and
  pushes the remaining output across a segment boundary, which is exactly how
  output was lost in live testing.

  An earlier revision of this change did treat the stall stop as a completion.
  See *Corrected defect: the stall stop was reported as success* below.
- **A running tool call is work, not silence.** If one of the continuation's own
  tool calls is still unresolved when the stall budget elapses, the budget is
  extended instead of ending the segment, so a slow tool is never misreported as
  a stall. The extension is bounded
  (`MAX_AUTONOMOUS_CONTINUATION_ACTIVE_TOOL_EXTENSIONS`, 20 budgets) so a tool
  call that never resolves cannot hold the session busy forever; when the bound
  is reached the segment ends with the `timed_out` outcome, not a completion.
- **Late output reopens rather than disappears.** A segment that ended on the
  safety stop stays marked incomplete, and the turn remains armed, so provider
  output that arrives afterwards opens a new honestly-labelled segment instead
  of being dropped.
- **Disposal is reported before the backend goes silent.** `dispose()` closes
  an open continuation *before* setting the disposed flag that silences event
  emission, so the runtime learns the segment ended, flushes the text already
  produced, and marks the turn incomplete rather than leaving it silently
  unresolved.
- **Client-turn idle budgets must not close a continuation.** The existing
  post-prompt idle timers exist to bound a *client* prompt turn whose completion
  was already published before the continuation opened. `finalizeIdleStatus()`
  therefore defers to an open continuation; otherwise it closes the generation
  during an ordinary reasoning pause and the provider's remaining output is
  dropped.
- **Opt-in per provider.** Only the Copilot ACP backend passes
  `providerAutonomousContinuation`. Every other ACP provider keeps byte-identical
  behavior.
- **Bounded work, not bounded visibility.** `maxPerTurn` (default 8) caps how
  many autonomous segments Happier will *work through* for one client turn, so a
  misbehaving provider cannot keep a session open indefinitely. It does not
  decide whether the user may see output the provider already produced. Once the
  budget is spent the turn stays armed for exactly one **terminal limit
  segment**: the next qualifying prompt-turn update opens it, its content is
  written to the transcript, and it closes in the same update batch with
  `outcome: 'limit_exceeded'` — no stall timer, no further work accepted. The
  client turn is then latched, so later chunks are dropped quietly instead of
  producing an error for every chunk. If the provider genuinely finishes inside
  the limit segment, the terminal `task_complete` check runs first and the
  segment truthfully reports `completed`.
- **`usage_update` never reopens.** Reopening on any notification would resurrect
  turns from bookkeeping traffic; only prompt-turn update types qualify.

### Why the continuation is a separate turn

Running the continuation as its own generation gives it a fresh accumulated
response and its own transcript turn, so an autonomous segment is attributable
and independently cancellable rather than being appended to a turn the client
already considers finished.

This separation alone was **not** sufficient for the final summary. See
[Corrected defect: a final summary after commentary was lost](#corrected-defect-a-final-summary-after-commentary-was-lost).

### Main implementation

- `apps/cli/src/agent/acp/AcpBackend.ts` — continuation arm/open/stall/close
  lifecycle beside the existing dispatch filter.
- `apps/cli/src/agent/acp/runtime/createAcpRuntime.ts` — projects a continuation
  as its own transcript turn; adds `waitForAutonomousContinuationIdle()` and
  `settleAutonomousContinuation()`.
- `apps/cli/src/agent/runtime/runPermissionModePromptLoop.ts` — settles an open
  continuation before a new client prompt calls `beginTurn()`.
- `apps/cli/src/backends/copilot/acp/backend.ts` — the single opt-in point.

### Backend-to-runtime end contract

`AcpBackend` emits `event/autonomous_continuation` with `phase: 'started'` and
`phase: 'ended'`. The ended payload carries:

| field | meaning |
| --- | --- |
| `continuationId` | identity of the segment being closed |
| `reason` | human-readable cause, for diagnostics only |
| `outcome` | `completed` \| `timed_out` \| `limit_exceeded` \| `cancelled` \| `failed` |
| `stallMs` | the safety budget in force, reported as the timeout cap |

`outcome` is the only field the runtime acts on, and the mapping is total:

| `outcome` | runtime turn outcome | transcript result |
| --- | --- | --- |
| `completed` | successful completion | `task_complete`, turn recorded completed |
| `timed_out` | `{ kind: 'timed_out' }` | `turn_aborted`, turn cancelled |
| `limit_exceeded` | `{ kind: 'failed' }` | `turn_aborted`, turn cancelled; the segment's text is still persisted |
| `cancelled` | `{ kind: 'aborted' }` | `turn_cancelled`, turn cancelled |
| `failed` | `{ kind: 'failed' }` | `turn_aborted`, turn cancelled |
| missing/unknown | `{ kind: 'failed' }` | `turn_aborted`, turn cancelled |

A missing or unrecognized outcome is deliberately treated as a failure, never as
a success, so a future backend change cannot silently reintroduce a fabricated
completion.

### Corrected defect: the stall stop was reported as success

The first revision of this change (`3abcd08653`) closed a stalled continuation
by emitting `phase: 'ended'` with a `reason` string only. The runtime discarded
the reason and always flushed the turn through the successful path, so
`flushTurn()` published `task_complete` and called
`recordSessionTurnCompleted()`. After any provider or tool interval longer than
the stall budget, Happier told the user that the autonomous work had finished
while the provider might still be working and might later resume behind that
false completion boundary.

This was found by independent product-quality review (defect QF-AC-001) and is
fixed by the `outcome` contract above. The stall budget now only ever produces
an explicitly incomplete turn.

### Corrected defect: budget exhaustion silently dropped provider output

The second revision (`8a04c52afa`) returned `false` from
`maybeBeginAutonomousContinuation()` as soon as the per-turn budget was spent and
wrote a debug log. The runtime therefore received neither the content nor any
incomplete indicator, so a truncated autonomous run was indistinguishable from a
coherent finished one. Documenting that as a known limit was not an acceptable
resolution.

This was found by independent product-quality review (defect QF-AC-002) and is
fixed by the terminal limit segment described above: the first output past the
budget is persisted and the turn is explicitly reported incomplete, exactly once.

### Corrected defect: a final summary after commentary was lost

`flushTurn()` used to project the `task_complete` summary **only** when the
segment had produced no ordinary assistant message. When a provider narrated
first and then finished the *same* turn with a canonical `task_complete`, the
stream segment was already claimed by the commentary, the fallback never ran,
and the final answer never reached the transcript — observed live on the v3
candidate (Happier session `cmtspnf8l0f7xnpp84ylz6c51`: one assistant row
containing the commentary marker, the `task_complete` summary present in the
lifecycle, and zero assistant rows containing the summary marker).

A successful final summary is now published as its **own** durable assistant
row after the stream flush, so it never overwrites or truncates the commentary
segment. The rules are:

- Only for a turn that completed successfully — a cancelled, aborted,
  `timed_out`, `failed` or `limit_exceeded` turn never gains an answer row.
- Never when the `task_complete` tool result itself reported failure.
- Never when the summary text is already visible in the turn's prose.
- Exactly once per provider tool-call id. The row `localId` is derived
  deterministically from that call id, so a direct retry that replays the same
  call reuses the same row identity instead of appending a second copy, while a
  later turn carries a new call id and gets its own row.
- The pre-existing empty-response fallback is unchanged.

### Corrected defect: cancelling active work stranded the session

An authenticated `abort` issued while the provider was running a tool never
acknowledged (30 s session-RPC timeout), and the same session then refused every
later prompt (`pendingCount=1`, 90 s send timeout). The runtime process stayed
alive at several hundred percent CPU with logging and keep-alives frozen.

The cause was a **busy-spin livelock in the prompt loop**, not a blocked network
await, and it predates this fork's continuation work — the same code is present
at the fork base `0d99e212`:

1. `handleAbort()` aborts the shared `AbortController` and only replaces it in
   its `finally`, i.e. after cancellation has fully settled.
2. `waitForNextInput()` returns `null` immediately while that signal is aborted.
3. The loop used to `continue` straight back into the wait, producing an
   unbounded microtask loop — measured at over 20 000 iterations in 155 ms, and
   at more than 2^32 iterations in ~15 s before an array overflowed.
4. That starves the event loop, so no timer, socket read or log flush runs. The
   cancellation it is waiting for can therefore never finish, which keeps the
   signal aborted: the livelock is self-reinforcing, and the pending prompt is
   never consumed.

The loop now settles instead of spinning. On an empty input wait it always
yields a macrotask, and while an abort is in flight it awaits the abort's own
settlement promise (`waitForAbortSettled`) rather than polling a signal that
cannot change until that promise resolves. This is lifecycle-driven; it is not a
grace sleep, and no timeout was added to the abort RPC — a cancellation that
genuinely cannot settle still surfaces as a truthful RPC timeout rather than a
fabricated success.

`AcpBackend.cancel()` already had a bounded 5 s settlement fallback that closes
an unresponsive provider connection. That fallback left the backend rejecting
every later prompt with `rejected_before_effect / 'Session not started'`, with
no way for the runtime to notice. The backend now reports
`isProviderConnectionForceClosed()`, and the prompt loop routes a force-closed
session back through the existing reset-and-resume path before the next turn.

Truthful limits of that recovery:

- The flag is set **only** by the cancellation fallback. Disposal is not
  reported as a force-close, so a disposed or intentionally closed session stays
  closed and is never blindly reopened.
- Recovery starts a **new provider process**. Happier's transcript is preserved
  and remains the source of truth, and the previous provider session id is
  offered for resume, but provider-side context is only restored to the extent
  that provider supports resuming it. Nothing here guarantees that the provider
  retains its prior context.
- Cancellation acceptance is unchanged: the turn is still marked aborted before
  any recovery. See the next section for why the stale-generation guard alone is
  **not** sufficient for cancelled autonomous work.

### Corrected defect: cancelled autonomous work was republished as the next turn's success

An earlier revision of this document claimed that late output from a cancelled
generation was rejected by the stale-generation guard. That claim was wrong for
provider-autonomous work, and independent native execution disproved it: an
active continuation was aborted and closed `outcome=cancelled`, the user's next
prompt completed, and roughly 13 s later the cancelled work's tool result, prose
and `task_complete` opened a **new** continuation after the completed generation
and were published as success.

The guard cannot help here, because the arming decision is per generation: once
the next prompt completed, it legitimately armed *its own* generation, and the
late frames were indistinguishable from that generation's own autonomous output.

#### What the protocol actually provides

Captured from the real wire against Copilot 1.0.84 with a transparent ACP stdio
proxy:

- `session/update` params contain exactly `sessionId` and `update`. There is no
  request id, turn id or generation, and the provider emitted **no `_meta`** on
  any notification.
- Provider-autonomous output is emitted entirely *after* the `session/prompt`
  request has already resolved with `end_turn`, so it belongs to no request.
- `session/cancel` sent during autonomous work drew **no response of any kind**,
  and the provider continued for a further 30 s, emitting the pending tool
  result, anonymous prose, and a **brand-new** `task_complete` tool call id.

Two consequences follow, and both are load-bearing:

1. ACP cancellation is defined for a *prompt turn*. While a `session/prompt`
   request is in flight the agent settles that request, so cancellation is
   cooperative and attribution survives. Outside a request there is no
   cancellation guarantee at all.
2. Because the late frames carry a new tool id and anonymous prose, no tool-id
   tombstone can cover them, and no quiet interval can prove the old work is
   gone. Correlation at the protocol boundary is impossible.

#### The boundary that is actually enforceable

When cancellation would leave uncancellable provider work running, the provider
**connection** is retired: a `session/cancel` is still sent as a courtesy, the
connection is closed and the provider process tree is killed, and the backend is
marked force-closed so the prompt loop reopens the session on the next prompt
through the existing reset-and-resume path.

Every connection carries an epoch, and each connection's notification handler is
bound to the epoch that was current when it was created. Callbacks still in
flight on a retired connection are dropped, so output from cancelled work cannot
be attributed to a later generation even during the close window.

#### When retirement triggers, and why cancelling an autopilot turn is not cooperative

Retirement requires the provider-autonomous continuation capability, so ACP
providers that never arm continuations are unaffected. Within that scope it
triggers when either:

- a continuation is already open or armed, in any mode — the provider is running
  work that no request owns; or
- the session is in autopilot mode and a prompt request is in flight.

The second case is the one that is easy to get wrong. ACP cancellation settles
the *request*, but an autopilot session's **goal** outlives it. Live on native
v8, an autopilot turn was cancelled while its request was still in flight, so
nothing was retired: the provider settled the request, answered the user's next
prompt, and then opened a continuation after that completed generation — on the
same connection, with no resume at all — and re-ran the entire cancelled plan,
publishing it as that turn's success.

Ordinary mode was tested the same way and behaves differently, which is why the
trigger is scoped rather than applied to every cancellation: the cancelled tool
never produced a result, the next prompt was answered normally, and the provider
never revisited the abandoned task. Ordinary-mode cancellation therefore keeps
its connection and its provider context.

An idle cancellation — no turn in flight and no continuation — retires nothing.

#### Retiring the transport alone is not enough

Retiring the connection was necessary but not sufficient, and the live probe of
the fix proved it. The provider keeps the unfinished job inside its **own**
session state. When the recovery resumed the same provider session id
(`session/load`), the provider restored the cancelled instruction, answered the
user's new prompt, and then opened a fresh continuation that re-ran the entire
cancelled plan — new tool call ids, the tool genuinely re-executed, and the
result published under the new turn.

So a cancellation that retires the connection also **poisons the provider
session for resume**. The recovery still reopens immediately, keeping the
Happier session usable, but it opens a *fresh* provider session rather than
loading the abandoned one. Every other force-close, including the unresponsive
process fallback, keeps the existing reset-and-resume recovery.

Truthful limits:

- This guarantees that cancelled work cannot be **delivered, republished, or
  resurrected by resume**. It does not prove the provider stopped computing
  before its process was killed.
- Recovery reopens the provider session, so the reply latency of the prompt
  after such a cancellation includes a provider restart.
- Because the fresh session is not the old one, provider-side context from
  before the cancellation is dropped. The Happier transcript remains the source
  of truth, and as stated above provider-side context was never guaranteed.
- The poison is durable, not process-lived. See "Durable retirement" below.
- Owner-visible tradeoff: because an autopilot turn cancellation now retires the
  provider session, cancelling in an autopilot session discards provider-side
  context and makes the next prompt pay a provider restart. That is the cost of
  the cancellation actually holding. Ordinary-mode cancellation is unchanged.

### Corrected defect: a restated summary was published as a second answer

A provider may answer in prose, end its turn, and then autonomously continue
with a canonical `task_complete` whose summary **restates that same answer**.
Because each autonomous continuation is projected as its own runtime turn,
`beginTurn()` reset the per-turn accumulated response that both summary
publication branches consult to decide whether the user has already seen the
text. With that state cleared, the continuation's empty-response fallback
treated the restatement as new output and published it as a second durable
assistant row for one user prompt.

The visible-answer decision is therefore scoped to the **dispatch** rather than
the turn. A dispatch is one client prompt plus the provider-autonomous
continuations that follow it: `beginTurn()` clears the delivered-answer set only
when a client prompt opens a new dispatch, and a projected continuation inherits
the answers its dispatch already delivered. `flushTurn()` skips the summary
projection when the summary repeats one of them.

The rules are:

- **Cross-continuation idempotence.** A summary that repeats an answer already
  delivered in the same dispatch yields exactly one durable assistant row, no
  matter how many continuation turns separate the answer from the summary.
- **Exact matching only.** Comparison is exact on the trimmed answer body, not a
  substring scan, so a summary that merely mentions or quotes earlier text is
  still published as its own answer.
- **Separate user turns are preserved.** The set is per dispatch, so two
  consecutive user prompts that legitimately produce the *same* answer text each
  keep their own durable row.
- **Tool activity is untouched.** Suppressing the duplicated answer projection
  does not remove the `task_complete` tool call or its result from the
  transcript; only the redundant assistant answer row is withheld.
- The deterministic per-call-id row identity and the successful-completion,
  failed-result, and already-visible-prose rules above are unchanged; this adds
  the dispatch scope those rules were missing across continuations.

### Durable retirement (cancel → restart → prompt)

An in-memory flag only protects the running session process. The retired
provider session id is also projected into durable session metadata
(`metadata.copilotSessionId`, the manifest-declared `vendorResumeIdField`), and
the daemon reads that projection back when it respawns a stopped session,
spawning the CLI with `--resume <id>`.

That was confirmed live on native v9. Happier session
`cmtsxu3at0lulnpp8fncwziga` completed a turn, an autopilot continuation was
cancelled and the backend logged `retiring the provider connection`, the session
process was stopped, and the next prompt respawned it with `hasResume:true` and
`--resume` naming the **retired** provider session. Combined with the v7 result
above — that resuming such a session restores the cancelled goal and re-runs the
whole plan — cancel-then-restart-then-prompt could hand cancelled work back.

The retirement is therefore also durable:

- `createVendorResumeIdMetadataPublisher` gained `invalidateBound(id)`, a
  **compare-and-clear** that removes the resume field only when it still names
  the retired id, and drops any deferred binding for it. Compare-and-clear
  matters because the in-process recovery immediately opens a *fresh* provider
  session whose id must still be publishable.
- `AcpBackend.cancel()` hands the retired id to the runtime through
  `setProviderSessionRetirementHandler` and **awaits** it before emitting
  `stopped`. Announcing a completed cancellation while a resumable pointer to
  the cancelled work is still on disk would announce a state that does not
  exist.
- If the metadata write fails, the backend emits `status: error` explaining that
  the session could not be permanently disconnected, instead of a clean stop.
- No cold-start consumer changed. An absent resume field already resolves to an
  empty `effectiveResume`, so no `--resume` argument is produced. That path was
  observed live: a session whose resume id had never been published respawned
  with `hasResume:false` and did not resurrect its cancelled plan.
- Durable retirement additionally requires evidence that the provider is working
  on something the cancellation abandons: an **opened** continuation, or an
  unresolved request. Connection retirement and the in-memory poison keep the
  wider trigger that also covers a merely *armed* continuation.

  This split is not cosmetic. `session stop` cancels the backend even when the
  session is idle, and a completed autopilot turn leaves a continuation armed, so
  using the wide trigger for the durable half made every normally stopped Copilot
  session clear its own resume id and post a cancellation notice it had never
  earned. That was observed live on native v10 for both an autopilot and an
  ordinary session, and fixed in v11, where the same controls respawn with
  `--resume` again and receive no notice.
- Opaque provider identifiers are not written to logs or to the user-visible
  notice.

Because the fresh provider context is a real, user-affecting consequence, it is
now recorded **in the transcript** rather than only in the terminal buffer. The
runtime publishes a durable session event (`sendSessionEvent({ type: 'message' })`,
the same mechanism as other durable notices) stating that the agent could not be
stopped, that the session was disconnected from that work, and that the next
message starts a fresh agent context with earlier messages retained but not
remembered by the agent. It is not an assistant answer, it does not alter
history, and it never replays the cancelled instruction.

Truthful limits of the durable retirement:

- It guarantees the cancelled provider session is never resumed again. It still
  does not prove the provider process stopped computing.
- Ordinary-mode cancellation keeps its resume projection, because ordinary-mode
  work really does stop. This is covered by regression, not by live evidence on
  this machine: every live Copilot session here reports an autopilot session
  mode, including one created explicitly with `--mode default`, so the
  ordinary-mode branch is not reachable through the public CLI against this
  provider build. That is a limit of the available live environment, not a claim
  that the branch is inert.
- An explicit cancellation of a continuation that is armed but not yet opened
  **does** durably retire the provider session. Round 6 could not do this,
  because it inferred intent from observable provider activity and there is none
  at that instant. Round 7 removed the inference: see "Abort intent" below.
- The metadata write is **server-acknowledged**, not best effort. Round 6
  described it as best effort; that was too pessimistic and has been corrected.
  `ApiSessionClient.updateMetadata` takes the metadata lock, waits for the
  session socket to be online for an acknowledged write, and delegates to
  `updateSessionMetadataWithAck`, which only resolves on an explicit
  `result === 'success'` answer, retries a `version-mismatch` against a fresh
  server snapshot, and otherwise throws a typed `SessionStateUpdateError`. A
  failure therefore cannot be mistaken for a completed cancellation: it is
  surfaced as the error status above instead of a clean stop.

### Abort intent (why a cancellation happened)

Every abort path in a runner converges on one `handleAbort` helper in
`runStandardAcpProvider.ts`, which used to take no arguments. The reason for the
abort was therefore thrown away before any backend could act on it. That single
missing fact caused two opposite defects:

- v10 durably retired the provider session of every normally stopped Copilot
  session, because a stop looks exactly like a cancellation from inside the
  backend.
- v11 avoided that by inferring intent from observable provider activity, which
  then could not retire a continuation that was armed but not yet opened — there
  is nothing observably running at that instant, even though the user really did
  cancel.

Round 7 stops guessing. `RunnerAbortIntent` is `'explicit-cancel' | 'shutdown'`,
and each registration site states its own intent:

| Call site | Intent | Why |
|---|---|---|
| `rpcHandlerManager.registerHandler('abort', …)` | `explicit-cancel` | the user abandoned the work |
| permission decision `abort` (`onAbortRequested`) | `explicit-cancel` | the user declined and abandoned the turn |
| `cancelActiveTurn` (in-flight steer) | `explicit-cancel` | the user interrupted this turn to send another |
| `registerRunnerTerminationHandlers` `onTerminate` | `shutdown` | signal, kill-session or crash |
| terminal display `onExit` | `shutdown` | the UI closed; the work was not abandoned |

Three properties make this safe:

- **The intent is fixed at the registration site, never read from the request
  payload.** A remote caller cannot claim to be a shutdown to avoid retirement,
  or claim to be a cancellation to destroy someone's resume pointer.
- **The default is `shutdown`**, the reading that never discards a resume
  pointer. `AgentBackend.cancel`'s new parameter is optional, so every other
  provider and every unconverted caller keeps its previous behaviour.
- **De-duplication escalates instead of swallowing.** Aborts share one in-flight
  promise. A cancellation arriving behind an in-flight shutdown is *stronger*, so
  it runs a follow-up cancellation rather than returning the shutdown's promise.
  The reverse (a shutdown behind a cancellation) is weaker and is still
  de-duplicated.

`happier session stop` reaches the runner as **SIGTERM**, not as the `abort` RPC,
so it lands on `onTerminate` and is correctly a shutdown. This is what makes
"normal stop stays resumable" and "explicit cancel retires" both achievable at
the same time.


### Regression coverage

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

`createAcpRuntime.continuationOutcome.test.ts` drives the *real* `AcpBackend`
stall timer, terminal correlation, cancellation and disposal paths into the real
runtime projection, so the outcome contract is covered end to end rather than by
a synthetic handler event. `AcpBackend.cancelForceClose.test.ts` drives the real
`cancel()` settlement fallback against an unresponsive provider peer, and
`runPermissionModePromptLoop.cancellationLivelock.test.ts` fails if the prompt
loop starves the event loop while the abort signal is aborted. The same file
also drives a real backend force-close through the real runtime accessor that
the prompt loop reads, so the recovery seam cannot silently become dead code.

The live acceptance check must use a real Copilot-managed Happier session in
autopilot mode:

1. Send a prompt that forces two stages: visible commentary first, then a final
   `task_complete` summary carrying a unique marker.
2. Confirm the persisted transcript contains the stage-one commentary and
   exactly one assistant row containing the stage-two marker.
3. Repeat with a prompt whose continuation reasons for several seconds and then
   emits plain prose before `task_complete`, and confirm the prose persists.
   This is the scenario that a short stall budget breaks.
4. Send a new prompt while a continuation is still running and confirm the
   continuation output persists under its own turn and the new turn is answered.
5. Cancel during a continuation and confirm the session stops and reports
   truthfully. Then send another prompt in the **same** session, wait past the
   original tool delay, and reread the transcript: the cancelled work's markers
   must never appear, and the new prompt must still be answered with
   `pendingCount` back to zero.
6. Confirm no duplicate assistant rows and that `pendingCount` and
   `pendingBlockedCount` both return to zero. In autopilot mode the provider
   may legitimately restate a summary in a following continuation; those are
   distinct provider turns with distinct segment identities, not duplicate rows
   for one turn.
7. Confirm the session debug log records `Closed provider-autonomous
   continuation ... (task_complete, outcome=completed)` rather than
   `(inactivity, outcome=timed_out)`, and records no
   `Dropping prompt-turn session/update` lines. Enable `DEBUG=1` for this check.
8. Force the safety stop by lowering
   `HAPPIER_ACP_AUTONOMOUS_CONTINUATION_STALL_MS` and confirm the stalled turn
   is reported as **incomplete**: no `task_complete` row, an aborted turn
   marker, and the text the provider already produced still persisted. A
   `task_complete` row here is defect QF-AC-001 reappearing.
9. Run a continuation whose tool call takes longer than the stall budget and
   confirm it is not reported as stalled or completed while the tool runs.
10. Force budget exhaustion by setting
    `HAPPIER_ACP_MAX_AUTONOMOUS_CONTINUATIONS=1` and confirm the output produced
    past the budget still appears in the transcript and the turn is reported
    **incomplete** with `outcome=limit_exceeded` exactly once. A silently
    missing row here is defect QF-AC-002 reappearing.
11. Run a single ordinary turn whose provider narrates and then finishes with a
    canonical `task_complete`, and confirm the transcript holds both the
    commentary row and exactly one row containing the summary. A missing summary
    row here is defect PA-AC-003 reappearing.
12. Run the same portfolio in ordinary `#agent` mode. The continuation option is
    passed for every Copilot session, so ordinary-mode behavior must be observed
    live, not assumed inert from the opt-in flag.

Tuning overrides for diagnostics only:
`HAPPIER_ACP_MAX_AUTONOMOUS_CONTINUATIONS`,
`HAPPIER_ACP_AUTONOMOUS_CONTINUATION_STALL_MS`.

Comparing the native provider event log, the ACP wire trace, and the persisted
transcript is required. A successful `session create` or an idle `send --wait`
is not acceptance evidence on its own.

### Known limits

- Coherent busy/completion reporting is enforced for the outcomes enumerated in
  the end contract. It is not a general guarantee that Happier can never report
  a finished turn while a provider is still working: ACP v1 gives no
  continuation lifecycle to observe, so a provider that stops emitting entirely
  and resumes much later still ends its segment on the safety stop. That case is
  now reported as incomplete rather than complete, and late output opens a new
  segment.
- Once `maxPerTurn` continuation segments have been used for one client turn,
  Happier accepts exactly one more terminal limit segment: that batch's output is
  persisted and the turn is reported incomplete with `limit_exceeded`. Provider
  output arriving *after* that terminal segment is dropped without a transcript
  row. This is a deliberate bound on unbounded autonomous work, and it is
  visible to the user as an incomplete turn rather than as a silent success.
- The default `maxPerTurn` of 8 is a judgement call; Copilot's own observed
  proxy limit was `--max-autopilot-continues=2`.
- The reproduction proves the isolated continuation-loss defect only. It does
  not establish that every historically reported missing-prose or fast-turn
  symptom shares this cause.
- Cancellation recovery reopens a force-closed provider connection; it does not
  guarantee that the provider restores its prior context. Only cancellations
  that hit the bounded settlement fallback trigger a reopen, and a cancellation
  that cannot settle at all still surfaces as a truthful RPC timeout.

### Compatibility and rollback

The change is additive and provider-gated. To disable it without reverting
code, remove `providerAutonomousContinuation` from
`buildCopilotAcpBackendOptions`; the backend then restores the previous
drop-after-`end_turn` behavior exactly. To roll back the deployed payload,
repoint `~/.happier/cli/current` at the previous version directory and restart
the daemon as described in [Deployment record](#deployment-record).

## Opaque citation display

Copilot ACP currently supplies citation identifiers such as
`turn0view0` without a source URL or annotation map. Happier therefore cannot
reconstruct a truthful clickable destination.

The Desktop display layer converts markers such as:

```text
citeturn0view0turn0view2
```

to stable, parser-safe references:

```text
〔1, 2〕
```

This is intentionally a readable fallback, not a fabricated hyperlink.

The original transcript text remains unchanged in storage and copy paths.
Normalization applies only when rendering assistant messages, user messages,
streaming output, thinking summaries, inline thinking, and tool-card content.
Incomplete trailing markers are hidden while streaming.

### Main implementation

- `apps/ui/sources/components/markdown/normalizeOpaqueCitationMarkers.ts`
- `apps/ui/sources/components/markdown/MarkdownView.tsx`
- `apps/ui/sources/components/markdown/rendering/MarkdownViewRenderer.tsx`
- `apps/ui/sources/components/sessions/transcript/MessageView.tsx`

### Regression coverage

```bash
cd apps/ui
yarn vitest run \
  sources/components/markdown/MarkdownView.enrichedRenderer.test.tsx \
  sources/components/sessions/transcript/MessageView.streamingMarkdownRender.native.test.tsx \
  sources/components/markdown/enriched/agentTexMathDelimiters.md4c.test.ts
yarn typecheck
```

The tests must continue to prove that literal opaque markers are absent from
rendered text, ordinary Markdown links still use the normal link renderer, and
the `〔...〕` fallback cannot be reinterpreted as Markdown link or TeX syntax.

## Building the customized CLI payload

Build a complete native payload rather than copying only `package-dist`:

```bash
cd /path/to/happier
node --input-type=module - <<'NODE'
import { buildCliBinaryArtifactPayload } from './packages/cli-common/dist/componentArtifacts/index.js';

await buildCliBinaryArtifactPayload({
  repoRoot: process.cwd(),
  payloadDir: '/absolute/path/to/output',
  releaseVersion: '0.2.11-cuihui-task-complete-v3',
});
NODE
```

The output must contain both the native `happier` executable and
`package-dist/`.

Install each payload under a new versioned directory, update
`~/.happier/cli/current`, and restart:

```bash
launchctl kickstart -k "gui/$(id -u)/com.happier.cli.daemon.default"
```

Do not overwrite the previous version directory; it is the CLI rollback path.

## Building the customized Desktop

```bash
PATH="$HOME/.cargo/bin:$PATH" \
  yarn --cwd apps/ui tauri:build:production
```

The production bundle executable is `Contents/MacOS/app`.

## Deployment record

Deployment completed September 8, 2026:

| Target | Installed version or artifact | SHA-256 |
| --- | --- | --- |
| MacBook CLI | `~/.happier/cli/versions/0.2.11-cuihui-task-complete-v3` | `a7d473a2916b14a3deb4023c9c7e0984eecb2282acd952f3331e0a4d861823b7` |
| Mac mini CLI | `~/.happier/cli/versions/0.2.11-cuihui-task-complete-v3` | `a7d473a2916b14a3deb4023c9c7e0984eecb2282acd952f3331e0a4d861823b7` |
| MacBook Desktop | `/Users/cuihui/Applications/Happier.app/Contents/MacOS/app` | `4d54a8982cad5c8920448ca54f95248d402a0f6fc9fdc14ce6e88cf5ffe18de9` |

Desktop rollback bundle:

```text
/Users/cuihui/Applications/Happier-pre-final-citation-20260908T1335.app
```

### Autopilot continuation fix — test deployment

The continuation-ownership work is validated on the Quinann test machine only.
The candidate is installed as that machine's default CLI; no other host was
changed.

| Item | Value |
| --- | --- |
| Version label | `0.2.11-cuihui-autopilot-continuation-366ac45a-v12` |
| Product build source | `42d8dd3c9aa33ee176abce19820abdd855356ac2` |
| Copilot build exercised | `1.0.84-3` |
| Native `happier` SHA-256 | `1f9bea06e687135a36c88e3d3aa9341336afa0cf2d6747471a61aef76e82b9dc` |
| Tarball SHA-256 | `cf8b3575598eee8fb906e4e929d998a4f0bec331ad40698626599b1845fb7966` |
| Installed/current target | `/Users/clawbot/.happier/cli/versions/0.2.11-cuihui-autopilot-continuation-366ac45a-v12` |

`…-v10` carried the durable retirement but retired far too widely, clearing the
resume id of every normally stopped Copilot session. It remains retained but is
not an acceptable rollback target.

Install and activate:

```bash
ln -sfn /Users/clawbot/.happier/cli/versions/0.2.11-cuihui-autopilot-continuation-366ac45a-v12 \
  /Users/clawbot/.happier/cli/current
launchctl kickstart -k gui/$(id -u)/com.happier.cli.daemon.default
happier daemon status   # must report the expected CLI Version
```

Roll back by pointing `current` at any retained version and kickstarting the
same service. Retained rollback targets, newest first:
`…-v11`, `…-v9`, `…-v8`, `…-v7`, `…-v6`, `…-v5`, `…-v4`, `…-v3`, and the
original `0.2.11-cuihui-task-complete-v3`. Current `…-v12` is not a rollback
target. Rolling back to v11 restores its older limitation: an explicitly
cancelled continuation that is armed but not yet opened cannot be durably
retired.

Compatibility: the change is confined to the ACP backend, its runtime, the
prompt loop and the vendor resume id publisher. Autonomous continuation remains
provider-gated, and cancellation intent defaults to shutdown for unconverted
callers and providers. An explicit Copilot cancellation durably removes one
metadata field (`copilotSessionId`) through a server-acknowledged write; failure
is reported as an error rather than a clean stop. No stored transcript or
session record is removed, no provider other than Copilot is affected, and
rolling back needs no data migration: an already-cleared field simply means the
next turn opens a fresh provider session.
## Hosted UI rollout: September 8, 2026

The hosted web bundle carrying the Desktop tracking-ID fix was activated at
`2026-09-08T10:31:19Z` (`17:31:19+07:00`). This is a scoped hosted deployment
record, not a completed release or end-to-end acceptance claim. Independent
final assessment, authenticated session creation, and user manual phone
acceptance remain pending. The CLI/Desktop deployment record above is historical
and unchanged; this rollout did not install a new CLI or native app.

### Behavior and exact deployed candidate

Source `ac0fe7965f946a0e38c2075f8eb7fe1a3cfedc7f` preserves caller-owned
`spawnNonce` in the legacy UI spawn payload used with custom daemon versions.
The running CLI remains `0.2.11-cuihui-task-complete-v3`. The hosted candidate
combines that core export with additive old hashed assets and compression
sidecars for cached clients, a `manifest.json` alias, and an entry-document
overlay linking `/manifest.json`.

Historical rollout workspace (now absent): `/tmp/happier-cli-macmini-test/hosted-ui-rollout-20260908`
(equivalent to `/private/tmp/happier-cli-macmini-test/hosted-ui-rollout-20260908`).
Evidence paths below are historical references relative to this workspace,
not available repository files; see the September 9 recovery status above.

| Identity | Value |
| --- | --- |
| Staged hosted tree | `deployment-candidate-v2/ui-web` (2,788 files) |
| Tree manifest | `evidence/deployment-candidate-v2-sha256-manifest.txt` |
| Tree manifest SHA-256 | `7063577d651b91534e898fe7714a5a0e153865b85028c4660624ed7c07b69a30` |
| `index.html` SHA-256 | `c128766916c5f6ab6a85318addb8aa684900777365e38bd7f8015dca61a31620` |
| Entry bundle | `/_expo/static/js/web/index-e7f5ed7f91a21506b4dd927741a78c8e.js` |
| Entry bundle SHA-256 | `092a5771f7cf3f92adc358c9182658da2204ff45e9e94fa8bca128f17bc3b6d6` |
| Served manifest | `/manifest.json`, JSON, 468 bytes |
| Manifest body SHA-256 | `1313ac427c1765ce02c04a19fc13be82157f20d437c4c2de352ce6639165a8a9` |

### Activation, refresh, and recovery

The user owns this scoped operation, with execution by PSWE under PA
coordination. PSWE activation evidence records an atomic directory exchange at
`/Users/cuihuiai/.happier/self-host/ui-web/current`, without a restart; daemon
PID `75201` and server PID `70892` were unchanged across activation.
The sibling snapshots `current.pre-spawnnonce-20260908-170903` (original
pre-fix baseline) and `current.pre-manifestfix-20260908-173119` (intermediate
v1 deployment) were retained.

The root response is `no-cache`; new hashed assets are served as immutable.
Reload the browser, or close and reopen the hosted home-screen client, to fetch
the new entry document. Do not clear storage or sign out for this update.
The phone is assumed to use this hosted UI; native iOS artifact identity is
unknown and no claim is made that the phone runs the latest native build.

Both manifest files remain on disk, but `/manifest.webmanifest` returns the
server's HTML fallback, not JSON. The v2 entry uses the original server-supported
`/manifest.json` route; no server configuration change was needed. Preserve this
entry-link overlay on future stock exports while the server limitation remains.

Historical v2 compatibility recovery command, not currently usable from the
absent workspace and not applicable to R3. At the time it required `current`
to match the exact v2 candidate and all preconditions to hold:

```bash
cd /tmp/happier-cli-macmini-test/hosted-ui-rollout-20260908
PYTHONDONTWRITEBYTECODE=1 bash rollout/rollback-v2.sh --apply
```

This restores the **pre-fix entry document** with both asset generations; it
does not maintain the nonce fix. It neither blindly replaces `current` with
the original baseline nor restarts the CLI. Stop on any nonzero exit or staging
residue for PA-coordinated state classification, rather than retrying blindly.
After compatibility rollback, `current.failed-*` contains the retained v2 tree
despite the tool's "Previous (v1) tree" label; rely on content identity.
Recovery was not executed during activation.

### Evidence and acceptance boundary

`qa-preactivation/report.txt` and `qa-v2/report.txt` record independent passes
for their exact staged preactivation scopes only, not final live-session
acceptance. `evidence/V2-ACTIVATION-EVIDENCE.md` is PSWE author evidence:
it records matching live tree bytes, the served bundle and JSON manifest, and
a credential-free real browser loading that bundle, mounting the SPA, and
reporting no console errors. These observations establish browser boot, not
authenticated spawning or end-to-end `spawnNonce` propagation.

At the v2 checkpoint, no authenticated browser session creation was observed because no
authenticated automation session was available. User manual phone acceptance
was then pending. Independent final product assessment and independent review
of that documentation candidate were then pending; neither author evidence nor
the earlier scoped passes establish overall rollout completion.
The September 9 user-reported outcome is recorded separately above.

## Hosted completion-card rendering: R3

The static hosted completion-card repair was activated during
`2026-09-08T12:39:13Z` through `2026-09-08T12:39:16Z`. It displays an existing
stored completion summary **inside the tool card**, not as a separate final
assistant message. This record is limited to that activation and rendering
contract; it is not a whole-system completion or actual-user acceptance claim.
The earlier persistence, citation, CLI/Desktop, and v2 rollout records above
remain historical records, not changes delivered by R3.

### Rendering contract and limits

The canonical `task_complete` tool has a dedicated renderer using the existing
safe Markdown path. Summary and full-detail modes show the full multiline
summary; compact/title-only mode remains title-only. A nonblank input summary
wins, with a usable result summary as fallback. Missing, blank, or malformed
content with no usable fallback produces no invented summary. Rendering never
modifies stored rows.

Historical compatibility correction is deliberately narrow: it requires a
nonblank input summary, exact completion metadata, and a known erroneous
`change_title` or generic identity. Any **own** `input.title` property prevents
that historical correction, even when blank, whitespace-only, null, undefined,
or malformed. An inherited property is not an own property. Explicit unrelated
canonical tools, such as `Bash`, remain unchanged. Actual canonical
`task_complete` is directly supported, including when an own title is present.
Result-summary fallback does not by itself qualify a historical row for
reclassification.

This does not promise repair of every mislabeled row or recreation of missing
stored text. It does not change CLI/native/provider persistence, restart
sessions, fix a separate final assistant bubble, or repair citations. Additive
canonical tool-name/schema entries belong to the UI/shared-protocol source
candidate; they are not a deployed CLI update.

### Exact source and hosted artifact

Paths in this section are historical references to the now-absent rollout
workspace stated above, not assertions of current artifact availability.
The source identity is a base commit plus an uncommitted patch, not a new
release commit.

| Identity | Value |
| --- | --- |
| Source base | `ac0fe7965f946a0e38c2075f8eb7fe1a3cfedc7f` |
| Source patch | `completion-card-repair/r3/candidate/source.patch` |
| Patch SHA-256 | `6a9fe25a0ceb84e81e48110f206b9c8feaf381170a9fda7a413756c3c044f136` |
| Exact 24-path inventory | `completion-card-repair/r3/candidate/changed-files.txt` |
| Inventory SHA-256 | `8ae10b5c4d2e83a3bd4d1aa8a1c63638f9ae6436320e58b68f9c0f37ae668724` |
| Static tree | `completion-card-repair/r3/candidate/ui-web` (3,692 files) |
| Tree manifest | `completion-card-repair/r3/evidence/candidate-r3-sha256-manifest.txt` |
| Tree manifest SHA-256 | `c88ca2e50304feb5fc4ea6ee774cf14ea1c2adddca918fc102ef3d7a7764aec4` |
| Static `index.html` SHA-256 | `d2a8f49753b39e0aee24d45c4eaa2613cc14c4f4fb159823bc28941e447deeb5` |
| Entry bundle | `/_expo/static/js/web/index-d661ba408f5130ccbec9007e5f8018cd.js` |
| Entry bundle SHA-256 | `9eb6c2607f21a09b5fb74c161d0f4abcd9fdb3aa2a985db49562bf83394b54cb` |

Implementation and artifact detail reside in
`completion-card-repair/r3/evidence/COMPLETION-CARD-REPAIR-R3-EVIDENCE.md`
and `completion-card-repair/r3/evidence/r3-artifact-hashes.txt`.
That implementation packet describes the prepared, preactivation phase;
its "nothing was activated" statement is historical, not the activation state
recorded here.

### Activation, refresh, and R3-only recovery

PSWE's `completion-card-repair/r3/evidence/ACTIVATION-EVIDENCE.md` records the
reviewed atomic exchange and the full live `current` tree matching the exact
R3 manifest at `/Users/cuihuiai/.happier/self-host/ui-web/current`.
Daemon PID `75201` and server PID `70892` retained their start times; neither
was restarted. The new retained snapshot
`current.pre-completioncard-20260908-193914` contains the v2 tree.
The prior `current.pre-spawnnonce-20260908-170903` and
`current.pre-manifestfix-20260908-173119` backups were also retained.

The no-cache public entry references the R3 content hashes and the
server-supported `/manifest.json` route. All previously published hashed
assets remain available, and compressed sidecars are coherent with their
raw assets. The public HTML includes the pre-existing server-appended welcome
comment and blank line; it is not byte-identical to static `index.html`.
The manifest body remains
`1313ac427c1765ce02c04a19fc13be82157f20d437c4c2de352ce6639165a8a9`.

Refresh the website, or close and reopen the hosted home-screen app. Do not
sign out or clear storage. The phone's use of this hosted/PWA client remains
an assumption; native artifact identity is unknown.

Historical scoped compatibility recovery, not currently usable from the absent
workspace. Execution would additionally require recovered and verified
artifacts, rebound paths, separate authorization and exact-current R3 preconditions:

```bash
cd /tmp/happier-cli-macmini-test/hosted-ui-rollout-20260908/completion-card-repair/r3/rollout
PYTHONDONTWRITEBYTECODE=1 bash rollback-r3.sh --apply
```

This restores the v2 entry while retaining both v2 and R3 assets and every
earlier published generation. It **loses this completion-card rendering repair
but retains the earlier nonce fix**. The rollback image manifest is
`0ed4890974eec16c9d0791c93351e5b78ce80d7c3405fb5f620c310688ad4e02`;
the restored entry hash is
`c128766916c5f6ab6a85318addb8aa684900777365e38bd7f8015dca61a31620`.
Do not use the inherited `rollout_v2.py` hint, the historical v2 rollback
command above, an original exact-baseline restore, or CLI restart guidance
for this R3 recovery. Stop on a failed precondition, nonzero exit, or staging
residue and route state classification through PA; do not retry blindly.
Rollback was not executed as part of the recorded activation.

### Evidence attribution and remaining acceptance

The independent Product Quality Engineer's
`completion-card-repair/r3/qa-preactivation/report.txt` records
`quality_gate_pass` only for the exact staged preactivation scope.
That separately authored disposition is not a final live product assessment
or a documentation gate.

PSWE's public-browser activation evidence exercised the actually deployed
`ToolView` with synthetic fixtures: the three runs reported 25, 51, and 162
passing checks, with no page errors. Counts overlap and are not 238 distinct
product scenarios. These are author observations, not independent approval
or a reproduction of the user's exact card.

Separately, the Independent Product Quality Engineer's live report
`completion-card-repair/r3/qa-live/report.txt`, SHA-256
`723f12f550520bde97dbcc3f701982aeaff0d8f2e15e290e4cc4be4f1676eff0`,
returns `quality_gate_pass` for the **exact deployed conditional completion-card
UI contract** bound to the R3 source and runtime identities above. Its independent
public-browser runs exercised the actual deployed `ToolView` with synthetic
payloads: 25, 51, and 162 overlapping checks passed, with no page errors.
The report separately establishes live identity, compression, JSON manifest,
published-asset retention, backup and process continuity within its stated
scope. This is distinct from the staged preactivation disposition and PSWE
author evidence. It is not an actual-user-card, phone, authenticated new-session,
whole-platform, or documentation pass.

The exact user card/event remains unknown; manual card review was explicitly
deferred by the user on September 9 at `08:43+07:00`, not verified or failed.
Original-phone New Session was separately reported as seeming to work at
`08:38+07:00`; no wire-level conclusion follows from that report or the scoped
live product result. PA retains coordination of the remaining evidence limits
without treating deferred card review as a failure. This local documentation
candidate also requires separate independent review; its predecessor was
staged and independently reviewed, not published. No overall completion,
publication, native-build currency, or final acceptance is implied.

## Daemon-spawn compatibility experiment

Record ID: `DSC-EXP-01`. Status: experimentally deployed on September 8, 2026,
`16:45:30Z` through `16:47:32Z`; the daemon restarted at `16:46:52Z`.
The user authorized experimental deployment after preparation; PA authorized
the exact R5 candidate only after the Independent Product Quality Engineer's
`quality_gate_pass` for preactivation readiness. Readiness was not deployment
permission or phone acceptance. PSWE's activation evidence records the running
version `0.2.11-cuihui-spawn-compat-r1` and preserved existing processes.
No new session was created during activation. The September 9 user-reported
phone outcome is recorded above; it is not independently verified wire-level
acceptance. Fresh independent documentation review is required; exact
legacy-phone wire correlation and modern-client live acceptance remain unverified.

### Intent, scope, and evidence boundary

A reported legacy request at `2026-09-08T20:13:11+07:00` omitted `spawnNonce`,
created a real session, and was followed by fruitless polling of a nonce the
old client had not sent. The experiment aims to return that exact accepted
spawn's direct `sessionId` to a client that already accepts direct success,
without requiring it to know the daemon-generated nonce.

This original event is an approved assignment-supplied operational fact.
The activation facts below are attributed to the exact operator evidence,
not a runtime investigation or deployment performed by this author.
The phone's native-versus-hosted identity and cache attribution are unproven.
The hosted R3 completion-card UI remains active and is outside this change.
Its independently reviewed live conditional rendering contract above is not
evidence that the original phone new-session failure was fixed. That failure
continued at the September 8 checkpoint; the September 9 user now reports
New Session seems to work, without establishing the exact request/result path.

The documentation impact is material: the machine RPC response timing/shape
for nonce-omitting callers, mixed-client failure limits, and the deployed
installation/recovery boundary need an explicit record. The affected families
are this experiment/rollout/acceptance record,
[CLI architecture](cli-architecture.md#accepted-spawn-identity-local-compatibility-experiment),
and [compatibility](compatibility.md#daemon-spawn-compatibility-experiment).
Relay `docs/protocol.md`, hosted assets, native phone artifacts, credentials,
and all runtime/source files are unchanged by this documentation assignment.
No support window, startup SLO, or caller-key idempotency commitment is added.

### Source, deployed payload, and operator identity

Historical experiment workspace (now absent):
`/tmp/happier-cli-macmini-test/daemon-spawn-compat-20260908.jVMKQt`
(equivalent to `/private/tmp/happier-cli-macmini-test/daemon-spawn-compat-20260908.jVMKQt`).
The source was in `repo/` and the original documentation in
`documentation/docs/`. Neither is currently available at those old paths.
The source has now been recovered and integrated at the durable repository
binding above; these old locators remain absent. The historical branch below
identifies the original daemon candidate, not the combined integration branch.

| Identity | Value |
| --- | --- |
| Runtime base | `0d99e21273200b3a43d9508d6878234895f0240a` |
| Branch | `exp/daemon-spawn-compat-r1` |
| Running experimental CLI version | `0.2.11-cuihui-spawn-compat-r1` |
| Source patch SHA-256 | `07d3fb50e68030e7a6cd48bf3552297771fb1d8954c978bd3f81ed8dc9806e6e` |
| Inspected changed handler | `apps/cli/src/api/machine/rpcHandlers.ts` |
| Handler SHA-256 | `e945ed4523b0e3fcb36a96b307b05a017aac3c271cf2fefb5425f73723063241` |
| Inspected changed author test | `apps/cli/src/api/machine/rpcHandlers.test.ts` |
| Test SHA-256 | `f1e66c24f825952bbd419d783dfd1c646067ddbb3768cfe6d46692a38799748b` |
| Native executable SHA-256 | `fcaab27ce06cb848cd782987edaec8c3782255dcda94f499ceec3df2f945cf30` |
| Full payload manifest, `evidence/payload-manifest.tsv`, SHA-256 | `51366c8835df336c10bf25f2c40a737c6b3be68f1cf74750c2afad16afb6e6d9` |
| Release archive SHA-256 | `b63b8de7b871c6623e5c10e3ad9d18f6918ec5a3b25d260342592b229d24e6bd` |
| R5 helper, `deploy/happier-compat-switch.sh`, SHA-256 | `099bcc75305573fb69f7ffbc902a67f2249005e9f506edc79c8160eacbc496e9` |
| R5 operations, `deploy/compat_ops.py`, SHA-256 | `7b01cb260ee99944ada385f5c0f4c3d71f06ca740f4d237ad30b433a28201702` |

The historical frozen payload root was
`candidate/happier-v0.2.11-cuihui-spawn-compat-r1-darwin-arm64`.
The archive was recorded at
`repo/dist/release-assets/cli/happier-v0.2.11-cuihui-spawn-compat-r1-darwin-arm64.tar.gz`;
the earlier missing-archive claim was disproven at that checkpoint, when no
artifact loss or restoration had occurred. This is not evidence of availability
after the old workspace disappeared. Paths in this section are historical
references relative to that workspace; payload/archive recovery is not
established by restoring these documents.

The custom/parser-unfriendly version is deliberate: a parser-friendly label
could change the old client's payload selection and mask the behavior being
tested. This is a daemon-side compatibility experiment, not another client
payload upgrade.

For the provider-safe RPC, a valid caller nonce (a nonblank string) preserves
the modern response, including accepted-but-pending success. An absent,
non-string, empty, or whitespace-only nonce selects the shared
`settleAcceptedSpawnIdentity` adapter also used by the legacy RPC. An already
direct ID or non-success result passes through. Pending acceptance is resolved
through `awaitSpawnedSessionId` using only the nonce on that acceptance result;
successful settlement returns the actual `sessionId` and preserves a boolean
`pendingFirstInputAccepted`. There is no newest-session/directory guess or
second spawn by the adapter.

The existing 90-second settlement default can still return
`SESSION_WEBHOOK_TIMEOUT`. On that response the inspected old client still
polls its own unknown nonce. A real created session therefore does not by itself
establish client acceptance. Existing semantic coalescing and retry limitations
remain: two identical legacy requests are not guaranteed to create different
sessions, and nonce-less calls do not gain caller-key idempotency.

### Actual daemon-only activation and preserved state

`activation/ACTIVATION-REPORT.txt`, its sanitized step files `01-preflight.txt`
through `05-verify-new.txt`, and the exact
`deploy/receipts/receipt-20260908T164636Z.txt` record all five steps exiting 0.
The receipt SHA-256 is
`beb8937d310d99baeb5c0141c83d4f143e172460348b5b15d6a3dbf6b4adbd57`.
Operator `VERIFY=PASS` is execution evidence, not an independent gate.

The full 57,376-entry source and staged payloads were exhaustively checked
against the pinned manifest. The candidate was copied, not consumed, into a
new version directory. Under the switch lock the staged tree was rechecked;
`current` and then `current.version` were replaced by temporary-file renames,
with receipted phases completing at `16:46:43Z`. These are two guarded atomic
renames, not a claim that pointer and marker change as one atomic transaction.
Post-restart verification checked the full active payload again.

| State | Before activation | After activation |
| --- | --- | --- |
| `~/.happier/cli/current` | `versions/0.2.11-cuihui-task-complete-v3` | `versions/0.2.11-cuihui-spawn-compat-r1` |
| `current.version` | `0.2.11-local-final3` plus newline | `0.2.11-cuihui-spawn-compat-r1` plus newline |
| Daemon PID | `75201` | `83830`, advertising the exact experimental version |
| Version inventory | Eight old directories | All eight retained plus the new ninth |
| `previous` | `versions/0.2.11-local-final2` | Unchanged |
| `previous-before-task-complete-fix` | `versions/0.2.11-local-final3` | Unchanged |

This table describes the earlier `0.2.11-cuihui-spawn-compat-r1` activation
only. The `previous` row is historical: `previous` was later repaired to point
at `versions/0.2.11-cuihui-spawn-compat-r1` and is no longer
`0.2.11-local-final2`. See "Product-initiated rollback bookkeeping (corrected
after the rollout)" below for the current state.

The supported owning command was `happier service restart`, not
`happier daemon service restart`; the helper previewed the service plan and
then used `/Users/cuihuiai/.happier/bin/happier service restart`. It did not
invoke `launchctl` directly or restart session runners. All 14 protected
PID/start identities survived: eight runners, five children, and relay
`70892`. Main runner `81619`, Copilot child `82196`, and server `70892` were
unchanged. The eight runner PPID changes from `75201` to `1` were expected,
diagnostic-only reparenting, not lost sessions. The machine and relay route
remained the same.

The old v3 payload remains available with native SHA-256
`a7d473a2916b14a3deb4023c9c7e0984eecb2282acd952f3331e0a4d861823b7`;
existing runners can still execute from it. Hosted R3 `index.html` remains
`d2a8f49753b39e0aee24d45c4eaa2613cc14c4f4fb159823bc28941e447deeb5`.
There was no pruning, frozen-candidate consumption, session creation, phone
cache clearing, native-app replacement, relay restart, or UI change.

### Prepared recovery, not live-tested rollback

No activation step failed; diagnosis and rollback were not invoked.
The historical R5 procedure has independent fixture recovery evidence, not an observed
production rollback. The command below is historical and not currently usable
from the absent workspace. Script, payload, manifest and receipt recovery,
hash verification and path rebinding remain prerequisites, not actions
authorized by this closure update. Non-exact daemon helper reconstructions were
discarded; the original receipt and a current executable recovery procedure
have not been re-established. A later authorized recovery must retain both
independent pins and use this exact receipt; never select a guessed retry receipt:

```bash
ROOT=/private/tmp/happier-cli-macmini-test/daemon-spawn-compat-20260908.jVMKQt
cd "$ROOT/deploy"
export HAPPIER_COMPAT_CANDIDATE_ROOT="$ROOT/candidate/happier-v0.2.11-cuihui-spawn-compat-r1-darwin-arm64"
export HAPPIER_COMPAT_EXPECT_OLD_MARKER_B64=MC4yLjExLWxvY2FsLWZpbmFsMwo=
RECEIPT="$ROOT/deploy/receipts/receipt-20260908T164636Z.txt"
./happier-compat-switch.sh diagnose "$RECEIPT"
```

Keep both pins in every recovery invocation and confirm the exact R5 identities
above. Diagnosis, not an unconditional command sequence, determines the route:

| Diagnosis | Permitted route under the approved procedure |
| --- | --- |
| `known_complete` or `known_recoverable_partial` | Run `./happier-compat-switch.sh rollback "$RECEIPT"`. Only if it exits 0, run `./happier-compat-switch.sh restart`, then, only after successful restart, `./happier-compat-switch.sh verify --expect old "$RECEIPT"`. |
| `known_unmutated` | No rollback and no restart. |
| `known_rolled_back` | Restart through the helper, then verify old only after successful restart. |
| `INVALID_RECEIPT_BINDING`, `UNKNOWN_OR_CONCURRENT`, or `known_partial_rollback_needs_coordination` | Stop and escalate through PA; no rollback retry or restart. |

A refused or failed rollback never permits restart. Missing receipt, failed
restart, unknown state, or nonzero verification requires coordination rather
than blind continuation. Recovery restores the exact old v3 pointer and the
different original marker bytes `0.2.11-local-final3\n`, retaining the compat
payload. Generic installers, pruning, direct service-manager commands,
whole-stack restart, credential changes, and session cleanup are not this
procedure and are not authorized by this record.

### Independent evidence and bounded history

Independent preactivation R1-R4 helper gates failed and their evidence was
historically recorded in `quality-preactivation*/REPORT.txt`; those files are
not recovered here. Repairs culminated in the
Independent Product Quality Engineer's R5 `quality_gate_pass`, closed at
`2026-09-08T16:40:51.604345Z` in `quality-preactivation-r5/REPORT.txt`.
That historical readiness result binds the source, payload and R5 helper above.
It includes 96 required-binding refusals, applicable recovery regressions, and
12/12 isolated compiled-branch tests with synthetic dependencies. The
reviewer-qualified synthetic child-reparenting `test_06` failure remains
visible; it is not a claim of failure in the observed runner reparenting.
R5 did not test live phone behavior or replace the later deployment review.

The Independent Product Quality Engineer subsequently returned
`quality_gate_pass` for **EXPERIMENTAL DEPLOYMENT AND PRESERVATION ONLY** in
`quality-live/REPORT.txt`, evidence closure `2026-09-08T16:54:41.545070Z`,
SHA-256 `9268e1a8edc4c484f390fe305c329310c37feb91bc07cd13db843dc57a9ad03b`.
This report became available after the preserved R2 author checkpoint at
`2026-09-08T16:54:07Z`; the earlier unavailability was not a failed gate.
The independent review matched the full installed 57,376-entry tree to the
approved manifest with zero missing, extra, or differing entries, and observed
persistent daemon `83830` on the same registered machine and relay route.
All 14 protected PID/start/executable identities, eight prior version
directories, prior pointers, old v3 native binary and hosted R3 entry point
were preserved. Persistence means launch-at-load and restart-on-failure
configuration with current stable operation, not an exercised reboot or
future restart. Old-directory preservation is not a full old-tree byte check.
This scoped pass is not nonce-less or nonce-bearing live RPC/client acceptance,
phone success, live rollback, whole-issue completion, or documentation approval.
R5 source/compiled synthetic evidence remains preactivation evidence.
A fresh independent documentation gate is required for these exact updated
three-document bytes.

### Acceptance record and evidence still required

| ID | Bounded requirement | Current evidence and remaining work |
| --- | --- | --- |
| `DSC-A01` | A nonce-less provider-safe request receives the exact accepted session's direct ID, without heuristic lookup or an adapter-triggered second spawn. | R5 independent compiled-branch coverage passes with synthetic dependencies. User reports original-phone New Session seems to work on September 9 at `08:38+07:00`; exact wire request/result correlation remains unverified. Direct ID is conditional on successful settlement. |
| `DSC-A02` | Preserve valid-nonce modern behavior, shared legacy settlement, and boolean `pendingFirstInputAccepted`; handle absent/invalid/blank nonce and settlement failure explicitly. | R5 independent compiled-branch and regression evidence covers these branches. Live first-input/error and modern nonce-bearing client outcomes remain pending. |
| `DSC-A03` | Bind the full native payload and final guarded rollout/rollback to immutable identities, retain old pointer/marker and versions, and restart only daemon without disturbing runners/server/R3 UI. | Exact identities and historical R5 readiness are bound above; the independent live `quality_gate_pass` verified the installed full tree, persistent daemon and protected-process/version/pointer/old-v3-binary/hosted-R3 preservation within its deployment-only scope. Real rollback was not exercised; current recovery-artifact availability/rebinding remains unverified. |
| `DSC-A04` | Evaluate the experiment with at most two later controlled test sessions, plus user phone acceptance coordinated by PA. | Deployment created no new sessions. User now reports original-phone New Session seems to work; no additional test was performed for this closure update. Exact request/result identity and first-input custody remain unverified; the separate manual card review is user-deferred, not a failure. |

The original-phone outcome is user-reported, not a result of deployment,
synthetic tests or an independently captured wire trace. Native-versus-hosted provenance and cache cause
remain unknown; do not clear the phone cache or infer a client upgrade. A
modern nonce-bearing client's live outcome is also pending. Preserve the
90-second settlement/old-client timeout-polling and coalescing/retry limits
above; deployment does not remove those causal boundaries.

PA coordinates separate product and documentation review and routes repairs
to PSWE or Product Documentation Engineer respectively. Any post-deployment
documentation change needs a new exact candidate and separate independent
review. Experimental deployment is historically evidenced and the apparent
phone success is user-reported; independently verified wire-level repair,
overall completion, final acceptance, publication and approval of this updated
documentation candidate are not claimed.

## Cuihui Mac mini rollout: continuation + preserved spawn compatibility

This is the first deployment of the merged autopilot-continuation work to
Cuihui's Mac mini. It is a CLI-only rollout. It replaces neither the hosted UI,
the relay, the self-hosted server, the native desktop app, nor any Tailscale,
network or authentication configuration.

### Why this candidate is not the accepted Quinann artifact

The Quinann qualification artifact `0.2.11-cuihui-autopilot-continuation-366ac45a-v12`
was built from the continuation branch alone. Cuihui was already running the
separately developed `0.2.11-cuihui-spawn-compat-r1`, whose daemon settles a
nonce-less legacy or mobile new-session request to its own real session id.
Merged PR #2 (`5636991f689b2e5b2502780ead5a6c92bd9c88cc`) does **not** contain
that compatibility work; `c50f6dbf545194cdad98a3b549c51a1f3e468164` is not an
ancestor of the merge and `settleAcceptedSpawnIdentity` is absent from the
merged `apps/cli/src/api/machine/rpcHandlers.ts`. Installing the Quinann
artifact on Cuihui would therefore have regressed confirmed new-session
creation, so it was not reused.

### Exact source lineage

| Item | Value |
| --- | --- |
| Merged continuation source | `5636991f689b2e5b2502780ead5a6c92bd9c88cc` (PR #2 merge) |
| Approved PR head | `9fd570390b6f5a5450b2e3faae1d38db946a8148` |
| Preserved compatibility source | `c50f6dbf545194cdad98a3b549c51a1f3e468164` |
| Combined deployed source | `8280b91f0c09ea3ce141ab56f28ecc5908c7b8fb` |

The compatibility commit was carried forward whole. `apps/cli/src/api/machine/rpcHandlers.ts`,
its tests and `packages/protocol/src/tools/v2/*` are byte-identical to the
compatibility source; the only conflict was additive prose in this file, and
both narratives were kept.

Provenance of the running fix was established before any change: the installed
`0.2.11-cuihui-spawn-compat-r1` payload contains `settleAcceptedSpawnIdentity`,
and its compiled region in `package-dist/api-*.mjs` is byte-identical to the
region emitted by this candidate's build. Preservation is therefore an observed
compile-output match, not an inference from the commit message.

### Exact artifact

| Item | Value |
| --- | --- |
| Version label | `0.2.11-cuihui-continuation-spawn-compat-366ac45a-r1` |
| Native `happier` SHA-256 | `14b6403c4838615534fc0d459453b97df4c7ea5986b36417092c64a6eb9322c0` |
| Tarball SHA-256 | `d9dc4cf83a8443ace6fbed9e66a070a81d27e9de8fb06d4525767c434d9b461f` |
| Builder | `scripts/pipeline/release/build-cli-binaries.mjs`, target `darwin-arm64` |
| Bun | `1.4.2`, workspace-local toolchain |
| Installed path | `/Users/cuihuiai/.happier/cli/versions/0.2.11-cuihui-continuation-spawn-compat-366ac45a-r1` |

Bun 1.4.2 compresses the embedded payload, so `strings` no longer finds source
identifiers inside the native binary. Artifact content is verified through the
compiled `apps/cli/dist` bundle and through live behavior, not through `strings`.

### Target route and activation

| State | Before | After |
| --- | --- | --- |
| `~/.happier/cli/current` | `versions/0.2.11-cuihui-spawn-compat-r1` | `versions/0.2.11-cuihui-continuation-spawn-compat-366ac45a-r1` |
| `current.version` | `0.2.11-cuihui-spawn-compat-r1` | `0.2.11-cuihui-continuation-spawn-compat-366ac45a-r1` |
| Daemon PID | `882` | `64215` |
| Daemon HTTP port | `49209` | `58564` |
| Relay service `happier-server` | PID `641` | PID `641`, unchanged |

Activation used the owning command `/Users/cuihuiai/.happier/bin/happier service restart`.
`launchctl` was not invoked directly and session runners were not restarted.
All four pre-existing user sessions survived with unchanged PIDs.

Replace the `current` symlink with `mv -h`. A plain `mv` resolves the existing
symlink and drops the replacement *inside* the old version directory instead of
switching the pointer.

### Rollback

```bash
ln -sfn versions/0.2.11-cuihui-spawn-compat-r1 ~/.happier/cli/current.tmp
mv -fh ~/.happier/cli/current.tmp ~/.happier/cli/current
printf '%s\n' 0.2.11-cuihui-spawn-compat-r1 > ~/.happier/cli/current.version.tmp
mv -f ~/.happier/cli/current.version.tmp ~/.happier/cli/current.version
/Users/cuihuiai/.happier/bin/happier service restart
happier daemon status   # must report the rollback version
```

`~/.happier/cli/previous-before-continuation-366ac45a` points at the rollback
target for this rollout. Its native SHA-256 is
`fcaab27ce06cb848cd782987edaec8c3782255dcda94f499ceec3df2f945cf30`, unchanged by
this deployment. Rolling back restores nonce-less spawn compatibility and gives
up the merged continuation behavior. `current`, `current.version` and
`previous-before-task-complete-fix` were not modified.

#### Product-initiated rollback bookkeeping (corrected after the rollout)

`current` was switched by hand rather than through `promoteVersionedPayload`,
so this rollout did not update the generic pointer and marker that
`rollbackVersionedPayload` consumes. That left two separate defects, both now
repaired as a metadata-only change:

1. `rollbackVersionedPayload` resolves its target from the
   `previous.version` **marker file**, not from the `previous` symlink. That
   file did not exist, so a product-initiated rollback would have thrown
   `Cannot rollback first-party payload without a previous installed version`
   rather than rolling back at all. An earlier note in this document claimed it
   would silently land on `0.2.11-local-final2`; that claim was wrong, and the
   observed pre-repair resolution was the throw.
2. The `previous` symlink was separately stale, still pointing at the much
   older `0.2.11-local-final2`, and was an absolute rather than a relative
   target.

Both were corrected through the product helpers `syncInstalledPayloadPointer`
and `writeInstalledVersionMarker`, so `previous` and `previous.version` now
agree with what a normal promotion would have written:

| Bookkeeping state | Before repair | After repair |
| --- | --- | --- |
| `~/.happier/cli/previous` | `/Users/cuihuiai/.happier/cli/versions/0.2.11-local-final2` | `versions/0.2.11-cuihui-spawn-compat-r1` |
| `~/.happier/cli/previous.version` | absent | `0.2.11-cuihui-spawn-compat-r1` plus newline |
| Product rollback resolution | throws, no previous marker | resolves `versions/0.2.11-cuihui-spawn-compat-r1` |

The former `previous` target is preserved verbatim at
`~/.happier/cli/previous-before-rollback-metadata-repair-366ac45a`. There was no
marker to preserve, because `previous.version` did not exist; reverting this
repair therefore means deleting that file, not rewriting it.

A product-initiated rollback now lands on the same target as the manual recipe
above, whose native SHA-256 is
`fcaab27ce06cb848cd782987edaec8c3782255dcda94f499ceec3df2f945cf30`.
`previous-before-continuation-366ac45a` remains the explicitly named target for
this rollout. The repair changed deployment bookkeeping only: no rebuild,
redeploy, service restart or live rollback was performed, `current`,
`current.version`, the installed combined artifact
(`14b6403c4838615534fc0d459453b97df4c7ea5986b36417092c64a6eb9322c0`), the
daemon, the relay, the user sessions and every retained version directory were
left untouched. Rollback resolution was verified read-only, up to but not
including the pointer write; a live rollback was still not exercised.

### Developer smoke evidence only

On the deployed candidate, through the real relay machine RPC route: a
nonce-less legacy spawn returned a usable session id directly; a nonce-carrying
spawn kept the modern asynchronous acceptance and then settled; an ordinary
Copilot turn produced a durable reply; a tool-using turn persisted both its
post-turn prose and its final `SUMMARY:` line; a real cancel stopped a running
120-second command while leaving the session immediately reusable for a further
durable reply; and all pre-existing sessions stayed `runner_alive`.

One earlier smoke turn parked with no visible reply. The cause was an
unanswered interactive shell permission request in a `default`-permission
session with no responder, observed in the provider log as
`Permission request (kind=shell): routing via PermissionService`. It is not a
deployment regression, and the same prompt shape completed normally under
`bypassPermissions`.

This is developer execution evidence. Independent product-quality evaluation,
including UI and browser transcript rendering and a New Session created from the
authenticated hosted UI against this host, is still required and is not claimed
here.

## Synchronizing with upstream

After merging `upstream/dev`, rerun all tests listed above. Remove a
customization only after the equivalent upstream behavior passes the same
regression and live acceptance checks.

Follow [Maintaining the Cuihui customization fork](custom-fork-workflow.md) for
the complete fetch, merge, validation, and push procedure.
