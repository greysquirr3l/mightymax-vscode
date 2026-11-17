import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as vscode from 'vscode';

import { CONTENT_FILTER_NOTICE, createReviewGate } from './review-gate.js';

function capture() {
  const parts: vscode.LanguageModelResponsePart[] = [];
  return { parts, progress: { report: (p: vscode.LanguageModelResponsePart) => void parts.push(p) } };
}
const text = (v: string) => new vscode.LanguageModelTextPart(v);
const values = (parts: vscode.LanguageModelResponsePart[]) =>
  parts.map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : '?'));

describe('createReviewGate', () => {
  it('streams straight through when not holding', () => {
    const host = capture();
    const gate = createReviewGate(host.progress, false);
    gate.progress.report(text('a'));
    deepStrictEqual(values(host.parts), ['a']);
    gate.release('stop');
    deepStrictEqual(values(host.parts), ['a']);
  });
  it('adds the notice only when a filtered turn streamed no text', () => {
    const empty = capture();
    createReviewGate(empty.progress, false).release('content_filter');
    deepStrictEqual(values(empty.parts), [CONTENT_FILTER_NOTICE]);
    const partial = capture();
    const gate = createReviewGate(partial.progress, false);
    gate.progress.report(text('partial'));
    gate.release('content_filter');
    deepStrictEqual(values(partial.parts), ['partial']);
  });
  it('holds output until release and replays it in order', () => {
    const host = capture();
    const gate = createReviewGate(host.progress, true);
    gate.progress.report(text('a'));
    gate.progress.report(text('b'));
    strictEqual(host.parts.length, 0);
    gate.release('stop');
    deepStrictEqual(values(host.parts), ['a', 'b']);
  });
  it('drops held output and shows the notice on a content filter', () => {
    const host = capture();
    const gate = createReviewGate(host.progress, true);
    gate.progress.report(text('secret'));
    gate.release('content_filter');
    deepStrictEqual(values(host.parts), [CONTENT_FILTER_NOTICE]);
  });
});
