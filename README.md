<div align="center">
  <img src="https://raw.githubusercontent.com/greysquirr3l/mightymax-vscode/refs/heads/main/assets/img/mighty_max_logo_readme.png" alt="Mighty Max Logo" width="350" />
</div>

# Mighty Max

MiniMax M-series language models for VS Code Chat (BYOK).

## What this is

Mighty Max is a Visual Studio Code and VS Code Insiders extension that
contributes the MiniMax M-series models (M3, M2.7, M2.5, M2, M1) to
VS Code Chat via the Language Model Chat Provider API (finalized in
VS Code 1.109). It registers under the `minimax` vendor and works as
a complete drop-in backend for Ask, Edit, Inline Chat, Agent mode,
custom and local agents, and utility tasks (commit messages, etc).

The defining feature is full agentic tool-calling parity: VS Code
hands the model a tool set per request, Mighty Max translates that
set into MiniMax's tool schema, streams tool calls back as the model
emits them, feeds tool results back, and loops until the agent turn
completes — without dropping, reordering, or garbling calls across
many rounds.

It speaks the MiniMax OpenAI- and Anthropic-compatible endpoints on
platform.minimax.io, streams responses incrementally, surfaces M3's
native thinking blocks, supports image input, and reports accurate
token usage so the context-window widget stays correct. Usage is
billed by MiniMax and does not count against Copilot quotas.

## Requirements

- VS Code 1.109 or later (Stable or Insiders)
- A MiniMax API key — set via the `Mighty Max: Manage` command

## Installation

### From Marketplace

1. Open VS Code or VS Code Insiders (version 1.109 or later)
2. Go to Extensions (Ctrl+Shift+X / Cmd+Shift+X)
3. Search for "Mighty Max"
4. Click Install

Alternatively, install from [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=greysquirr3l.mighty-max).

The extension ships as a single CommonJS bundle with no native dependencies or `node_modules`.

### From VSIX

