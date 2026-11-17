/**
 * Output gating for content review.
 *
 * With `mightyMax.streamUnreviewedOutput` off, nothing a turn produces
 * reaches the chat widget until the stream has finished with a verdict:
 * parts are held, then replayed on a normal finish or replaced by a
 * notice when the provider's content filter fired. With it on (the
 * default) parts stream straight through and only an empty filtered
 * turn gets the notice.
 */

import * as vscode from 'vscode';

export const CONTENT_FILTER_NOTICE =
  'MiniMax withheld this response (its content filter fired). Rephrase the request and try again.';

export interface ReviewGate {
  /** Pass this to the stream pump in place of the host progress. */
  readonly progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  /** Settle the turn: replay held parts or substitute the notice. */
  release(finishReason: string | undefined): void;
}

export function createReviewGate(
  host: vscode.Progress<vscode.LanguageModelResponsePart>,
  holdOutput: boolean,
): ReviewGate {
  const held: vscode.LanguageModelResponsePart[] = [];
  let reportedText = false;
  return {
    progress: {
      report: (part) => {
        if (holdOutput) {
          held.push(part);
          return;
        }
        if (part instanceof vscode.LanguageModelTextPart && part.value.length > 0) {
          reportedText = true;
        }
        host.report(part);
      },
    },
    release: (finishReason) => {
      const filtered = finishReason === 'content_filter';
      if (holdOutput) {
        if (filtered) {
          host.report(new vscode.LanguageModelTextPart(CONTENT_FILTER_NOTICE));
          return;
        }
        for (const part of held) host.report(part);
        return;
      }
      if (filtered && !reportedText) {
        host.report(new vscode.LanguageModelTextPart(CONTENT_FILTER_NOTICE));
      }
    },
  };
}
