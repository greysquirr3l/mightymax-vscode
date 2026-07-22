# Smart Tool Filtering

## Problem

M3 has difficulty calling tools when presented with 80+ tools (common in VS Code environments with MCP servers and extensions). Symptoms:

- Generates text like "I'll use the X tool..." but returns `finishReason: "stop"` with `toolCallCount: 0`
- Tool calls never execute despite explicit instructions
- Works fine with 20-40 tools

## Solution

Smart tool filtering automatically reduces the tool set sent to M3 based on:

1. **Relevance scoring**: Keyword matching between user prompt and tool names/descriptions
2. **Usage tracking**: Prioritizes tools that have been successfully called in the past
3. **Priority tools**: Always includes essential tools (configurable)

## Configuration

All settings are in the VS Code Settings UI under "Mighty Max" or in `settings.json`:

### `mightyMax.enableSmartToolFiltering`

- **Type**: Boolean
- **Default**: `true`
- **Description**: Enable/disable smart tool filtering. When disabled, all tools are sent to M3 (may cause tool-calling failures with large tool sets).

### `mightyMax.maxTools`

- **Type**: Number
- **Default**: `64`
- **Range**: 5-100
- **Description**: Maximum tools to send when filtering is enabled. M3 handles 64 cleanly. Copilot Chat's virtual-tool grouper handles larger sets at the chat-UI level, not here.

### `mightyMax.alwaysIncludeTools`

- **Type**: Array of strings
- **Default**: `["copilot_", "run_in_terminal", "apply_patch", "grep_search", "file_search", "semantic_search"]`
- **Description**: Tools to keep regardless of relevance scoring. Supports three match modes:
  - **Exact**: `"run_in_terminal"` matches the tool whose `.name === "run_in_terminal"`.
  - **Prefix**: `"copilot_"` matches any tool whose `.name` STARTS with `"copilot_"`. Captures every Copilot Chat built-in (renames don't rot the pin).
  - **Substring**: A pin without a trailing `_` matches any tool containing it as a fragment (e.g. `"grep"` matches `grep_search`, `grep_file_contents`).
- Tools referenced by the current request's `tool_use` / `tool_result` history are pinned automatically and cannot be silently dropped by the cap.

## How It Works

### 1. Filtering OFF by default

`enableSmartToolFiltering` ships at `false`. The full VS Code tool set is forwarded verbatim so agent-mode has every tool the chat UI exposes. Enable the setting only when your provider enforces a smaller cap than the request needs.

### 2. Priority Tools (Always Included)

Tools matched by `alwaysIncludeTools` (exact / prefix / substring), PLUS every tool referenced by the current request's `tool_use` / `tool_result` history, are sent first regardless of the cap. The history pin is what stops the filter from silently dropping in-flight tool calls mid agent-loop — the failure mode this feature was rebuilt to prevent.

### 3. Cap enforcement

After pinning, the remaining budget (`maxTools - pinnedCount`) is filled with the first-N tools in the order VS Code passed them in. Order is stable, so the model sees the same tools every turn at the same cap.

For each remaining tool, score is calculated based on:

- **Exact name match**: +1.0 if prompt contains full tool name
- **Name keyword overlap**: +0.3 per matching word (e.g., "read" in "read_file")
- **Description overlap**: +0.5 × (matched words / total words)

Example:

```
Prompt: "Use read_file to check the config"
Tool: { name: "read_file", description: "Read file contents" }
Score: 1.0 (exact match) + 0.5 (description overlap) = 1.5 → capped at 1.0
```

### 3. Usage Scoring (0-1 scale)

Normalized by most-called tool:

```
score = (tool_call_count) / (max_call_count_across_all_tools)
```

Tools never called have score 0. Frequently-used tools approach 1.0.

### 4. Hybrid Strategy

Combines both scores:

```
final_score = (relevance × 0.6) + (usage × 0.4)
```

### 5. Selection

1. Include all priority tools
2. Calculate remaining budget: `maxTools - priority_count`
3. Score and rank all other tools
4. Select top N by score to fill remaining slots

## Logging

When filtering is active, check the "Mighty Max" output channel for details:

```
[INFO] Smart tool filtering enabled
  totalTools: 80
  maxTools: 30
  strategy: "hybrid"
  alwaysIncludeCount: 6

[INFO] Tool filtering complete
  originalCount: 80
  filteredCount: 30
  priorityCount: 6
  selectedOthersCount: 24
  topScoredTools: [
    { name: "coraline_search", score: "0.850" },
    { name: "read_file", score: "0.820" },
    ...
  ]
```

## Example Configuration

### Minimal filtering (conservative)

```json
{
  "mightyMax.enableSmartToolFiltering": true,
  "mightyMax.maxTools": 50,
  "mightyMax.toolFilterStrategy": "usage"
}
```

### Aggressive filtering (maximum compatibility)

```json
{
  "mightyMax.enableSmartToolFiltering": true,
  "mightyMax.maxTools": 20,
  "mightyMax.toolFilterStrategy": "hybrid",
  "mightyMax.alwaysIncludeTools": [
    "read_file",
    "write_file",
    "edit_file",
    "bash"
  ]
}
```

### Disable filtering (use all tools)

```json
{
  "mightyMax.enableSmartToolFiltering": false
}
```

## Testing

To verify filtering is working:

1. Open a workspace with many MCP servers/tools (80+)
2. Open VS Code Settings → Extensions → Mighty Max
3. Set "Log Level" to "info"
4. Open "Mighty Max" output channel
5. Start a chat with M3
6. Check logs for "Smart tool filtering enabled" and "Tool filtering complete"

## Troubleshooting

### Issue: M3 still won't call tools after enabling filtering

**Solution**: Lower `maxTools` to 20-25. Some tool sets have verbose schemas that consume more tokens.

### Issue: Important tool is missing

**Solution**: Add it to `alwaysIncludeTools`:

```json
{
  "mightyMax.alwaysIncludeTools": [
    "read_file",
    "write_file",
    "my_critical_tool"
  ]
}
```

### Issue: Wrong tools are selected

**Solution**:

- If tools don't match your prompt: Switch to `"relevance"` strategy
- If rarely-used tools are prioritized: Switch to `"usage"` strategy
- For best results: Use `"hybrid"` and ensure good prompt keywords

## Implementation Details

- **Tool usage tracking**: Persists across requests within a session (cleared on extension reload)
- **Filtering scope**: Only affects tools sent to M3; doesn't modify VS Code's tool registry
- **Performance**: O(n log n) where n = tool count (negligible overhead even with 100+ tools)
- **Thread safety**: Single-threaded (VS Code extension host is single-threaded)

## Version History

- **0.1.4**: Initial implementation (default enabled, hybrid strategy, 30 tool limit)