Download the `.vsix` file from the [GitHub Releases](https://github.com/greysquirr3l/mightymax-vscode/releases) page, then:

```bash
code --install-extension mighty-max.vsix
```

## Getting Started

### 1. Get a MiniMax API Key

1. Sign up at [platform.minimax.io](https://platform.minimax.io)
2. Navigate to your API keys section
3. Create a new API key (starts with `sk-`)
4. Copy the key — you'll need it in the next step

**Billing**: Usage is billed directly by MiniMax based on your subscription plan. It does **not** count against GitHub Copilot quotas.

### 2. Configure the Extension

1. Open the Command Palette (Ctrl+Shift+P / Cmd+Shift+P)
2. Run **"Mighty Max: Manage"**
3. Select **"Set API key"**
4. Paste your MiniMax API key
5. The key is stored securely in VS Code's SecretStorage (never in settings)

### 3. Select a Model

1. Open the Chat panel (View → Chat or Ctrl+Alt+I / Cmd+Alt+I)
2. Click the model picker dropdown
3. Select a MiniMax model:
   - `minimax:MiniMax-M3` — Latest, with thinking blocks (1M context)
   - `minimax:MiniMax-M2.7` — High performance (1M context)
   - `minimax:MiniMax-M2.5` — Balanced (1M context)
   - `minimax:MiniMax-M2` — Fast (196K context)
   - `minimax:MiniMax-M1` — Lightweight (32K context)

### 4. Start Chatting

Use any Chat feature:

- **Ask** — Type questions in the Chat panel
- **Edit** — Select code, right-click → "Edit with Chat"
- **Inline Chat** — Press Ctrl+I / Cmd+I in the editor
- **Agent mode** — Enable tools, the model can edit files and run commands

## Configuration

| Setting              | Scope       | Default                  | Description                                                     |
| -------------------- | ----------- | ------------------------ | --------------------------------------------------------------- |
| `mightyMax.baseUrl`  | application | `https://api.minimax.io` | MiniMax API base URL. Restricted in untrusted workspaces.       |
| `mightyMax.logLevel` | window      | `info`                   | Minimum log level forwarded to the `Mighty Max` output channel. |

The API key never lives in settings — it is stored exclusively in
`context.secrets` (SecretStorage) and entered through the
`Mighty Max: Manage` command.

## Token plan usage indicator

Once a Subscription Key is stored, Mighty Max adds a status-bar item
on the right side (the Mighty Max aviator glyph) that mirrors the
MiniMax console's Token Plan usage bar. The icon stays neutral until
the first successful fetch, then renders the binding constraint
across the 5-hour and weekly windows:

- **0–79%** — neutral foreground
- **80–99%** — warning tint
- **100%** — error tint (the console also pauses requests at 100%)

Hover for a tooltip with per-window usage bars and reset times; click
(or run **Mighty Max: Show MiniMax Usage**) to open a compact panel
with the same data, a refresh button, and a collapsible raw-response
disclosure that helps diagnose schema drift.

The indicator refreshes every 5 minutes. Switching the API key via
**Mighty Max: Manage** triggers an out-of-band refresh so the new
quota shows immediately. Pay-as-you-go keys don't have a Token Plan
bar — the adapter catches the 4xx and the status bar stays neutral
with a "click for details" tooltip, never a red icon.

The endpoint is `GET https://www.minimax.io/v1/token_plan/remains`
and is unauthenticated from MiniMax's published schema standpoint —
it requires only the Subscription Key as a Bearer token. The same
endpoint is consumed by the opencode TUI usage display, so the
schema interpretation is battle-tested in production.

### Utility model (commit messages, doc generation)

MiniMax models can serve as VS Code's utility model for commit message
generation, doc string generation, and other short-completion tasks.
Set this in your VS Code settings:

```json
{
  "chat.utilityModel": "minimax:MiniMax-M3"
}
```

Replace `MiniMax-M3` with any MiniMax model (M1, M2, M2.5, M2.7, M3).
Utility requests are short, tool-less completions optimized for
quick, focused responses.

#### One-click utility model configuration for BYOK agent mode

When you select a MiniMax model as your main agent model, Copilot Chat
surfaces the warning

> No utility model is configured for 'copilot-utility-small' while the selected main agent model is BYOK.

until `chat.byokUtilityModelDefault` (or `chat.utilityModel` +
`chat.utilitySmallModel`) is set. Mighty Max offers a one-click fix via
the **Mighty Max: Configure Utility Models** command (also reachable
from the _Manage Mighty Max_ QuickPick). The picker offers three
options:

- **Use MiniMax for utility tasks (recommended)** — writes
  `chat.utilityModel = "minimax/MiniMax-M3"` and
  `chat.utilitySmallModel = "minimax/MiniMax-M2.5"`. No extra quota;
  usage is billed to your MiniMax account.
- **Use the main agent model** — writes
  `chat.byokUtilityModelDefault = "mainAgent"`. Copilot reuses the
  MiniMax model for utility tasks.
- **Use Copilot's models (uses Copilot quota)** — writes
  `chat.byokUtilityModelDefault = "copilot"`. Utility tasks run on
  Copilot's hosted models.

## Bundled agents & skills

Mighty Max ships with opt-in chat customizations that are surfaced
alongside your personal agents in the VS Code Chat panel:

- **`max-planner`** — a read-only implementation planner pinned to
  `M3 (MiniMax)`. It explores the codebase with `search/codebase`,
  `search/usages`, `read/problems`, and `changes`, then returns a
  numbered implementation plan (files to change, risks, open
  questions). It never edits files or runs commands. Use it when you
  want a second pair of eyes before starting a non-trivial change.
- **`max-review`** — an M3-pinned maintainer review
  agent with a fixed `🔴/🟡/✅` output contract, a `≥80%`-confidence
  rule, and a hard cap of ten findings per run. It dispatches to
  language- and topic-specific skills (next bullet) instead of trying
  to encode every language's idioms in the agent body.
- **12 review skills** — `chat/skills/<name>/SKILL.md` for ten
  languages, GitHub Actions / CI, and both OWASP lists. `max-review`
  selects a skill from its dispatch table based on the files under
  review; each skill carries the language- or domain-specific
  checklist. The skills, grouped:

  - **Languages** — `code-review-dotnet` (C# / .NET),
    `code-review-rust` (Rust), `code-review-go` (Go),
    `code-review-typescript` (TypeScript / JavaScript),
    `code-review-python` (Python), `code-review-kotlin` (Kotlin /
    JVM), `code-review-swift` (Swift / Apple platforms),
    `code-review-powershell` (PowerShell),
    `code-review-bash` (Bash / POSIX shell).
  - **CI** — `code-review-github-actions` (workflow `.yml`, action
    pinning, script-injection, least-privilege `permissions:`).
  - **Security** — `owasp-top-10-2025` (A01–A10: access control,
    injection, supply chain, crypto, logging, exception handling…)
    and `owasp-api-security-2023` (API1–API10: BOLA, broken auth,
    mass-assignment, SSRF, BFLA, …).

All assets live under `chat/agents/`, `chat/prompts/`, and
`chat/skills/` in the extension source. `max-planner`, `max-review`,
`/review-code`, and all 12 review skills ship in the current release.

Mighty Max deliberately does **not** ship a `chatInstructions`
contribution. `chatInstructions` injects prompt text into every
request that uses a model from this provider — that is invisible to
the user and easy to mis-tune. The agent / prompt / skill system is
opt-in (you pick `max-planner` from the agent dropdown) and the
prompt is auditable in the file. If you need a persistent system
preamble, set `mightyMax.systemPrompt` in settings; it is redacted
in logs and forwarded verbatim to MiniMax.

On VS Code older than the engine floor (1.109), the bundled agents
and skills are silently absent — VS Code ignores contribution
points it does not recognize — but the model provider and every
other feature keep working.

## What Mighty Max provides

Mighty Max covers every BYOK-supported surface in VS Code Chat:

| Feature                 | Status       | Notes                                                                |
| ----------------------- | ------------ | -------------------------------------------------------------------- |
| Chat: Ask               | ✅ Supported | Standard chat mode in the Chat panel                                 |
| Chat: Edit              | ✅ Supported | Edit mode with diff previews                                         |
| Chat: Inline            | ✅ Supported | Inline chat in the editor (Ctrl+I)                                   |
| Agent mode              | ✅ Supported | Full agentic tool calling with built-in, extension, and MCP tools    |
| Custom/local agents     | ✅ Supported | User-authored agent definitions work with MiniMax models             |
| Utility tasks           | ✅ Supported | Commit messages, doc generation via `chat.utilityModel` setting      |
| Tool calling            | ✅ Supported | Built-in (apply-edit, run-in-terminal), extension tools, MCP servers |
| Image input             | ✅ Supported | M3, M2.7, M2.5, M2 accept images via data URIs                       |
| Thinking blocks         | ✅ Supported | M3 surfaces native Anthropic-style thinking; M2.x surfaces reasoning |
| Multi-round agent loops | ✅ Supported | Tool results fed back across many rounds without dropping calls      |
| Token usage tracking    | ✅ Supported | Accurate context-window widget via prompt + completion token counts  |

## What Mighty Max does NOT provide

The following features are outside the BYOK boundary and require a GitHub
account with Copilot:

- **Inline code completions** (ghost text): This is not exposed to BYOK
  providers and requires the official GitHub Copilot extension.

- **Semantic search** and `#codebase` queries: Embeddings-backed features use
  GitHub's infrastructure and are not surfaced through the Language Model Chat
  Provider API.

- **Other embeddings features**: Similarity search, context retrieval, and
  other vector-backed operations remain GitHub Copilot-specific.

- **Agents Window vendor-specific hosts** (future): The new VS Code Agents
  Window may include vendor-specific agent implementations that remain coupled
  to official SDK providers. Standard agent mode (Chat panel, inline chat) and
  custom/local agents continue to work with BYOK.

## Workspace trust posture

| Capability           | Status                                         |
| -------------------- | ---------------------------------------------- |
| Untrusted workspaces | `limited` (the base-URL setting is restricted) |
| Virtual workspaces   | `limited`                                      |

Agent-mode tools (apply-edit, run-in-terminal) remain a real security
boundary in untrusted workspaces. The manifest is the contract.

## Development

```bash
npm ci
npm run typecheck
npm run compile
npm test
npm run lint
```

The build pipeline is `tsc -p .` (type-check + emit to `out/`)
followed by `esbuild out/extension.js` (single-file CommonJS bundle
to `dist/extension.js`). Production builds add `--minify` and
disable sourcemaps.

### Layout

```
src/
  extension.ts                 # composition root
  ports/                       # port interfaces (Logger, SecretStore, MiniMaxClient, ModelCatalog, UsageClient)
  adapters/                    # port implementations (I/O lives here; StatusBarAdapter + UsageTransportAdapter for the usage panel)
  providers/                   # VS Code LanguageModelChatProvider
  commands/                    # command handlers (manage, configure-utility-models, show-usage)
  lib/                         # domain layer (no vscode, no HTTP)
    domain/                    # pure catalog, mapping, capability, usage-normalization rules
    *.test.ts                  # unit tests (vanilla mocha, no host)
  test/                        # integration tests (run in the VS Code host)
assets/
  fonts/mightymax.woff         # status-bar glyph (PUA codepoint, contributed via `contributes.icons`)
  img/mightymax-glyph.svg      # source vector for regenerating the .woff
```

## License

MIT
