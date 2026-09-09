# Repository boundary for custom deployments

Happier source and environment operations have different audiences, review
paths, and disclosure risks. Keep reusable product truth in the public source
repository and keep environment-specific operating records in an
operator-controlled private deployment repository.

This is an architectural documentation split. It does not move runtime state,
change a host, deploy an artifact, rotate credentials, or remove information
from existing public Git history.

## Ownership

| Public product repository | Private deployment repository |
| --- | --- |
| Reusable source code and tests | Environment inventory |
| Generic product and protocol contracts | Non-secret deployment configuration |
| Architecture and canonical owners | Artifact and source pins used by an environment |
| Compatibility behavior and limits | Environment status and acceptance records |
| Portable regression and test guidance | Rollout and recovery records |
| Generic contributor workflow | Environment-specific runbooks |

The product repository may state that an operator-controlled deployment
repository exists, but it must not depend on a private URL or expose host
identifiers, local absolute paths, process identities, environment-specific
artifact hashes, private routes, or user-session history.

The deployment repository may link an immutable public source commit. It must
not become a copy of the product workspace or product history.

## Information that is never committed

A private repository is not a secret store. Do not commit:

- secrets, tokens, credentials, certificates, or private keys;
- authentication exports, browser storage, cookies, or session material;
- raw logs, packet captures, crash dumps, or session journals;
- build payloads, release archives, installed binaries, or dependency trees;
- unredacted production configuration; or
- copied workspaces containing unrelated source or operational state.

Commit only reviewed, redacted records and explicit placeholders. Unknown
configuration stays unknown rather than being filled with plausible values.

## Change routing

1. Product behavior changes are implemented and tested in the public product
   repository.
2. The public documentation records reusable behavior, architecture,
   compatibility, and test guidance.
3. The private deployment repository records the exact environment pin,
   non-secret configuration, rollout evidence, acceptance limits, and recovery
   readiness.
4. Runtime changes require their own authorization and validation. Editing
   either repository does not deploy or approve anything.

## Migration and history

Current public pages should remove environment-specific operational content
while retaining generic contracts and links. The private repository should
receive only the minimum structured records needed for operations and
traceability.

This forward migration does not revoke earlier public disclosure. Removing a
file or section in a new commit leaves prior Git objects and published commits
available. Any history rewrite, credential response, or external publication
decision requires separate authorization and is outside this documentation
boundary.
