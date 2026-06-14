# Changelog

All notable changes to Mighty Max are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/) and the
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.4] — 2026-06-14

### Added

- **Smart tool filtering**: When M3 receives 80+ tools (common in MCP-heavy VS Code setups) it stops calling tools and generates text instead. Smart filtering automatically scores and reduces the tool set sent per request based on keyword relevance, historical call frequency, or a hybrid of both. New settings: `mightyMax.enableSmartToolFiltering` (default `true`), `mightyMax.maxTools` (default `30`), `mightyMax.alwaysIncludeTools` (priority list), `mightyMax.toolFilterStrategy` (`"relevance"` | `"usage"` | `"hybrid"`). See `SMART_TOOL_FILTERING.md` for details.
- **Thinking block passback cache**: A per-provider shadow cache stores thinking blocks with their Anthropic signatures keyed by a hash of the preceding assistant message. Cached blocks are re-injected into enriched messages before each request so M3 extended-thinking round-trips survive VS Code's history reconstruction, bridging the gap until `LanguageModelThinkingPart` is available in `@types/vscode`.
- **Capability validation guards**: `evaluateAgentEligibility` now rejects model capability objects that carry non-boolean flags (e.g. a string `"true"`) and returns typed reasons explaining the failure instead of silently producing incorrect eligibility.
- **`tool-call` / `tool-result` callId validation**: `validateMessages` now emits a `missing-tool-call-id` error for any tool-call or tool-result part that lacks a non-empty `callId`, surfacing wire mistakes before they reach the transport.
- **Robust `callId` extraction**: new `partCallId` helper resolves the call id from `part.callId`, `part.toolCall.callId`, or `part.toolResult.callId` to cover all shaped variants that flow through the mapper.
- **Tool usage statistics**: `ChatProvider` accumulates per-tool call counts across the provider lifetime; the smart filter uses these counts to prioritise tools that have been successfully called before.

### Changed

- **`mapRequestToMiniMax` uses enriched messages**: thinking-block injection happens before the mapper sees messages, so the Anthropic `thinking` blocks land in the correct assistant turn on the wire.
- **`StartStreamingRequest` extended**: `MiniMaxClient` port now carries optional `thinking` configuration (`type`, `budgetTokens`) surfaced from `ThinkingStyle` so the transport can forward the right extended-thinking parameters to MiniMax.
- **Streaming log level raised to `info`**: the "Starting streaming request" log line is now `info` (was `debug`) and includes `toolMode` and the full tool name list for easier on-call diagnosis.
- **`MappingValidationError` code union extended**: the discriminated `code` type now includes `'missing-tool-call-id'` so callers get exhaustive narrowing.

### Fixed

- **Transient 5xx server errors now retried**: `MiniMaxClientAdapter` now retries 500, 502, 503, 504, and 529 (overloaded) responses with the same bounded exponential backoff strategy used for 429 and network errors (up to `maxRetries` attempts). Previously all 5xx errors failed immediately on first occurrence. The transport also logs detailed request/response diagnostics for all 5xx errors similar to 400 errors, making server-side failures easier to diagnose.
- **`pendingToolUseStarts` made request-scoped**: moved the Anthropic tool-use header buffer from module-level to per-request `MutableParseState` so an abandoned stream cannot leak tool-call fragments into a concurrent request on the same transport instance.

## [0.1.2] — 2026-06-10

### Fixed

