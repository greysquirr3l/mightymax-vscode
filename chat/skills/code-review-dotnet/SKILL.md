---
name: code-review-dotnet
description: C# and .NET code-review expertise. Use when reviewing .cs, .csproj, .sln, .razor, or Program.cs files — async/await correctness, IDisposable hygiene, EF Core query patterns, and nullable-reference-type discipline.
---

# C# / .NET review checklist

Catches the defects a Roslyn-clean compile still ships: async traps, hidden
I/O, time-zone bugs, and EF Core queries that detonate under load.

## Async & threading

- **No `async void` outside event handlers** — exceptions in an `async void`
  method crash the process because there is no Task to surface them. WRONG:
  `public async void Save() { await _db.SaveAsync(); }` RIGHT: `public
async Task SaveAsync() { ... }` (event handlers can use `async void`).
- **No `.Result` / `.Wait()` on Tasks** — both block the calling thread and
  are a deadlock magnet in sync-over-async contexts (UI threads, classic
  ASP.NET). WRONG: `var user = GetUserAsync().Result;` RIGHT: `var user =
await GetUserAsync();` (propagate `async`).
- **`ConfigureAwait(false)` in library code** — keeps library awaits from
  marshalling back to a captured context the caller no longer needs. Skip
  it in app-level code (UI / ASP.NET Core) where the context matters.
- **No `Thread.Sleep` / `Task.Delay` as a synchronization primitive** —
  both are guesses; replace with a real signal (`SemaphoreSlim`,
  `Channel<T>`, `IAsyncEnumerable`).

## Resource & lifetime hygiene

- **`IDisposable` / `IAsyncDisposable` is held by `using` / `await using`** —
  WRONG: `var fs = File.OpenRead(path);` (leaks the handle on exception).
  RIGHT: `await using var fs = File.OpenRead(path);`.
- **No `new` of an `IDisposable` inside a `using` chain you don't dispose** —
  if the enclosing scope is long-lived, the disposable lives too long.

## Entity Framework Core

- **No client-side evaluation of `IQueryable`** — `Where(x =>
MyMethod(x))` translates the lambda but `MyMethod` runs in-memory and
  pulls the whole table. WRONG: `users.Where(u => DepartmentName(u) ==
"x")` RIGHT: `users.Where(u => u.Department.Name == "x")` and ensure
  `Department` is `.Include`d or a navigation.
- **No N+1 over navigation properties in a loop** — iterate `_db.Posts` and
  dereference `.Author` per row and you issue 1 + N queries. WRIGHT:
  `.Include(p => p.Author)` (or `.AsSplitQuery()` when joins explode).
- **Use `AsNoTracking()` on read-only queries** — saves the change-tracker
  memory and a write-lock per entity.

## Time & money

- **`DateTime.UtcNow`, never `DateTime.Now` in server code** — local time
  embeds the server's TZ and DST shifts into logs and persistence layers.
  `DateTimeOffset` is even safer when a wall-clock instant matters.
- **No `DateTime` for money** — float/double rounds; `decimal` for arithmetic,
  `Money` types or minor units (`int cents`) for storage.

## Error handling

- **No bare `catch (Exception)`** — swallows everything including
  `OperationCanceledException`, `OutOfMemoryException`, and bugs you
  meant to see. WRONG: `try { ... } catch (Exception) { }` RIGHT: catch
  the specific type you can recover from; let the rest propagate.
- **No exception-driven control flow** — throwing for a "not found" turn
  every conditional into an exception edge. Use `Try*` patterns or
  nullable returns.

## Nullable-reference-types

- **Don't suppress `!` without a comment** — `user!.Name` silences the
  analyzer and the next refactor may break the invariant silently. WRONG:
  `var x = dict[key]!;` RIGHT: `dict.TryGetValue(key, out var x) ? x :
throw new KeyNotFoundException(...)`.
- **Enable `<Nullable>enable</Nullable>` and `<TreatWarningsAsErrors>`**
  on every new project; the warnings are cheaper than the production bug.

## LINQ

- **No multiple enumeration of an `IEnumerable`** — each enumeration may
  re-execute the upstream query (DB round-trip, file read). WRONG:
  `if (q.Any()) Process(q);` (two enumerations) RIGHT: `var list =
q.ToList(); if (list.Count > 0) Process(list);`.
- **Avoid `IEnumerable` parameters in public APIs** — use `IReadOnlyCollection<T>`
  / `IReadOnlyList<T>` so the caller knows you may enumerate more than once.

## See also

For HTTP handlers, controllers, or middleware in this diff, also apply
[`owasp-top-10-2025`](./../owasp-top-10-2025/SKILL.md) and, if the diff
serves a JSON or RPC API, [`owasp-api-security-2023`](./../owasp-api-security-2023/SKILL.md).
