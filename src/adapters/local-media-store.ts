/**
 * LocalMediaStore — `MediaArtifactStore` impl that writes to disk.
 *
 * T36 — default landing pad for downloaded media bytes. Honors
 * `mightyMax.mediaOutputDir`; falls back to the VS Code
 * extension-storage directory when the setting is empty. The store
 * is responsible for collision-free naming (timestamp + random
 * suffix) so two concurrent generations never clobber each other.
 *
 * No `vscode` imports — the directory is passed in at construction
 * time so tests can point at a temp dir without mocking the
 * extension host.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  MediaArtifactRef,
  MediaArtifactStore,
  MediaArtifactWriteHint,
} from '../ports/media-artifact-store.js';

const DEFAULT_MEDIA_SUBDIR = 'media';

export interface LocalMediaStoreOptions {
  /** Directory new artifacts land in. Required — no implicit default. */
  readonly baseDirectory: string;
}

export class LocalMediaStore implements MediaArtifactStore {
  private readonly base: string;

  constructor(options: LocalMediaStoreOptions) {
    this.base = options.baseDirectory;
  }

  defaultDirectory(): string {
    return this.base;
  }

  async write(bytes: Uint8Array, hint: MediaArtifactWriteHint): Promise<MediaArtifactRef> {
    if (!(bytes instanceof Uint8Array)) {
      throw new Error('LocalMediaStore.write: bytes must be a Uint8Array');
    }
    if (typeof hint.extension !== 'string' || hint.extension.length === 0) {
      throw new Error('LocalMediaStore.write: hint.extension is required');
    }
    await mkdir(this.base, { recursive: true });
    const filename = buildFilename(hint);
    const absolutePath = path.join(this.base, filename);
    await writeFile(absolutePath, bytes);
    return {
      absolutePath,
      sizeBytes: bytes.byteLength,
      mime: hint.mime ?? 'application/octet-stream',
    };
  }
}

/**
 * Build a collision-free filename. Pattern:
 *   <prefix?>-YYYYMMDD-HHMMSS-<6 random hex chars>.<ext>
 *
 * The random suffix matters when a user spams the command within the
 * same second; the timestamp keeps the list readable in a file browser.
 */
function buildFilename(hint: MediaArtifactWriteHint): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const HH = String(now.getUTCHours()).padStart(2, '0');
  const MM = String(now.getUTCMinutes()).padStart(2, '0');
  const SS = String(now.getUTCSeconds()).padStart(2, '0');
  const stamp = `${yyyy}${mm}${dd}-${HH}${MM}${SS}`;
  const random = randomHex(6);
  const prefix = hint.prefix !== undefined && hint.prefix !== '' ? `${hint.prefix}-` : '';
  return `${prefix}${stamp}-${random}.${hint.extension}`;
}

function randomHex(byteCount: number): string {
  // Six hex chars from 3 random bytes; sufficient for collision-free
  // naming in the same second. Avoids pulling in `crypto.randomUUID`
  // for a filename suffix.
  let out = '';
  for (let i = 0; i < byteCount; i++) {
    out += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0');
  }
  return out;
}

/**
 * Resolve the directory the `LocalMediaStore` should write to,
 * honoring `mightyMax.mediaOutputDir` and falling back to the
 * VS Code extension storage path when unset.
 */
export function resolveMediaOutputDirectory(
  storageDir: string,
  configuredOverride: string | undefined,
): string {
  if (typeof configuredOverride === 'string' && configuredOverride.trim() !== '') {
    return configuredOverride.trim();
  }
  return path.join(storageDir, DEFAULT_MEDIA_SUBDIR);
}
