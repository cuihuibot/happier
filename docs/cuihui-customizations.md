# Cuihui Happier customizations

This document is the source of truth for behavior intentionally maintained on
`custom/cuihui` outside `happier-dev/happier`.

Last verified: September 8, 2026.

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
- The poison is held for the life of the running session process. If that
  process is restarted between the cancellation and the next prompt, a cold
  start can still resume the old provider session id from its stored resume
  reference. Cancel-then-restart-then-prompt is therefore not covered.
- Owner-visible tradeoff: because an autopilot turn cancellation now retires the
  provider session, cancelling in an autopilot session discards provider-side
  context and makes the next prompt pay a provider restart. That is the cost of
  the cancellation actually holding. Ordinary-mode cancellation is unchanged.

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
  src/agent/runtime/runPermissionModePromptLoop.cancellationLivelock.test.ts
yarn vitest run src/agent/acp src/backends/copilot src/agent/runtime
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
| Version label | `0.2.11-cuihui-autopilot-continuation-366ac45a-v9` |
| Source commit | `93e8abd9e57abcd4c291a3b986b30909f44737d8` |
| Native `happier` SHA-256 | `5c4f7777ba8b9fd6ac4cff9958e68b3d1a00ce092f5342a8edc40e18acc42557` |
| Tarball SHA-256 | `617c80419ceed575b53495f6aad9467fdecd5a3fa287e17a1d24245feba0d823` |
| Install path | `~/.happier/cli/versions/0.2.11-cuihui-autopilot-continuation-366ac45a-v9` |

Install and activate:

```bash
ln -sfn ~/.happier/cli/versions/0.2.11-cuihui-autopilot-continuation-366ac45a-v9 \
  ~/.happier/cli/current
launchctl kickstart -k gui/$(id -u)/com.happier.cli.daemon.default
happier daemon status   # must report the expected CLI Version
```

Roll back by pointing `current` at any retained version and kickstarting the
same service. Retained rollback targets, newest first:
`…-v8`, `…-v7`, `…-v6`, `…-v5`, and the original
`0.2.11-cuihui-task-complete-v3`.

Compatibility: the change is confined to the ACP backend, its runtime and the
prompt loop. It alters cancellation behavior only for providers that enable the
autonomous continuation capability, so no stored transcript, session record or
provider other than Copilot is affected, and rolling back needs no data
migration.

## Synchronizing with upstream

After merging `upstream/dev`, rerun all tests listed above. Remove a
customization only after the equivalent upstream behavior passes the same
regression and live acceptance checks.

Follow [Maintaining the Cuihui customization fork](custom-fork-workflow.md) for
the complete fetch, merge, validation, and push procedure.
