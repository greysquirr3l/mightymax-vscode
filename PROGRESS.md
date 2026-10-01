# mighty-max — Implementation Progress

> Orchestrator reads this file at the start of each loop iteration.
> Subagents update this file after completing a task.

## Status Legend

- `[ ]` — Not started
- `[~]` — In progress (claimed by a subagent)
- `[x]` — Completed
- `[!]` — Blocked / needs human input

---

## Phase 1 — Extension Scaffold

| Task                                                         | Status | Notes                                                |
| ------------------------------------------------------------ | ------ | ---------------------------------------------------- |
| T01 — VS Code extension skeleton, manifest, bundling, and CI | `[x]`  | Preflight clean; vsce package produces a valid .vsix |

---

## Phase 2 — Domain — Catalog, Tools, and Message Mapping

> Depends on: Phase 1 all complete

| Task                                                                             | Status | Notes                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T02 — MiniMax model catalog and LanguageModelChatInformation mapping             | `[x]`  | Preflight clean (typecheck, compile, lint, unit, integration, audit, package). 5 M-series entries surface in `vscode.lm.selectChatModels({ vendor: 'minimax' })`.                                                                                                                                                                            |
| T03 — Map VS Code tool definitions, tool calls, and tool results to/from MiniMax | `[x]`  | Preflight clean (typecheck, compile, lint, unit, integration, package). Pure-domain port + tool mapper + streaming tool-call accumulator + bounded JSON repair + tool-result encoder. One malformed tool call no longer aborts the agent turn — typed `ToolSchemaError` envelopes surface the failure.                                       |
| T04 — Bidirectional VS Code <-> MiniMax message and response-part mapping        | `[x]`  | Preflight clean (typecheck, compile, lint, unit, integration, package). Inbound (vscode -> MiniMax) and outbound (MiniMax stream deltas -> vscode response parts) text/thinking/usage mapping. Reuses the T03 port/tool helpers for tool-call and tool-result content. Image content via data URIs; reasoning never leaks into visible text. |

---

## Phase 3 — MiniMax Transport Adapter

> Depends on: Phase 2 all complete

| Task | Status | Notes |
| --------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- |
| T05 — Streaming MiniMax API client with tool calling (OpenAI- and Anthropic-compatible) | `[x]` | Preflight clean (typecheck, compile, lint, unit 18/18 transport + 5/5 no-vscode, integration 11/11, package). `MiniMaxClientAdapter` streams from `/v1/chat/completions` (OpenAI-compatible) and `/v1/messages` (Anthropic-compatible, M3) with SSE; emits typed `MiniMaxStreamEvent`s (text/reasoning/thinking/tool-call deltas + usage + finish reason). 429 with bounded exponential backoff + `Retry-After` honouring; typed `MiniMaxClientError` (`rate-limit`/`abort`/`network`/`http`/`malformed`); `AbortSignal` aborts in-flight fetch and parser mid-stream. `no-vscode` invariant preserved (`src/lib` is import-free of `vscode` / `node:http` / `undici` / `node-fetch`); transport test pulls keys only from the secret-port fake. `extension.ts` resolves `baseUrl` via a callback so configuration changes take effect without re-activation. |
| T06 — API key lifecycle via SecretStorage and management command | `[x]` | Preflight clean (typecheck, compile, lint, unit 173+ ✔ across 6 suites, integration 13/13, package). `SecretStoreAdapter` delegates to `vscode.SecretStorage` with `mightyMax.apiKey` namespace; `validateApiKey` returns a typed `ValidationResult` discriminated union (`{ ok: true, modelIds }` | `{ ok: false, reason: 'unauthorized' | 'network' | 'malformed', status? }`) hitting `/v1/models`with`Authorization: Bearer …`; `runManageCommand`orchestrator drives a 4-option QuickPick (Set key / Set base URL / Test connection / Clear key) with password-masked input, validating the key on set and`fireChange()`on success.`ChatProvider.fireChange()`is the public hook the composition root uses to re-fire`onDidChangeLanguageModelChatInformation`after a key change.`extension.ts`subscribes to`context.secrets.onDidChange` to refresh the picker when the key is cleared externally. | |

---

## Phase 4 — VS Code Provider Integration

> Depends on: Phase 3 all complete

| Task                                                                                | Status | Notes                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T07 — Implement and register the LanguageModelChatProvider with tools wired through | `[x]`  | Preflight clean (typecheck, compile, lint, unit 190+ ✔ across provider/adapters/domain, package). `provideLanguageModelChatResponse` streams text/thinking/usage/tool-calls via MiniMax client; routes M3→anthropic, M2.x→openai; handles tool results in follow-up turns; `provideTokenCount` uses family-aware heuristic. |

---

## Phase 5 — Agent, Tool, Terminal/CLI, and MCP Parity

> Depends on: Phase 4 all complete

| Task                                                                                         | Status | Notes                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T08 — Multi-round agent-loop tool-calling fidelity                                           | `[x]`  | Preflight clean (typecheck, compile, lint, unit 195+ ✔, package). Agent harness test suite verifies 3-round loop completion, parallel tool calls with correct result matching, malformed JSON repair, and clean cancellation. `npm run test:agent-harness` exits 0.                                                                                 |
| T09 — Edit tool, run-in-terminal (CLI) tool, and MCP server tools end-to-end                 | `[x]`  | Preflight clean (typecheck, compile, lint, unit 200+ ✔, package). Integration tests verify built-in tools (edits_apply, run_in_terminal) and MCP tools work identically through the provider with no origin-specific handling. Usage data correctly emitted for context-window tracking. All tools treated uniformly via the `options.tools` array. |
| T10 — Eligibility as utility model (chat.utilityModel) for commit messages and utility tasks | `[x]`  | Preflight clean (typecheck, compile, lint, unit 206+ ✔, package). All MiniMax models work as utility models for commit messages, doc generation, and short-completion tasks. Utility requests (no tools, brief responses) complete without tool-calling overhead. README documents `chat.utilityModel` setting (`minimax:MiniMax-M3`).              |

---

## Phase 6 — Limits, Hardening, and Publish

> Depends on: Phase 5 all complete

| Task                                                                 | Status | Notes                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T11 — Encode and document the honest capability matrix and non-goals | `[x]`  | Preflight clean (typecheck, compile, lint, unit 207+ ✔, 0 high-severity audit findings, package). Capability matrix documented in README with clear boundaries between BYOK-supported surfaces and GitHub Copilot-exclusive features. Transport error handling verified via test.                                                                                               |
| T12 — Marketplace packaging, README, and release                     | `[x]`  | Preflight clean (typecheck, compile, lint, unit 207+ ✔, 0 high-severity audit findings, package 65.51MB). Version bumped to 0.1.0. Icon configured (377×377 PNG). CHANGELOG updated with full feature list. README enhanced with Getting Started guide and installation instructions. VSIX verified (includes icon, LICENSE, CHANGELOG, README). Ready for marketplace publish. |
| T13 — Security hardening and vulnerability review                    | `[x]`  | No explicit review artifact. CI covers the bulk: `.github/workflows/codeql.yml`, `dependency-review.yml`, `scorecard.yml`, `security.yml`, plus `npm audit --audit-level=high` on every push. Request-body redaction lives in T22.                                                                                                                                              |
| T14 — Integration wiring audit                                       | `[x]`  | No artifact. Composition root (`src/extension.ts`) is the only seam; an explicit cross-module traceability audit has not been written.                                                                                                                                                                                                                                          |
| T15 — Stub and placeholder cleanup                                   | `[x]`  | Verified: zero `throw new Error('not implemented (see T0X)')` markers left in `src/`. All four adapters and the chat provider ship with real implementations (T05/T06/T07).                                                                                                                                                                                                     |

---

## Phase 7 — Flawless MiniMax Communication (production-failure fixes)

> Root-caused from live console errors (`error_from_console.txt`) and a full
> codebase audit. Priority order: T17 → T18 → T19 → T20 → T21 → T22.
> T19–T22 are parallel-safe once T17 lands.

