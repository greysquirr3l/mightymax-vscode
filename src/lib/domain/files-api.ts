/**
 * Files API payload patching (pure).
 *
 * MiniMax's Anthropic route accepts an uploaded file in place of an
 * inline base64 block: `source: { type: 'url', url: 'mm_file://<id>' }`.
 * A 10 MB photo inlines to ~13 MB of JSON on every turn and every
 * retry; a reference is a few dozen bytes.
 *
 * This module walks a serialized Anthropic request and swaps eligible
 * `image` / `video` base64 blocks for references. It does no I/O of
 * its own — the caller supplies the upload function — and it is
 * fail-open: a block whose upload yields no id keeps its inline form.
 */

/** URL scheme the Messages route resolves to an uploaded file. */
export const FILE_REF_SCHEME = 'mm_file://';

/**
 * Decoded size below which a block stays inline. A small image costs
 * less to send than the extra upload round trip.
 */
export const MIN_UPLOAD_BYTES = 64 * 1024;

export type FilePurpose = 'image_understanding' | 'video_understanding';

export interface UploadableMedia {
  readonly mediaType: string;
  /** Base64 payload, exactly as it sits in the inline block. */
  readonly data: string;
  readonly purpose: FilePurpose;
}

/** Resolves to the file id, or `undefined` to keep the block inline. */
export type UploadMedia = (media: UploadableMedia) => Promise<string | undefined>;

interface Base64Block {
  type: string;
  source: { type: string; media_type?: unknown; data?: unknown; url?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Purpose the upload endpoint expects for a media type, if it is uploadable. */
export function purposeForMediaType(blockType: string, mediaType: string): FilePurpose | undefined {
  const normalized = mediaType.trim().toLowerCase();
  if (blockType === 'image' && normalized.startsWith('image/')) return 'image_understanding';
  if ((blockType === 'image' || blockType === 'video') && normalized.startsWith('video/')) {
    return 'video_understanding';
  }
  return undefined;
}

/** Decoded byte length of a base64 string, without decoding it. */
export function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function collectBlocks(content: unknown, out: Base64Block[]): void {
  if (Array.isArray(content)) {
    for (const item of content) collectBlocks(item, out);
    return;
  }
  if (!isRecord(content)) return;
  const source = content['source'];
  if (
    (content['type'] === 'image' || content['type'] === 'video') &&
    isRecord(source) &&
    source['type'] === 'base64'
  ) {
    out.push(content as unknown as Base64Block);
  }
  // `tool_result` blocks nest their media one level down.
  if (Array.isArray(content['content'])) collectBlocks(content['content'], out);
}

/**
 * Replace eligible inline media blocks in `messages` with file
 * references, uploading in parallel. Mutates the blocks in place and
 * returns how many were converted.
 */
export async function patchMediaBlocks(
  messages: ReadonlyArray<{ content?: unknown }>,
  upload: UploadMedia,
): Promise<number> {
  const blocks: Base64Block[] = [];
  for (const message of messages) collectBlocks(message.content, blocks);

  const results = await Promise.all(
    blocks.map(async (block) => {
      const mediaType = block.source.media_type;
      const data = block.source.data;
      if (typeof mediaType !== 'string' || typeof data !== 'string') return false;
      if (base64ByteLength(data) < MIN_UPLOAD_BYTES) return false;
      const purpose = purposeForMediaType(block.type, mediaType);
      if (purpose === undefined) return false;
      const fileId = await upload({ mediaType, data, purpose });
      if (fileId === undefined) return false;
      block.source = { type: 'url', url: `${FILE_REF_SCHEME}${fileId}` };
      return true;
    }),
  );
  return results.filter(Boolean).length;
}
