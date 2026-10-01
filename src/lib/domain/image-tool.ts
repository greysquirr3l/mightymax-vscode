/**
 * Domain: `mightyMax_generateImage` tool descriptor.
 *
 * Sibling to `video-tool.ts`. Same contract — pure descriptor, the
 * adapter does the VS Code wiring — so the manifest entry and the
 * runtime registration stay derived from one source of truth.
 */

import {
  IMAGE_ASPECT_DIMENSIONS,
  IMAGE_ASPECT_RATIOS,
  IMAGE_COUNT_MAX,
  IMAGE_DIMENSION_MAX,
  IMAGE_DIMENSION_MIN,
  IMAGE_PROMPT_MAX_CHARS,
  renderImageToolError,
  renderImageToolResult,
  validateImageRequest,
  type ImageResult,
  type ImageValidationResult,
} from './image.js';

export const MIGHTYMAX_GENERATE_IMAGE_TOOL = 'mightyMax_generateImage';

export interface ImageToolInputSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required: ReadonlyArray<string>;
}

export interface ImageToolDescriptor {
  readonly name: typeof MIGHTYMAX_GENERATE_IMAGE_TOOL;
  readonly displayName: string;
  readonly toolReferenceName: string;
  readonly userDescription: string;
  readonly modelDescription: string;
  readonly tags: ReadonlyArray<string>;
  readonly inputSchema: ImageToolInputSchema;
}

const RATIO_HELP = IMAGE_ASPECT_RATIOS.map((r) => `${r} (${IMAGE_ASPECT_DIMENSIONS[r]})`).join(
  ', ',
);

export function buildGenerateImageDescriptor(): ImageToolDescriptor {
  return {
    name: MIGHTYMAX_GENERATE_IMAGE_TOOL,
    displayName: 'Mighty Max: Generate Image',
    toolReferenceName: MIGHTYMAX_GENERATE_IMAGE_TOOL,
    userDescription: 'Generate an image with MiniMax image-01. Saves to disk and returns the path.',
    modelDescription:
      'Generate an image from a text prompt using MiniMax image-01. Returns the absolute ' +
      'path of the saved PNG on disk; describe the result to the user. Use aspectRatio for ' +
      'a standard shape, or width+height together for exact pixel dimensions (each must be ' +
      'a multiple of 8 between 512 and 2048; cannot be combined with aspectRatio).',
    tags: ['minimax', 'media', 'image'],
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          enum: ['image-01'],
          description: 'Which MiniMax image model to invoke.',
        },
        prompt: {
          type: 'string',
          maxLength: IMAGE_PROMPT_MAX_CHARS,
          description: `Plain-text description of the desired image. Required. Max ${IMAGE_PROMPT_MAX_CHARS} characters.`,
        },
        aspectRatio: {
          type: 'string',
          enum: [...IMAGE_ASPECT_RATIOS],
          description: `Output aspect ratio. Default 1:1. Options: ${RATIO_HELP}.`,
        },
        width: {
          type: 'number',
          minimum: IMAGE_DIMENSION_MIN,
          maximum: IMAGE_DIMENSION_MAX,
          description: `Explicit output width in pixels. Must be a multiple of 8 and set together with height. Cannot be combined with aspectRatio.`,
        },
        height: {
          type: 'number',
          minimum: IMAGE_DIMENSION_MIN,
          maximum: IMAGE_DIMENSION_MAX,
          description: `Explicit output height in pixels. Must be a multiple of 8 and set together with width. Cannot be combined with aspectRatio.`,
        },
        count: {
          type: 'number',
          minimum: 1,
          maximum: IMAGE_COUNT_MAX,
          description: `Number of images to generate (1-${IMAGE_COUNT_MAX}). Default 1.`,
        },
        seed: {
          type: 'number',
          description: 'Random seed. The same seed and parameters produce a reproducible image.',
        },
        promptOptimizer: {
          type: 'boolean',
          description: 'Let MiniMax expand the prompt before generating. Default false.',
        },
      },
      required: ['model', 'prompt'],
    },
  };
}

/**
 * The tool takes exactly the same input shape as the domain
 * validator, so there is nothing to translate — re-export rather
 * than invent a parallel type that can drift.
 */
export type ImageToolValidationResult = ImageValidationResult;

/** Validate the raw input the chat host (or command adapter) hands the tool. */
export function validateImageToolInput(raw: unknown): ImageValidationResult {
  return validateImageRequest(raw);
}

export function renderGenerateImageToolResult(result: ImageResult): string {
  return renderImageToolResult(result);
}

export function renderGenerateImageToolError(errorCode: string, errorMessage: string): string {
  return renderImageToolError(errorCode, errorMessage);
}
