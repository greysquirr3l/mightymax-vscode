/**
 * T41 — Opt-in response-stream capture (diagnostic only).
 *
 * ## Why this exists
 *
 * A suspected defect — MiniMax emitting its native tool-call
 * protocol into the Anthropic `text` channel instead of a
 * structured `tool_use` block — cannot be diagnosed from
 * `mighty-max.log`, because the log is metadata-only by design
 * (no request/response bodies, ever). It also cannot be
 * diagnosed by reproducing on demand, because the symptom is
 * intermittent and unpredictable.
 *
 * That combination means the capture has to be **armed in
 * advance and dormant** until it fires: enabled explicitly,
 * writing to its own file (NOT the log channel, so the
 * redaction rule is untouched), retaining a rolling window so
 * the corrupting stream is still on disk whenever the user
 * notices the garbling.
 *
 * ## Redaction posture
 *
 * This sink records RESPONSE events only — text deltas, tool
 * deltas, finish reasons. It never sees the API key, the
 * Authorization header, or a request body: the transport calls
 * it from the response-parsing loop only. Note this is still
 * model output, which can echo user content — which is exactly
 * why it is off by default and writes outside the log channel.
 *
 * ## Failure posture
 *
 * Diagnostics must never break streaming. Every method is
 * wrapped so a filesystem error is swallowed; `append` is
 * synchronous and allocation-light, and the cap is enforced by
 * slicing the in-memory buffer (oldest first) rather than by
 * seeking on disk.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

/** Default retained bytes before the oldest records are dropped. */
export const DEFAULT_CAPTURE_MAX_BYTES = 2_000_000;

/** Default debounce between a dirty buffer and its disk flush. */
export const DEFAULT_CAPTURE_FLUSH_MS = 2_000;

export interface StreamCaptureOptions {
  /** Absolute path of the capture file. */
  readonly path: string;
  /** Rolling window size in characters. Defaults to 2 MB. */
  readonly maxBytes?: number;
  /** Debounce before writing a dirty buffer. Defaults to 2000ms. */
  readonly flushIntervalMs?: number;
}

/**
 * A size-capped, append-only diagnostic sink.
 *
 * Deliberately has no dependency on `vscode` so it is unit
 * testable outside the extension host.
 */
export class StreamCapture {
  private buffer = '';
  private dirty = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Serializes flushes so concurrent writes cannot interleave. */
  private inflight: Promise<void> = Promise.resolve();

  private readonly maxBytes: number;
  private readonly flushIntervalMs: number;

  constructor(private readonly options: StreamCaptureOptions) {
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_CAPTURE_MAX_BYTES);
    this.flushIntervalMs = Math.max(0, options.flushIntervalMs ?? DEFAULT_CAPTURE_FLUSH_MS);
  }

  /**
   * Append one already-escaped line. Callers MUST pass
   * `JSON.stringify`-escaped payloads so the rolling buffer stays
   * line-delimited and parseable.
   */
  append(line: string): void {
    if (this.closed) return;
    try {
      this.buffer += line;
      // Enforce the cap by dropping the OLDEST content. Re-checking
      // after the slice guards a single oversize append.
      if (this.buffer.length > this.maxBytes) {
        this.buffer = this.buffer.slice(this.buffer.length - this.maxBytes);
      }
      this.dirty = true;
      this.schedule();
    } catch {
      // Diagnostics are never allowed to throw.
    }
  }

  /** Current retained size, for tests and diagnostics. */
  get size(): number {
    return this.buffer.length;
  }

  /** Stop accepting writes and flush whatever is pending. */
  async close(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.flushNow();
    this.closed = true;
    await this.inflight;
  }

  private schedule(): void {
    if (this.timer !== undefined || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushNow();
    }, this.flushIntervalMs);
  }

  private flushNow(): void {
    if (!this.dirty) return;
    const payload = this.buffer;
    this.dirty = false;
    const path = this.options.path;
    this.inflight = this.inflight
      .then(async () => {
        try {
          await fs.mkdir(dirname(path), { recursive: true });
          await fs.writeFile(path, payload, 'utf8');
        } catch {
          // Unwritable capture target is not an error worth raising.
        }
      })
      .catch(() => undefined);
  }
}

/**
 * Serialize one stream event into a capture line.
 *
 * Returns `undefined` for events that carry nothing worth
 * diagnosing (errors, thinking) so the rolling window is spent on
 * the text/tool interleaving we are actually hunting.
 */
export function formatCaptureLine(event: {
  readonly textDelta?: string;
  readonly toolCallDelta?: {
    readonly id?: string;
    readonly name?: string;
    readonly argumentsDelta?: string;
  };
  readonly finishReason?: string;
}): string | undefined {
  try {
    if (event.textDelta !== undefined) {
      return `[text] ${JSON.stringify(event.textDelta)}\n`;
    }
    if (event.toolCallDelta !== undefined) {
      const d = event.toolCallDelta;
      const id = d.id === undefined ? '-' : d.id;
      const name = d.name === undefined ? '-' : d.name;
      const args = d.argumentsDelta === undefined ? '' : d.argumentsDelta;
      return `[tool] id=${id} name=${name} args=${JSON.stringify(args)}\n`;
    }
    if (event.finishReason !== undefined) {
      return `[finish] ${event.finishReason}\n`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
