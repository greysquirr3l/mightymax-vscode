# Changelog

All notable changes to Mighty Max are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/) and the
project adheres to [Semantic Versioning](https://semver.org/).

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
