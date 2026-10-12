/**
 * OpenAI media operations: image generation and editing, vision, speech, and
 * transcription.
 *
 * Thin wrappers over the official `openai` SDK. Every function takes the client
 * as an argument so tests can point it at a local HTTP server.
 */
import type OpenAI from 'openai';
import { toFile } from 'openai';

export const IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Detect an image MIME type from its magic bytes. Returns null for formats this module does not accept. */
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) return 'image/gif';
  return null;
}

/** Bound on downloading an image when the API returns a URL instead of base64. */
const IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * First image from an images response. gpt-image-* returns base64; dall-e-* returns a URL
 * unless asked for base64. The bytes must be a supported image before anything is written.
 */
async function firstImage(res: { data?: ReadonlyArray<{ b64_json?: string; url?: string }> | null }): Promise<Buffer> {
  const image = res.data?.[0];
  let buf: Buffer;
  if (image?.b64_json) {
    buf = Buffer.from(image.b64_json, 'base64');
  } else if (image?.url) {
    const download = await fetch(image.url, { signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS) });
    if (!download.ok) throw new Error(`Downloading the generated image failed: HTTP ${download.status}`);
    buf = Buffer.from(await download.arrayBuffer());
  } else {
    throw new Error('Image API returned no image data');
  }
  if (!sniffImageMime(buf)) throw new Error('Image API returned data that is not a PNG, JPEG, WEBP or GIF image');
  return buf;
}

export async function generateImage(
  client: OpenAI,
  args: { model: string; prompt: string; size: ImageSize },
): Promise<Buffer> {
  const res = await client.images.generate({ model: args.model, prompt: args.prompt, size: args.size, n: 1 });
  return firstImage(res);
}

export async function editImage(
  client: OpenAI,
  args: { model: string; prompt: string; image: Buffer; mimeType: string; filename: string; size?: ImageSize },
): Promise<Buffer> {
  const image = await toFile(args.image, args.filename, { type: args.mimeType });
  const res = await client.images.edit({
    model: args.model,
    prompt: args.prompt,
    image,
    ...(args.size ? { size: args.size } : {}),
  });
  return firstImage(res);
}

/** Answer a question about an image. `imageUrl` is an http(s) URL or a base64 `data:` URL. */
export async function analyzeImage(
  client: OpenAI,
  args: { model: string; imageUrl: string; question: string },
): Promise<string> {
  const res = await client.chat.completions.create({
    model: args.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: args.question },
        { type: 'image_url', image_url: { url: args.imageUrl } },
      ],
    }],
    stream: false,
  });
  return res.choices[0]?.message?.content ?? '';
}

/** Text to speech. Returns MP3 bytes. The API accepts at most 4096 input characters per request. */
export async function synthesizeSpeech(
  client: OpenAI,
  args: { model: string; voice: string; input: string; speed?: number },
): Promise<Buffer> {
  const res = await client.audio.speech.create({
    model: args.model,
    voice: args.voice,
    input: args.input,
    response_format: 'mp3',
    ...(args.speed !== undefined ? { speed: args.speed } : {}),
  });
  return Buffer.from(await res.arrayBuffer());
}

export async function transcribeAudio(
  client: OpenAI,
  args: { model: string; audio: Buffer; filename: string; mimeType: string },
): Promise<string> {
  const file = await toFile(args.audio, args.filename, { type: args.mimeType });
  const res = await client.audio.transcriptions.create({ model: args.model, file });
  return res.text;
}
