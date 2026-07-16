# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1.0 | :x:                |

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

### Workspace Trust

- The `mightyMax.baseUrl` setting is restricted in untrusted workspaces
- Agent-mode tools (apply-edit, run-in-terminal) respect VS Code's workspace trust boundary
- Virtual workspaces are supported with `limited` capability

### Dependency Security

- All dependencies are audited via `npm audit` in CI
- Dependabot monitors for security updates
- Dependencies are pinned in package-lock.json
- High-severity vulnerabilities block CI/CD

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
