---
name: owasp-top-10-2025
description: OWASP Top 10 (2025) review expertise. Use when reviewing any HTTP handler, endpoint, controller, or middleware — broken access control, injection, supply-chain failures, and the rest of the OWASP 2025 list.
---

# OWASP Top 10 (2025) review checklist

Reference list of the 2025 categories with the "what it looks like in
a diff" cues. Pair with the matching language skill for handler
flavor (`code-review-python` for Flask, `code-review-typescript` for
Express, etc.).

## A01 — Broken Access Control

- Authn checks present but authz missing: `if user:` then `db.query(...)`
  without `if user.org_id == row.org_id:`.
- IDOR-by-URL: `/api/users/{id}` accepts any authenticated user's ID.
- CORS `Access-Control-Allow-Origin: *` plus `Allow-Credentials: true`.
- Path traversal via concatenation:
  `open(f"./uploads/{req.params.name}")` — `../etc/passwd` works.
- WRONG: `app.get('/files/:name', (req, res) => res.sendFile(req.params.name))`
  RIGHT: resolve to an absolute path under a fixed root and verify
  `resolvedPath.startsWith(allowedRoot)`.

## A02 — Security Misconfiguration

- Default credentials left in config (`admin/admin`, `root/changeme`).
- Debug mode enabled in production (`DEBUG=true`, `FLASK_DEBUG=1`).
- Stack traces returned to clients (`e.printStackTrace()` →
  HTTP 500 body includes class names).
- Verbose `Server:` and `X-Powered-By:` headers that advertise the stack.
- Open admin ports, exposed `.git/`, exposed `.env`, exposed S3 buckets.
- WRONG: `app.run(debug=True, host='0.0.0.0')` RIGHT:
  `app.run(debug=False)` behind a real WSGI server with a hardened
  reverse proxy.

## A03 — Software Supply Chain Failures

- Dependencies without integrity (`pip install <url>` without a hash;
  `npm install <pkg>` without `package-lock.json`).
- Unpinned Docker base images (`FROM python`) — pulls whatever's
  latest on build day.
- Build scripts that `curl | sh` from a non-pinned URL.
- Vendored binaries without checksums.
- WRONG: `RUN curl -L https://example.com/install.sh | sh` RIGHT:
  `RUN curl -fsSL https://example.com/install-v1.2.3.sh | sh` plus a
  checksum verification step.

## A04 — Cryptographic Failures

- Plaintext protocols for sensitive data (`http://`, `ftp://`,
  `smtp://` for tokens).
- `md5` / `sha1` for passwords or signatures.
- Hard-coded keys in source (`const KEY = "abcd1234"`).
- TLS verification disabled (`requests.get(url, verify=False)`,
  `tls_skip_verify: true`).
- WRONG: `crypto.createHash('md5').update(password).digest('hex')`
  RIGHT: `bcrypt.hash(password, 12)` (or argon2id).

## A05 — Injection

- SQL via concatenation (parameterized queries missing).
- Shell injection via `subprocess(shell=True)`, `child_process.exec`,
  `Runtime.exec("bash -c " + userInput)`.
- NoSQL injection via JSON object operators (`{$gt: ""}`).
- LDAP / XPath / template injection via unescaped input.
- WRONG: `cursor.execute(f"SELECT * FROM users WHERE id = {uid}")`
  RIGHT: `cursor.execute("SELECT * FROM users WHERE id = %s", (uid,))`.

## A06 — Insecure Design

- Business-logic flaws that no input filter catches: a "transfer
  money" endpoint with no negative-amount check; a "reset password"
  flow that doesn't invalidate existing sessions.
- Threat-model gaps: feature built without asking "what stops an
  attacker from doing this 1000 times in parallel?".
- Missing rate limits on sensitive endpoints.
- WRONG: a coupon-redeem endpoint that accepts the same code twice
  because the validation step doesn't check `redeemed_at IS NOT NULL`.

## A07 — Authentication Failures

- Login over HTTP.
- Predictable session IDs or tokens (sequential, JWT with `alg: none`,
  unsigned cookies).
- Sessions that don't expire, or "remember me" tokens that are
  effectively permanent.
- Password storage without work factor (`md5`, `sha1`, single-round
  bcrypt).
- Credential stuffing mitigations missing (no rate limit on `/login`,
  no MFA, no breached-password check).

## A08 — Software or Data Integrity Failures

- Auto-update without signature verification.
- Deserialization of untrusted bytes (`pickle.load`, `yaml.load`,
  Java `ObjectInputStream`, .NET `BinaryFormatter`).
- CI/CD pipeline that doesn't verify artifacts (no checksums, no
  SLSA-style provenance).
- Webhook payloads accepted without HMAC verification.
- WRONG: `data = pickle.loads(request.body)` from an HTTP endpoint
  RIGHT: use a typed deserializer (JSON + schema validation) and
  never deserialize arbitrary bytes from the network.

## A09 — Security Logging & Alerting Failures

- Login failures not logged.
- Sensitive data in logs (`logger.info(f"User {email} signed in with
password {password}")`).
- Logs that an attacker can clear (write access to log storage).
- No alerting on spikes of 401/403 (account-takeover signal).
- WRONG: `console.log(req.body)` RIGHT: log a structural summary
  (`{event: "login_attempt", user_id_hash: "...", result: "fail"}`).

## A10 — Mishandling of Exceptional Conditions

- Empty `except:` / `catch (_) {}` blocks that swallow every failure.
- Catch-all that re-throws as a 500 with stack trace exposed.
- Fallback paths that silently downgrade security checks (e.g.
  "TLS failed, retry over plaintext").
- Resource leaks on the error path: `try { f = open(p) } finally { f.close() }`
  when `open` itself throws.
- WRONG: `try { critical_security_check() } catch (e) { /* ignore */
return true }` RIGHT: log and either retry-with-explicit-policy or
  fail closed.

## See also

For endpoints that serve JSON/RPC APIs, also apply
[`owasp-api-security-2023`](./../owasp-api-security-2023/SKILL.md) —
BOLA, broken function-level auth, and SSRF are API-specific flavors
of the OWASP categories above.
