'use strict';

/**
 * Minimal `vscode` module stub for running host-free unit tests under
 * plain Node (see `run-vscode-stub-tests.cjs`).
 *
 * Implements the surface actually exercised at runtime by:
 *   - `src/providers/chat-provider.ts` / `chat-provider.test.ts`
 *   - `src/providers/stream-pump.ts` / `stream-pump.test.ts`
 *   - `src/test/tool-filtering.test.ts` (exercises the same
 *     `ChatProvider.provideLanguageModelChatResponse` path plus the
 *     `vscode.workspace.getConfiguration('mightyMax')` read/write
 *     round-trip that `readToolFilterConfig()` depends on)
 *
 * That surface: `EventEmitter`, `CancellationTokenSource`, the
 * `LanguageModel{Text,ToolCall,ToolResult}Part` value classes, the
 * `LanguageModelChatMessageRole` / `LanguageModelChatToolMode` /
 * `ConfigurationTarget` enums, and a real (in-memory,
 * scope-collapsing) `workspace.getConfiguration()` store. Everything
 * else `vscode`-namespaced in these files is a TYPE ONLY
 * (`CancellationToken`, `LanguageModelChatInformation`, `Progress<T>`,
 * etc.) — TypeScript erases those at compile time, so they need no
 * runtime stand-in.
 *
 * If a future test starts touching more of the `vscode` namespace,
 * extend this object rather than reaching for the real API — that's
 * what the `integration` / `agent-harness` / `thinking-passback`
 * profiles (real VS Code host, via @vscode/test-cli) are for.
 */

class Disposable {
  constructor(disposeFn) {
    this._disposeFn = disposeFn;
  }
  dispose() {
    this._disposeFn?.();
  }
}

class EventEmitter {
  constructor() {
    this._listeners = new Set();
    this.event = (listener) => {
      this._listeners.add(listener);
      return new Disposable(() => this._listeners.delete(listener));
    };
  }
  fire(value) {
    for (const listener of this._listeners) listener(value);
  }
  dispose() {
    this._listeners.clear();
  }
}

class CancellationTokenSource {
  constructor() {
    const emitter = new EventEmitter();
    let cancelled = false;
    this.token = {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested: emitter.event,
    };
    this.cancel = () => {
      if (cancelled) return;
      cancelled = true;
      emitter.fire(undefined);
    };
    this.dispose = () => {
      emitter.dispose();
    };
  }
}

class LanguageModelTextPart {
  constructor(value) {
    this.value = value;
  }
}

class LanguageModelToolCallPart {
  constructor(callId, name, input) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
}

class LanguageModelToolResultPart {
  constructor(callId, content) {
    this.callId = callId;
    this.content = content;
  }
}

class LanguageModelDataPart {
  constructor(data, mimeType) {
    this.data = data;
    this.mimeType = mimeType;
  }
}

class LanguageModelChatMessage {
  constructor(role, content, name) {
    this.role = role;
    this.content = typeof content === 'string' ? [new LanguageModelTextPart(content)] : content;
    this.name = name;
  }
  static User(content, name) {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.User, content, name);
  }
  static Assistant(content, name) {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, content, name);
  }
}

// Values match the real `vscode.d.ts` enum declarations.
const LanguageModelChatMessageRole = Object.freeze({ User: 1, Assistant: 2 });
const LanguageModelChatToolMode = Object.freeze({ Auto: 1, Required: 2 });
const ConfigurationTarget = Object.freeze({ Global: 1, Workspace: 2, WorkspaceFolder: 3 });

/**
 * Real (in-memory) `vscode.WorkspaceConfiguration`. Unlike the real
 * API there is no Global/Workspace/WorkspaceFolder scope resolution —
 * `update()`'s `target` argument is accepted but ignored, all values
 * land in one flat per-section store. That's sufficient for what
 * `readToolFilterConfig()` (chat-provider.ts) and
 * `tool-filtering.test.ts`'s `config.update(...)` calls need: a
 * `get`/`update` round-trip that's visible across every
 * `getConfiguration('mightyMax')` call in the process.
 */
class WorkspaceConfiguration {
  constructor(store) {
    this._store = store;
  }
  get(key, defaultValue) {
    return this._store.has(key) ? this._store.get(key) : defaultValue;
  }
  has(key) {
    return this._store.has(key);
  }
  update(key, value, _target) {
    if (value === undefined) {
      this._store.delete(key);
    } else {
      this._store.set(key, value);
    }
    return Promise.resolve();
  }
}

const configSections = new Map();
function getConfiguration(section = '') {
  let config = configSections.get(section);
  if (!config) {
    config = new WorkspaceConfiguration(new Map());
    configSections.set(section, config);
  }
  return config;
}

const vscodeStub = {
  Disposable,
  EventEmitter,
  CancellationTokenSource,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  LanguageModelDataPart,
  LanguageModelChatMessage,
  LanguageModelChatMessageRole,
  LanguageModelChatToolMode,
  ConfigurationTarget,
  workspace: {
    getConfiguration,
    onDidChangeConfiguration: () => new Disposable(),
  },
  window: {},
  extensions: { getExtension: () => undefined },
};

/**
 * Installs the stub so `require('vscode')` resolves to it for the
 * remainder of the process. Idempotent.
 */
function install() {
  const Module = require('node:module');
  if (require.cache.vscode) return; // already installed

  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return 'vscode';
    return originalResolveFilename.call(this, request, ...rest);
  };

  require.cache.vscode = {
    id: 'vscode',
    filename: 'vscode',
    loaded: true,
    exports: vscodeStub,
  };
}

module.exports = { install, vscodeStub };
