/**
 * Port: MediaArtifactStore — adapter-agnostic surface for persisting
 * downloaded media artifacts (video bytes today; image / audio bytes
 * later) to a destination the chat tool result can reference.
 *
 * T36 — the chat widget does not render video bytes inline; the
 * chat model's tool result must point to a filesystem path the user
 * can open. This port is the seam between "downloaded bytes" and
 * "absolute path on disk". The default `LocalMediaStore` writes
 * under VS Code's per-extension storage; tests inject an in-memory
 * store so they don't touch the filesystem.
 *
 * No `vscode` imports.
 */

export interface MediaArtifactRef {
  /** Absolute filesystem path the chat widget / notification can deep-link. */
  readonly absolutePath: string;
  /** Final on-disk size in bytes. */
  readonly sizeBytes: number;
  /** MIME type the adapter declared when writing the artifact. */
  readonly mime: string;
}

/** Optional hint the caller can pass to influence the filename. */
export interface MediaArtifactWriteHint {
  /** Human-readable prefix for the filename (e.g. "h3", "image-gen"). */
  readonly prefix?: string;
  /** File extension WITHOUT the leading dot (e.g. "mp4", "png"). */
  readonly extension: string;
  /** Best-effort MIME type (defaults to application/octet-stream). */
  readonly mime?: string;
}

export interface MediaArtifactStore {
  /**
   * Persist `bytes` to disk and return the absolute path. The store
   * is responsible for collision-free naming (timestamp + random
   * suffix) and for ensuring the destination directory exists.
   */
  write(bytes: Uint8Array, hint: MediaArtifactWriteHint): Promise<MediaArtifactRef>;

  /**
   * Absolute path of the directory new artifacts would land in by
   * default. Surfaced in the picker UI so users can configure
   * `mightyMax.mediaOutputDir` against the real fallback.
   */
  defaultDirectory(): string;
}
