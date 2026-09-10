# Maintaining the Cuihui customization fork

This checkout keeps Cuihui-specific Happier changes in `cuihuibot/happier`
without proposing or pushing them to `happier-dev/happier`.

The maintained behavior, compatibility limits, and regression commands are
documented in
[Cuihui Happier customizations](cuihui-customizations.md).
Environment configuration, rollout records, acceptance status, and recovery
procedures belong in an operator-controlled deployment repository; see
[Repository boundary for custom deployments](repository-boundary.md).

## Repository model

| Name | Purpose | Push policy |
| --- | --- | --- |
| `origin` | Cuihui customization fork: `cuihuibot/happier` | Allowed |
| `upstream` | Main Happier repository: `happier-dev/happier` | Disabled |
| `custom/cuihui` | Long-lived customization branch and fork default | Allowed to `origin` only |
| `upstream/dev` | Upstream integration baseline | Fetch and merge only |

Configure each local checkout with `remote.pushDefault=origin` and disable the
`upstream` push URL.

## Clone the customization repository

```bash
git clone https://github.com/cuihuibot/happier.git
cd happier
git remote add upstream https://github.com/happier-dev/happier.git
git remote set-url --push upstream DISABLED
git config remote.pushDefault origin
git switch custom/cuihui
```

Confirm the safety boundary before making changes:

```bash
git remote -v
git branch -vv
git config --get remote.pushDefault
```

`origin` must point to `cuihuibot/happier`, `upstream` must show
`DISABLED` for pushes, and `custom/cuihui` must track
`origin/custom/cuihui`.

## Develop a fix on a topic branch

Do not commit directly to `custom/cuihui`. Branch from the current integration
tip, keep the change reviewable, and open a pull request into `custom/cuihui`
without merging it yourself.

```bash
git fetch origin
git switch -c fix/<short-description> origin/custom/cuihui
# implement, then run the relevant documented regression commands
git push -u origin fix/<short-description>
gh pr create --repo cuihuibot/happier --base custom/cuihui --head fix/<short-description>
```

Verify the acting GitHub identity before any remote write:

```bash
gh api user --jq .login   # must print: cuihuibot
```

Record reusable behavior, compatibility limits, and regression guidance in
[Cuihui Happier customizations](cuihui-customizations.md) in the same branch.
Record environment-specific acceptance, rollout, artifact, and rollback facts
in the deployment repository without adding secrets or raw operational data.

## Sync changes from upstream

Use merges rather than rebases so the customization history remains stable and
does not require force-pushing.

```bash
git fetch upstream
git merge --no-ff upstream/dev
```

Resolve conflicts by preserving the upstream behavior unless a recorded Cuihui
customization intentionally overrides it. Then run the tests that cover both
the upstream changes and the affected custom behavior.

After validation:

```bash
git push origin custom/cuihui
```

Never run `git push upstream`. The disabled push URL is a guardrail, not a
substitute for checking the destination before an external write.

## Review maintained customizations

List commits and changed files that remain outside upstream:

```bash
git log --oneline upstream/dev..custom/cuihui
git diff --stat upstream/dev...custom/cuihui
```

Before removing a customization, verify that the equivalent behavior exists in
the fetched upstream source and passes the same regression and live acceptance
tests. Remove the local change only after that verification.

## Recover repository remotes

If remote names or push policies drift:

```bash
git remote set-url origin https://github.com/cuihuibot/happier.git
git remote set-url --add --push origin https://github.com/cuihuibot/happier.git
git remote set-url upstream https://github.com/happier-dev/happier.git
git remote set-url --push upstream DISABLED
git config remote.pushDefault origin
git branch --set-upstream-to=origin/custom/cuihui custom/cuihui
```
