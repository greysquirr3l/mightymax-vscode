---
name: code-review-rust
description: Rust code-review expertise. Use when reviewing .rs files, Cargo.toml, Cargo.lock, or unsafe blocks — memory safety, error handling, async, and clippy-class defects the borrow checker does not catch.
---

# Rust review checklist

The borrow checker catches lifetime errors; this list catches everything
it does not — panics on user input, blocking calls in async, and
`unsafe` blocks whose invariant lives only in someone's head.

## Panics on user input

- **No `.unwrap()` / `.expect()` on values an attacker can influence** —
  request bodies, file paths, env vars, parsed numbers. WRONG: `let n:
u32 = env::var("PORT").unwrap().parse().unwrap();` (a malformed env
  crashes the process). RIGHT: `let n: u32 = env::var("PORT")?
.parse().context("PORT must be a u32")?;`.
- **`unwrap()` is acceptable for invariants the program itself just
  established** (e.g. immediately after a `match` that covered every
  variant). If the invariant is non-local, write a comment.

## `unsafe`

- **Every `unsafe` block has a `// SAFETY:` comment** naming the
  invariant the block relies on. WRONG: `unsafe { *ptr.offset(i) }`
  RIGHT: `// SAFETY: i < len, validated above. unsafe { *ptr.add(i) }`.
- **`unsafe` is not a license to disable the borrow checker** — if you
  reach for `unsafe` to "make it compile", step back and check the
  ownership story.
- **No `unsafe impl Send` / `unsafe impl Sync` without a soundness
  argument** — a single missing field on the type can yield UB under
  thread spawn.

## Error handling

- **No `clone()` to appease the borrow checker on hot paths** — usually
  signals the wrong abstraction. WRONG: `let v = map.clone(); v.insert(k,
v2);` RIGHT: factor the borrow so the original can mutate without
  cloning.
- **Don't erase library errors to `Box<dyn Error>`** — callers can't
  branch on the failure mode. WRONG: `fn read(p: &Path) -> Result<String,
Box<dyn Error>>` in a library. RIGHT: a `thiserror` enum that names
  each variant.
- **Use `?` and `From` impls, not `.unwrap()`-on-Result** — `.unwrap()`
  on `Result` panics with the wrong context; `?` carries the type chain.

## Async

- **No blocking calls inside `async fn`** — `std::fs::read`, `std::net::*`,
  `sleep`, `std::sync::Mutex` lock guards across `.await`. WRONG:
  `async fn handle() { std::fs::read("a").unwrap(); }` RIGHT: spawn a
  blocking task on `tokio::task::spawn_blocking` (or use the async
  equivalent — `tokio::fs::read`).
- **`std::sync::Mutex` is never held across `.await`** — the lock guard
  is `!Send` and the await point yields to another task that may deadlock
  waiting on the same lock. Use `tokio::sync::Mutex` only where the
  critical section itself awaits.
- **Cancellation safety** — every `.await` is a cancellation point; if
  the surrounding future is mid-transaction, drop is a partial state.
  Use `tokio::select!` with care and wrap critical sections in
  cancellation-safe primitives.

## Numeric & casts

- **`as` casts truncate silently** — `i64::MAX as u32` becomes
  `0xFFFFFFFF` without complaint. WRONG: `let n = input.parse::<i64>()?
as u32;` RIGHT: `let n = u32::try_from(input.parse::<i64>()?).map_err(||
MyError::TooLarge)?;`.
- **Floating-point equality checks** — `==` on `f64` is almost always
  wrong; use an epsilon or `f64::total_cmp`.

## Concurrency & data sharing

- **Shared state is `Arc<T>` (immutable) or behind a lock/mutex** — a
  bare `&T` shared across threads requires `'static` and immutable data.
  `Rc<T>` is not `Send`.
- **`Send` / `Sync` impls are auto-derived only when sound** — a
  hand-rolled `unsafe impl` needs a `static_assertions` check or a
  miri test.

## See also

For HTTP handlers, RPC endpoints, or anything handling untrusted input,
also apply [`owasp-top-10-2025`](./../owasp-top-10-2025/SKILL.md) and, if
the diff serves an API, [`owasp-api-security-2023`](./../owasp-api-security-2023/SKILL.md).
