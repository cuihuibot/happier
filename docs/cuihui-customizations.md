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
