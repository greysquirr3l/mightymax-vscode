---
name: code-review-bash
description: Bash and POSIX shell code-review expertise. Use when reviewing .sh, .bash, .bashrc, or Dockerfile RUN blocks — quoting, error mode, and injection hazards.
---

# Bash / POSIX shell review checklist

`shellcheck` catches the lint-class mistakes; this list catches the
runtime and security defects it does not — word-splitting traps,
quoting collapse, and `eval`-class injection.

## Error mode

- **`set -euo pipefail` at the top** — `-e` exits on error, `-u` on
  unset variable, `-o pipefail` propagates the pipe's first failing
  command. WRONG: a 200-line script with no `set` line; a failure
  halfway through silently continues. RIGHT: `set -euo pipefail` (or
  `set -Eeuo pipefail` if you trap ERR) as line 2.
- **Caveat: `set -e` does not exit on commands in `&&` chains,
  subshells' last command, or functions called from `if`.** When
  any of those matter, check the exit code explicitly
  (`if ! cmd; then ...; fi`) or use `|| exit 1`.

## Quoting & word-splitting

- **Always quote expansions** — `"$var"` not `$var`. WRONG: `cp $src
$dst` when `$src` contains a space (becomes two args). RIGHT:
  `cp "$src" "$dst"`.
- **`for f in $(ls ...)` is word-splitting + glob + filename injection
  rolled into one** — use a glob (`for f in *.txt`) or
  `while IFS= read -r f; do ...; done < <(find . -name '*.txt')`.
- **`$@` is `"$@"`** — `$@` (unquoted) word-splits on `$IFS`; `"$@"`
  preserves each arg as its own word. Always `"$@"`.

## Injection

- **No `eval` and no backtick command substitution on any interpolated
  input** — `eval` interprets a string as shell; backticks re-parse
  too. WRONG: `eval "echo $user_msg"` RIGHT: `printf '%s\n'
"$user_msg"`.
- **Bash arrays for arguments to child commands** — WRONG:
  `ssh $user@$host "rm $path"` (path with spaces breaks the remote
  command). RIGHT: `ssh "$user@$host" "rm $(printf '%q' "$path")"`.

## File parsing

- **Never parse `ls`** — `ls` is for humans; `*.txt`, `find`, or
  `stat` are for scripts. WRONG: `files=$(ls)` (mangles spaces,
  newlines, unicode). RIGHT: `files=(*.txt)`.
- **`[ ]` vs `[[ ]]` — prefer `[[ ]]`** — `[[ ]]` is a bash keyword
  (no word-splitting, pattern-match with `==`, no quoting most
  vars). `[` is the legacy `/usr/bin/[` and word-splits. WRONG:
  `if [ $foo = "bar" ];` when `$foo` is empty (syntax error). RIGHT:
  `if [[ $foo == "bar" ]];`.
- **`grep` patterns are not regex unless `-E`** — the default is
  BRE; `|` is literal. WRONG: `grep "a|b"` RIGHT: `grep -E "a|b"`.

## Temp & cleanup

- **`mktemp`, not `/tmp/foo`** — predictable names enable
  symlink-attack races. WRONG: `f=/tmp/foo.$$; echo secret > $f`.
  RIGHT: `f=$(mktemp); trap 'rm -f "$f"' EXIT; echo secret > "$f"`.
- **`trap` cleans up on EXIT** — every script that creates temp files
  or background processes needs `trap 'cleanup' EXIT INT TERM`.
- **`umask 077` for files containing secrets** — default `umask 022`
  makes the file world-readable.

## Numeric / string comparison

- **`[[ ]]` for strings, `(( ))` for arithmetic** — `[[ $a -eq $b ]]`
  does numeric compare but `-eq` is a syntactic landmine; `(( a == b
))` is clearer.
- **No `$RANDOM` for security** — predictable; use `/dev/urandom` or
  `openssl rand -hex 16`.

## Subshell pitfalls

- **Pipeline runs in a subshell** — variables set in `cmd | while read
...; do x=...; done` do not survive the pipeline. WRONG: `cat file
| while read line; do count=$((count+1)); done; echo $count` (count
  is unset). RIGHT: `while read -r line; do count=$((count+1)); done
< file; echo "$count"` (process substitution `< <(cmd)` also avoids
  the subshell).

## See also

For scripts that drive HTTP APIs, talk to cloud credentials, or run
as automation in CI, also apply
[`owasp-top-10-2025`](./../owasp-top-10-2025/SKILL.md). If the
script consumes a remote API as part of its data flow,
[`owasp-api-security-2023`](./../owasp-api-security-2023/SKILL.md)
applies on the other side of that call.
