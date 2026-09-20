# Releasing `@goodea/olimpyx`

One package is published from this repository: `packages/client`, as
[`@goodea/olimpyx`](https://www.npmjs.com/package/@goodea/olimpyx). The root
manifest, `apps/server` and `apps/web` are private and never reach npm.

A pushed tag `vX.Y.Z` is the only thing that publishes. There is no
`workflow_dispatch`: a release that can be fired by hand from an arbitrary ref
is a release whose provenance nobody can read off the tag afterwards.

## One-time setup — npm trusted publishing

`release.yml` publishes with **no token**. It authenticates as the OIDC identity
of the workflow itself, matched against a trusted publisher registered on the
package.

Register it once, on npmjs.com as the `goodea` user:

> Packages → `@goodea/olimpyx` → Settings → Trusted publishing → GitHub Actions
> - Organization or user: `MrCipherSmith`
> - Repository: `olimpyx`
> - Workflow filename: `release.yml`
> - Environment: *(leave empty)*

Ordering matters and is not obvious: a trusted publisher is configured **on an
existing package**, so the very first publish of a new package cannot use it.
For `@goodea/olimpyx` that first publish — `0.1.0` — already went out manually
on 2026-09-20 under a token, so the registration is available now and no
`NPM_TOKEN` secret is needed. Do not add one: a credential that nothing reads is
still a credential that can be read.

Until the registration exists, the publish step fails with `ENEEDAUTH`. That is
the expected failure, not a reason to reintroduce a token.

## Cutting a release

1. **Bump both manifests** to the new version — `packages/client/package.json`
   and the root `package.json`. They are kept in lockstep so that "the version
   of this release" stays one fact across the repository; `release.yml` refuses
   a tag when they disagree.

2. **Write the changelog section** in `CHANGELOG.md`, newest first:

   ```markdown
   ## [X.Y.Z] — YYYY-MM-DD
   One or two lines saying what this release is for.

   ### Added / Changed / Fixed / Removed

   - **Short bold claim.** What changed and what a consumer now sees.
   ```

   The heading must read exactly `## [X.Y.Z]`. `release.yml` extracts the
   section between this heading and the next `## [` for the GitHub Release body,
   and an empty extraction fails the job — a release whose notes are blank is
   worse than no release, because it looks intentional.

3. **Commit as `chore(release): X.Y.Z`**, touching only those three files. Open
   a PR and merge it to `main`. The release commit stays reviewable and separate
   from the work it ships.

4. **Tag the merge commit and push the tag:**

   ```bash
   git checkout main && git pull --ff-only
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

Everything after that is `release.yml`.

## What the tag triggers

| Gate | Why it is there |
|---|---|
| `check.yml` (the full CI) | A tag must not be able to ship what a pull request could not. |
| Tag ↔ manifests agree | Tag and manifest are independent statements of one fact; disagreement means the published artifact carries a version nobody intended. |
| Changelog section is non-empty | Fails before the build, not after, so a missing section costs seconds rather than minutes. |
| `npm pack` + global install | `olimpyx --help` and `olimpyx status` must run from the packed tarball — proves the artifact works before publishing, not after. |
| Library entry import | The package has a `bin`, so it would keep "working" with a broken `exports` map. `--help` cannot reach that half. |
| `npm publish --provenance` | Signed provenance attestation; requires `id-token: write` and a public repository, both of which hold here. |
| `gh release create` | One GitHub Release per tag, notes from the changelog, tarball attached. |

## Version numbers

Semver, against the *consumer-visible* surface — the `olimpyx` CLI commands and
flags, and the named exports of the library entry:

- **patch** — fixes and internals; no CLI or export surface changes.
- **minor** — new commands, new flags, new exports; existing ones keep working.
- **major** — a command, flag, export or output shape is removed or changes
  meaning. Pre-`1.0.0`, breaking changes go in the minor slot, and the changelog
  entry has to say so plainly.

Versions are never reused. npm refuses a republish of an existing version with
`E403`, which is the registry enforcing the same rule.

## The 0.1.0 exception

`0.1.0` was published by hand before this workflow existed and therefore has no
`v0.1.0` tag and no GitHub Release. It is deliberately not tagged after the
fact: pushing `v0.1.0` now would trigger a publish of a version that already
exists and fail on `E403`. The first tagged release is the next one.
