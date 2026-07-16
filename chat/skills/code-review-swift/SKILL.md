---
name: code-review-swift
description: Swift code-review expertise. Use when reviewing .swift, Package.swift, or .xcodeproj files — optionals, concurrency, and memory management on Apple platforms.
---

# Swift review checklist

The Swift compiler catches a lot; this list catches the runtime
defects it does not — force-unwraps on user data, retain cycles
inside escaping closures, and main-thread UI from a background
task.

## Optionals

- **No force-unwrap `!` or `try!` on runtime data** — JSON responses,
  URL parameters, user defaults. WRONG: `let user = try!
JSONDecoder().decode(User.self, from: data)` (malformed JSON
  crashes the app). RIGHT: `let user = try? JSONDecoder()...; guard
let user else { return showError() }`.
- **No force cast `as!`** — type-checked at runtime; if the cast is
  wrong, crash. WRONG: `cell as! CustomCell` (wrong reuse identifier
  crashes). RIGHT: `guard let cell = cell as? CustomCell else { fatalError("misconfigured cell") }`
  only when the cast is truly guaranteed by configuration.

## Closures & retain cycles

- **`[weak self]` in escaping closures stored for later** — captures
  by default are strong; a long-lived callback retains self forever.
  WRONG: `URLSession.shared.dataTask(with: req) { data, _, _ in
self.handle(data) }` RIGHT: `{ [weak self] data, _, _ in
self?.handle(data) }`.
- **`[weak self]` is not always needed** — synchronous closures that
  don't outlive the call (e.g. `map`, `filter`, completion handlers
  that fire before the function returns) are fine with strong `self`.
  Use `weak` only when the closure is stored or escapes the lifetime
  of the call.

## Concurrency

- **No UI updates from a background queue** — UIKit/AppKit require
  main. WRONG: `DispatchQueue.global().async { label.text = "x" }`
  RIGHT: `DispatchQueue.main.async { label.text = "x" }` or
  `Task { @MainActor in label.text = "x" }`.
- **`@MainActor` / `actor` isolation is consistent** — mixing
  `@MainActor` and non-isolated calls into the same mutable state is
  a data race waiting to happen. WRONG: `actor Counter { var n = 0
}; counter.n = 1` from outside the actor.
- **`@unchecked Sendable` requires a comment** — `Sendable` is a
  static guarantee; bypassing it skips the compiler's race check.
  Use only with a documented safety argument.
- **`Task { ... }` is unstructured** — has no cancellation or
  priority inheritance. Prefer structured concurrency
  (`TaskGroup`, `async let`) or `Task.detached` only when you
  intentionally want to break structure.

## Resource & lifetime

- **`weak` / `unowned` references are intentional** — `unowned`
  crashes if the referenced object is already deallocated. WRONG:
  `unowned var delegate: MyDelegate` when the delegate may go away
  first. RIGHT: `weak` (with optional chaining at use-site) or a
  strong reference if lifetime is provably co-extensive.
- **NotificationCenter / KVO observers are removed** — every
  `addObserver` needs a matching remove, or a `Task`-style
  cancellable handle.

## Numeric & string

- **No `Int` for byte counts** — use `Int64` or `Data.count`. `Int`
  is 32-bit on 32-bit targets and overflows a 4 GB buffer.
- **No `as` numeric casts that truncate** — `Int64(x)` can trap if
  `x` doesn't fit; use the right `init(exactly:)` and handle nil.

## See also

For HTTP handlers, URLSession-based code, or anything handling
untrusted input, also apply
[`owasp-top-10-2025`](./../owasp-top-10-2025/SKILL.md) and, if the
diff serves an API,
[`owasp-api-security-2023`](./../owasp-api-security-2023/SKILL.md).
