---
name: code-review-kotlin
description: Kotlin code-review expertise. Use when reviewing .kt, .kts, or build.gradle* files — nullability, coroutines, and concurrency correctness on the JVM.
---

# Kotlin review checklist

The Kotlin compiler catches the easy null bugs; this list catches
the runtime defects it does not — coroutine lifetime, blocking
calls hidden behind suspend, and swallowed cancellation.

## Nullability

- **No `!!` on platform types or untrusted input** — `!!` is "I, the
  author, swear this is non-null". WRONG: `val id = intent.getStringExtra("id")!!`
  RIGHT: `val id = intent.getStringExtra("id") ?: return` (or a typed
  error).
- **`@Nullable` / `@NotNull` annotations on Java interop** — Kotlin
  treats platform types as `T!`, which the compiler cannot check;
  annotate the Java side or wrap at the boundary.
- **`?.let { ... }` for nullable-side-effects is fine; chains of `!!`
  are not** — if you have three `!!` in a row, the model is wrong.

## Coroutines

- **`GlobalScope.launch` is forbidden in application code** —
  `GlobalScope` has no parent, so cancellation never reaches it; use a
  `CoroutineScope` tied to the lifecycle (viewModelScope, lifecycleScope).
  WRONG: `GlobalScope.launch { run() }` RIGHT: `viewModelScope.launch { run() }`.
- **No blocking IO in coroutines without `Dispatchers.IO`** — WRONG:
  `suspend fun fetch(): User { return db.runInTransaction { ... } }`
  on `Dispatchers.Main`. RIGHT: `withContext(Dispatchers.IO) { ... }`.
- **Don't swallow `CancellationException`** — re-throw it; the
  coroutine machinery relies on it for cancellation propagation.
  WRONG: `try { ... } catch (e: Exception) { log(e) }` RIGHT: `catch
(e: CancellationException) { throw e } catch (e: Exception) { ... }`.
- **`lateinit` is for non-null DI-managed dependencies only** — race
  conditions follow if two threads touch it before init. WRONG:
  `lateinit var cache: Map<K, V>` populated on first call. RIGHT:
  `private val cache = ConcurrentHashMap<K, V>()` or `@Volatile`.

## Data structures & mutation

- **No `var` fields in `data class` instances held in a `Set` or
  `Map` key** — mutation changes the hash code, and the entry becomes
  unreachable. WRONG: `data class Token(var expiresAt: Long)` used as
  a `Map` key. RIGHT: immutable `data class` or use a wrapper.
- **`MutableList` / `MutableMap` is exposed through an interface** —
  callers can mutate the collection out from under you. Use `List` /
  `Map` (read-only views) at the API boundary.

## Concurrency primitives

- **`synchronized` / `Mutex` held across suspension points** — same
  shape as Rust's std-Mutex-across-await: the lock guard is fine
  for sync sections but a suspending block inside a synchronized
  scope can deadlock under contention. WRONG: `synchronized(lock) {
withContext(Dispatchers.IO) { io() } }` RIGHT: `withLock` from
  `kotlinx.coroutines.sync.Mutex` for suspending, or move the
  `synchronized` inside the IO block.
- **`@Synchronized` on long methods is a performance foot-gun** —
  coarse lock; prefer a fine-grained mutex or a `ConcurrentHashMap`.

## Build & dependencies

- **Pinned dependency versions** — Gradle dependency without a
  version pulls "the latest", which silently upgrades between
  builds. Pin with `implementation("group:artifact:1.2.3")` or use
  `dependencyLocking`.
- **`buildSrc` or version catalog for shared versions** — magic
  strings spread across `build.gradle.kts` are a CI roulette wheel.

## See also

For HTTP handlers, Spring controllers, or Ktor routes in this diff,
also apply [`owasp-top-10-2025`](./../owasp-top-10-2025/SKILL.md)
and, if the diff serves an API,
[`owasp-api-security-2023`](./../owasp-api-security-2023/SKILL.md).
