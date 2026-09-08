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
- **Bounded.** `maxPerTurn` (default 8) caps reopenings per client turn, so a
  misbehaving provider cannot keep a session open indefinitely.
- **`usage_update` never reopens.** Reopening on any notification would resurrect
  turns from bookkeeping traffic; only prompt-turn update types qualify.

### Why the continuation is a separate turn

`flushTurn()` projects the `task_complete` summary fallback only when the
segment produced no ordinary assistant message. That rule from
[Copilot completion persistence](#copilot-completion-persistence) is intentional
and is preserved unchanged. Running the continuation as its own generation gives
it a fresh empty accumulated response, so a stage-two summary that follows
stage-one commentary is projected correctly *by construction* rather than by
broadening the fallback rule and risking duplicate summaries on ordinary turns.

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
| `outcome` | `completed` \| `timed_out` \| `cancelled` \| `failed` |
| `stallMs` | the safety budget in force, reported as the timeout cap |

`outcome` is the only field the runtime acts on, and the mapping is total:

| `outcome` | runtime turn outcome | transcript result |
| --- | --- | --- |
| `completed` | successful completion | `task_complete`, turn recorded completed |
| `timed_out` | `{ kind: 'timed_out' }` | `turn_aborted`, turn cancelled |
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

### Regression coverage

```bash
cd apps/cli
yarn vitest run \
  src/agent/acp/__tests__/AcpBackend.autonomousContinuation.test.ts \
  src/agent/acp/runtime/__tests__/createAcpRuntime.autonomousContinuation.test.ts \
  src/agent/acp/runtime/__tests__/createAcpRuntime.continuationOutcome.test.ts
yarn vitest run src/agent/acp src/backends/copilot src/agent/runtime
yarn typecheck
```

`createAcpRuntime.continuationOutcome.test.ts` drives the *real* `AcpBackend`
stall timer, terminal correlation, cancellation and disposal paths into the real
runtime projection, so the outcome contract is covered end to end rather than by
a synthetic handler event.

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
   truthfully.
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
  further provider output for that turn is dropped by the dispatch guard. This
  is logged (`continuation budget exhausted`) but is not surfaced in the
  transcript.
- The default `maxPerTurn` of 8 is a judgement call; Copilot's own observed
  proxy limit was `--max-autopilot-continues=2`.
- The reproduction proves the isolated continuation-loss defect only. It does
  not establish that every historically reported missing-prose or fast-turn
  symptom shares this cause.

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

## Synchronizing with upstream

After merging `upstream/dev`, rerun all tests listed above. Remove a
customization only after the equivalent upstream behavior passes the same
regression and live acceptance checks.

Follow [Maintaining the Cuihui customization fork](custom-fork-workflow.md) for
the complete fetch, merge, validation, and push procedure.
