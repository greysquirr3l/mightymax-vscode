---
name: code-review-powershell
description: PowerShell code-review expertise. Use when reviewing .ps1, .psm1, or .psd1 files — strict mode, credential handling, path safety, and idempotent destructive operations.
---

# PowerShell review checklist

PSScriptAnalyzer catches the lint smells; this list catches the
runtime defects and security pitfalls it does not — credential leaks,
path injection, and the `$null` comparison trap that breaks
counter-intuitively.

## Strictness

- **Every script sets `Set-StrictMode -Version Latest`** — surfaces
  uninitialized variables, property access on `$null`, and array
  misuse. WRONG: `$name = $env:USR; "$($name.Length)"` when
  `$env:USR` is unset silently yields `0` (or worse). RIGHT: declare
  - `Set-StrictMode -Version Latest` at the top.
- **Every script sets `$ErrorActionPreference = 'Stop'` (or
  explicitly per-call)** — default is `Continue`, which lets
  non-terminating errors vanish. `Stop` makes the script fail loudly.

## Injection & execution

- **No `Invoke-Expression` on any interpolated input** — RCE.
  WRONG: `iex "Get-Process $name"` (also: `$name` is interpreted as
  an expression). RIGHT: `Get-Process -Name $name` (parameterized).
- **`&` (call operator) on user input** — same risk class; prefer
  named cmdlets with parameters.
- **No `iex (Get-Content $path)` for config** — config files should
  parse, not execute.

## $null comparisons

- **Always place `$null` on the LEFT of `-eq`** — array on the right
  coerces. WRONG: `if ($items -eq $null)` returns `$null` when
  `$items` is a single-element array, not `$true`. RIGHT:
  `if ($null -eq $items)` (and use `-is [array]` to actually check
  for arrays).

## Paths & expansion

- **No unquoted paths with spaces** — WRONG: `Get-Content
$path\report.txt` when `$path` is `C:\My Folder` becomes `C:\My`
  (literal) `\Folder\report.txt`. RIGHT: `Get-Content
-Path (Join-Path $path 'report.txt')` or always quote:
  `Get-Content "$path\report.txt"`.
- **`Join-Path` not string concat** — `Join-Path` normalizes
  separators; `$a\$b` does not.

## Credentials

- **No plaintext passwords in code, env, or config files** — use
  `Get-Credential`, the SecretManagement vault
  (`Get-Secret -Name 'x'`), or a CI secret. WRONG: `$pwd =
'hunter2'; Connect-Server -Password $pwd` RIGHT: `$cred =
Get-Secret -Name 'prod' -AsCredential; Connect-Server -Credential $cred`.
- **`ConvertTo-SecureString` with `-AsPlainText` from a variable** —
  still a string in process memory; the difference vs plaintext is
  bookkeeping, not security. Treat it the same.

## Idempotency & safety

- **Destructive functions support `-WhatIf` and `-Confirm`** —
  `-WhatIf` is the safe-rail the platform already ships; not
  supporting it is hostile. WRONG: `function Remove-Stale { Remove-Item
$path }` with no `-WhatIf`. RIGHT: wrap destructive calls in
  `SupportsShouldProcess` and call `ShouldProcess(...)`.
- **`-Force` is documented or commented** — `-Force` overrides
  safety checks; readers need to know why it's safe here.

## Module hygiene

- **Module exports are explicit** — `Export-ModuleMember -Function
'Public-*'` so internal helpers don't leak into the consumer's
  scope.
- **`#Requires` declares the runtime constraints** — `#Requires
-Version 7.4`, `-PSEdition Core`, `-Modules Az.Accounts`.

## See also

For scripts that drive HTTP APIs, automation across tenants, or
anything handling tokens, also apply
[`owasp-top-10-2025`](./../owasp-top-10-2025/SKILL.md). Most
PowerShell automation is internal; an external API consumer falls
under [`owasp-api-security-2023`](./../owasp-api-security-2023/SKILL.md).
