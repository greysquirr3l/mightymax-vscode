---
name: code-review-python
description: Python code-review expertise. Use when reviewing .py, pyproject.toml, requirements.txt, or Pipfile files — async correctness, input handling, and deserialization safety.
---

# Python review checklist

`ruff` and `mypy` catch surface mistakes; this list catches the runtime
defects they do not — mutable defaults, SQL interpolation, and
deserialization of untrusted bytes.

## Functions & defaults

- **No mutable default arguments** — `def f(items=[])` shares one list
  across every call. WRONG: `def push(item, items=[]): items.append(item);
return items` RIGHT: `def push(item, items=None): if items is None:
items = []; ...`.
- **No bare `except:`** — catches `KeyboardInterrupt` and `SystemExit`.
  WRONG: `try: ... except: pass` RIGHT: `except Exception:` (with a
  justification) or, better, the specific exception you can recover from.
- **No `except Exception: pass`** — silently swallows bugs. Log with
  `logger.exception(...)` and re-raise or return a typed result.

## SQL & shell

- **No f-string / `+` / `%` SQL** — injection classic. WRONG:
  `cursor.execute(f"SELECT * FROM users WHERE id = {uid}")` RIGHT:
  `cursor.execute("SELECT * FROM users WHERE id = %s", (uid,))` (or
  SQLAlchemy / SQLModel parameter binding).
- **No `subprocess.run(..., shell=True)` with interpolated input** —
  shell-interpretation + injection. WRONG: `subprocess.run(f"ping
{host}", shell=True)` RIGHT: `subprocess.run(["ping", "-c", "1",
host], shell=False, check=True)`.

## File & resource handling

- **Files / locks / connections use `with`** — manual `open` +
  try/finally `close` is brittle. WRONG: `f = open(p); data = f.read();
f.close()` RIGHT: `with open(p) as f: data = f.read()`.
- **`tempfile.mkstemp` / `TemporaryDirectory`** — never roll your own
  `/tmp/foo` naming; race conditions and predictable-name attacks
  follow.

## Async

- **No blocking calls inside `async def`** — `requests.get(...)`,
  `time.sleep(...)`, `open(...).read()` block the event loop. WRONG:
  `async def fetch(): return requests.get(url).json()` RIGHT: `async
def fetch(): return await asyncio.to_thread(requests.get, url)` or
  use an async HTTP client (`httpx.AsyncClient`, `aiohttp`).
- **`asyncio.gather(..., return_exceptions=True)`** when you want every
  result; default `gather` short-circuits on the first exception.
- **Don't `await` inside `map` / `filter` / list comprehensions** —
  those are sync iterators; use `[await x async for x in xs]` or
  `asyncio.gather(*[coro(x) for x in xs])`.

## Types & annotations

- **No `# type: ignore` pile-ups** — every ignore hides a real type
  error. WRONG: a file with ten `# type: ignore` comments. RIGHT:
  annotate the boundary (parse with `pydantic` / `TypedDict`) and let
  the rest of the function be honest.
- **No `cast` to silence the type checker** — same as TypeScript's
  `as`. If `cast` is unavoidable, narrow first.
- **`Optional[T]` is not silently unwrapped** — `value.field` on an
  `Optional` is a real None-handling bug; check explicitly or use
  `assert value is not None` with a comment.

## Deserialization

- **No `pickle.loads` on untrusted input** — arbitrary code execution.
  Use JSON / MessagePack / protobuf for cross-process payloads; reserve
  pickle for in-process caches.
- **No `yaml.load(...)` (full loader) on untrusted input** — same
  RCE class. WRONG: `yaml.load(open(p))` RIGHT: `yaml.safe_load(...)`.

## See also

For HTTP handlers (Flask, FastAPI, Django), RPC servers, or anything
processing untrusted input, also apply
[`owasp-top-10-2025`](./../owasp-top-10-2025/SKILL.md) and, if the
diff serves an API,
[`owasp-api-security-2023`](./../owasp-api-security-2023/SKILL.md).