- **Transport double-read of error body**: `MiniMaxClientAdapter` no longer crashes with `Body is unusable: Body has already been read` on 4xx/5xx responses. The error body is now read once and re-wrapped into a new `Response` so logging and error propagation both have access to it (was previously the case in `error_from_console.txt`).
- **Anthropic `tool_use` blocks lost across turns**: `mapRequestToMiniMax` now preserves `tool-call` parts in assistant history (instead of warning and dropping them), so Anthropic `tool_use`/`tool_result` round-trips survive across multi-round agent loops.
- **Orphan `tool_result` in request payload**: `mapRequestToMiniMax` now drops `role: 'tool'` wire messages whose `toolCallId` doesn't match any `tool_call` id from the immediate prior assistant turn, and surfaces a typed warning. Anthropic rejects the request outright with `400 invalid params, tool result's tool id not found (2013)` if a `tool_result` references a `tool_use_id` the assistant never emitted. The chat-provider's history scrubber can drop the `tool_use` half while keeping the `tool_result`; the reconciler closes the gap so the user no longer sees a hard 400 mid-session.
- **Structured tool result rendered as `[object Object]`**: the message mapper now `JSON.stringify`s non-string content before it hits the wire. Anthropic's `tool_result.content` rejects objects and falls back to `String(obj) → [object Object]`; enforcing a primitive string at the mapper boundary is the only safe place to do this.
- **`tool-call` part emitted on a non-assistant role**: now dropped with a typed `unsupported-content` warning. The matching `tool-result` on the next message is then dropped by the reconciler, so the pair never breaks the assistant/tool alternation the Anthropic protocol requires.
- **Slow request stalls surfaced silently**: `MiniMaxClientAdapter` now emits a `warn`-level `MiniMax request slow — possible model stall` line (visible at the default log level) when `elapsedMs > 20_000`, and includes `cacheReadTokens` / `cacheCreateTokens` from the stream's `usage` block so a stall is diagnosable as "cold cache, real work" vs "warm cache, server-stalled." The completion `info` log carries the same cache fields so non-slow requests are also observable.
- **Abandoned stream silently completing an empty turn**: when a stream ends without a terminal `finishReason` marker and `elapsedMs > 30_000`, the transport now throws a typed `MiniMaxClientError({ kind: 'abandoned' })`. The chat-provider catches it and surfaces a user-visible message ("The model started a response but its tool loop was interrupted before any tool calls could run. Try again — if the issue persists, the model may be hitting a context-window or rate-limit ceiling.") instead of letting the turn end with "I'll build X now" and no follow-up execution. The 30+ second requests observed in long Mighty Max sessions (Sturgis WXR exporter, etc.) are now caught and reported instead of being silently absorbed. See `tasks/T16-server-side-cache-observability.md` for the diagnostic recipe.
- **Empty stream treated as success**: a stream that delivers zero events now throws `MiniMaxClientError({ kind: 'network' })` instead of being logged as a successful completion with no output. The transport still throws `kind: 'abandoned'` for the more common case of "events arrived but no finish marker."
- **MiniMax Anthropic endpoint authentication**: switched from `x-api-key` to `Authorization: Bearer` to match MiniMax's actual Anthropic-compatible endpoint requirements.
- **Anthropic message ordering**: leading assistant text is now folded into the system prompt so the Anthropic `messages` array always begins with a user turn (Anthropic API requirement), while tool calls are preserved.
- **Anthropic tool schema conversion**: OpenAI-format tools and `tool_choice` are now translated to Anthropic's `input_schema` and `{type,name}` shape.
- **Temperature clamping**: outgoing `temperature` is now clamped to `[0, 2]` for both MiniMax dialects.

## [0.1.0] — 2026-06-10

### Added

- **Full MiniMax M-series model support**: M3, M2.7, M2.5, M2, M1 appear in VS Code Chat model picker under `minimax` vendor
- **Complete BYOK chat provider**: Ask, Edit, Inline Chat, Agent mode, custom agents, and utility tasks all supported
- **Agentic tool calling**: Multi-round agent loops with built-in tools (apply-edit, run-in-terminal), extension tools, and MCP server tools
- **Image input support**: M3, M2.7, M2.5, M2 accept images via data URIs
- **Thinking blocks**: M3 surfaces native Anthropic-style thinking; M2.x surfaces OpenAI-style reasoning
- **Token usage tracking**: Accurate context-window widget updates via prompt/completion token counts
- **Anthropic-compatible endpoint**: All models use MiniMax's Anthropic-compatible protocol (`/v1/messages`)
- **API key management**: Secure SecretStorage-based key lifecycle via `Mighty Max: Manage` command
- **Utility model eligibility**: Any MiniMax model can serve as `chat.utilityModel` for commit messages and doc generation
- **Comprehensive test coverage**: 207+ unit and integration tests covering agent loops, tool parity, message mapping, and error handling
- **Extension icon**: Mighty Max head logo (377×377 PNG with transparency)
- **Enhanced marketplace metadata**: Categories (AI, Chat, Machine Learning), keywords (minimax, m3, byok, copilot, agent, mcp)

### Changed

- **Anthropic protocol default**: Switched all models to Anthropic-compatible endpoint (VSCode prefers Anthropic over OpenAI)
- **Capability matrix documentation**: README now explicitly lists supported features and GitHub Copilot-exclusive features outside BYOK boundary

### Security

- API keys stored exclusively in `context.secrets` (SecretStorage), never in settings
- Logger redacts API keys, Authorization headers, and 401 response bodies at all log levels
- Base URL setting restricted in untrusted workspaces
- Transport errors surface as user-visible chat errors without crashing extension host
- Bounded JSON repair for malformed tool calls prevents agent turn abortion

### Fixed

- Tool-call argument JSON repair for truncated/malformed streamed payloads
- Parallel tool calls with correct result matching across multi-round loops
- Type narrowing with type guards instead of unsafe type assertions

---

## [0.0.1] — 2026-06-09

### Added

- VS Code extension scaffold with strict TypeScript and esbuild bundling
- `languageModelChatProviders` contribution under the `minimax` vendor
- `Mighty Max: Manage` command for API key lifecycle
- Settings: `mightyMax.baseUrl`, `mightyMax.logLevel`
- Capability manifest: untrusted/virtual workspaces (limited)
- ESLint flat config with deny profile (no-floating-promises, no-explicit-any, etc.)
- `@vscode/test-cli` profiles: unit and integration
- GitHub Actions CI: Ubuntu/Windows/macOS matrix
