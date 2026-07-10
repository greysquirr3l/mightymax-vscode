/**
 * `mightyMax.showUsage` — opens a compact webview panel modeled on
 * the Copilot "Manage Budget" flyout: a title row, an "as of"
 * banner, one section per quota window with a big percent + progress
 * bar, and a raw-payload disclosure for when MiniMax changes the
 * schema (the adapter catches schema drift and surfaces the last raw
 * blob here).
 *
 * The panel reads from the status bar's last successful fetch (so
 * the bar and the panel never disagree) and offers a "Refresh"
 * button that fans back into the status bar's adapter — refreshing
 * one refreshes both. The first-open trigger kicks an immediate
 * fetch when no cached payload is available.
 *
 * Implementation notes:
 *  - The panel icon is the existing large PNG used by the rest of
 *    the extension (`assets/img/mighty_max_head.png`); the
 *    status-bar glyph is a separate .woff because VS Code does not
 *    render PNGs in status-bar slots.
 *  - The webview uses `var(--vscode-*)` tokens so light/dark/high-
 *    contrast themes adopt the colors automatically.
 *  - Script is enabled but CSP is left at default (no remote URLs
 *    are loaded); the only outbound is the explicit refresh button.
 */

import * as vscode from 'vscode';
import type { StatusBarAdapter } from '../adapters/status-bar.js';
import type { TokenPlanUsage } from '../ports/usage-client.js';

export function runShowUsageCommand(
  context: vscode.ExtensionContext,
  statusBar: StatusBarAdapter,
): vscode.Disposable {
  const panel = vscode.window.createWebviewPanel(
    'mightyMaxUsage',
    'Mighty Max Usage',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    { enableScripts: true, localResourceRoots: [context.extensionUri] },
  );

  panel.iconPath = vscode.Uri.joinPath(
    context.extensionUri,
    'assets',
    'img',
    'mighty_max_head.png',
  );

  const render = (usage: TokenPlanUsage | undefined): void => {
    panel.webview.html = renderHtml(usage);
  };

  render(statusBar.getLastUsage());

  const messageSub = panel.webview.onDidReceiveMessage(
    (msg: unknown) => {
      if (isRefreshMessage(msg)) {
        void statusBar.refresh().then(render);
      }
    },
    undefined,
    context.subscriptions,
  );

  if (statusBar.getLastUsage() === undefined) {
    void statusBar.refresh().then(render);
  }

  return vscode.Disposable.from(panel, messageSub);
}

function isRefreshMessage(msg: unknown): boolean {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'refresh'
  );
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderHtml(usage: TokenPlanUsage | undefined): string {
  const exhausted = usage?.percentUsed !== undefined && usage.percentUsed >= 100;
  const banner = exhausted
    ? `<div class="banner err">Requests are paused until the quota resets.</div>`
    : usage === undefined
      ? `<div class="banner">No usage data — pay-as-you-go keys have no Token Plan bar.</div>`
      : '';

  const sections = (usage?.windows ?? [])
    .map((w) => {
      const width = Math.min(100, Math.max(0, w.percentUsed));
      const fullClass = w.percentUsed >= 100 ? ' full' : '';
      return `
      <section>
        <div class="row">
          <span class="label">${esc(w.label)}</span>
          ${w.resetsAt !== undefined ? `<span class="meta">Resets ${esc(w.resetsAt)}</span>` : ''}
        </div>
        <div class="big">${String(w.percentUsed)}% <span class="dim">used</span></div>
        <div class="track"><div class="fill${fullClass}" style="width:${String(width)}%"></div></div>
      </section>`;
    })
    .join('\n');

  const raw =
    usage !== undefined
      ? `<details><summary>Raw response</summary><pre>${esc(JSON.stringify(usage.raw, null, 2))}</pre></details>`
      : '';

  const asOf =
    usage !== undefined ? `As of ${esc(usage.fetchedAt.toLocaleString())} · ` : '';

  return /* html */ `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         padding: 16px 20px; max-width: 460px; }
  h2 { display:flex; justify-content:space-between; align-items:center;
       font-size:15px; font-weight:600; margin:0 0 12px; }
  button { background: var(--vscode-button-secondaryBackground);
           color: var(--vscode-button-secondaryForeground);
           border: 1px solid var(--vscode-widget-border, transparent);
           border-radius: 4px; padding: 4px 12px; cursor: pointer; }
  .banner { border:1px solid var(--vscode-focusBorder); border-radius:6px;
            padding:10px 12px; margin-bottom:14px; font-size:12.5px; }
  .banner.err { border-color: var(--vscode-inputValidation-errorBorder); }
  section { border-top: 1px solid var(--vscode-widget-border, #3333);
            padding: 12px 0 14px; }
  .row { display:flex; justify-content:space-between; font-size:12.5px; }
  .label { font-weight:600; }
  .meta, .dim { color: var(--vscode-descriptionForeground); }
  .big { font-size:26px; font-weight:700; margin:2px 0 8px; }
  .big .dim { font-size:13px; font-weight:400; }
  .track { position:relative; height:6px; border-radius:3px;
           background: color-mix(in srgb, var(--vscode-foreground) 15%, transparent);
           overflow:hidden; }
  .fill { position:absolute; inset:0 auto 0 0; border-radius:3px;
          background: var(--vscode-progressBar-background, #4fa3c7); }
  .fill.full { background: var(--vscode-errorForeground); }
  details { margin-top:14px; font-size:12px; }
  pre { overflow:auto; background: var(--vscode-textCodeBlock-background); padding:8px; border-radius:4px; }
  footer { margin-top:12px; font-size:11.5px; color: var(--vscode-descriptionForeground); }
</style></head>
<body>
  <h2>Mighty Max <button id="refresh">Refresh</button></h2>
  ${banner}
  ${sections}
  ${raw}
  <footer>${asOf}Source: platform.minimax.io Token Plan</footer>
  <script>
    const vsapi = acquireVsCodeApi();
    document.getElementById('refresh').addEventListener('click', () => vsapi.postMessage({ type: 'refresh' }));
  </script>
</body></html>`;
}
