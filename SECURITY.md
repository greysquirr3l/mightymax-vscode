# Security Policy

## Supported Versions

Only the latest published release receives security fixes. Older
versions are not patched; please update before reporting an issue
against them.

| Version | Supported          |
| ------- | ------------------ |
| 0.10.x  | :white_check_mark: |
| 0.9.x   | :x:                |
| < 0.9.0 | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report vulnerabilities by emailing the maintainers directly or using GitHub's [private security advisory reporting](https://github.com/greysquirr3l/mightymax-vscode/security/advisories/new).

Please include the following information in your report:

- Type of vulnerability (e.g., authentication bypass, credential exposure, etc.)
- Full paths of affected source files
- Location of the affected source code (tag/branch/commit)
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit it

## What to Expect

- You should receive an acknowledgment within 48 hours
- We will send a more detailed response within 7 days
- We will keep you informed of the progress toward a fix
- We may ask for additional information or guidance

## Security Measures

This extension implements several security safeguards:

### API Key Protection

- API keys are stored exclusively in VS Code's SecretStorage (never in settings or files)
- Keys are never logged to the output channel
- Authorization headers are redacted from all logs
- Keys are only transmitted over HTTPS to platform.minimax.io

### Diagnostic Stream Capture

The opt-in `mightyMax.captureStream` setting is the one setting that
writes model output to disk. It is designed so it cannot weaken the
guarantees above:

- **Disabled by default.** Nothing is captured unless explicitly enabled
- **Response events only** — text deltas, tool deltas, finish reasons. The transport calls it from the response-parsing loop, so it never receives the API key, the `Authorization` header, or a request body
- **Written outside the log channel** to `stream-capture.txt` in the extension's global storage, so the log channel's no-bodies rule is unaffected
- **Capped** at a rolling 2 MB window, so it cannot grow without bound
- **Fail-safe** — every filesystem error is swallowed, because a diagnostic must never break streaming

It does contain model output, which can echo content from your
conversation. That is why it is off by default. Enable it only to
investigate a suspected rendering defect, then turn it off and delete
the file.

### Workspace Trust

- The `mightyMax.baseUrl` setting is restricted in untrusted workspaces
- Agent-mode tools (apply-edit, run-in-terminal) respect VS Code's workspace trust boundary
- Virtual workspaces are supported with `limited` capability

### Dependency Security

- Production dependencies are audited on every push and on a weekly cron (`npm audit --omit=dev --audit-level=moderate`), which **does** block CI on moderate-and-above findings
- The full audit including dev dependencies runs at `--audit-level=high` but is `continue-on-error`, so a dev-only advisory does not block CI
- Dependencies are pinned in `package-lock.json`, which the release workflow enforces via `npm ci`
- Dependabot raises pull requests for dependency updates

### Code Security

- CodeQL static analysis runs on all PRs and weekly
- OSSF Scorecard monitors security best practices
- Gitleaks scans for accidentally committed secrets
- Dependency Review blocks vulnerable dependencies in PRs

## Security Disclosure Policy

When we learn of a security vulnerability, we will:

1. Confirm the problem and determine affected versions
2. Audit code to find similar issues
3. Prepare fixes for all supported versions
4. Release patches as soon as possible
5. Publish a security advisory on GitHub

## Attribution

We appreciate responsible disclosure and will acknowledge researchers who report valid security issues (unless they prefer to remain anonymous).
