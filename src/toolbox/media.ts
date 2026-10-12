/**
 * Multimodal tools backed by OpenAI's media API: image generation and editing,
 * vision, text-to-speech, and transcription.
 *
 * Requires OPENAI_API_KEY (or OPENAI_MEDIA_API_KEY) in .env. Endpoint and model
 * come from the OPENAI_MEDIA_* and OPENAI_*_MODEL settings, so the chat provider
 * can point elsewhere (for example Z.ai GLM) without changing these tools.
 */
import { z } from 'zod';
import { defineTool } from '@nemesis-oss/ollama-sdk';
import OpenAI from 'openai';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { loadConfig, normalizeOpenAIBaseUrl, resolvePath, type MediaConfig } from '../config.js';
import { log } from '../logger.js';
import * as ops from './media-ops.js';
import { IMAGE_SIZES, sniffImageMime } from './media-ops.js';

/** OpenAI's documented input limit for the speech endpoint. */
const TTS_MAX_CHARS = 4096;

const AUDIO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.mpga': 'audio/mpeg', '.mpeg': 'audio/mpeg',
  '.mp4': 'audio/mp4', '.m4a': 'audio/mp4',
  '.wav': 'audio/wav', '.webm': 'audio/webm',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.flac': 'audio/flac',
};

let cached: { key: string; client: OpenAI } | null = null;

/** OpenAI client for media calls, or null when no key is configured. Cached per key and base URL. */
export function mediaClient(cfg: MediaConfig = loadConfig().media): OpenAI | null {
  if (!cfg.apiKey) return null;
  const baseURL = normalizeOpenAIBaseUrl(cfg.baseUrl);
  const key = `${cfg.apiKey}\n${baseURL}`;
  if (cached?.key !== key) cached = { key, client: new OpenAI({ apiKey: cfg.apiKey, baseURL }) };
  return cached.client;
}

function notConfigured(tool: string): string {
  return `${tool} requires OPENAI_API_KEY (or OPENAI_MEDIA_API_KEY) in .env.`;
}

