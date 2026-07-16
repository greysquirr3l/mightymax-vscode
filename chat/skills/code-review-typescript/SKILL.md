---
name: code-review-typescript
description: TypeScript and JavaScript code-review expertise. Use when reviewing .ts, .tsx, .js, .jsx, mjs, cjs, or package.json files — strictness, async safety, and untyped boundaries.
---

# TypeScript / JavaScript review checklist

The type system catches shape errors; this list catches the runtime
traps it cannot — floating promises, listener leaks, and untyped
JSON at the trust boundary.

## Types & strictness

- **No `any` to silence a real error** — `as any` and `<any>` hide the
  bug, not fix it. WRONG: `const user = req.body as any; user.id;` RIGHT:
  parse with Zod / Valibot / TypeBox and use the inferred type.
- **No `as` casts that erase errors the compiler just caught** — same
  defect, different syntax. If the cast is unavoidable, narrow first
  and comment why.
- **`==` is forbidden, `===` always** — `==` coerces; `"" == false` is
  `true`. WRONG: `if (count == 0)` RIGHT: `if (count === 0)`.
- **Every discriminated union has an exhaustiveness check** — WRONG:
  `switch (kind) { case "a": ... }` (silently no-ops on new variants).
  RIGHT: `default: { const _: never = kind; throw new Error(_); }`.

## Async & promises

- **No floating promises** — calling `async` without `await` swallows
  rejections and loses cancellation. WRONG: `this.load();` where
  `load` returns a Promise. RIGHT: `await this.load();` or `.catch(...)`.
  ESLint's `@typescript-eslint/no-floating-promises` rule is the cheap
  enforcement.
- **No mutation of shared state across `await` in async handlers** — the
  interleaving produces lost updates and stale reads. WRONG:
  `request.foo = 1; await remote(); request.bar = 2;` (concurrent
  requests see `foo` but not `bar`). RIGHT: snapshot to a local,
  mutate, write back atomically.
- **`Promise.all` vs `Promise.allSettled`** — `all` short-circuits on
  the first rejection; use `allSettled` when you want every result.

## I/O boundaries

- **`JSON.parse` results are never trusted** — the parsed value is
  `any`. WRONG: `const u = JSON.parse(raw); u.email;` RIGHT: parse
  with a schema and use the typed result.
- **`fs.readFile` / `fs.readFileSync` with the right encoding** —
  default is `Buffer`; forgetting `.toString("utf8")` produces
  `Buffer` in places expecting strings.
- **`child_process.exec` strings are shell-interpreted** — prefer
  `execFile` with an arg array; never interpolate user input into
  `exec`.

## Resources & Node-specific

- **Event listeners are removed on teardown** — every `emitter.on(...)`
  leaks if not paired with `emitter.off(...)` (or `AbortSignal`).
  WRONG: `this._listener = (e) => ...; target.on("event", this._listener);`
  RIGHT: pair with `signal.addEventListener("abort", () =>
target.off("event", this._listener));`.
- **Timers are cleared on unmount** — `setInterval` keeps the process
  alive after teardown. WRONG: `setInterval(this.poll, 1000);` in a
  React effect. RIGHT: `useEffect(() => { const id = setInterval(...);
return () => clearInterval(id); }, [...])`.
- **Streams are drained / destroyed on error** — a half-read stream
  keeps the underlying file handle open.

## ESM/CJS & packages

- **`import` paths match the runtime** — `import` from a CommonJS
  package without `.default` for the export shape.
- **`package.json` `type` field matches file extensions** — mixed
  `.js` files with `type: module` need `.cjs`/explicit `module`
  fields.

## See also

For HTTP handlers, RPC servers, or anything that touches `req`/`res`,
also apply [`owasp-top-10-2025`](./../owasp-top-10-2025/SKILL.md) and,
if the diff serves an API,
[`owasp-api-security-2023`](./../owasp-api-security-2023/SKILL.md).