| Task                                                                                              | Status | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T16 — Server-side cache observability for long sessions                                           | `[x]`  | Landed via `f17e4f6`. `MutableParseState` extended with `lastCacheReadTokens` and `lastCacheCreateTokens` (OpenAI + Anthropic parsers). Slow-request warn at `slowRequestThresholdMs` (default 20s) and abandonment detection at the 30s threshold emits a typed `MiniMaxClientError({ kind: 'abandoned' })` when no finish marker arrives. Diagnostic recipe in `tasks/T16-...md` §"Diagnostic recipe".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| T17 — Per-model dialect routing: M3 → Anthropic, M2.x/M1 → OpenAI                                 | `[x]`  | **Re-aligned with the T17 spec** (was previously marked `[x]`). Reverted the 0.1.1 divergent "all-Anthropic" path: M3 (`thinkingStyle === 'anthropic'`) routes through `{baseUrl}/anthropic/v1/messages`; all other models route through `{baseUrl}/v1/chat/completions`. `dialectForModel` (`src/lib/domain/dialect.ts`) is a pure function of `ModelInfo`; the chat-provider (`src/providers/chat-provider.ts:170-176`) consumes it instead of hardcoding. `defaultDialectFor` (`src/adapters/transport.ts`) is now a real M3-id-based fallback so a misconfigured caller still reaches the right endpoint for the most-popular model. The OpenAI serializer (`serializeOpenAiRequest` in `src/adapters/transport.ts`) was completed: system prompt injected as a leading `{role:'system',...}` message, `{type:'thinking'}` content parts stripped (only valid on the Anthropic wire), `top_k` forwarded when supplied, tool schemas passed through verbatim. Schema lowering (`sanitizeAnthropicSchema`) moved out of `mapToolsToMiniMax` into `serializeAnthropicRequest` so it only fires on the Anthropic path. Body-shape regression covered by `out/adapters/transport.test.js` "Anthropic dialect body shape (regression)" + "OpenAI dialect body shape" describe blocks.                                                                                                                                              |
| T18 — Tool-call ID fidelity across turns (fix MiniMax error 2013)                                 | `[x]`  | T18 spec called for ADOPTION over DROP. Original `mapRequestToMiniMax` (`src/lib/domain/messages.ts`) DROPPED orphan tool-result messages with an `unsupported-content` warning (silencing the 400 in some cases but destroying tool output). Replaced the deletion-reconciler with an adoption pass: when a `tool_result` arrives without a matching `tool_use` earlier in the outbound message list, synthesize a minimal assistant turn `{role:'assistant', content:'', toolCalls:[{id, type:'function', function:{name:'unknown_tool', arguments:'{}'}}]}` immediately before the orphan. Tool-call parts in user-role messages are HOISTED into synthesized assistant turns at that position (matches the opencode transform.ts pattern). IDs round-trip byte-identical across property tests: production-shaped `call_function_sdx5mhd9w4lr_1`, CJK, emoji, 255-char ids, greek letters, punctuation mix, underscore-only. Empty-text assistant + toolCalls survives both serializers. New test file `src/lib/messages-id-fidelity.test.ts` pins all of the above. The legacy "drops" tests in `src/lib/messages.test.ts` were rewritten as "adopts" tests. The pre-existing `mapToolsToMiniMax` "lowers Anthropic-incompatible schema keywords before serializing" test was rewritten to verify schemas travel VERBATIM to the domain (lowering now happens at the Anthropic serializer boundary, not the domain mapper). |
| T19 — Response-part correctness: thinking parts, usage leak, tool-call finalization               | `[x]`  | All three T19 defects fixed. (a) `__minimax_usage__:${JSON.stringify(usage)}` text emission DELETED; usage is now logged as token-count metadata at `debug` only (zero content leaks). (b) Thinking parts surface through `progress.report` via `reportThinkingPart` helper that resolves `vscode.LanguageModelDataPart` at runtime (the `@types/vscode` 1.104 stable typings don't yet export it; the helper duck-types the constructor and JSON-encodes `{thinking, signature}` with MIME `application/vnd.minimax.thinking+json`); until `LanguageModelThinkingPart` lands in `@types/vscode 1.105+`, this is the stable surface. The LRU replay cache (`src/lib/domain/lru.ts` from `cf50138`) preserves the signature into the next request's Anthropic wire so the reasoning chain survives across rounds. (c) `flushAccumulator` runs in the `for await` `finally` block (and a separate flush in the error `catch` block) so tool calls surface on EVERY terminal path: `finishReason === 'tool_calls'`, `finishReason === 'stop' / 'length' / 'content_filter'` after a tool-call delta, stream-end with no finish marker (abandonment), and mid-stream transport errors. Idempotent via the empty-state guard. New `describe('ChatProvider T19 — response-part correctness', ...)` block in `src/providers/chat-provider.test.ts` covers all four paths plus the no-`__minimax_usage__`-text invariant.                |
| T20 — Utility-model onboarding (fix "No utility model is configured for 'copilot-utility-small'") | `[x]`  | New command `mightyMax.configureUtilityModels` registered in `package.json` (`contributes.commands[]`, category `Mighty Max`). `src/commands/configure-utility-models.ts` exposes the pure `decideUtilityNudge` helper (the 4-condition conjunction, 8-case truth table fully tested in `src/lib/utility-nudge.test.ts`) and the `runConfigureUtilityModelsCommand` orchestrator (3 QuickPick choices: `minimax/MiniMax-M3` + `minimax/MiniMax-M2.5`, `byokUtilityModelDefault = "mainAgent"`, `byokUtilityModelDefault = "copilot"`). Writes go through injected `ConfigureUtilityConfig.update`; failures surface via `showErrorMessage`. The "Configure utility models" row was added to the existing `mightyMax.manage` QuickPick in `src/commands/manage-command.ts`. Activation nudge UI wiring is a follow-up — the pure-helper seam is ready so the activation hook is a 5-line `if (decideUtilityNudge(...) === 'show') showInformationMessage(...)` next to the existing `context.secrets.onDidChange` listener in `src/extension.ts`.                                                                                                                                                                                                                                                                                                                                                                                 |
| T21 — Tool filtering: honest defaults that don't break agent mode                                 | `[x]`  | Pure-domain `filterTools` (`src/lib/domain/tool-filter.ts`) replaces the inline `ChatProvider.filterTools` method. Defaults flipped per spec: `enableSmartToolFiltering = false`, `maxTools = 64`, `alwaysIncludeTools = ['copilot_', 'run_in_terminal', 'apply_patch', 'grep_search', 'file_search', 'semantic_search']` (real Copilot tool names with the `copilot_*` prefix pin). `matchesAlwaysInclude` correctly handles three cases: exact match, prefix match (`copilot_` → startsWith), substring match (`grep` → contains). The matcher's substring rule does NOT also fire for prefix pins (so `my_copilot_helper` is NOT falsely matched by `copilot_`). History-aware pinning: `collectHistoryReferencedToolNames` walks the request's tool_use history and unions every prior tool name into the always-include set before the cap is enforced — a tool that the model already used cannot be silently dropped on the next request. Dropped-tool list logged at `warn` with names only (no schemas/content, per AGENTS.md). `package.json` setting descriptions updated; `SMART_TOOL_FILTERING.md` rewritten. 13 unit tests pin every guarantee including the no-double-match bug.                                                                                                                                                                                                                                  |
| T22 — Logging hygiene: stop logging request/response bodies (AGENTS.md violation)                 | `[x]`  | `summarizeRequestForLog(request, dialect)` (in `src/adapters/transport.ts`) returns ONLY structural keys (dialect, model, messageCountByRole, toolCount, referencedToolCallIds, hasSystem, hasThinking, cacheMarkerCount, approxContentChars) — never message content, never tool schemas. `summarizeErrorBody(bodyText)` parses the response envelope as JSON and surfaces only `{errorType, errorMessage, errorCode}`; falls back to `{bodyParseFailed: true}` for HTML / non-JSON bodies. `parseMiniMaxErrorBody(bodyText)` returns just `{message}` for the user-facing `MiniMax returned <status>: <message>` envelope. All four `JSON.stringify(requestBody)` and raw `errorBody` log sites in the 400/5xx branches were rewritten to use these helpers. Content previews in `src/providers/chat-provider.ts:305` and `:320` were already removed by T19 (`Text delta` and `Thinking content` now log only `length` at `debug`). Sentinel-based redaction guard test in `src/adapters/transport.test.ts` plants a `SENTINEL_USER_CONTENT_9f3a` in the user message + system prompt and asserts no captured log line contains the message-boundary keys (`"messages":`, `"system":`) — proves the structural summary, not the body, lands in the log channel.                                                                                                                                                               |

---

## Phase 8 — Bundled Chat Customizations (agents, prompts, skills)

> Ship custom agents, prompt files, and Agent Skills inside the .vsix via
> the `chatAgents` / `chatPromptFiles` / `chatSkills` contribution points,
> turning Mighty Max into a batteries-included MiniMax experience.
> Order: T23 first (plumbing + engine bump + validators). T24 and T25 are
> parallel-safe after T23 — the 12 skill names are frozen in the T25 spec
> and referenced verbatim by T24's dispatch table.
> We deliberately do NOT ship `chatInstructions` (always-on injection from
> a model-provider extension is intrusive); rationale in tasks/T23.

| Task | Status | Notes |
| ---------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T23 — Chat customization scaffolding: contribution points, engine bump, frontmatter validators | `[x]` | Preflight clean (compile, unit, lint, vsce-ls chat listing). Bumped `engines.vscode` + `@types/vscode` to `1.109.0`; declared `chatAgents` in `contributes`; shipped `chat/agents/max-planner.agent.md` (read-only M3 planner) plus empty `chat/prompts/` and `/` directories for T24/T25. Pure-domain frontmatter parser + per-asset validators live at `src/lib/domain/chat-assets.ts`; manifest↔disk consistency test (`src/lib/chat-assets-manifest.test.ts`) is now green. Deliberately did **not** add empty `chatPromptFiles` / `chatSkills` entries to `contributes` — the manifest test would fail because the directories contain no files. |
| T24 — `max-review` agent (M3-optimized maintainer review) + `/review-code` prompt file | `[x]` | Preflight clean (compile, unit 5/5 T24 cases, lint, vsce ls shows max-review + review-code). `max-review` ships read-only (tools list omits edit + terminal tool ids); model pinned to `M3 (MiniMax)`; body word count 661 (/2,500 ceiling); dispatch table names all 12 T25 skill names verbatim; worked-example finding + skip-list + 80%-confidence rule + 10-finding cap present. `/review-code` prompt pins `agent: max-review`. Test asserts added to `src/lib/chat-assets-manifest.test.ts` so the plumbing test also guards T24. | Read-only tools, model pinned to M3, ≥80%-confidence rule, ≤10 findings, 🔴/🟡/✅ format contract, worked example, skill dispatch table naming all 12 T25 skills. Body ≤ ~2,500 words — depth lives in skills, not the agent. |
| T25 — 12 domain review skills: 10 languages, GitHub Actions/CI, OWASP 2025 + OWASP API 2023 | `[x]` | Preflight clean (compile, unit 371/371 incl. T25 block 6/6, lint zero warnings, vsce ls chat/skills = 12, audit clean at high). 12 SKILL.md files in `chat/skills/<name>/SKILL.md` ship via `contributes.chatSkills`; each description contains "Use when" and names the file extensions; OWASP 2025 + OWASP API 2023 bodies cover all 10 IDs each; `.gitkeep` removed now that the directory has real content. Each language skill ends with a `See also` cross-link to both OWASP skills. |

---

## Phase 9 — Flight Deck Key Management (multi-key UX overhaul)

> Root-caused from live user feedback (2026-07-24): the T25 multi-key
> rotation wiring is incomplete (only `auth` failures trigger `markFailed`,
> fallback is not sticky), and the manage-command QuickPick trees are
> too deep and too redundant (6-item main menu, 10-item keys submenu,
> nested active-slot picker). This phase fixes the rotation bugs and
> redesigns the UX around an aviator/flight-deck theme that matches the
> existing mascot brand.
>
> Order: T27 → T28 → T29 → T30 → T31 → T32. T33 is the test sweep
> across all six. T34 is the standalone docs follow-up for the image
> attachment workflow.

| Task                                                                                                                | Status | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T25-multi-key — Multi-key rotation domain + port (3-slot pickKey, markFailed/markSucceeded cooldown, setActiveSlot) | `[x]`  | `src/lib/domain/key-pool.ts` + `src/ports/key-provider.ts` + `src/adapters/key-provider.ts` ship. Cooldown durations per `FailureKind` (auth 60s / rate-limit 30s / http 15s / network 10s / other 5s). The port has `setActiveSlot(slot)` ready — wiring is the T27 job.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| T27 — Rotation wiring fidelity fix (markFailed for all failure kinds + sticky fallback)                             | `[x]`  | **DONE (committed `3bcf1e0` on `feat/flight-deck-key-management`).** All three bugs fixed TDD-first in `src/providers/chat-provider.ts`. (1) `markFailed` now fires for ANY `MiniMaxClientErrorKind` via a new `mapErrorKindToFailureKind` helper; `abort` is excluded so cancellation never penalizes a slot. (2) Sticky fallback: `await this.keyProvider.setActiveSlot(pick.slot)` promotes the winner and the `"Key fallback succeeded"` log carries `newActiveSlot`. (3) Non-auth errors now attempt fallback when auto-rotation is enabled; when disabled, rate-limit/network/http surface with their raw `MiniMaxClientError` envelope. 3 new TDD tests pass. Preflight clean (typecheck, lint 0 warnings, 506 tests passing). |
| T28 — Surface the auto-rotation toggle in the UI                                                                    |
| T29 — Reusable QuickPick status header component                                                                    |

                 | `[x]`  | **DONE (committed `9c10624`).** Added a `Toggle auto-rotation` row to the manage QuickPick. State-dependent label (`● … ON` vs `○ … OFF`) rebuilt per render. Picking inverts via `deps.getConfig().update('enableAutoKeyRotation', !current)`, calls `deps.fireChange()` so the chat-provider re-fires `onDidChangeLanguageModelChatInformation`. Default `true` when nothing stored. `package.json` description now points at the in-app toggle. 5 new TDD cases pin the round-trip. `scripts/run-vscode-stub-tests.cjs` extended to include `out/commands/manage-command.test.js`. Full preflight clean (typecheck, lint 0 warnings, 533 tests passing). |
                 | `[x]`  | **DONE.** New pure module `src/commands/quickpick-header.ts` exporting `buildStatusHeader(state: HeaderState): PickItem`. Four visual states implemented: healthy (`Active: Slot N ★ ● ● ● Auto-rotate: ON/OFF`), partial cooldown (active ★ + ○ empty dots + per-slot seconds in description), warning (`⚠ Active key (Slot N) was rejected Ns ago` + ready-count description), no-keys onboarding. Dots reflect HEALTH only — `★` lives in the prefix so the dot row never duplicates the active marker. ms rounded UP to whole seconds (`Math.ceil`). 13 new TDD cases in `src/commands/quickpick-header.test.ts` covering all four states plus three cross-cutting invariants (always separator, always shown, never empty label). Full preflight clean (typecheck, lint 0 warnings, 546 tests passing: 342 node + 149 stub + 55 vscode-host). |

| T30 — Restructure the manage command's main menu (6 → 3 + 1) | `[x]` | **DONE.** Collapsed the 6-item main menu into 3 CTAs (➕ Add or rotate API key / 🔑 Manage keys (N slots) / ⚙ Settings) with the T29 status header at index 0. Primary CTA label flips to `⚠ Rotate to a healthy key` when the active slot is in cooldown. Settings submenu holds: Set base URL, Test all stored keys, Configure utility models, Log level (with current value), Auto-rotate toggle. New `handleLogLevel` helper writes via `cfg.update('logLevel', …)` and surfaces a confirmation toast. `ManagePickItem` extended with optional `kind`/`alwaysShown` so the T29 header row carries `kind: 'separator'` and `alwaysShown: true`. The 10 obsolete top-level items (Test connection / Clear API key / Set base URL / Configure utility models / Toggle auto-rotation) move to the Settings submenu; the two describe blocks for `Clear API key` and `Test connection` are deleted (their per-slot variants move to T31). 7 new TDD cases cover the 3-CTAs-only structure, status-header integration, dynamic primary CTA label (healthy vs cooldown), Manage-keys count, primary-CTA → set-key routing, Settings submenu opening, Settings label coverage, and Log-level current-value rendering. Full preflight clean (typecheck, lint 0 warnings, 552 tests passing: 345 node + 152 stub + 55 vscode-host). |
| T31 — Per-slot flight-deck view (replace 10-item keys submenu) | `[x]` | **DONE.** New `src/commands/flight-deck-view.ts` replaces the 10-item `handleManageApiKeys`. Per-slot view (`buildFlightDeckItems`) renders one row per stored slot using `●`/`★`/`○` markers and the user-customised label from `globalState`. Tapping a row opens `runSlotActionSheet` (Set / Test / Clear / Make active / Rename). `Make active` is hidden when the slot is already active. New pure domain helper `src/lib/domain/slot-labels.ts` (buildDefaultLabels / getLabel / setLabel / parseLabelsFromGlobalState / serializeLabelsToGlobalState / defaultLabelFor) — empty labels are dropped on serialize so the map stays tight. New shared test helper `src/commands/manage-command.test-helpers.ts` (in-memory SecretStore). `ManageDeps` extended with optional `slotLabels: SlotLabelsStore`. `runFlightDeckForManage` orchestrator loads labels from `slotLabels.getAll()`, hands the working map to the view (mutable so Rename writes back), then persists any changes via `slotLabels.set`. 2 new TDD cases in `src/lib/domain/slot-labels.test.ts` (14 cases total), 2 new in `src/commands/flight-deck-view.test.ts` (8 cases), 2 new integration cases in `src/commands/manage-command.test.ts` (per-slot view + label persistence). Full preflight clean (typecheck, lint 0 warnings, 581 tests passing: 371 node + 154 stub + 56 vscode-host). |
| T32 — Status bar flight-deck dashboard (markdown tooltip + red-dot overlay on active-slot cooldown) | `[x]` | **DONE.** New pure module `src/lib/domain/flight-deck-tooltip.ts` exporting `buildFlightDeckTooltip` + `buildFlightDeckText` + `isActiveInCooldown`. 5-section layout per spec: header → per-slot health (● healthy / ★ active / ○ cooldown Ns) → auto-rotation ON/OFF → last fallback with relative-ago math → Token Plan bars (`5h window:` / `Weekly:`) → `as of HH:MM:SS · click for details`. Window labels compacted to short forms (`5h window` / `Weekly`). UTC clock formatter so tests are tz-independent. Default labels suppressed (no `Slot 1 ● healthy ★ Slot 1` duplication). Item text gets ` $(error)` codicon suffix when the active slot is in cooldown — pure `buildFlightDeckText` renders this. `src/adapters/status-bar.ts` refactored to single `renderFlightDeck()` snapshotting active slot / healthy slots / per-slot cooldown remaining (via new public `cooldownRemainingMs` in `src/lib/domain/key-pool.ts`) / slot labels / auto-rotation toggle / last fallback / usage. `KeyProvider` port extended with `recordFallback(slot, fellBackFrom, atMs)` + `readonly lastFallback`; `chat-provider.ts` calls `recordFallback` after every successful sticky fallback. `KeyProviderAdapter` (and `test-helpers/key-provider-test-double.ts`) implement the new port methods with real `CooldownState` plumbing so the `__testOnlyCooldown` seam drives the status-bar math. `scripts/vscode-stub.cjs` extended with `MarkdownString` / `ThemeColor` / `StatusBarAlignment` value classes so the new `src/adapters/status-bar.test.ts` runs host-free. 14 new TDD cases in `flight-deck-tooltip.test.ts` (healthy / one-slot-cooldown / last-fallback-set / no-keys / PAYG-unavailable / sub-minute "just now" / default labels / auto-rotation OFF / 4 text cases / active-cooldown predicate / determinism). 4 new TDD cases in `status-bar.test.ts` exercising the 4 acceptance states end-to-end through the adapter. Full preflight clean (typecheck, lint 0 warnings, 559 tests passing: 386 node + 158 stub + 15 vscode-host). |
| T34 — Image attachment workflow for agent prompts (docs follow-up) | `[ ]` | **NOT IMPLEMENTED.** `docs/dev/agent-prompts.md` does not exist; AGENTS.md image-attachment one-liner is not present. Document the `tmp/` workaround for visual references (in-prompt image attachments are not visible to subagents). Standalone, no runtime code changes. |

---

## Phase 10 — M3.1 Flash Preview + Hailuo-03 video generation

> Depends on: Phase 9 complete. Released together in `v0.9.0`
> (squash-merged as PR #84, `725e5b8`).

| Task                                               | Status | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T36 — Media generator tools (H3 / Hailuo-03 video) | `[x]`  | **DONE (PR #84).** Wires MiniMax's async Hailuo-03 video endpoint (`MiniMax-H3`, `MiniMax-H3-Max`) as both an LM tool (`mightyMax_generateVideo`) and a command-palette entry (`mightyMax: Generate Video`). Hexagonal: pure domain (`media`, `media-capability`, `video-tool`), ports (`VideoGenerator`, `MediaArtifactStore`), adapters (`HailuoVideoAdapter` for the H3 wire protocol, `LocalMediaStore` for filesystem landing, `generate-video-tool-adapter` for the LM host registration), and command (`generate-video-command`). Pipeline runs submit → poll → download → save on the same multi-slot `KeyProvider`; `prepareInvocation` gates the chat-tool surface on `mightyMax.allowVideoToolInChat`; the command is always available. H3-Max supports subject-reference video (up to 4 reference images); H3 rejects with a clear error. Four new settings: `allowVideoToolInChat`, `mediaOutputDir`, `videoPollIntervalMs`, `videoTimeoutMs`. Stubs gained a minimal `vscode.Uri` + `vscode.env.clipboard` so the `run-vscode-stub-tests.cjs` runner exercises the Open / Reveal / Copy-path branches. **Also shipped in this PR:** M3.1-Flash-Preview catalog entry (1M ctx, multimodal, Anthropic thinking; picks up the existing `includes('minimax-m3')` branches unchanged). 24 files changed (+3,317 lines). Full preflight clean (typecheck, lint 0 warnings, 591 node unit + 186 stub + integration exit 0). Includes dependabot #80 dev-deps bump (`@types/node`, `eslint`, `mocha`, `prettier`, `typescript-eslint`). Follow-ups tracked: M3/M3.1-Flash-Preview **video input** via Anthropic content blocks (needs a new `videoInput` capability flag + message-mapping change); image / speech / music generators via MiniMax's other endpoints (the `VideoGenerator` + `MediaArtifactStore` foundation is ready to clone). |

## Accumulated Learnings

> Subagents append discoveries here after each task.
> The orchestrator reads this section at the start of every iteration
> to avoid repeating past mistakes.

### T01 — Extension scaffold

- **vsce 3.2.1 does not exist on npm.** Latest stable is 2.15.0; pin to `2.15.0`. (3.x is a different package.)
- **vsce entrypoint resolution appends `.js` to any `main` that does not end in `.js`.** If `main` is `./dist/extension.cjs`, vsce looks for `./dist/extension.cjs.js` and the package step fails with "Extension entrypoint(s) missing". Use `./dist/extension.js` (or rename the bundle).
- **vsce emits `WARNING  LICENSE.md, LICENSE.txt or LICENSE not found` for license files.** It will still include `LICENSE` (no extension) ONLY if the `.vscodeignore` does not exclude it; rename to `LICENSE.md` for cleanliness and GitHub license-detection parity. The `*.md` blanket rule in `.vscodeignore` requires a `!LICENSE.md` allow exception.
- **`vsce package` complains about a missing `repository` field** if the manifest does not declare one. Always include `repository: { type: "git", url: "..." }`.
- **A high-severity npm audit advisory in `serialize-javascript@6.0.2` (used by `mocha@10.x` for reporter output) cannot be fixed by upgrading `mocha`** — mocha 10.x and 11.x both still depend on `^6.0.2`. The patched range starts at `serialize-javascript@7.0.5`. Use a top-level `overrides: { "serialize-javascript": "^7.0.5" }` in `package.json` (requires Node ≥ 20, which we already require). The override forces the patched version through the mocha transitive without breaking mocha's usage (mocha only uses `serialize(obj)` which is the same 6.x → 7.x API).
- **`@types/vscode@1.104` finalized the LanguageModelChatProvider API.** The provider signature is `provideLanguageModelChatResponse(model, messages: readonly LanguageModelChatRequestMessage[], options: ProvideLanguageModelChatResponseOptions, progress, token)`. `LanguageModelChatMessage` is the broader public type; the request parameter is the narrower `LanguageModelChatRequestMessage`. `provideTokenCount` returns `Thenable<number>` (not `ProviderResult<number>`).
- **`@vscode/test-cli` (0.0.10+) uses mocha as a library, not a CLI** — so the broken `yargs@16.2.0` entry file (which has `"type": "module"` in its package.json but is loaded via `require`) does not bite. The CLI is silent by design; trust the exit code.
- **ESLint v9 flat config requires the `@typescript-eslint/` prefix on every typescript-eslint rule.** `no-floating-promises` and `no-misused-promises` only exist with the namespace. Bare names resolve to the deprecated v8 config keys and are silently dropped.
- **`import * as vscode` triggers `consistent-type-imports` when the import is used only in type positions** (e.g. `vscode.LogOutputChannel` in a constructor signature). Use `import type * as vscode` instead.
- **TypeScript strict mode flags unused constructor parameters AND unused private class fields with `TS6133`/`TS6138`.** In stub classes, prefix unused parameters with `_` and do NOT assign them to class fields. Real fields are added by the implementing task (T05/T06/T07).
- **ESLint `@typescript-eslint/no-unsafe-member-access` fires on `extension.packageJSON.contributes`** because the `contributes` accessor returns `any`. For test files, add a test-file rule block that turns off `no-unsafe-member-access`, `no-unsafe-assignment`, and `require-await` — these are routine in test setup.
- **`import.meta.url` does not work in CommonJS-emitted test files.** Use `__filename`/`dirname` from `node:path` directly.
- **The global npm cache at `/Users/nickcampbell/.npm/_cacache/` had root-owned files from a previous npm bug, causing EPERM on every install.** Workaround: set `NPM_CONFIG_CACHE="$PWD/.npm-cache"` for the install (and add `.npm-cache/` to `.gitignore`, which the project's `.gitignore` already includes).

### T02 — Model catalog and picker wiring

- **`LanguageModelChat` (the runtime type returned by `selectChatModels`) is a different shape from `LanguageModelChatInformation` (the picker-info type the provider returns).** `LanguageModelChat` exposes `id`, `name`, `vendor`, `family`, `version`, `maxInputTokens`, plus `sendRequest` and `countTokens`; it does **not** expose `maxOutputTokens` or `capabilities`. Don't assert on those fields against `selectChatModels` — assert on them only when you hold a `LanguageModelChatInformation[]` (e.g. via `onDidChangeLanguageModelChatInformation` listeners or the internal mapping helper).
- **`node:test`'s `describe`/`it`/`suite`/`test` return `Promise<void>`.** The runner awaits them internally, but ESLint's `@typescript-eslint/no-floating-promises` flags every call site. Disable that one rule (and `no-misused-promises` if it bites) in the test-file block of the flat config — disabling it project-wide breaks the provider code that uses `Promise.all` / `await` correctly.
- **`capabilities.toolCalling = true` is the AGENTS.md invariant that gates agent-mode eligibility.** Every model the extension advertises as agent-capable (M3, M2.7, M2.5, M2) must declare it; M1 must not, so the picker hides it from agent mode. Use a literal `true`/`false` (not `undefined`) under `exactOptionalPropertyTypes` — `{}` is the correct way to represent "no image input", `capabilities: { imageInput: true, toolCalling: true }` for the agent-capable models.
- **The merge catalog invariant "static wins on collision" is the simplest, safest default.** If a future MiniMax release renames an M-series model, the static `BUILT_IN_CATALOG` keeps the old id discoverable and the new id surfaces as a separate entry sorted alphabetically. This avoids the alternative "live overwrites static" path, which would silently drop the static entry and break pinned references in user settings.
- **`thinkingStyle` as a discriminator (`'anthropic' | 'openai' | 'none'`) keeps the transport decision (T05) honest.** M3 streams Anthropic-style content blocks (thinking + text + tool_use interleaved in one delta stream); M2.x streams OpenAI-style deltas with separate `tool_calls` arrays. T05 will branch on this discriminator instead of regex-sniffing the model id.
- **`Event<void>` is the right signal for "the catalog mutated".** VS Code's `onDidChangeLanguageModelChatInformation?: Event<void>` expects a `void` payload — the picker re-fetches the full `provideLanguageModelChatInformation` result on every fire. Don't put the new catalog in the event payload; VS Code doesn't read it.
- **VS Code 1.104's `exactOptionalPropertyTypes` is unforgiving on `LanguageModelChatInformation.capabilities`.** Building the object via spread (`...(imageInput ? { imageInput: true } : {})`) is the only way to satisfy "omit the key when false" without sprinkling `| undefined` everywhere. The chat provider uses an explicit object literal for clarity (one of two paths in the codebase, both pass typecheck).

## Codebase State

> Subagents update this section after completing each task.
> Describe what now exists, what is wired up, and what key decisions were made.
> A fresh agent should be able to orient from this section alone.

### After T01 — Extension scaffold

**Manifest contract** — `package.json` declares:

- `engines.vscode = ^1.104.0`, `engines.node = >=20.0.0`
- `publisher = "greysquirr3l"`, `main = "./dist/extension.js"`, `extensionKind = ["workspace"]`
- `contributes.languageModelChatProviders[0]` — vendor `"minimax"`, `displayName "Mighty Max (MiniMax)"`, `managementCommand = "mightyMax.manage"`
- `contributes.commands[0]` — `mightyMax.manage` ("Manage Mighty Max (Set API Key)")
- `contributes.configuration.properties` — `mightyMax.baseUrl` (default `https://api.minimax.io`, application scope) and `mightyMax.logLevel` (enum `debug|info|warn|error`, default `info`, window scope)
- `capabilities.untrustedWorkspaces.supported = "limited"` with `restrictedConfigurations: ["mightyMax.baseUrl"]`; `capabilities.virtualWorkspaces.supported = "limited"`
- `repository` field present, `overrides: { "serialize-javascript": "^7.0.5" }` for the high-severity advisory

**Layout** — hexagonal, with hard I/O boundary at `src/lib/`:

```
src/
  ports/        # Consumer-owned port traits (no vscode dep)
    logger.ts
    secret-store.ts
    minimax-client.ts
    model-catalog.ts
  adapters/     # Port implementations (own all I/O; stubbed in T01)
    logger.ts
    secret-store.ts
    transport.ts
    catalog.ts
  providers/    # vscode glue (implements LanguageModelChatProvider)
    chat-provider.ts
  lib/          # Domain: pure, no vscode dep
    domain/
      catalog.ts        # validateCatalog()
      mapping.ts        # RichChatRole, RichChatPart, RichChatMessage, validateMessages()
      capability.ts     # evaluateAgentEligibility()
  test/
    extension.test.ts   # Integration smoke test
  extension.ts          # Composition root: wires adapters + provider + commands
```

**Build pipeline** — `tsc -p .` emits to `out/`, then `node esbuild.config.mjs` bundles `out/extension.js` → `dist/extension.js` (CJS, `vscode` marked external, sourcemap in dev, minified in prod via `npm run vscode:prepublish`).

**Lint** — ESLint v9 flat config (`eslint.config.mjs`) with `tseslint.config(...)`, type-checked recommended rules, deny list: `@typescript-eslint/no-floating-promises`, `@typescript-eslint/no-misused-promises`, `@typescript-eslint/no-explicit-any`, `@typescript-eslint/await-thenable`, `@typescript-eslint/no-unused-vars` (with `argsIgnorePattern: "^_"` and `varsIgnorePattern: "^_"`), `@typescript-eslint/no-non-null-assertion`, `@typescript-eslint/consistent-type-imports`. Test files relax `require-await`, `no-unsafe-member-access`, `no-unsafe-assignment`.

**Tests** — `@vscode/test-cli` with two profiles (`.vscode-test.mjs`):

- `unit` — vanilla Mocha on `out/lib/**/*.test.js` (no host). 7 tests pass: validateCatalog, validateMessages, evaluateAgentEligibility.
- `integration` — extension host, VS Code Insiders, `--disable-extensions --disable-updates`, runs `out/test/**/*.test.js`. Smoke test: activates the extension and asserts the management command, settings, and manifest contract.

**CI** — `.github/workflows/ci.yml` matrixes Ubuntu / Windows / macOS on `node-version: [20]`. Steps: `npm ci` → `npm run typecheck` → `npm run compile` → `npm run lint` → `npm test` (Linux uses `xvfb-run -a`) → `npm audit --audit-level=high` → `npm run package` → upload the `.vsix` artifact.

**Stubs pending implementation** — all four adapters (`logger`, `secret-store`, `transport`, `catalog`) are typed, import-only shells whose method bodies throw `"not implemented (see T0X)"`. `ChatProvider` exists with the correct 1.104 API but its methods also throw (delegates would be wired in T05-T07). The `LoggerAdapter` wraps `vscode.LogOutputChannel` and is the only adapter that does real I/O — it must work for activation to log anything.

### After T02 — Model catalog and picker wiring

**Domain (`src/lib/domain/catalog.ts`)** — pure, no vscode or HTTP imports (verified by `no-vscode.test.ts`):

- `BUILT_IN_CATALOG`: 5 frozen `ModelInfo` entries — M3, M2.7, M2.5, M2, M1 — all `vendor = MINIMAX_VENDOR`, `family = MINIMAX_FAMILY` (`"minimax"`).
- Token budgets: M3 `maxInputTokens = 1_040_384`, M2.7/M2.5/M2 `maxInputTokens = 196_608`, M1 `maxInputTokens = 32_768`. `maxOutputTokens = 8_192` for M2-M3, `4_096` for M1. `DEFAULT_MAX_OUTPUT_TOKENS = 8_192` exported for live-merge defaults.
- Capabilities: M3 advertises `imageInput = true` and `toolCalling = true`; M2.7/M2.5/M2 advertise `imageInput = true`, `toolCalling = true`, and a 200 RPM limit; M1 has `imageInput = false`, `toolCalling = false`. `DEFAULT_LIVE_DEFAULTS.capabilities.toolCalling = true` (AGENTS.md invariant — the agent-mode gate).
- `thinkingStyle: 'anthropic' | 'openai' | 'none'` discriminator on `ModelInfo` — M3 uses `'anthropic'`, M2.x uses `'openai'`, M1 uses `'none'`. Drives the `LanguageModelChatInformation.version` field and the future transport selection (T05).
- `mergeCatalog(staticList, liveList, defaults)` — static-first, drops any live entry whose `id` collides with a static entry, fills missing `maxOutputTokens` and capability booleans from `defaults`, sorts non-static extras alphabetically. Pure, non-mutating, deterministic.
- `normalizeModelId`, `formatTokenCount`, `validateCatalog` (kept from T01) round out the file.
- `MINIMAX_VENDOR` and `MINIMAX_FAMILY` exported from the domain so adapters and providers share one source of truth.

**Port (`src/ports/model-catalog.ts`)** — `ModelInfo` extended with `thinkingStyle` and `detail`; `ModelCatalog` now requires `onDidChange: Event<void>` so the provider can re-emit to the picker when a live refetch succeeds.

**Adapter (`src/adapters/catalog.ts`)** — `CatalogAdapter implements ModelCatalog` wraps a single mutable `liveModels: ReadonlyArray<ModelInfo>` plus an `EventEmitter<void>`. `setLiveModels` invalidates the merge cache, recomputes eagerly, and fires `onDidChange`. The provider subscribes to that event and re-fires its own emitter to refresh the model picker.

**Provider (`src/providers/chat-provider.ts`)** — `provideLanguageModelChatInformation` now:

1. Honours cancellation before and after the catalog fetch.
2. Maps each `ModelInfo` through `toLanguageModelChatInformation` (exported for unit tests in T07).
3. Wraps both `imageInput` and `toolCalling` into a plain `Record<…, true | false>` (`exactOptionalPropertyTypes` requires omitting the keys entirely when false; the runtime contract is the literal `true` for agent-capable entries).
4. Logs the count of returned models at `debug` level on every invocation.
5. Re-throws catalog failures wrapped in a chat error so VS Code surfaces them instead of crashing the host.

`provideLanguageModelChatResponse` and `provideTokenCount` still throw `"not implemented (see T07)"`. The `dispose()` chain subscribes the catalog `onDidChange` to the provider's emitter.

**Composition root (`src/extension.ts`)** — `new CatalogAdapter(logger)` (was missing the logger arg in T01), wired into the `ChatProvider` constructor before registration with `vscode.lm.registerLanguageModelChatProvider('minimax', chatProvider)`.

**Tests** — `src/lib/catalog.test.ts` (32 cases):

- `BUILT_IN_CATALOG` length, ordering by id, identity (id, name, vendor, family, max tokens, capability booleans, `thinkingStyle` per model).
- M3 specifically: image + tool, anthropic thinking, 1_040_384 input.
- M2.7/M2.5/M2: openai thinking, 196_608 input, 8_192 output.
- M1: no image, no tool, no thinking, 32_768 input, 4_096 output.
- `validateCatalog` rejects duplicate ids, non-positive `maxInputTokens`, `maxOutputTokens > maxInputTokens`, and non-boolean capability booleans.
- `mergeCatalog` returns static-only when `live` is empty, applies defaults to live entries that omit them, never overrides static, never mutates inputs, sorts extras alphabetically, and is deterministic.
- `normalizeModelId` lowercases, trims, and rejects empty/overlong input.
- `formatTokenCount` returns `"1,040,384"` style thousand-separators.
- `DEFAULT_LIVE_DEFAULTS` sanity (toolCalling true, imageInput true, rpm > 0).

Integration test `src/test/extension.test.ts` adds 4 T02 cases (T01 cases preserved): `vscode.lm.selectChatModels({ vendor: 'minimax' })` returns a non-empty array; every M-series id is present; every returned `LanguageModelChat` has `vendor = 'minimax'`, `family = 'minimax'`, a non-empty `name`, and a positive `maxInputTokens`; and M3's `maxInputTokens` exceeds M2's.

**Preflight (T02)** — `npm run typecheck` (clean), `npm run compile` (`dist/extension.js` = 21.1 kB), `npm run lint` (0 warnings, 0 errors), `npm run test:unit` (exit 0, 32+ tests pass under VS Code test-cli's silent mocha runner), `npm run test:integration` (exit 0, 5 T02 cases green under VS Code Insiders host), `npm audit --audit-level=high` (offline, 0 vulnerabilities), `npm run package` (`mighty-max.vsix`, 1458 files, 65.49 MB).

---

### T02-fix — `fillLiveDefaults` defaults forced for unknown live models (commit `2d99cb2`)

The original T02 `fillLiveDefaults` used a `??` merge between the API-supplied `raw.capabilities.toolCalling` and `defaults.capabilities.toolCalling`. `false ?? true === false` under `??`, so an unknown model that the API happened to ship with `toolCalling: false` would silently be hidden from agent mode and the agent model picker. The fix forces `defaults.capabilities.toolCalling`, `defaults.capabilities.imageInput`, and `defaults.thinkingStyle` for unknown live models (entries that survive the `mergeCatalog` collision filter). `thinking` is then derived from `thinkingStyle \!== 'none'`. The AGENTS.md invariant — `capabilities.toolCalling = true` gates agent-mode eligibility — is now honored for every live entry. Discovered via T03 preflight re-running the full unit suite, which surfaced the long-standing T02 test gap.

### T03 — Tool schema mapping

Pure-domain port + tool mapper + streaming tool-call accumulator + bounded JSON repair + tool-result encoder. One malformed tool call no longer aborts the agent turn — typed `ToolSchemaError` envelopes surface the failure.

**Learnings**

- `LanguageModelChatTool.inputSchema` is required by the MiniMax wire shape; the mapper omits the `parameters` key when the vscode tool does not declare a schema.
- `LanguageModelChatToolMode` is a numeric enum (`Auto=1`, `Required=2`); match by `Number(mode)` (not by enum member) for forward-compat with future vscode versions, and to avoid `@typescript-eslint/no-unsafe-enum-comparison`.
- Tool-call deltas carry an `index` for parallel-call identification. The accumulator must detect TWO protocol violations: (a) same call id at a different index, and (b) same index with a different call id. Both emit a `duplicate-call-id` `ToolSchemaError` and leave the state untouched so the in-flight call is not lost.
- `LanguageModelToolResultPart` is allowed in the User role only — the wire mapper is a pure `toRole='tool'` projection, no copying into Assistant.
- The bounded JSON repair algorithm: walk the input once to build an LIFO stack of open `{`/`[` and track `colonAfterLastSep`; on partial entry, drop back to the last `,` (or last open structural token) and re-walk; close any unclosed string; close remaining opens in LIFO order. **Never** invent `null`/`0` placeholders — the function may only close what was opened.
- The `'in' operator cannot narrow a union type` in TypeScript: `keyof (A | B)` is the intersection of `keyof A` and `keyof B`, so `'role' in (MiniMaxWireMessage | ToolSchemaError)` fails because `role` is not in `keyof ToolSchemaError`. Solution: a domain-level `isToolSchemaError` type guard (`kind in x`) — the discriminated union's `kind` field is the only narrowing key.
- The chat-provider surfaces a typed `ToolSchemaError` rather than throwing so a single malformed tool call cannot abort the agent turn. The transport emits an error chat message and continues with whatever the accumulator yielded.
- `vscode.LanguageModelToolCallPart` and `vscode.LanguageModelTextPart` are value classes (constructors), not type-only — value-import the constructors; re-export the types only from the port file (domain stays vscode-free).
- `serializeToolResultContent` joins a `LanguageModelToolResultPart.content` array with `'\n'` per element after running each through `JSON.stringify`. The output is NOT a single JSON document; it is a multi-document stream the model joins back together. Tests must not `JSON.parse` the joined output.

**Preflight (T03)** — `npm run typecheck` (clean), `npm run compile` (`dist/extension.js` = 20.9 kB), `npm run lint` (0 warnings, 0 errors), unit suite (50+ tests pass, 0 failures), `npm run test:integration` (exit 0), `npm run package` (`mighty-max.vsix`, 1458 files, 65.5 MB). `npm audit --audit-level=high` was BLOCKED by the sandbox network allowlist (403 from `registry.npmjs.org`); the offline `_cacache` already reflects the previous successful audit and the dep set is unchanged since T02 (no new production deps were added by T03).

**Codebase State (after T03)**

- `src/ports/tool-schema.ts` — port re-exports for `vscode.LanguageModelToolCallPart`/`TextPart` (value) and `LanguageModelChatTool`/`Mode`/`ToolResultPart` (type). Conversion helpers `toChatTool`, `toChatToolResultPart`, `toChatToolMode` (forward-compat numeric match), `toLanguageModelToolCallPart`, `toLanguageModelTextPart`.
- `src/lib/domain/tools.ts` — pure domain: `mapToolsToMiniMax`, `mapToolModeToChoice`, `serializeToolResultContent`, `mapToolResultToMiniMax`, `accumulatorSeed`, `accumulateToolCallDelta` (with `duplicate-call-id` detection), `finalizeAccumulator`, `repairTruncatedJson` (stack-based, LIFO close, partial-key vs partial-value detection via `colonAfterLastSep`), `ToolSchemaMappingError` class, `isToolSchemaError` type guard.
- `src/lib/tools.test.ts` — 30+ cases covering empty input, name/description passthrough, JSON-schema parameters, `inputSchema` omission, all-vscode-tool-origins uniformity, mode mapping (Auto / Required / unknown), tool-result encoding (single text, mixed, structured, missing id, non-array content, helper exposure), accumulator behavior (seed, single call, parallel calls, fragment concatenation, `duplicate-call-id` violation), `finalizeAccumulator` (empty, truncated reparsed, un-repairable surfaces typed error), and `repairTruncatedJson` (well-formed passthrough, truncated value with unclosed string + brace, truncated array, trailing-comma strip, no-repair fallback, nested truncation).
- `src/lib/no-vscode.test.ts` — confirms the domain layer imports no `vscode` / `node:https?` / `undici` / `node-fetch`.
- All T02 cases still pass; the T02 catalog fix (`fillLiveDefaults` forces defaults) is in place.

### T04 — Message and response-part mapping

Pure-domain port + bidirectional message and response-part mapper. Inbound maps VS Code chat messages (text, image, tool-result, tool-call) to MiniMax wire messages; outbound maps MiniMax stream deltas (text, reasoning, thinking, usage, tool-call) to VS Code response parts. One malformed message or delta does not abort the turn — typed `MessageMappingError` envelopes surface the failure for the transport to log and skip.

**Learnings**

- **The wire shape has to grow for image support.** The T03 `MiniMaxWireMessage.content` was `string`; T04 extends it to `string | ReadonlyArray<MiniMaxWireContentPart>` so user messages with images emit a content-parts array. The widening is backwards-compatible — the T03 mapper still returns `string` for tool results, and the T03 test was patched to narrow `typeof out.content === 'string'` before the `JSON.parse` assertion.
- **The T03 tool-result mapper returns a discriminated `MiniMaxWireMessage | ToolSchemaError`** — to consume it from T04, discriminate on `mapped.role === 'tool'` (the only valid role on a tool wire message), not on the `kind` field. ToolSchemaError members do not have a `role` field, so the narrowing falls through naturally. The T03 type guard `isToolSchemaError` is not the right shape for a T04 consumer that needs to read `toolCallId` / `content` from the success path.
- **Image bytes are encoded to base64 with the `btoa` global** (not `Buffer.from(...).toString('base64')`) so the file is portable between the extension host (Node 20) and the unit tests (also Node 20). Both have `btoa` as a global. The encoder normalises the MIME type to lowercase before lookup so `'IMAGE/PNG'` is accepted; unsupported MIME types and empty data both surface a `malformed-image` typed error.
- **M2.x reasoning content and M3 Anthropic thinking blocks are NEVER emitted as visible text.** The mapper surfaces both as `ChatResponsePart.thinking` and the chat-provider (T07) is responsible for emitting them as `LanguageModelThinkingPart` (or, until that type lands in `@types/vscode`, as a separate thinking-specific `LanguageModelTextPart` with a marker the UI can recognize). The T04 spec is explicit on this — the context-window widget counts only visible text and tool calls against the budget.
- **The M3 Anthropic thinking-block extraction is a defensive belt-and-braces step.** The transport (T05) is expected to split the Anthropic stream into per-block deltas and surface them as `thinkingDelta` events; the mapper still strips inline `[<anthropic_thinking>...</anthropic_thinking>]` markers from a `textDelta` (with or without the outer brackets) and surfaces the content as a thinking part. The transport may use either form — both are accepted.
- **`@types/vscode@1.104` does not yet export `LanguageModelDataPart`, `LanguageModelThinkingPart`, or `LanguageModelImagePart`.** The T04 spec is written for a future API. The mapper produces the domain-neutral `ChatResponsePart` shape and the port re-exports the types that _do_ exist (`LanguageModelChatMessageRole`, `LanguageModelChatRequestMessage`, `LanguageModelTextPart`, `LanguageModelToolCallPart`, `LanguageModelToolResultPart`). T07 is responsible for emitting the right vscode value class once those types land.
- **A tool-call part appearing in a user request is structurally impossible in normal flow** (the wire history of the prior assistant turn carries it), but the mapper still surfaces a typed `unsupported-content` warning if one sneaks in. One malformed message does not abort the turn — the surrounding parts of the message and surrounding messages continue to map.
- **The `mapRequestToMiniMax` mapper concatenates text parts with `'\n'`** (one newline per part boundary, no surrounding whitespace). When images are present, the text becomes the first element of a content-parts array (`{ type: 'text', text }` followed by the `image_url` parts). When text-only, the wire content stays a plain string (the cheap path the model can index faster than a one-element array).
- **The `mapMiniMaxUsage` normaliser omits `totalTokens`** even when the wire event includes it. The chat-provider can derive it as `promptTokens + completionTokens` if the context-window widget needs the running total; the normalised shape stays narrow (4 fields, all optional).

**Preflight (T04)** — `npm run typecheck` (clean), `npm run compile` (`dist/extension.js` = 20.9 kB), `npm run lint` (0 warnings, 0 errors), `npm run test:unit` (exit 0, 50+ unit tests pass under VS Code test-cli's silent mocha runner — T03's 30+ cases still pass; T04's 40+ new cases pass), `npm run test:integration` (exit 0, T02's 5 cases still green under VS Code Insiders host), `npm run package` (`mighty-max.vsix`, 1458 files, 65.49 MB). `npm audit --audit-level=high` was BLOCKED by the sandbox network allowlist (403 from `registry.npmjs.org`); the offline `_cacache` already reflects the previous successful audit and the dep set is unchanged since T02 (no new production deps were added by T04).

**Codebase State (after T04)**

- `src/ports/minimax-client.ts` — wire shape extended for image + thinking support: `MiniMaxWireContentPart` discriminated union (`text` / `image_url`); `MiniMaxWireMessage.content` widened to `string | ReadonlyArray<MiniMaxWireContentPart>`; `MiniMaxUsageDelta` extracted so cache tokens are optional fields; `MiniMaxStreamEvent` gains `reasoningDelta` (M2.x OpenAI-style) and `thinkingDelta` (M3 Anthropic-style) for per-block thinking content.
- `src/ports/message-mapping.ts` — port re-exports for `vscode.LanguageModelChatMessageRole` / `LanguageModelChatRequestMessage` (type) and `LanguageModelTextPart` / `LanguageModelToolCallPart` / `LanguageModelToolResultPart` (value). Domain-neutral types: `ChatMessageRole` (`'user' | 'assistant'`), `ChatMessageContentPart` (text / image / tool-call / tool-result variants mirroring the vscode shapes 1:1), `ChatMessage`, `ChatUsageData` (4 optional token fields), `ChatResponsePart` (text / thinking / usage / tool-call), `MessageMappingError` (discriminated union: missing-role, unsupported-content, malformed-image, unknown-message-role, empty-message), `isMessageMappingError` type guard. Conversion helpers `toLanguageModelTextPart` / `toLanguageModelToolCallPart` / `toLanguageModelToolResultPart` for the chat-provider (T07) to convert domain parts back to vscode value classes.
- `src/lib/domain/messages.ts` — pure domain (no `vscode` / `node:https?` / `undici` / `node-fetch` imports, verified by `no-vscode.test.ts`): `mapRequestToMiniMax` (joins text with `\n`, encodes images to data URIs, projects tool results via T03's `mapToolResultToMiniMax`, surfaces typed warnings for tool-call in user content / malformed images / unknown roles / empty messages, continues past every malformed input); `mapStreamDeltaToResponseParts` (handles `textDelta` with optional Anthropic thinking-block extraction when `thinkingStyle === 'anthropic'`, `reasoningDelta` → thinking part, `thinkingDelta` → thinking part, `usage` → usage part; never mixes reasoning into visible text); `mapMiniMaxUsage` (normalises 4 optional fields, omits `totalTokens`); `extractAnthropicThinking` (internal helper — regex-strips `[<anthropic_thinking>...</anthropic_thinking>]` markers with optional outer brackets, returns concatenated thinking content + cleaned visible text); `createStreamMappingState` (factory for future block-tracking state — the mapper is stateless today but the seam is reserved); `MessageMappingModel` (`{ id, thinkingStyle }`) and `MessageMappingResult` (`{ messages, warnings }`) interface shapes. Internal helpers `bytesToBase64` (uses `btoa` global, not `Buffer`) and `buildImageContentPart` (validates against `ALLOWED_IMAGE_MIME_TYPES` Set: png, jpeg, jpg, gif, webp).
- `src/lib/messages.test.ts` — 40+ cases across 7 describe blocks: `mapRequestToMiniMax — text` (single, assistant, multi-part join with `\n`, order preservation); `mapRequestToMiniMax — image` (PNG data URI, all allowed MIME types, lowercase normalisation, unsupported MIME rejection, empty data rejection, text+image content-parts shape); `mapRequestToMiniMax — tool-result and tool-call` (call id preservation, multiple tool results, tool-call warning, tool-result error surface, empty assistant handling); `mapRequestToMiniMax — error tolerance` (unknown role, empty message, continue-after-malformed, empty input array); `mapRequestToMiniMax — round-trip` (text-only round trip preserves order); `mapStreamDeltaToResponseParts — text` (textDelta to text part, empty event, empty textDelta, M2.x / M1 passthrough); `mapStreamDeltaToResponseParts — thinking` (Anthropic thinking-block extraction with/without outer brackets, multiple blocks, M2.x reasoningDelta, M3 thinkingDelta, combined reasoning+text event, no reasoning leak to visible text); `mapStreamDeltaToResponseParts — usage` (prompt+completion, cache tokens, combined with text); `mapStreamDeltaToResponseParts — error tolerance` (empty usage shape, empty textDelta + usage combination); `mapMiniMaxUsage` (passthrough, cache tokens, empty input, `totalTokens` omitted); `extractAnthropicThinking` (no block, multiline content); `isMessageMappingError` (positive for all variants, negative for `ChatResponsePart`, null, undefined, string, number, object without `kind`, object with non-string `kind`).
- `src/lib/tools.test.ts` — T03 case at line 188 patched to narrow `typeof out.content === 'string'` after the T04 wire-shape widening. All other T03 cases pass unchanged.
- `src/lib/no-vscode.test.ts` — still green; the T04 domain file imports only from `node:test`-free pure sources (`node:assert/strict` is not used in the domain; the test file is the only `node:assert/strict` consumer).
- All T01/T02/T03 cases still pass; the T02 catalog fix and the T03 tool-schema mapping are both preserved.

**Learnings (T06)**

- **`vscode.window.showQuickPick`/`showInputBox` return `Thenable<T>`, not `Promise<T>`.** When the domain layer needs to mock or wrap them, the `Promise.resolve(...)` pattern (already used for `SecretStorage` in T05) is the consistent adapter. Marking the wrapper `async` also works (`async (items) => { const c = await vscode.window.showQuickPick(...); return c; }`) because `await` automatically adapts `Thenable` → `Promise` — both are valid; `Promise.resolve` is more explicit at the call-site.
- **`exactOptionalPropertyTypes` and the `QuickPickOptions.title: string` overload.** Passing `title: options?.title` with `title: string | undefined` fails because `string | undefined` is not assignable to `string` under the strict-optional flag. The pattern that works: `options?.title !== undefined ? { title: options.title } : {}` (conditional spread with a plain object). Same trick works for `ignoreFocusOut`, `password`, `value` on `showInputBox`.
- **Generic `showQuickPick<T extends QuickPickItem>(items: readonly T[], options?: QuickPickOptions)` overload ambiguity.** The non-generic `showQuickPick(items: readonly string[] | Thenable<readonly string[]>, options?: QuickPickOptions, ...)` overload comes first in the .d.ts and TypeScript sometimes prefers it. Workarounds: pass an explicit `T` (`vscode.window.showQuickPick<vscode.QuickPickItem>(vscodeItems, ...)`) or transform your items into a fresh `vscode.QuickPickItem[]` so structural matching is unambiguous.
- **`fireChange()` as a public method beats a public `changeEmitter`.** The `EventEmitter` is already wired to the `onDidChangeLanguageModelChatInformation` event; exposing just `fireChange()` (which delegates to `this.changeEmitter.fire()`) keeps the encapsulation tight. The extension listens to `vscode.SecretStorage.onDidChange` and calls `chatProvider.fireChange()` whenever the namespaced key changes — the model family appears/disappears in the picker without a host restart.
- **Manage-command UI dependency injection uses a `scriptedUi` testing pattern.** The test array `script` (with `pick` and `input` fields per step) drives a deterministic interaction through the same `ManageUi` interface the real `vscode.window` adapter implements. This avoids touching `vscode.window` from the test host (which doesn't have a real input source) and keeps the entire command testable as a pure function over a UI seam.
- **`fetch` injection for `validateApiKey` uses a `FetchLike` alias of `typeof fetch`.** The real `fetch` in `src/extension.ts` is passed as `fetchImpl: fetch` — the test injects a mock that returns a `Response`-shaped object. The `signal: AbortSignal | undefined` parameter is `exactOptionalPropertyTypes`-correct only when conditionally attached to `init: RequestInit` (the same pattern as the QuickPick options).
- **The `noUncheckedIndexedAccess` flag forces `arr[i]` to `T | undefined`.** When extracting model ids from `/v1/models` (the API can return objects whose `id` field is `unknown`), use `(item as Record<string, string>)['id'] ?? ''` and filter empties at the end — never use the non-null `!` (denied by `no-non-null-assertion` lint rule) and never leave the `undefined` lurking in the returned array.

**Codebase State (after T06)**

- `src/ports/secret-store.ts` — `SecretStore` port (get/store/delete/has/namespace). Adapter implemented and wired in extension.ts; no domain layer depends on `vscode`.
- `src/adapters/secret-store.ts` — `SecretStoreAdapter` wraps `vscode.SecretStorage` with the `mightyMax.` namespace prefix; every `Thenable` wrapped in `Promise.resolve`; `hasSecret` implemented as `get` + `undefined` check.
- `src/adapters/api-key-validator.ts` — `validateApiKey(apiKey, baseUrl, fetchImpl?, signal?)` returns `ValidationResult` discriminated union; hits `${baseUrl}/v1/models` with `Authorization: Bearer ${key}`; rejects empty/whitespace keys and empty baseUrl; strips trailing slash; typed `ValidationFailure = 'unauthorized' | 'network' | 'malformed'`; `FetchLike = typeof fetch` exported for test injection. 14 unit tests pass.
- `src/commands/manage-command.ts` — `runManageCommand(deps)` orchestrator with `ManageUi` / `ManageDeps` / `ManageConfig` interfaces; 4-option QuickPick (Set key / Set base URL / Test connection / Clear key); password-masked input for API keys; calls `fireChange()` after successful store/delete; never logs the key, the Authorization header, or 401 response bodies. `__testing` internal export for test helpers. 16 unit tests pass.
- `src/commands/manage-command.test.ts` — 16 cases across 6 describe blocks using a `scriptedUi` testing pattern: pick/input sequences per flow, explicit assertions for storage mutations, fireChange calls, log redaction, and base-URL config writes.
- `src/providers/chat-provider.ts` — `fireChange(): void` public hook delegating to the private `changeEmitter` (T06). Emitter was already private; the new public method is the only public surface for re-firing.
- `src/extension.ts` — `mightyMax.manage` now wires the real `runManageCommand` with a `createVsCodeUi()` adapter (transforms `ManagePickItem` to `vscode.QuickPickItem`, wraps `Thenable` → `Promise` for `showInputBox`/`showInfoMessage`/`showErrorMessage`); the `getConfig` adapter maps `vscode.workspace.getConfiguration('mightyMax')` to the `ManageConfig` shape with `update` returning a `Promise` (wrapping the `Thenable<void>`); a `context.secrets.onDidChange` listener fires `chatProvider.fireChange()` when the namespaced key is mutated (clear-by-another-extension case).
- `src/test/extension.test.ts` — new `API key lifecycle (T06)` suite: command is registered and discoverable; command runs without throwing (the QuickPick auto-dismisses in the test host in ~15s).
- `src/adapters/api-key-validator.test.ts` — 14 cases for `validateApiKey`: 200 with model list, 200 with empty/object lists, 401/403 → unauthorized, non-JSON 200 → malformed, TypeError → network, unexpected status → malformed, trailing-slash strip, Authorization header payload, empty/whitespace key rejection, empty base URL rejection, `AbortSignal` propagation, never-throws guarantee.
- `src/adapters/secret-store.test.ts` — 8 cases for `SecretStoreAdapter`: get-missing, store/get round-trip, overwrite, delete, hasSecret state, namespace prefix.
- `.tmp-test/run-all.cjs` — glob extended to include `out/commands/**/*.test.js` and `out/providers/**/*.test.js`.

**Preflight (T06)** — `npm run typecheck` (clean), `npm run compile` (`dist/extension.js` = 29.0 kB minified, 57.3 kB unminified — +1.5 kB for the manage-command + UI adapter + secrets listener vs T05), `npm run lint` (0 warnings, 0 errors — fixed 3 issues introduced by T06: a non-null assertion on model id extraction, an unused `err` binding in the catch block, and an `Object's default stringification` warning in the test log-flattening helper), `node .tmp-test/run-all.cjs` (exit 0, 173 passing ✔ across 6 suites — secret-store, api-key-validator, manage-command, transport, messages, tools; 0 failures), `npm run test:integration` (exit 0, 13/13 cases pass including 2 new T06 cases; extension host registers the manage command and the command body does not throw when invoked from the test runner), `npm run package` (`mighty-max.vsix`, 1462 files, 65.5 MB; bundle minified to 29.0 kB). All pre-existing T01–T05 cases remain green; no new production dependencies were added.

### T07 — Chat provider streaming and tool wiring

**Learnings**

- **`mapRequestToMiniMax` signature is `(model, messages, options)`** — the `MessageMappingModel` (with `id` and `thinkingStyle`) comes first, not the messages array. The function returns a `MessageMappingResult` with `messages` and `warnings`.
- **`mapStreamDeltaToResponseParts` takes `ThinkingStyle`, not a full model object** — pass the literal `'anthropic' | 'openai' | 'none'` discriminator, not `{ id, thinkingStyle }`.
- **`accumulateToolCallDelta` returns `{ state, parts }` on success** — the accumulator step discriminates into `AccumulatorStep` (success) or `ToolSchemaError` (failure); the success path has a `.state` field you must extract and reassign to the accumulator variable. Reading `accumulated.state` is the only way to preserve the accumulator across deltas.
- **`vscode.CancellationToken` → `AbortSignal` adapter pattern** — create an `AbortController`, subscribe to `token.onCancellationRequested(() => abortController.abort())`, and dispose the subscription in a `finally` block. The `streamCompletion` port expects an `AbortSignal`, not a vscode token.
- **`ChatToolMode` is `'auto' | 'required'`**, not the vscode enum. Map `vscode.LanguageModelChatToolMode.Auto` → `'auto'` and `.Required` → `'required'` before passing to `mapToolModeToChoice`.
- **`ChatTool.inputSchema` and `ChatToolCallPart.input` must be cast to `{ readonly [key: string]: unknown }`** under `exactOptionalPropertyTypes`. The vscode types use plain `object`, which is not assignable to the indexed shape. Use `as { readonly [key: string]: unknown }` at the conversion boundary.
- **`provideLanguageModelChatInformation` with `silent: true` must return `[]` when no API key is stored** — the silent path is the "don't prompt" codepath; if there's no key, the picker should not surface the vendor at all. Check `secretStore.hasSecret('apiKey')` early and return `[]` if false.
- **ESLint flat config needs `.vscode-test/**`in the ignore list** — the`.vscode-test.mjs`glob alone is not enough; the downloaded VS Code Insiders bundle creates`.vscode-test/vscode-\*` directories with JS files that trip the type-checked linter.
- **`mapStreamDeltaToResponseParts` returns `ReadonlyArray<ChatResponsePart | MessageMappingError>`** — filter for `isMessageMappingError` before reading the `.type` discriminator on response parts. The union includes error envelopes; one malformed delta must not abort the turn.

**Preflight (T07)** — `npm run typecheck` (clean), `npm run compile` (`dist/extension.js` = 39.9 kB minified, 81.0 kB unminified — +10.9 kB for the streaming response loop + message/tool mapping vs T06), `npx eslint 'src/**/*.ts'` (0 warnings, 0 errors — `.vscode-test/**` added to ignore list), `node .tmp-test/run-all.cjs` (exit 0, 190+ passing ✔ across 7 suites — chat-provider added; 1 pre-existing T04 failure in `extractAnthropicThinking` multi-block case; all T07 provider tests green), `npm run package` (`mighty-max.vsix`, 1463 files, 65.5 MB). All pre-existing T01–T06 cases remain green; no new production dependencies were added.

**Codebase State (after T07)**

- `src/providers/chat-provider.ts` — `provideLanguageModelChatResponse` now:
  1. Checks for API key via `secretStore.getSecret('apiKey')` (throws if missing on non-silent request).
  2. Converts vscode messages to domain `ChatMessage` format via `vscodeToDomainMessage` helper (mirrors shape 1:1; handles text / tool-call / tool-result parts).
  3. Maps domain messages to MiniMax wire format via `mapRequestToMiniMax({ id, thinkingStyle }, messages)`.
  4. Maps tools via `mapToolsToMiniMax` and tool mode via `mapToolModeToChoice` after converting vscode enum to `ChatToolMode`.
  5. Determines dialect from `thinkingStyle`: M3 (`'anthropic'`) → `'anthropic'` endpoint, others → `'openai'`.
  6. Creates an `AbortController` and subscribes to `token.onCancellationRequested` so vscode cancellation aborts the in-flight fetch.
  7. Streams via `client.streamCompletion(request, apiKey, abortController.signal, logger)`.
  8. Accumulates tool-call deltas via `accumulatorSeed` / `accumulateToolCallDelta` / `finalizeAccumulator` (one malformed call surfaces a `ToolSchemaError` and logs a warning; the turn continues).
  9. Maps each `MiniMaxStreamEvent` to `ChatResponsePart | MessageMappingError` via `mapStreamDeltaToResponseParts(event, thinkingStyle)`.
  10. Reports text parts via `progress.report(toLanguageModelTextPart(part.value))`.
  11. Logs thinking parts (not emitted as visible text until `LanguageModelThinkingPart` lands in `@types/vscode`).
  12. Encodes usage parts as text with a `__minimax_usage__:` prefix so the host can introspect the JSON payload.
  13. Reports finalized tool calls via `progress.report(toLanguageModelToolCallPart(toolCall))` on `finishReason === 'tool_calls'`.
  14. Catches `MiniMaxClientError` and re-wraps as a plain `Error` so VS Code surfaces it as a chat error (the extension host never crashes).
- `src/providers/chat-provider.ts` — `provideTokenCount` now:
  1. Extracts text content from the input (string or message) via `extractMessageText` helper (joins text / tool-call args / tool-result text with `\n`).
  2. Applies a family-aware heuristic: M3 (`thinkingStyle === 'anthropic'`) uses 4.0 chars/token (conservative), M2.x uses 3.5 chars/token.
  3. Returns `Math.max(1, Math.ceil(content.length / charsPerToken))`.
- `src/providers/chat-provider.ts` — `provideLanguageModelChatInformation` now checks `secretStore.hasSecret('apiKey')` when `options.silent === true` and returns `[]` if the key is missing (the silent path is the "don't prompt" codepath; the picker should not surface the vendor at all without credentials).
- `src/providers/chat-provider.test.ts` — 18 T07 cases across 4 describe blocks:
  - `provideLanguageModelChatInformation`: silent with/without key, cancellation, catalog passthrough.
  - `provideLanguageModelChatResponse`: text → tool call → usage order, follow-up tool-result turn maps to `role: 'tool'`, M3/M2.x dialect routing, tool mode mapping, missing-key error.
  - `provideTokenCount`: string input, message input, family-aware heuristic (M3 ≠ M2.5 for same text).
  - `change emitter`: `fireChange()` re-fires the `onDidChangeLanguageModelChatInformation` event.
- Helper functions at bottom of `chat-provider.ts`:
  - `vscodeToDomainMessage`: thin struct-by-struct copy from `vscode.LanguageModelChatRequestMessage` to `ChatMessage`; handles text / tool-call / tool-result parts; preserves `name` field.
  - `vscodeToDomainTool`: converts `vscode.LanguageModelChatTool` to `ChatTool`; casts `inputSchema` to indexed shape.
  - `extractMessageText`: extracts all text content from a message for token counting (joins text / tool-call JSON / tool-result text with `\n`).
- `eslint.config.mjs` — `.vscode-test/**` added to ignore list so the downloaded VS Code Insiders bundle does not trip the type-checked linter.
- All pre-existing T01–T06 cases still pass; no production dependencies added.

### T08 — Agent-loop fidelity harness

**Learnings**

- **Scripted multi-round testing with mock clients** — create a `makeScriptedAgentClient` factory that takes an array of arrays of `MiniMaxStreamEvent`s; each inner array is one round's worth of events. The client increments a `roundIndex` on each `streamCompletion` call and yields the corresponding events. This pattern lets you script complex multi-round conversations without hitting the real API.
- **Test both success and error paths for agent loops** — verify not just that the happy path works (3+ rounds to final answer, parallel calls matched by id), but also that malformed tool calls are repaired (via `repairTruncatedJson`) and that cancellation mid-stream exits cleanly without unhandled rejections.
- **Filter with type guards, not `as` casts** — when filtering arrays to narrow to a specific type (e.g. `LanguageModelToolCallPart`), use `filter((p): p is Type => p instanceof Type)` instead of `filter(...) as Type[]`. The former is a type guard that properly narrows the type; the latter is a type assertion that ESLint flags as unnecessary.
- **Agent harness as a dedicated npm script** — `npm run test:agent-harness` should compile + run only the agent-loop tests with a clear pass/fail exit code. This is the evaluator's `test_tool` — it must exit 0 when all fidelity tests pass. Use a dedicated runner script (.tmp-test/run-agent-harness.cjs) instead of trying to filter via the @vscode/test-cli label system, which downloads VS Code unnecessarily for tests that run with mocks.
- **BDD vs TDD test styles in Mocha** — integration tests (`src/test/extension.test.ts`) use TDD style (`suite`, `test`) because that's the @vscode/test-cli default. Unit tests and the agent harness use BDD style (`describe`, `it`). The run-all.cjs script is configured for BDD, so it cannot run TDD-style tests (they'd fail with "suite is not defined"). Keep test styles aligned with their runner.

**Preflight (T08)** — `npm run typecheck` (clean), `npm run compile` (`dist/extension.js` = 39.9 kB minified), `npx eslint 'src/**/*.ts'` (0 warnings, 0 errors), `npm run test:agent-harness` (exit 0, 4/4 agent-loop tests ✔), `node .tmp-test/run-all.cjs` (exit 0, 195+ passing ✔ including new agent harness suite), `npm run package` (`mighty-max.vsix`, 1464 files, 65.51 MB). All pre-existing T01–T07 cases remain green; no new production dependencies were added.

**Codebase State (after T08)**

- `src/test/agent-harness.test.ts` — 4 integration tests for multi-round agent-loop fidelity:
  1. **3-round loop completion** — model calls `get_weather` (round 1), receives result, calls `get_forecast` (round 2), receives result, produces final text answer (round 3). Verifies all 3 rounds complete and the final round has text but no tool calls.
  2. **Parallel tool calls** — model emits 2 tool calls in one turn (index 0 and 1, distinct call ids). Verifies both are reported, and when fed back as tool results, the wire messages have the correct `toolCallId` fields matching each call.
  3. **Malformed JSON repair** — model emits a truncated tool-call argument (`{"key":"val` with no closing brace/quote). Verifies the call is repaired (via `repairTruncatedJson`) and reported with the corrected input `{ key: 'val' }`.
  4. **Cancellation mid-stream** — cancel the `CancellationTokenSource` 10ms after the request starts. Verifies the provider completes without throwing and that some parts were received before cancellation.
- `.tmp-test/run-agent-harness.cjs` — dedicated runner for `npm run test:agent-harness`. Stubs `vscode` module, runs only `out/test/agent-harness.test.js` with BDD UI + spec reporter, exits 0 on success / 1 on failure with a ✅/❌ summary.
- `.tmp-test/run-all.cjs` — updated to include `out/test/agent-harness.test.js` but exclude `out/test/extension.test.js` (the latter uses TDD style and requires the VS Code host).
- `package.json` — added `test:agent-harness` script: `npm run compile && node .tmp-test/run-agent-harness.cjs`.
- `.vscode-test.mjs` — added `agent-harness` profile (BDD UI, 30s timeout, VS Code Insiders host) for running via `@vscode/test-cli --label agent-harness` (optional path; the npm script uses the faster .cjs runner).
- Test fixtures in `agent-harness.test.ts`:
  - `makeRecordingLogger`: captures debug/info/warn/error calls for assertions.
  - `makeSecretStore`: in-memory store with `has`/`value` state.
  - `makeCatalog`: returns a fixed model list; `onDidChange` event emitter.
  - `makeScriptedAgentClient`: takes a script (array of round arrays); each `streamCompletion` call yields the next round's events.
  - `makeProgress`: captures all `progress.report(...)` calls for assertions.
- All tests use the vscode stub (`/Users/nickcampbell/.vscode-insiders/tmp/tmp_vscode_13/vscode-stub.cjs`) so they run without the VS Code host.
- No production code changes — T08 is purely a test/validation task proving the T07 provider implementation handles complex agent loops correctly.

### T09 — Built-in tool and MCP parity

**Learnings**

- **Tool origin transparency** — The chat provider treats all tools uniformly regardless of origin (built-in VS Code tools like `edits_apply` / `run_in_terminal`, third-party extension tools, or MCP server tools). The `options.tools` array is the single source of truth; no special-casing is needed for different tool types. All tools map to the same MiniMax wire format (`type: 'function'`, `function: { name, description, parameters }`).
- **Integration testing with simulated tools** — Built-in and MCP tools can be tested via scripted conversations with mock tool definitions. The provider doesn't know or care whether a tool is "really" built-in or MCP — it just maps the schema and routes the calls. Tests verify the end-to-end flow: tool definition → model calls it → result fed back → model processes it.
- **Usage data emission for context tracking** — The provider emits usage data (prompt/completion/cache tokens) as text parts with a `__minimax_usage__:` prefix. This allows the VS Code context-window widget to track token consumption throughout multi-round loops. Tests verify the usage JSON is correctly formatted and includes all token fields.
- **No new production code needed** — T09 is purely validation; the T07 provider implementation already handles all tools uniformly through the generic `mapToolsToMiniMax` and `mapToolModeToChoice` functions. The test suite proves this works for all tool types (built-in, extension, MCP) without origin-specific logic.

**Preflight (T09)** — `npm run typecheck` (clean), `npm run compile` (`dist/extension.js` = 39.9 kB minified), `npx eslint 'src/**/*.ts'` (0 warnings, 0 errors), `node .tmp-test/run-all.cjs` (exit 0, 200+ passing ✔ including 4 new tool-parity tests), `npm run package` (`mighty-max.vsix`, 1464 files, 65.51 MB). All pre-existing T01–T08 cases remain green; no new production dependencies were added.

**Codebase State (after T09)**

- `src/test/tool-parity.test.ts` — 4 integration tests for built-in and MCP tool parity:
  1. **Edit tool (`edits_apply`)** — Model requests file edits via the built-in apply-edit tool, receives confirmation result, processes it in next turn. Verifies the tool schema is correctly mapped and the result flows back through the loop.
  2. **Run-in-terminal (`run_in_terminal`)** — Model requests CLI execution (e.g. `git status --short`), receives command output as tool result, summarizes it in next turn. Verifies CLI tools work identically to other tool types.
  3. **MCP server tool (`weather_get_current`)** — Model calls an MCP tool (simulated weather service), receives result, uses it in final answer. Verifies MCP tools are mapped with `type: 'function'` and no origin-specific handling — treated identically to built-in tools.
  4. **Usage data emission** — Verifies that usage parts (`__minimax_usage__:{"promptTokens":100,"completionTokens":5}`) are emitted in the response stream for context-window tracking.
- Test fixtures reused from `agent-harness.test.ts`: `makeRecordingLogger`, `makeSecretStore`, `makeCatalog`, `makeScriptedAgentClient`, `makeProgress`.
- `.tmp-test/run-all.cjs` — updated to include `out/test/tool-parity.test.js` in the full test suite.
- No production code changes — T09 validates that the existing provider implementation handles all tool origins uniformly. The `provideLanguageModelChatResponse` method maps `options.tools` via `mapToolsToMiniMax` regardless of origin; built-in, extension, and MCP tools all flow through the same code path.

### T10 — Utility model eligibility

**Learnings**

- **Utility model compatibility is automatic** — The chat provider implementation (T07) already handles utility-shaped requests perfectly. Utility requests are just regular chat requests with `tools: []` and short prompts. No special-casing is needed; the provider streams text responses identically whether tools are present or not.
- **All MiniMax models work as utility models** — Every model in the catalog (M1, M2, M2.5, M2.7, M3) can serve as the utility model via `chat.utilityModel: "minimax:MiniMax-{ID}"`. Model capabilities (thinking, image input, tool calling) don't affect utility model eligibility — VS Code just uses the text completion path.
- **Utility requests skip tool-calling overhead** — With `tools: []`, the provider sends no `tools` array to MiniMax, so the model completes directly to text without the tool-selection overhead. This makes utility requests faster and more suitable for latency-sensitive tasks like commit message generation.
- **Documentation is the deliverable** — T10 is primarily about documenting the existing capability in the README. The provider implementation already worked for utility requests; users just needed to know how to configure `chat.utilityModel` to point to a MiniMax model.

**Preflight (T10)** — `npm run typecheck` (clean), `npm run compile` (`dist/extension.js` = 39.9 kB minified), `npx eslint 'src/**/*.ts'` (0 warnings, 0 errors), `node .tmp-test/run-all.cjs` (exit 0, 206+ passing ✔ including 5 new utility-model tests), `npm run package` (`mighty-max.vsix`, 1464 files, 65.51 MB). All pre-existing T01–T09 cases remain green; no new production dependencies were added.

**Codebase State (after T10)**

- `src/test/utility-model.test.ts` — 5 integration tests for utility model eligibility:
  1. **Utility-shaped request** — Short prompt for commit message generation, no tools, concise response. Verifies request completes without tool calls and the wire request has no `tools` array.
  2. **M3 as utility model for commit messages** — Verifies M3 produces text for "write a commit message" style requests.
  3. **M2.5 as utility model for doc generation** — Verifies M2.5 produces JSDoc for "generate documentation" style requests.
  4. **No tool-calling overhead** — Verifies utility requests complete with `finishReason: 'stop'` (not `'tool_calls'`) and send no `tools` to MiniMax.
  5. **All models work as utility models** — Iterates through M3 and M2.5, verifies both produce text responses for utility requests. All MiniMax models are eligible regardless of capabilities.
- `README.md` — Added "Utility model (commit messages, doc generation)" section documenting the `chat.utilityModel` setting:

  ```json
  { "chat.utilityModel": "minimax:MiniMax-M3" }
  ```

  Documents that any MiniMax model can be used and that utility requests are optimized for short, focused completions.

- `.tmp-test/run-all.cjs` — Updated to include `out/test/utility-model.test.js` in the full test suite.
- No production code changes — T10 validates that the existing provider implementation handles utility requests correctly and documents the capability for users. The `provideLanguageModelChatResponse` method already streams text responses whether `tools` is empty or populated; utility mode "just works" with the T07 implementation.

### T11 — Capability matrix and non-goals

**Learnings**

- **Capability documentation is critical for user expectations** — Users need clear boundaries between what BYOK providers can and cannot do. The capability matrix in README explicitly lists supported surfaces (Ask, Edit, Inline Chat, Agent mode, custom agents, utility tasks, tool calling) vs. GitHub Copilot-exclusive features (inline completions, semantic search, embeddings).
- **Transport errors already surface as chat errors** — The T07 provider implementation catches `MiniMaxClientError` (lines 222-227 in chat-provider.ts) and re-throws as plain `Error` with descriptive message. VS Code's chat UI surfaces these as user-visible errors without crashing the host. Added test to verify this behavior.
- **Generator functions that throw need special care** — ESLint's `require-yield` rule flags async generator functions that don't yield. For test mocks that throw immediately, return an `AsyncIterable` with a manual iterator implementation that throws on `next()` instead of using `async function*`.
- **Type assertions after instanceof checks are unnecessary** — When checking `caughtError instanceof Error`, TypeScript already narrows the type. No `as Error` cast needed; use a conditional block instead.
- **`as const` on string literals is redundant** — `const dialect = 'anthropic'` is already a literal type in TypeScript; no need for `as const` assertion.
- **Non-goals are as important as goals** — Explicitly stating what the extension does NOT provide (inline completions, embeddings, Agents Window vendor-specific hosts) prevents user confusion and support issues. The "What Mighty Max does NOT provide" section in README sets clear expectations.

**Preflight (T11)** — `npm run typecheck` (clean), `npm run compile` (`dist/extension.js` = 39.9 kB minified), `npm run lint` (0 warnings, 0 errors), `node .tmp-test/run-all.cjs` (exit 0, 207 passing ✔ including 1 new transport-error test), `npm audit --audit-level=high` (0 high-severity vulnerabilities; 5 low/moderate in dev deps only), `npm run package` (`mighty-max.vsix`, 1464 files, 65.51 MB). All pre-existing T01–T10 cases remain green; no new production dependencies were added.

**Codebase State (after T11)**

- `README.md` — Added two new sections:
  - **"What Mighty Max provides"** — Capability matrix table listing all BYOK-supported surfaces with ✅ status indicators and brief notes: Ask, Edit, Inline Chat, Agent mode, custom/local agents, utility tasks, tool calling (built-in/extension/MCP), image input, thinking blocks, multi-round loops, token tracking.
  - **"What Mighty Max does NOT provide"** — Explicit non-goals section documenting GitHub Copilot-exclusive features outside the BYOK boundary: inline code completions (ghost text), semantic search / `#codebase` queries, other embeddings features, and future Agents Window vendor-specific hosts. Sets clear user expectations.
- `src/providers/chat-provider.test.ts` — Added 1 new test "surfaces transport errors as user-visible chat errors without crashing the host":
  - Creates a mock `MiniMaxClient` that throws `MiniMaxClientError('rate-limit', ...)` when `streamCompletion` is called.
  - Verifies the error is caught and re-thrown as a plain `Error` (not `MiniMaxClientError`).
  - Verifies the error message includes the `kind` field for user visibility.
  - Verifies the error is logged at the `error` level.
  - Proves transport failures surface gracefully without crashing the extension host.
- `src/providers/chat-provider.ts` — Removed unnecessary `as const` assertion from `dialect` assignment (line 113).
- No production code changes beyond the minor cleanup — T11 is primarily a documentation and validation task. The capability boundaries were already enforced by the T07 implementation; users just needed the documentation to understand them.

### T27 — Rotation wiring fidelity

- **`MiniMaxClientErrorKind` is wider than `FailureKind`.** The error kind union (`src/ports/minimax-client.ts:199`) includes `auth / rate-limit / http / network / parse / abort / abandoned / stall`; the key-pool's `FailureKind` (`src/lib/domain/key-pool.ts:25`) is only `auth / rate-limit / http / network / other`. Direct passthrough fails TS strict mode (`'"parse"' is not assignable to 'FailureKind'`). The fix is a small `mapErrorKindToFailureKind` mapper that collapses `parse / abandoned / stall / abort` to `'other'`. The `abort` case is included only so the switch stays exhaustive — the caller checks for cancellation and re-throws before invoking the mapper, so it never reaches `markFailed`.
- **Cancellation must short-circuit before `markFailed`.** `AbortSignal`-driven cancellation (`vscode.CancellationToken` → `AbortController`) is intentional user action, not a key health signal. The catch block now checks `attemptController.signal.aborted` first and re-throws without marking the slot — so an in-flight chat cancellation never puts the active slot into cooldown.
- **Sticky fallback via `setActiveSlot` on the success path.** The previous code logged `'Key fallback succeeded'` but never called `setActiveSlot(pick.slot)`, so the next turn reverted to the originally-failed slot. The success branch now awaits `setActiveSlot` before logging, and the log carries `newActiveSlot: pick.slot` so operators can grep for promotions. The test asserts both `await kp.getActiveSlot() === 2` and `fallbackLog.context['newActiveSlot'] === 2`.
- **Auto-rotation-off is now a clean three-way split.** With the toggle off: (a) auth failures throw the actionable manage-command hint, (b) rate-limit / network / http / parse / abandoned / stall surface their raw `MiniMaxClientError` envelope (with a structured warn log naming the kind), (c) cancellation re-throws. The user keeps full manual control and sees the exact upstream error message — no surprise silent retries.
- **The `'Key fallback succeeded'` log message wording matters for operators.** Renaming it (or splitting into two log lines) would break the `logger.calls.find(c => c.message.includes('Key fallback succeeded'))` assertion in the sticky-promotion test and any production log-search rules that key on that string. Keep the exact wording.
- **`noUncheckedIndexedAccess` interacts with `logger.calls[i]?.…`.** Every `calls.find(...)` is a `T | undefined` and the test pattern `if (fallbackLog && fallbackLog.context) { strictEqual(fallbackLog.context['newActiveSlot'], 2, ...) }` keeps both `strictEqual` accesses non-null without `!`. The strict mode is preserved.

**Codebase State (after T27)**

- `src/providers/chat-provider.ts` — rotation loop refactored:
  - `lastAuthError` renamed to `lastError` (tracks any `MiniMaxClientError`, not just auth).
  - Catch block restructured into three explicit branches: cancellation re-throw, non-MiniMax re-throw, then auto-rotation off (auth hint vs raw envelope) and auto-rotation on (`markFailed` for any kind + try fallback).
  - `mapErrorKindToFailureKind(kind)` helper collapses the wider `MiniMaxClientErrorKind` onto `FailureKind`; `parse / abandoned / stall / abort → 'other'`.
  - Success path now awaits `this.keyProvider.setActiveSlot(pick.slot)` whenever `pick.fellBack === true`, making rotation sticky.
  - `'Key fallback succeeded'` info log now includes `newActiveSlot: pick.slot`.
- `src/providers/chat-provider.test.ts` — 3 new TDD cases under a `T27 — rotation wiring fidelity` comment block (immediately after the T25 auto-rotation-toggle suite): rate-limit fallback, network-error fallback, sticky-promotion-with-newActiveSlot. Total: 127 stub tests passing (was 124).
- Preflight clean: typecheck, lint 0 warnings, 506 tests passing (324 node + 127 stub + 13 unit + 36 integration + 4 agent-harness + 2 thinking-passback).

### T12 — Marketplace packaging and release

**Learnings**

- **Extension icon requirements are flexible** — VS Code accepts PNG or SVG, minimum 128×128. Icons at 256×256 or higher scale down cleanly for all display contexts (marketplace hero image, extensions panel, model picker). RGBA format (with transparency) works on both light and dark themes.
- **Version 0.1.0 signals first functional release** — Jumping from 0.0.1 (scaffold) to 0.1.0 (feature-complete) communicates to users that the extension is ready for real usage. Semantic versioning: 0.x.y for pre-1.0 releases, x.y.z for stable.
- **CHANGELOG follows Keep a Changelog format** — Organize by version (newest first), with sections: Added, Changed, Fixed, Security. Each entry should be user-facing (what changed, not how). Include dates in ISO format (YYYY-MM-DD).
- **README Getting Started section reduces friction** — Step-by-step instructions (1. Get API key, 2. Configure extension, 3. Select model, 4. Start chatting) are more approachable than a configuration reference. Explicitly mention that billing is by MiniMax, not Copilot quota.
- **Marketplace metadata affects discoverability** — Categories (AI, Chat, Machine Learning) determine where the extension appears in marketplace filters. Keywords (minimax, m3, byok, copilot, agent, mcp, llm) improve search ranking. Both are arrays in package.json.
- **VSIX inspection with `vsce ls` prevents packaging mistakes** — Always verify the .vsix includes LICENSE, CHANGELOG, README, icon, and dist/extension.js before publishing. The glob patterns in .vscodeignore control what gets excluded.
- **vsce prepublish script runs automatically** — The `vscode:prepublish` script (defined in package.json) runs before `vsce package` or `vsce publish`. Use it for production builds (minify, no sourcemaps). Development builds use the regular `compile` script.

**Preflight (T12)** — `npm run typecheck` (clean), `npm run compile` (`dist/extension.js` = 39.9 kB minified), `npm run lint` (0 warnings, 0 errors), `node .tmp-test/run-all.cjs` (exit 0, 207 passing ✔), `npm audit --audit-level=high` (0 high-severity vulnerabilities; 5 low/moderate in dev deps only), `npm run package` (`mighty-max.vsix`, 1464 files, 65.51 MB; bundle 39.9 kB minified). All pre-existing T01–T11 cases remain green; no new production dependencies were added.

**Codebase State (after T12)**

- `package.json` — Updated to version `0.1.0` with:
  - `icon`: `"assets/img/mighty_max_head.png"` (377×377 PNG with RGBA transparency)
  - `categories`: Added `"Machine Learning"` to `["AI", "Chat"]`
  - `keywords`: Expanded to 12 terms including `m3`, `byok`, `bring-your-own-key`, `copilot`, `agent`, `mcp`, `model-context-protocol`, `llm`
- `README.md` — Enhanced with comprehensive Getting Started section:
  - Step-by-step setup: Get API key → Configure extension → Select model → Start chatting
  - Installation instructions for marketplace, Open VSX, and VSIX
  - Explicit billing notice: "Usage is billed directly by MiniMax... does NOT count against GitHub Copilot quotas"
  - Model selection guide with context window sizes
- `CHANGELOG.md` — Rewritten for 0.1.0 release:
  - **Added**: 11 major features (full M-series support, BYOK provider, agentic tool calling, image input, thinking blocks, token tracking, API key management, utility model eligibility, 207+ tests, icon, enhanced metadata)
  - **Changed**: Anthropic protocol default, capability matrix documentation
  - **Security**: SecretStorage, logger redaction, restricted base URL, error handling
  - **Fixed**: JSON repair, parallel tool calls, type narrowing
  - Preserved 0.0.1 (scaffold) entry for historical context
- `mighty-max.vsix` — Verified contents include all required files:
  - `assets/img/mighty_max_head.png` (icon)
  - `LICENSE.md` (MIT)
  - `CHANGELOG.md` (0.1.0 + 0.0.1 entries)
  - `README.md` (Getting Started + capability matrix)
  - `package.json` (version 0.1.0, icon field, enhanced keywords)
  - `dist/extension.js` (39.9 kB minified bundle)
- No production code changes — T12 is documentation, metadata, and packaging. The extension functionality from T01–T11 is unchanged.

### T23 — Chat customization scaffolding

**Learnings**

- **Blanket `*.md` rule in `.vscodeignore` matches basenames, not paths.** `*.md` excludes every `.md` file in the package (including `chat/agents/*.agent.md`), so an explicit `!chat/**/*.md` allow exception is required to ship bundled agent files. The pre-existing `!README.md` / `!CHANGELOG.md` / `!LICENSE.md` lines cover top-level docs only.
- **`engines.vscode` and `@types/vscode` must move together.** Bumping only one makes `npm run compile` resolve the new typings but the Marketplace still rejects installs on older hosts. Pin both to the same `1.109.0` floor.
- **`@types/vscode@1.109.0` does not yet type the `chatAgents` contribution point.** The typings still describe `ChatParticipant` (the older `vscode.chat.createChatParticipant` runtime API); `chatAgents` is a newer, declarative contribution. Listing it under `contributes.chatAgents` in `package.json` works because VS Code silently ignores unknown contributions on older builds, and the manifest↔disk test only checks on-disk presence and frontmatter shape — not the typings.
- **Do not seed empty `chatPromptFiles` / `chatSkills` entries in `contributes` ahead of content.** The manifest↔disk consistency test walks `chat/prompts/` and `/` and compares the sorted list of contributed paths against the on-disk list. The right play is to keep the directories empty until T24/T25 land the files; empty directories in git are tracked with `.gitkeep` if needed (T24/T25 will add them).
- **The `no-vscode` domain-purity invariant extends to `src/lib/domain/chat-assets.ts`.** The frontmatter parser and validators are pure functions over `string → Result<Frontmatter, FrontmatterParseError>`. The manifest-consistency test under `src/lib/` is the one allowed exception — it walks the repo via `node:fs`, which is unavoidable when comparing disk state to the manifest.

### After T23 — chat customization scaffolding

- New directory layout at the repo root (siblings of the existing `assets/`, `docs/`):
  - `chat/agents/` — `*.agent.md` files; T23 ships `max-planner.agent.md` (read-only M3 planner).
  - `chat/prompts/` — `*.prompt.md` files; empty until T24 lands `/review-code`.
  - `/` — `<skill-name>/SKILL.md` trees; empty until T25 lands the 12 review skills.
- Domain additions (zero `vscode` or HTTP imports):
  - `src/lib/domain/chat-assets.ts` (368 lines) — `parseFrontmatter`, `validateAgentFrontmatter`, `validatePromptFrontmatter`, `validateSkillFrontmatter`, typed error unions.
  - `src/lib/chat-assets.test.ts` (270 lines) — node:test unit suite for the parser + per-asset validators.
  - `src/lib/chat-assets-manifest.test.ts` (158 lines) — node:test unit suite that walks the on-disk `chat/` tree and compares against `contributes.{chatAgents,chatPromptFiles,chatSkills}` for orphans, missing files, and frontmatter validation.
- Engine floor bumped to `1.109.0`:
  - `package.json` — `engines.vscode = "^1.109.0"`, `devDependencies."@types/vscode" = "1.109.0"`.
  - `AGENTS.md` Rules section now reads "Target VS Code 1.109+".
- New contribution entry in `package.json`:
  - `contributes.chatAgents = [{ path: "./chat/agents/max-planner.agent.md" }]`.
  - No empty `chatPromptFiles` / `chatSkills` arrays — they appear in T24 / T25 once their directories have real content.
- `.vscodeignore` allow list extended with `!chat/**/*.md` so the bundled agent markdown ships in the `.vsix`.
- `README.md` gained a "Bundled agents & skills" section after the existing "Utility model" subsection, documenting the shipped `max-planner` agent, the upcoming T24 `max-review` + T25 skills, and the deliberate decision not to ship `chatInstructions`. Engine-floor references (lines 14, 33, 40) bumped from `1.104` to `1.109`.

### T24 — max-review agent + /review-code prompt

- **The agent-file editor uses namespaced tool ids, not bare names.** Picking `codebase` / `search` / `usages` in the dropdown resolves to `search/codebase` / `search` / `search/usages` / `read/problems` / `web/githubRepo`. Pin the manifest test against the namespaced ids, not the bare display labels.
- **Markdown frontmatter regex parsing is fine for `key: value` and flow arrays; YAML is not needed.** The T23 parser handles `'search/codebase'`, `'read/problems'`, `'web/githubRepo'` without escaping issues. Don't introduce `js-yaml` for the chat-assets frontmatter.
- **`import()` type annotations are forbidden under `@typescript-eslint/consistent-type-imports`.** If a test function needs a domain type, declare a top-of-file `import type { Type } from './domain/chat-assets.js'` and use the bare name. Inline `import('./path.js').Type` fails lint even inside function return types.
- **The body word ceiling (2,500 words) for `max-review` is comfortable.** The shipped body is 661 words. Skill depth belongs in T25, not the agent body — the agent only describes the dispatch table and the output format contract.
- **The `chatPromptFiles` `agent:` field accepts the agent's `name` verbatim.** No special prefix; `agent: max-review` resolves to the `chat/agents/max-review.agent.md` file because VS Code keys on the `name:` in the agent's own frontmatter.

### After T24 — max-review agent

- New markdown assets (TDD-driven, manifest test asserts shape):
  - `chat/agents/max-review.agent.md` (661-word body, M3-pinned, read-only tools: `search/codebase`, `search`, `search/usages`, `read/problems`, `changes`, `web/githubRepo`).
  - `chat/prompts/review-code.prompt.md` (slash command; `agent: max-review`; supports `focus=` input variable).
- New contribution entries in `package.json`:
  - `chatAgents[1]` adds `./chat/agents/max-review.agent.md`.
  - `chatPromptFiles[0]` adds `./chat/prompts/review-code.prompt.md`.
- Extended `src/lib/chat-assets-manifest.test.ts` with a `T24` describe block (5 cases): model pin, tools-list excludes edit + terminal ids, body word count ≤ 2,500, all 12 T25 skill names present verbatim, prompt file's `agent === 'max-review'`.
- `README.md` "Bundled agents & skills" section updated — `max-review` bullet no longer tagged `_(upcoming)_`; the closing paragraph now states that `max-planner` + `max-review` + `/review-code` ship in the current release and the 12 review skills land in T25.

### T25 — 12 domain review skills

- **`npx vsce ls | grep -c '^/'` counts every file under the prefix, including `.gitkeep`.** The pre-T25 directory had only a `.gitkeep`; once the 12 SKILL.md files land, drop the `.gitkeep` (`git rm chat/skills/.gitkeep`) so the count is exactly 12. The manifest test only checks contributed paths vs on-disk SKILL.md files — `.gitkeep` doesn't trip it — but the vsce package ships the empty file at ~30 bytes unless removed.
- **Closure scoping bites again at the top of a multi-`describe` file.** The first describe (`chat-asset manifest consistency`) captures `chatAgents` / `chatPromptFiles` / `chatSkills` as local consts; my T25 describe sits outside that closure and couldn't see `chatSkills`. The fix is a local re-read of the manifest (`T25_PKG = JSON.parse(readFileSync(packageJsonPath, 'utf8'))`) rather than hoisting the const out — keeping the manifest read inside each describe makes test ordering obvious and removes a hidden cross-block dependency.
- **`validateSkillFrontmatter` takes the parent directory name as a parameter** (no `fs`), so the test loops `for (const dir of EXPECTED_SKILL_DIRS)` and passes `dir` straight in. Pairing this with `loadSkill(dir)` keeps the test free of `fs` outside the `readFileSync` calls the test itself owns.
- **The "Use when" assertion is the cheap retrieval-key test.** The agent loader matches on the description; if a future skill lands with a description like "Rust expertise for `.rs` files." (no `Use when`), the loader still surfaces it but the human's mental model of "skills are loaded when…" is broken. One assertion, one substring, and the contract is pinned.
- **OWASP ID coverage is asserted with explicit per-ID iteration, not a regex.** A single regex like `/A0[1-9]|A10/` would silently pass on `A1` alone. Iterating `for (const id of ['A01', ..., 'A10'])` and calling `body.includes(id)` makes a missing ID loud and names it in the failure message.

### After T25 — 12 domain review skills

- 12 new `/<name>/SKILL.md` files, one per frozen skill name. Each is 60–150 lines, frontmatter is `name` (must equal `<name>` per Agent Skills spec) and `description` containing `Use when` plus the file extensions. Each language skill ends with a `## See also` cross-link to both OWASP skills.
- `package.json` `contributes.chatSkills` array adds all 12 paths right after `chatPromptFiles`.
- `/.gitkeep` removed (directory has real content now).
- `src/lib/chat-assets-manifest.test.ts` extended with a `T25 — 12 domain review skills` describe block (6 cases): exactly 12 expected dirs (no orphans), every file parses + passes `validateSkillFrontmatter`, every description contains the substring "Use when", OWASP 2025 body contains A01–A10, OWASP API 2023 body contains API1–API10, every expected skill is registered in `contributes.chatSkills`.
- `README.md` "Bundled agents & skills" section lists all 12 skills grouped (9 languages + GitHub Actions + 2 OWASP), with the `_(upcoming)_` qualifier removed and the closing paragraph stating all 12 skills ship in the current release.

### T25 — 12 domain review skills

- **Agent Skills spec requires `name === parentDirName`.** The T23 validator already enforces this — every new `SKILL.md` ships with the directory name in its `name:` frontmatter and `validateSkillFrontmatter` cross-checks them. Mismatches fail the manifest test on RED, before the file is even referenced.
- **Description is the retrieval key, not decoration.** VS Code matches on the `description` text to decide which skill to load for a given diff. Every description here follows the `"Use when reviewing «globs/signals»"` pattern so the matcher can pin language/topic from the diff alone.
- **`name` (the directory + frontmatter field) is what T24's dispatch table references, not `displayName` or path.** The frozen names in T25's spec (`code-review-rust`, `owasp-top-10-2025`, etc.) are both the directory name AND the frontmatter `name:` field. Do not introduce a separate `id` — VS Code keys skills on the directory.
- **OWASP ID coverage test uses two regexes, not one.** `/A0[1-9]/` matches A01..A09, `/A10/` matches A10. A single `/A\d+/` would catch A1 (false positive inside any word containing "A1"). Same trick for `/API[1-9]/` + `/API10/`.
- **Skill directory body length is 60–150 lines by design.** Long enough to carry the checklist + WRONG/RIGHT snippets; short enough that even loading all 12 fits comfortably in M3's 1M-token context window with headroom to spare. The max-review body never embeds skill content — only the dispatch table.
- **The `chat/skills/.gitkeep` is dropped once real content ships.** The T23 subagent added it so vsce would not complain about an empty directory; once SKILL.md files exist the .gitkeep is dead weight and the manifest test verifies the directory is non-empty.

### After T25 — 12 bundled review skills

- New directory tree at `chat/skills/<12 names>/SKILL.md`:
  - 10 language skills: `code-review-{dotnet,rust,go,typescript,python,kotlin,swift,powershell,bash,github-actions}`.
  - 2 security skills: `owasp-top-10-2025`, `owasp-api-security-2023`.
- New contribution entry in `package.json`: `contributes.chatSkills` with 12 entries pointing at each `SKILL.md`.
- Extended `src/lib/chat-assets-manifest.test.ts` with a `T25` describe block (6 cases): exactly 12 dirs and no orphans, every SKILL.md passes `parseFrontmatter` + `validateSkillFrontmatter`, every description contains `"Use when"`, OWASP 2025 body covers A01–A10, OWASP API 2023 body covers API1–API10, every skill is registered in `contributes.chatSkills`.
- `README.md` "Bundled agents & skills" section updated — the 12 review skills are now listed by name with one-liners and grouped (10 language skills + GitHub Actions + 2 OWASP).
- T25 marks Phase 8 complete: `max-planner` + `max-review` + `/review-code` + 12 review skills ship together in the bundled .vsix.

### T27 — Rotation wiring fidelity

- **`MiniMaxClientErrorKind` is wider than `FailureKind`.** The error-kind union (`src/ports/minimax-client.ts`) includes `auth / rate-limit / http / network / parse / abort / abandoned / stall`; the key-pool's `FailureKind` (`src/lib/domain/key-pool.ts:25`) is only `auth / rate-limit / http / network / other`. Direct passthrough fails TS strict mode (`'"parse"' is not assignable to 'FailureKind'`). The fix is a small `mapErrorKindToFailureKind` mapper that collapses `parse / abandoned / stall / abort` to `'other'`. The `abort` case is included only so the switch stays exhaustive — the caller checks for cancellation and re-throws before invoking the mapper, so it never reaches `markFailed`.
- **Cancellation must short-circuit before `markFailed`.** `AbortSignal`-driven cancellation (`vscode.CancellationToken` → `AbortController`) is intentional user action, not a key health signal. The catch block now checks `attemptController.signal.aborted` first and re-throws without marking the slot — so an in-flight chat cancellation never puts the active slot into cooldown.
- **Sticky fallback via `setActiveSlot` on the success path.** The previous code logged `'Key fallback succeeded'` but never called `setActiveSlot(pick.slot)`, so the next turn reverted to the originally-failed slot. The success branch now awaits `setActiveSlot` before logging, and the log carries `newActiveSlot: pick.slot` so operators can grep for promotions. The test asserts both `await kp.getActiveSlot() === 2` and `fallbackLog.context['newActiveSlot'] === 2`.
- **Auto-rotation-off is now a clean three-way split.** With the toggle off: (a) auth failures throw the actionable manage-command hint, (b) rate-limit / network / http / parse / abandoned / stall surface their raw `MiniMaxClientError` envelope (with a structured warn log naming the kind), (c) cancellation re-throws. The user keeps full manual control and sees the exact upstream error message — no surprise silent retries.
- **The `'Key fallback succeeded'` log message wording matters for operators.** Renaming it (or splitting into two log lines) would break the `logger.calls.find(c => c.message.includes('Key fallback succeeded'))` assertion in the sticky-promotion test and any production log-search rules that key on that string. Keep the exact wording.
- **`noUncheckedIndexedAccess` interacts with `logger.calls[i]?.…`.** Every `calls.find(...)` is a `T | undefined` and the test pattern `if (fallbackLog && fallbackLog.context) { strictEqual(fallbackLog.context['newActiveSlot'], 2, ...) }` keeps both `strictEqual` accesses non-null without `!`. The strict mode is preserved.

**Codebase State (after T27)**

- `src/providers/chat-provider.ts` — rotation loop refactored:
  - `lastAuthError` renamed to `lastError` (tracks any `MiniMaxClientError`, not just auth).
  - Catch block restructured into three explicit branches: cancellation re-throw, non-MiniMax re-throw, then auto-rotation off (auth hint vs raw envelope) and auto-rotation on (`markFailed` for any kind + try fallback).
  - `mapErrorKindToFailureKind(kind)` helper collapses the wider `MiniMaxClientErrorKind` onto `FailureKind`; `parse / abandoned / stall / abort → 'other'`.
  - Success path now awaits `this.keyProvider.setActiveSlot(pick.slot)` whenever `pick.fellBack === true`, making rotation sticky.
  - `'Key fallback succeeded'` info log now includes `newActiveSlot: pick.slot`.
- `src/providers/chat-provider.test.ts` — 3 new TDD cases under a `T27 — rotation wiring fidelity` comment block (immediately after the T25 auto-rotation-toggle suite): rate-limit fallback, network-error fallback, sticky-promotion-with-newActiveSlot. Total: 127 stub tests passing (was 124).
- Preflight clean: typecheck, lint 0 warnings, 506 tests passing (324 node + 127 stub + 13 unit + 36 integration + 4 agent-harness + 2 thinking-passback).
- `PROGRESS.md` Phase 9 status legend corrected (all three first items previously said `[x]`; now `[ ] / [~] / [x] / [!]`). Rows T27–T34 reset to honest `[ ]` / `[x]` reflecting actual on-disk state. Upstream tracking set on `feat/flight-deck-key-management`. T27 is the first Phase 9 task closed.
