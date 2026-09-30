/**
 * Port: VideoGenerator — adapter-agnostic surface for the MiniMax
 * Hailuo-03 / H3 / H3-Max async video generation endpoint.
 *
 * T36 — the chat-provider registers `mightyMax_generateVideo` as a
 * `LanguageModelTool`. The tool's `invoke` handler drives the
 * submit → poll → download pipeline through THIS port so the
 * `HailuoVideoAdapter` is swappable (test stub / future gateway /
 * local cache).
 *
 * Three methods rather than one so the tool loop can implement
 * exponential backoff and cancellation independently of the adapter.
 * Cancellation propagates via the `AbortSignal` on every method.
 *
 * No `vscode` imports — this port is consumed by both the chat-tool
 * adapter and the command adapter, neither of which need it.
 */

import type {
  VideoBytes,
  VideoModelId,
  VideoRequest,
  VideoTaskState,
} from '../lib/domain/media.js';

export interface VideoTaskHandle {
  /** Upstream task id used in subsequent `pollStatus` / `downloadResult` calls. */
  readonly taskId: string;
  /** Model id echoed back from the upstream `submit` response (defaults to request.model). */
  readonly model: VideoModelId;
}

export interface VideoGenerator {
  /**
   * Submit a generation task. Returns the task id; the caller is
   * responsible for polling until `kind === 'success'` or `'fail'`.
   */
  submitTask(request: VideoRequest, apiKey: string, signal: AbortSignal): Promise<VideoTaskHandle>;

  /**
   * Poll the upstream status. The caller chooses the cadence via
   * `mightyMax.videoPollIntervalMs`; the adapter does NOT block.
   */
  pollStatus(taskId: string, apiKey: string, signal: AbortSignal): Promise<VideoTaskState>;

  /**
   * Download the generated video bytes once `pollStatus` reports
   * `kind === 'success'`. The adapter is responsible for picking
   * the canonical download URL from the upstream payload.
   */
  downloadResult(taskId: string, apiKey: string, signal: AbortSignal): Promise<VideoBytes>;
}
