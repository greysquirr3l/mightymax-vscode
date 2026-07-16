---
name: owasp-api-security-2023
description: OWASP API Security Top 10 (2023) review expertise. Use when reviewing any JSON or RPC API endpoint — BOLA, broken authentication, server-side request forgery, and the rest of the API-specific list.
---

# OWASP API Security Top 10 (2023) review checklist

API-flavored security defects — the ones a generic "broken access
control" check misses because the request format is structured JSON,
not URL paths and form fields.

## API1 — Broken Object Level Authorization (BOLA)

The #1 API vulnerability. Authn present, authz by object missing —
the most common shape is `GET /api/users/{id}` returning the row
without checking `row.owner_id == request.user.id`.

- WRONG: `app.get('/users/:id', (req) => db.user.findOne({id: req.params.id}))`
- RIGHT: `app.get('/users/:id', (req) => { const u = await
db.user.findOne({id: req.params.id}); if (u.org_id !== req.user.org_id)
throw Forbidden; return u; })`
- Cues in a diff: a new `GET/PUT/DELETE /resource/:id` handler
  without an ownership check; a query by ID without an `AND
owner_id = ?` clause.

## API2 — Broken Authentication

- Login endpoint missing rate limit (credential stuffing).
- JWT validation skipped (`jwt.decode` instead of `verify`).
- `alg: none` accepted; signature verification bypassed.
- Tokens in URLs (logged by proxies and browser history) instead of
  `Authorization: Bearer`.
- WRONG: `const claims = jwt.decode(token); req.user = claims;`
  RIGHT: `jwt.verify(token, PUBKEY, { algorithms: ['RS256'] })`.

## API3 — Broken Object Property Level Authorization

- Mass-assignment: `Object.assign(user, req.body)` writes
  `is_admin`, `account_balance` from the request body.
- Excessive data exposure: `GET /users/:id` returns the password hash
  and reset token because the serializer includes every column.
- WRONG: `await db.user.update({ id }, req.body)` (any field writable)
- RIGHT: pick a whitelist:
  `await db.user.update({ id }, pick(req.body, ['name', 'email']))`.

## API4 — Unrestricted Resource Consumption

- No pagination on list endpoints (returns 1M rows).
- No rate limit per user/IP on expensive endpoints (image resize,
  search, export).
- No request-body size limit (10MB JSON accepted as default).
- No execution timeout on long queries.
- WRONG: `app.get('/search', async (req) => db.events.find(req.query))`
  with no `limit` and no time-budget.
- RIGHT: paginate (`limit/offset` or cursor), enforce a per-user
  rate, set a request-body size limit at the framework boundary.

## API5 — Broken Function Level Authorization

- Admin endpoints accessible to non-admin users because the role
  check is at the wrong layer.
- `if (user.is_admin)` checked on the client, not the server.
- WRONG: an `/api/admin/*` route group without a server-side
  `requireAdmin` middleware.
- RIGHT: every privileged route runs through an authorization
  middleware that re-checks the role server-side.

## API6 — Unrestricted Access to Sensitive Business Flows

- No anti-automation on signup, login, coupon-redeem, ticket-buy,
  password-reset flows (a bot scripts 1000 signups/sec).
- No CAPTCHA / rate limit / proof-of-work on these flows.
- Cues in a diff: a new `POST /signup` or `POST /redeem` endpoint
  without a rate-limit middleware.

## API7 — Server-Side Request Forgery (SSRF)

- Server fetches a user-supplied URL:
  `fetch(req.body.url)`.
- `requests.get(url, timeout=2)` where `url` is from the request
  body; `http://169.254.169.254/...` returns cloud metadata.
- WRONG: `const html = await fetch(req.query.callback_url)` for an
  OAuth-style "fetch URL on behalf of user" endpoint with no allow-list.
- RIGHT: parse the URL, resolve DNS yourself, check the IP is not
  in `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16`, `169.254.0.0/16`, `::1/128`, or cloud-metadata
  ranges, then fetch.

## API8 — Security Misconfiguration

- CORS `Allow-Origin: *` plus `Allow-Credentials: true`.
- Stack traces returned to clients.
- Default credentials for admin panels / DBs / message brokers.
- TLS not enforced (`http://` allowed for sensitive endpoints).
- Verbose error responses that leak internal paths, library versions,
  or stack frames.
- WRONG: `res.status(500).send(err.stack)` in production.

## API9 — Improper Inventory Management

- Old API versions (`/v1/`) still active after `/v2/` ships; the
  legacy version has the same data exposure as the old version did.
- Internal admin endpoints exposed at the public hostname.
- Debug endpoints (`/_debug`, `/healthz` exposing internals, `/metrics`
  unauthenticated).
- Cues in a diff: a new endpoint without an explicit deprecation
  policy; an endpoint added under `/internal/` but reachable from
  the public ingress.

## API10 — Unsafe Consumption of APIs

- Trusting upstream responses blindly: no schema validation, no
  length limit, no content-type check.
- Following upstream redirects to attacker-controlled URLs
  (SSRF-via-upstream).
- Passing upstream data directly into SQL / shell / template
  render without re-validation.
- WRONG: `const r = await fetch(partner_api); const data = await
r.json(); return data.items;` with no schema check.
- RIGHT: validate the upstream response against your own schema
  before returning; cap array length and string length; reject
  unexpected content types.

## See also

For the broader web-application context (SSRF, injection, crypto,
authn) also apply
[`owasp-top-10-2025`](./../owasp-top-10-2025/SKILL.md) — many
API-specific items (BOLA / BFLA / mass-assignment) are
access-control defects the general OWASP list summarizes as A01.
