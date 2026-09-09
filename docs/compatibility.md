# Compatibility and version skew

This document defines when Happier preserves old behavior across UI, CLI, daemon, server, installers, and persisted state. The goal is safe upgrades and mixed-version operation without turning undeployed implementation history into permanent compatibility debt.

Closure update, September 9, 2026: original-phone New Session seems to work
according to the user; exact wire correlation and a separate modern
nonce-bearing live probe remain unverified. Manual completion-card review is
user-deferred, not a pass or failure. The [closure and recovery
status](cuihui-customizations.md#september-9-closure-and-recovery-status) records
the recovered documentation and gaps at the now-absent historical workspaces.
All 26 source files are now recovered byte-identically and durably integrated on
`exp/spawn-compat-and-completion-card-recovery-r1`, base
`0d99e21273200b3a43d9508d6878234895f0240a`, without a source integration delta.
The [durable integration identity](cuihui-customizations.md#durable-integration-identity)
binds exact source inventories and new paths. Production is untouched; fresh
product approval, exact-repository documentation approval and publication remain
pending. Recovered historical review bodies do not restore the underlying old
test logs. The non-exact daemon rollout-helper reconstructions were discarded;
the original receipt and a current executable recovery procedure have not been
re-established. Source integration does not establish current rollback readiness.
This update changes no compatibility requirement or runtime behavior.

## Trigger

Apply this policy when a change affects a cross-component wire shape or semantic, persisted/session/settings data, schema or migration, feature/capability negotiation, installer or service state, upgrade/coexistence, or rollback. Routine internal refactors that leave these seams unchanged do not need a compatibility matrix or shim.

## Baseline classes

### Hard released obligations

- Active stable and preview releases count because both can exist on user machines or deployed infrastructure.
- Resolve each component independently. UI, CLI/daemon, server, desktop/mobile, and stack tags may point to different commits.
- Discover the current channel through rolling tags such as `cli-preview`, then record the immutable component version tag, commit, and relevant artifact/deploy evidence used by the check.
- Older releases count only when explicitly supported by policy or task scope; tag existence alone does not imply indefinite support.

### Non-obligations

- `dev`/`*-dev.*` builds, untagged commits, abandoned experiments, and undeployed internal module paths are not lasting compatibility contracts.
- Do not keep aliases or adapters solely for an atomic internal rename/move whose old path never shipped.
- Repository-specific predecessor rules may add a prospective baseline, but they do not convert every historical intermediate implementation into permanent support.

## Map the seam

For the changed concept, identify:

- the canonical domain owner;
- every producer, consumer, reader, writer, serializer, parser, and persisted artifact;
- the old/new component versions that can actually meet during rollout or rollback;
- the wire, semantic, persistence, and operational expectations at that seam;
- any existing split-brain, duplicate decision path, fallback, or compatibility adapter in the touched corridor.

An existing same-concept split-brain in the touched corridor must be consolidated at the canonical owner. A compatibility adapter may translate released shapes, but it must not independently decide domain behavior.

## Direction and rollout

### Self-hosted independent upgrades

Self-hosted operators can upgrade clients, daemons, relays, and persisted
state independently. Release evidence therefore covers the reachable
directions rather than imposing a fleet wait or a global cutover:

- current clients, CLI, and daemon against a supported older stable relay;
- bounded supported older client/daemon core flows against the current relay;
- persisted state from an older writer into current readers; and
- current writes into older readers only when supported rollback or
  coexistence makes that direction reachable.

The last direction is conditional, not an excuse to add dual writers or a
permanent fallback. The release agent derives the affected, reachable
directions from the actual diff and supported released baselines. Scripts prove
only named behaviors against exact artifacts; they do not issue a general
compatibility verdict. The named Docker relay-upgrade scenario is selected
automatically only when the release changes the server and a supported
published relay predecessor exists. Installer and broader Docker validation
remain risk-selected; deep certification owns cross-OS, provider, mobile, and
comprehensive review.
Product seams still own the actual compatibility implementation.

- New readers accept supported old shapes; new writes use the canonical current shape.
- Old readers need to accept new writes only when coexistence, independent component rollout, or rollback makes that direction reachable.
- New clients talking to old servers must capability-negotiate or degrade safely instead of assuming the new contract.
- Old clients talking to new servers retain released behavior for ordinary compatible changes and for every operation the new server can still execute safely. A major incompatible server change may require a newer client for the affected operation, but that support boundary is an explicit developer/product decision—not an agent-selected default.
- Persisted-state changes consider both old-writer → new-reader and, when rollback/coexistence is supported, new-writer → old-reader.
- Prefer operation-scoped graceful degradation over connection-wide rejection: admit the old client, keep unaffected reads and writes available, and return a typed upgrade requirement only when the requested operation cannot be performed safely. Reject the whole connection only when no authenticated operation can be made safe.
- For an incompatible transition, prefer prepare/expand → activate/migrate → contract when mixed-version coexistence or rollback is an approved requirement. Do not assume that old clients must read new writes merely because the server is self-hosted.

Before adding dual writers, parallel persisted formats, rollout modes, operator flags, socket-drain protocols, or a mandatory client floor, compare their lifetime cost with the actual user behavior required. If preserving old-client/new-server behavior for a major change would require substantial machinery, stop and obtain an explicit developer/product decision among: operation-scoped degradation, a documented client update requirement, or the heavier compatibility transition. An agent must not silently choose either forced upgrades or heavy compatibility machinery. This exception is for genuinely incompatible, high-cost transitions; routine server changes must remain compatible and must not manufacture client-update requirements.

### Self-hosted relay release checks

For stable releases, prioritize current UI, CLI, and daemon core flows against
the supported older self-hosted relay. Check the bounded reverse direction only
for core usability affected by the changed seam. Check released persisted state
against current readers/migrations, and current writers against old readers
only when rollback or coexistence makes that direction reachable.

The registry may automatically select the exact `docker-release-assets`
published-channel-to-current-source upgrade when the server changed and a
supported published predecessor exists. That proves one named SQLite/Postgres relay
upgrade; it is not a generic compatibility verdict. Release orchestration never
waits for client adoption, self-hosted relay upgrades, daemon drain, migration
cohorts, or a global cutover.

## Proportionate matrix

List all affected reachable directions and mark each `required`, `unreachable`, or `unsupported` with a reason. Direct seam tests cover each required direction. End-to-end rows are selected by risk and real deployment order.

Do not run a full Cartesian UI × CLI × daemon × server matrix for an internal or unrelated change. Require broader combinations when a shared protocol, persistence shape, installer/service state, or rollout ordering actually couples those roles.

## Evidence and tests

- Prefer real released/predecessor artifacts, serializers, clients, or provenance-pinned golden vectors.
- A fixture reconstructed from current types is not evidence that the released reader/writer behaves that way.
- Use the smallest discriminating test for each material direction, then add risk-selected upgrade, coexistence, rollback, and state-continuity flows.
- Do not multiply shallow permutations. A new test must distinguish a plausible incompatibility, reader/writer mismatch, semantic change, or rollout failure.
- Record the exact tag/commit/artifact, component roles, direction, command, and result.

## Compatibility path lifecycle

Every retained compatibility path records:

- the released or prospective source shape it supports;
- its producer and consumer;
- whether it exists for upgrade, coexistence, rollback, or persisted historical data;
- the canonical owner it delegates to;
- its removal condition.

Remove the path when its support window has ended and evidence shows no supported reader, writer, or stored shape still requires it. Do not remove a released-data reader merely because current writers stopped producing that shape.

### Daemon-spawn compatibility experiment

Record ID: `DSC-COMPAT-01`. This bounded local experiment was activated on
September 8, 2026 (`16:45:30Z`-`16:47:32Z`), with daemon-only restart at
`16:46:52Z`. It is not a new support window, client floor, relay protocol
revision, or guarantee of successful phone behavior.
The original exact source scope is base `0d99e21273200b3a43d9508d6878234895f0240a`
plus the original uncommitted machine RPC handler/test change on
`exp/daemon-spawn-compat-r1`. The [experiment record](cuihui-customizations.md#daemon-spawn-compatibility-experiment)
owns rollout status; [CLI architecture](cli-architecture.md#accepted-spawn-identity-local-compatibility-experiment)
describes the settlement adapter. The same source bytes are now integrated
as the daemon portion of the combined durable candidate above; historical
review scope remains unchanged.

The running CLI identity deliberately remains
`0.2.11-cuihui-spawn-compat-r1`, a custom/parser-unfriendly version. Do not
substitute a parser-friendly version or update client payloads to make this
experiment appear successful. The inspected pre-fix client source at
`c11d059fa09332dc85a87ac512256e789d3b55f3` builds a local attempt nonce, but its
legacy payload builder drops that nonce when selecting the legacy shape.
It still tries `SPAWN_HAPPY_SESSION_PROVIDER_SAFE` before falling back to the
legacy method only on method-unavailable/not-found errors. Its
`apps/ui/sources/sync/ops/machines.ts` accepts direct success with `sessionId`;
on pending success or `SESSION_WEBHOOK_TIMEOUT`, it resolves using its own
locally retained nonce, not the daemon-generated nonce returned on acceptance.
The existing source at `ac0fe7965f946a0e38c2075f8eb7fe1a3cfedc7f` already
preserves the nonce in the legacy payload builder; that earlier UI fix does
not prove the unidentified phone is running those bytes.

| Reachable direction | Requirement and intended behavior | Evidence boundary |
| --- | --- | --- |
| Nonce-omitting legacy client to deployed experimental daemon, provider-safe RPC | Required: settle the exact accepted result nonce and return actual `sessionId` on successful settlement; no newest-session/directory guess and no settlement-triggered second spawn. | R5 independent compiled-branch coverage passes with synthetic dependencies; user reports original-phone New Session seems to work on September 9 at `08:38+07:00`, but exact wire correlation remains unverified. |
| Nonblank string caller nonce to deployed experimental daemon, provider-safe RPC | Required: retain the modern response, including accepted-but-pending success; caller can resolve its submitted nonce. | R5 independent unchanged-branch coverage passes; modern nonce-bearing client live outcome pending. |
| Absent, non-string, empty, or whitespace-only caller nonce to deployed experimental daemon | Required: use the same settlement adapter as legacy RPC; invalid nonce presence alone must not select modern pending behavior. | R5 independent compiled malformed/blank-input coverage passes; not live phone evidence. |
| Legacy RPC to deployed experimental daemon | Required: retain direct settlement via the shared helper and preserve a boolean `pendingFirstInputAccepted`, including `false`. | R5 independent compiled/regression evidence; live first-input/error outcomes pending. |
| Existing clients to restored `0.2.11-cuihui-task-complete-v3` daemon | Required rollback direction: preserve the old payload and pointer/marker state; nonce-less provider-safe failure may recur when the adapter is removed. | Historical R5 independently reviewed fixture recovery; actual deployment retained old state. No real rollback executed. Current script/receipt/payload availability and path rebinding remain unverified; the old workspace commands are not currently usable. Any separately authorized recovery still requires both exact pins and diagnose-first routing in the experiment record. |
| Client/relay protocol migration or new native phone build | Unreachable as an action in this experiment: neither client nor relay is being replaced. Existing client-to-daemon requests still traverse the unchanged relay. | No protocol or native-app currency claim. |

The adapter delegates to `awaitSpawnedSessionId` and the existing nonce
settlement primitive; it does not own a parallel identity lookup or admission
policy. Preserve `pendingFirstInputAccepted` on direct settlement so the client
does not lose the existing custody signal. Acknowledgement does not prove
first-turn execution.

The daemon settlement default remains 90 seconds, with existing environment
bounds. The inspected client's spawn RPC default is five minutes, separately
bounded by its existing timeout reader; neither default is a startup SLO.
On daemon `SESSION_WEBHOOK_TIMEOUT`, the inspected old client still polls its
own unknown nonce. Slow or failed identity settlement can therefore retain
the original failure even if a session exists. Transport/retry behavior and
semantic request coalescing are unchanged. No guarantee is made that two
identical nonce-less requests always create different sessions or that they
provide caller-key idempotency. Mocked out-of-order resolver coverage proves
neither real daemon admission behavior nor phone acceptance. In particular,
"no caller-key deduplication" must not be restated as a guarantee that every
retry creates a distinct session.

The reported September 8 `20:13:11 +07:00` legacy request omitted a nonce,
created a real session, and was followed by fruitless old-client polling.
This is assignment-supplied operational evidence, not a phone-artifact
identification or cache diagnosis. Native-versus-hosted identity and cache
attribution remain unproven. The active hosted R3 completion-card rendering
contract and its scoped independent live result remain unchanged; the
original authenticated new-session outcome is now user-reported: at
`2026-09-09T08:38+07:00`, the user said New Session on the original phone seems
to work. This does not identify the exact wire path or client build. At
`08:43+07:00`, the user deferred manual card review; it remains unverified,
not failed. No further phone/card test is claimed here. Deployment created no new sessions
and did not clear phone cache, replace the native app, or change relay/UI bytes.

Independent preactivation helper failures R1-R4 were repaired; the exact R5
readiness `quality_gate_pass` is historical. It includes synthetic compiled-branch
and guarded operational recovery evidence, not live client compatibility.
Actual operator evidence records daemon `75201` replaced by `83830`. The
Independent Product Quality Engineer's `quality-live/REPORT.txt`, closed at
`2026-09-08T16:54:41.545070Z`, returned `quality_gate_pass` for
**EXPERIMENTAL DEPLOYMENT AND PRESERVATION ONLY**; report SHA-256:
`9268e1a8edc4c484f390fe305c329310c37feb91bc07cd13db843dc57a9ad03b`.
It independently matched the full installed 57,376-entry tree, observed
persistent daemon `83830` on the same machine and relay route, and verified
all 14 protected PID/start/executable identities, all eight prior version
directories plus the new ninth, unchanged prior pointers, old v3 native binary
and hosted R3 index, and an unconsumed frozen candidate. Eight runner PPID
changes are diagnostic only. Full old-tree byte equivalence and an exercised
reboot/restart-on-failure are not claimed.
The [experiment record](cuihui-customizations.md#daemon-spawn-compatibility-experiment)
binds exact source/native/operator/receipt identities and separately attributes
the live deployment/preservation review. Neither readiness nor deployment
preservation proves nonce-less or nonce-bearing live RPC/client acceptance,
phone success, or documentation approval. The user-reported phone outcome
does not verify the live wire-level rows above; source/compiled synthetic
evidence remains preactivation-only. The recovered historical reports do not
approve this updated three-document candidate; fresh independent review is pending.

This prospective coexistence adapter has no invented expiration date.
Retirement requires a separate owner decision supported by evidence that
nonce-omitting callers are no longer required in the bounded deployment, or
that an independently validated replacement covers them. This experiment
does not establish a permanent released-client obligation.

### Account-pool quota-reset opt-in (development)

`autoUseQuotaResetsWhenExhausted` is optional in the V1 pool policy; absence means
false. Do not materialize a default in the wire schema. The `connectedServices.autoQuotaReset`
server feature bit negotiates authoring; older servers do not advertise it, so updated
clients do not offer the opt-in there.

Updated group readers send `Accept: application/json; happier-connected-service-auto-quota-reset=1`.
This uses a CORS-safelisted header so updated browsers can still reach older relays.
The existing V3 group-route response boundary omits only this field for readers without
that header. Policy PATCH remains a merge, so older clients can edit the fields they
understand without erasing the opt-in. This projection preserves the strict readers in
`cli-v0.2.11` and `server-v0.2.11` (commit `98ea8fb76733b1dd785d38c31360179cafa84824`);
it can be removed when those strict response readers are no longer supported.

The same response boundary masks the opt-in while its server feature or dependencies
are disabled, without changing the stored policy. Existing recovery reads therefore
observe automatic spending as disabled; re-enabling the feature restores the saved choice.

This is forward coexistence, not an old-server rollback guarantee. An older server's
persisted-policy parser rejects the new field and falls back to its complete default
policy. Do not roll back a database containing this opt-in to that reader without a
separately validated, authorized data reconciliation. No database rewrite is performed
by the response projection.

### Session draft rollout

The current development UI stores browser draft repositories and pending-message outboxes in
IndexedDB, outside Web Storage's small synchronous quota. Native clients retain MMKV. Browser
startup prepares drafts before restoring Sync or rendering draft consumers; a failed preparation
uses the existing app recovery boundary rather than treating saved drafts as absent.

The draft repository writes a compact local v2 envelope and reads both v1 and v2. Equal base/local
documents and pending fields are stored once and reconstructed on read; independent conflict
values are retained. This does not change the synchronized draft document or server wire format.
Older UI binaries cannot read this local v2 representation.

Legacy browser values are removed only after their IndexedDB transaction commits. Migration
preserves conflicting copies and reports a failure instead of silently choosing one. Reload older
open tabs when updating the UI so they stop writing the retired Web Storage records. Concurrent
editing from an unupgraded tab during migration is not supported: old Web Storage writers cannot
participate in IndexedDB transactions. Browser
outbox operations await local transaction completion before reporting local custody; enqueue
acknowledgements cannot retire a concurrently recorded cancellation.

Draft autosaves retain failed writes in memory, expose the existing error status, and retry through
the repository's flush owner. Browser draft updates preserve unrelated replicas written by another
tab and reject conflicting changes to the same replica. IndexedDB still has browser/disk limits:
an error is not permission to discard drafts or pending messages, and unsaved in-memory edits must
be preserved before reloading. These device-local stores are not substitutes for server acknowledgement.

Synchronized Session drafts are negotiated through the `sessions.drafts` server feature bit. A new
client fails closed when that bit or the typed routes are unavailable and retains the incumbent
local-only behavior; it does not send draft records through generic Account KV routes. A capable
server reserves the draft KV prefix so old generic-KV clients cannot read or overwrite typed draft
rows.

The first capable client imports the retired local existing-Session text/semantic stores and the
singleton new-Session draft into the canonical draft repository. It removes each legacy value only
after the corresponding canonical record is durably acknowledged, so an interrupted import remains
recoverable. The legacy readers are migration adapters, not parallel writers, and may be removed
when supported persisted local state no longer requires them.

During supported 0.2/0.3 coexistence, the draft authoring map remains closed except for explicitly
enumerated compatibility keys. The 0.2 reader accepts and preserves the 0.3 `executionTarget`,
`organizationPlacement`, `agentTarget`, `modelSelection`, and `runtimeDescriptorV1` fields but does
not treat them as 0.2 execution authority. The 0.3 reader validates and preserves the published 0.2
`machineId`, `serverId`, `agentId`, `backendTarget`, `modelId`, and `codexBackendMode` fields; its UI
projects only exact safe equivalents into canonical execution, Agent, and native-model selections.
Canonical 0.3 fields, including explicit clears, win over predecessor values, and each version's
writers continue to emit only their native catalog. Remove these reader bridges only after
0.2/0.3 coexistence and persisted drafts from the other catalog are no longer supported inputs.

Draft documents preserve unknown extension fields as JSON. This lets a client without a newer
composer contribution edit fields it understands without deleting newer semantic data; it does not
authorize that client to execute the unknown contribution. Raw files, handles, secrets, and other
device-only state remain outside the compatibility shape.

### Request notification previews (development)

`requestIncludeMessageText` extends the existing account notification preferences and
notification-channel objects. Remote readers default a missing field to true;
an explicit false omits request content. The device-local preview setting
is independent of account writeback and defaults to true. No session, permission
response, or webhook payload shape changes: richer text uses the existing body and
`request.toolDetails`, and disabling previews omits details from both.

The released `ui-mobile-v0.2.11` and `ui-web-v0.2.11-preview.186` readers at
`98ea8fb76733b1dd785d38c31360179cafa84824` strip unknown nested notification fields.
Their notification editor rebuilds both preference objects, and raw settings
writeback replaces those objects rather than merging their members. An old-client
edit can therefore erase this flag. The user-selected default is to show previews, so losing an explicit
opt-out restores previews; users can disable them again from an updated client. Older CLI senders ignore
the flag and retain their existing reduced hints. There is no new server operation,
migration, duplicate settings owner, or client-update requirement.

## Migration history

Migration source has a stricter authoring boundary than ordinary internal code:

- A migration is **local-only** while it has not shipped in a supported stable or preview artifact. Local-only migrations may be edited, renamed, consolidated, or removed before publication.
- Once a migration ships in a supported stable or preview artifact, its name and bytes are immutable. Correct later behavior with a new append-only migration; do not rewrite, rename, or delete the released migration.
- Shared development branches and `*-dev.*` artifacts are evidence that a development database may need explicit reconciliation, but they do not create a lasting product compatibility obligation. Before the next supported release, their migration source may be corrected or consolidated in place when the final transition is still unreleased.

Before publishing a feature, consolidate local-only migration churn into the smallest clear transition from the published schema to the intended final schema. Do not retain add-then-drop columns, temporary tables, renamed draft identities, checksum aliases, or corrective migrations solely because a developer database applied an earlier draft. Retain multiple migrations only when each step serves a real rollout, backfill, transaction, provider, or mixed-version requirement.

If a persistent development database applied a local-only draft that is later rewritten:

1. back up or snapshot the database;
2. compare its actual schema and migration ledger with the published baseline and intended final schema;
3. prepare a database-specific, reviewable reconciliation procedure;
4. obtain explicit approval before mutating a database that contains retained user or development data;
5. verify the reconciled schema and ledger against the canonical migration set.

The migration edit and its retained-development reconciliation are one work unit. Compare the complete physical schema—not only columns, but also indexes, constraints, and foreign keys—and test the procedure on a current backup or clone after the final migration edit. Any later edit to the migration invalidates earlier checksum/ledger reconciliation evidence and requires the procedure and proof to be refreshed before handoff.

That reconciliation is an operator/development action, not a shipped compatibility path. Do not add runtime checksum exceptions, migration-name aliases, duplicate no-op migrations, or automatic ledger repair merely to preserve unpublished development history.

Keep PostgreSQL, SQLite, and MySQL migrations aligned by intent. Before publication, validate both a clean migration from the published baseline and the approved reconciliation path for any retained development database. After publication, preserve the exact migration history and test upgrades append-only.
