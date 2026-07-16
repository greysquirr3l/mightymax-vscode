---
name: code-review-go
description: Go code-review expertise. Use when reviewing .go files, go.mod, go.sum, or go.work — concurrency correctness, error propagation, and Go 1.22 loop-variable semantics.
---

# Go review checklist

`go vet` and `go build` cover the easy stuff; this list covers what
`go vet` does not — goroutine leaks, err-shadowing, and data races
that only fire under contention.

## Errors

- **No unchecked `err`** — `_ = doThing()` is almost always wrong; the
  compiler accepts it, your future self does not. WRONG: `data, _ :=
os.ReadFile(p);` RIGHT: `data, err := os.ReadFile(p); if err != nil {
return fmt.Errorf("read %s: %w", p, err) }`.
- **Wrap with `%w`, not `%v`** — `%w` preserves the chain for
  `errors.Is` / `errors.As`; `%v` flattens the error and breaks matching.
- **No `errors.New` for typed failures** — define a sentinel (`var
ErrNotFound = errors.New(...)`) or a custom type so callers can branch.

## Goroutines & concurrency

- **Every goroutine has an exit path** — a goroutine blocked on a channel
  the sender forgot is a leak. Trace the lifetime of every channel and
  `done` channel in the diff.
- **No `defer` inside a `for` loop body that runs many iterations** —
  defers run at function return, not loop iteration; the file handles
  pile up. WRONG: `for _, p := range paths { f, _ := os.Open(p); defer
f.Close() }` RIGHT: factor into a function, or call `f.Close()` at end
  of iteration.
- **No captured loop variables in goroutines before Go 1.22** — the
  variable address is shared. WRONG (pre-1.22): `for _, v := range vs {
go func() { use(v) }() }` all goroutines see the last `v`. RIGHT:
  `go func(v T) { use(v) }(v)`. Post-1.22, each iteration gets its own
  binding and this is fine.

## Maps, slices, and shared state

- **No writes to a nil map** — panics. WRONG: `var m map[string]int;
m["x"] = 1` RIGHT: `m := make(map[string]int); m["x"] = 1`.
- **Concurrent reads/writes on a map = data race** — even if the writes
  "look" safe. Use `sync.Map` for hot shared maps, or guard with a
  `sync.RWMutex`.
- **`time.After` in a `select` loop leaks the timer** — every iteration
  creates a new timer; old timers only fire (and free) when they expire.
  WRONG: `for { select { case <-time.After(time.Second): ... } }`
  RIGHT: `t := time.NewTicker(time.Second); defer t.Stop(); for { select
{ case <-t.C: ... } }`.

## Context propagation

- **`ctx` is the first parameter of every cancellable operation** —
  WRONG: `func fetch(url string) error` on a server handler. RIGHT:
  `func fetch(ctx context.Context, url string) error`.
- **No `context.Background()` inside library code** — caller's deadline
  is silently lost. Only `main` and top-level orchestration should use
  `Background`.
- **Don't store `ctx` in a struct** — pass it as a parameter; stored
  contexts outlive their request and confuse cancellation.

## Resource handling

- **`defer` for cleanup, immediately after the success check** — WRONG:
  `f, err := os.Open(p); if err == nil { defer f.Close(); ... }` (leaks
  on err). RIGHT: `f, err := os.Open(p); if err != nil { return err };
defer f.Close()`.
- **`http.Response.Body` is always closed** — leaks the connection.
  Use `defer resp.Body.Close()` right after the nil check.

## Types & interfaces

- **Accept interfaces, return structs** — a function that returns an
  interface forces callers into a type assertion at use-site.
- **No `interface{}` / `any` where a concrete type exists** — `any`
  erases intent; `json.RawMessage` is honest about deferred parsing.

## See also

For HTTP handlers, middleware, or RPC servers in this diff, also apply
[`owasp-top-10-2025`](./../owasp-top-10-2025/SKILL.md) and, if the diff
serves an API, [`owasp-api-security-2023`](./../owasp-api-security-2023/SKILL.md).