function ensureDir(file: string): void {
  const dir = resolve(file, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Image bytes from a data: URL, an existing file path, or raw base64.
 * The MIME type comes from the bytes, not the file name, so mislabelled files are handled.
 */
function imageBytes(input: string): { buf: Buffer; mimeType: string } {
  let buf: Buffer;
  if (input.startsWith('data:')) {
    buf = Buffer.from(input.slice(input.indexOf(',') + 1), 'base64');
  } else if (existsSync(resolvePath(input))) {
    buf = readFileSync(resolvePath(input));
  } else {
    buf = Buffer.from(input, 'base64');
  }
  const mimeType = sniffImageMime(buf);
  if (!mimeType) throw new Error('Image input is neither an existing file nor PNG, JPEG, WEBP or GIF data');
  return { buf, mimeType };
}

function extensionFor(mimeType: string): string {
  return { 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[mimeType] ?? '.png';
}

/** Image generation tool: produces a PNG from a text prompt. */
export const generateImageTool = defineTool({
  name: 'generate_image',
  description: `Generate an image from a text prompt using OpenAI image generation. Saves the PNG to a file and returns the path. Sizes: ${IMAGE_SIZES.join(', ')}.`,
  schema: z.object({
    prompt: z.string().describe('Detailed image description'),
    size: z.enum(IMAGE_SIZES).optional().describe('Output dimensions'),
    outputPath: z.string().optional().describe('Where to save the PNG. Defaults to .agent/generated/img-<timestamp>.png'),
  }),
  timeoutMs: 120_000,
  execute: async ({ prompt, size, outputPath }) => {
    const cfg = loadConfig();
    const client = mediaClient(cfg.media);
    if (!client) return notConfigured('generate_image');
    const abs = resolvePath(outputPath || `${cfg.sessionsDir.replace(/\/sessions$/, '/generated')}/img-${Date.now()}.png`);
    const png = await ops.generateImage(client, { model: cfg.media.imageModel, prompt, size: size ?? '1024x1024' });
    ensureDir(abs);
    writeFileSync(abs, png);
    log.info('Image generated', { path: abs, prompt: prompt.slice(0, 60) });
    return `Image saved to ${abs}`;
  },
});

/** Vision tool: describes or answers questions about a local file, a URL, or a data: URL. */
export const analyzeImageTool = defineTool({
  name: 'analyze_image',
  description: 'Analyze an image (local file path, HTTP(S) URL, or data: URL) and answer questions about its content using a vision model. Returns a textual description or answer.',
  schema: z.object({
    image: z.string().describe('Local file path, HTTP(S) URL, or data: URL of the image'),
    question: z.string().optional().describe('Question about the image. Defaults to a general description.'),
  }),
  timeoutMs: 90_000,
  execute: async ({ image, question }) => {
    const cfg = loadConfig();
    const client = mediaClient(cfg.media);
    if (!client) return notConfigured('analyze_image');
    let imageUrl: string;
    if (/^https?:\/\//i.test(image)) {
      imageUrl = image;
    } else {
      if (!image.startsWith('data:') && !existsSync(resolvePath(image))) return `Image file not found: ${resolvePath(image)}`;
      const { buf, mimeType } = imageBytes(image);
      imageUrl = `data:${mimeType};base64,${buf.toString('base64')}`;
    }
    const text = await ops.analyzeImage(client, {
      model: cfg.media.visionModel,
      imageUrl,
      question: question || 'Describe this image in detail.',
    });
    log.info('Vision analysis done', { image: image.slice(0, 60), question: (question || 'describe').slice(0, 40) });
    return text;
  },
});

/** Text-to-speech tool: converts text into an MP3 file. */
export const textToSpeechTool = defineTool({
  name: 'text_to_speech',
  description: 'Convert text into speech audio using OpenAI text-to-speech. Saves an MP3 file and returns the path.',
  schema: z.object({
    text: z.string().describe(`The text to synthesize (at most ${TTS_MAX_CHARS} characters)`),
    voice: z.string().optional().describe('Voice name, for example alloy, nova or shimmer. Defaults to OPENAI_TTS_VOICE.'),
    speed: z.number().min(0.25).max(4).optional().describe('Playback speed multiplier'),
    outputPath: z.string().optional().describe('Output audio file path. Defaults to .agent/audio/tts-<timestamp>.mp3'),
  }),
  timeoutMs: 60_000,
  execute: async ({ text, voice, speed, outputPath }) => {
    const cfg = loadConfig();
    const client = mediaClient(cfg.media);
    if (!client) return notConfigured('text_to_speech');
    if (text.length > TTS_MAX_CHARS) return `text_to_speech input is limited to ${TTS_MAX_CHARS} characters; split the text into chunks.`;
    const abs = resolvePath(outputPath || `${cfg.sessionsDir.replace(/\/sessions$/, '/audio')}/tts-${Date.now()}.mp3`);
    const mp3 = await ops.synthesizeSpeech(client, {
      model: cfg.media.ttsModel,
      voice: voice ?? cfg.media.ttsVoice,
      input: text,
      speed,
    });
    ensureDir(abs);
    writeFileSync(abs, mp3);
    log.info('TTS generated', { path: abs, chars: text.length });
    return `Audio saved to ${abs}`;
  },
});

/** Speech-to-text tool: transcribes an audio file. */
export const transcribeAudioTool = defineTool({
  name: 'transcribe_audio',
  description: `Transcribe speech from an audio file to text. Supported formats: ${Object.keys(AUDIO_MIME).join(', ')}.`,
  schema: z.object({
    filePath: z.string().describe('Path to the audio file to transcribe'),
  }),
  timeoutMs: 90_000,
  execute: async ({ filePath }) => {
    const cfg = loadConfig();
    const client = mediaClient(cfg.media);
    if (!client) return notConfigured('transcribe_audio');
    const abs = resolvePath(filePath);
    if (!existsSync(abs)) return `Audio file not found: ${abs}`;
    const mimeType = AUDIO_MIME[extname(abs).toLowerCase()];
    if (!mimeType) return `Unsupported audio format "${extname(abs)}". Supported: ${Object.keys(AUDIO_MIME).join(', ')}.`;
    const text = await ops.transcribeAudio(client, {
      model: cfg.media.transcriptionModel,
      audio: readFileSync(abs),
      filename: basename(abs),
      mimeType,
    });
    log.info('ASR done', { file: abs, chars: text.length });
    return text;
  },
});

/** Image edit tool: modifies an existing image with a text instruction. */
export const editImageTool = defineTool({
  name: 'edit_image',
  description: 'Edit an existing image using a text instruction. Saves the result as a PNG and returns the path.',
  schema: z.object({
    prompt: z.string().describe('Edit instruction'),
    image: z.string().describe('Local file path, data: URL, or base64 of the source image'),
    size: z.enum(IMAGE_SIZES).optional().describe('Output dimensions'),
    outputPath: z.string().optional().describe('Where to save the PNG. Defaults to .agent/generated/edit-<timestamp>.png'),
  }),
  timeoutMs: 120_000,
  execute: async ({ prompt, image, size, outputPath }) => {
    const cfg = loadConfig();
    const client = mediaClient(cfg.media);
    if (!client) return notConfigured('edit_image');
    const { buf, mimeType } = imageBytes(image);
    const abs = resolvePath(outputPath || `${cfg.sessionsDir.replace(/\/sessions$/, '/generated')}/edit-${Date.now()}.png`);
    const png = await ops.editImage(client, {
      model: cfg.media.imageModel,
      prompt,
      image: buf,
      mimeType,
      filename: `input${extensionFor(mimeType)}`,
      size,
    });
    ensureDir(abs);
    writeFileSync(abs, png);
    return `Edited image saved to ${abs}`;
  },
});

export const mediaTools = [
  generateImageTool, analyzeImageTool, textToSpeechTool, transcribeAudioTool, editImageTool,
];
