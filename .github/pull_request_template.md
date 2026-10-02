# Release checklist

<!--
  Merge strategy for release PRs: SQUASH AND MERGE.

  v0.9.0–v0.9.3 were squash-merged, so `main` carries one commit per
  release titled "Release X.Y.Z — …". v0.9.4 was merged with a merge
  commit by accident, which left five commits in `main` and broke that
  pattern. The published artifact is identical either way; the point
  is a readable, bisectable `main` where each release is one commit.

  If GitHub offers "Create a merge commit" as the default on this
  repo, switch the repo setting back to squash-merge, or use the
  squash option on the PR itself.
-->

## Before opening

- [ ] `npm run compile` clean
- [ ] `npm run lint` clean (`--max-warnings 0`)
- [ ] `npm test` — 0 failures
- [ ] `CHANGELOG.md` has a dated section for this version
- [ ] `package.json` version bumped and matches the changelog heading
- [ ] Any new setting is declared in `contributes.configuration` —
      a setting the provider reads but the manifest does not declare
      has no Settings UI entry and no schema validation
- [ ] Documented defaults match the compiled constants (tool pin
      lists, numeric caps). Two surfaces disagreeing about a default
      is the same class of bug as two matchers disagreeing.

## Merging

- [ ] **Squash and merge.** Do not use a merge commit.
- [ ] Title follows `Release X.Y.Z — <summary>`

## After merge

- [ ] `git checkout main && git pull`
- [ ] `git tag -a vX.Y.Z -m "Release X.Y.Z — <summary>"`
- [ ] `git push origin vX.Y.Z`

The tag push is what fires `.github/workflows/release.yml`, which
packages the VSIX, creates the GitHub Release, and publishes to the
VS Code Marketplace. There is no other publish path — the tag _is_
the release trigger.

## Notes

- Tag `main`, never the release branch. Prior releases tag a commit
  that is an ancestor of `main`; tagging the branch would mean
  `main` does not contain the version users are running.
- Open VSX publishing is disabled pending the `greysquirr3l`
  namespace grant. The Marketplace is the only live channel.
