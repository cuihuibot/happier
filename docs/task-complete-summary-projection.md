# Task-complete summary projection

The ACP runtime keeps one visible answer for one client prompt when a provider
finishes in prose and then autonomously emits a canonical `task_complete`
summary that restates that answer. It still preserves genuinely new summaries,
identical answers to separate prompts, and the complete tool transcript.

This is current development behavior in `apps/cli`; it does not by itself state
that a published release contains the contract.

## Mental model

A **dispatch** is one client prompt plus the provider-autonomous continuations
that follow it. Each continuation is projected as its own runtime turn, but the
visible-answer decision spans the whole dispatch.

The runtime clears its delivered-answer set when a client prompt opens a new
dispatch. A projected continuation inherits the answers already delivered for
that dispatch. When the runtime flushes a turn, it withholds an assistant
summary row if the `task_complete` summary exactly repeats an answer the same
dispatch already delivered.

Without dispatch scope, beginning a continuation clears the per-turn response
state. The empty-response summary fallback can then mistake a restatement for
new output and publish a second durable assistant row for one prompt.

## Contract

- **Cross-continuation idempotence.** A summary that repeats an answer already
  delivered in the same dispatch yields exactly one durable assistant row,
  regardless of how many continuation turns separate the answer and summary.
- **Exact matching only.** Comparison uses the exact trimmed answer body, not a
  substring scan. A summary that only mentions or quotes earlier text remains a
  new answer and is published.
- **Separate prompts stay separate.** Two consecutive client prompts that
  legitimately produce the same answer text each keep their own durable row.
- **Tool activity remains visible.** Withholding the duplicate answer row does
  not remove the `task_complete` tool call or its result from the transcript.
- **Existing summary rules remain in force.** Deterministic per-call-id row
  identity and the successful-completion, failed-result, and
  already-visible-prose rules are unchanged.

## Implementation references

- Runtime owner:
  `apps/cli/src/agent/acp/runtime/createAcpRuntime.ts`
- Regression coverage:
  `apps/cli/src/agent/acp/runtime/__tests__/createAcpRuntime.sameTurnSummary.test.ts`
