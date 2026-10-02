/**
 * Z.ai-powered tools — image generation, vision analysis, TTS, ASR,
 * web search, and page reading. These extend the agent with multimodal
 * capabilities beyond text, using the z-ai-web-dev-sdk.
 *
 * Requires ZAI_API_KEY in .env and AGENT_PROVIDER=zai. Tools degrade
 * gracefully (return a clear message) when the provider is inactive,
 * so the registry still loads.
 */
import { z } from 'zod';
import { defineTool } from '@nemesis-oss/ollama-sdk';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rawZai } from '../providers.js';
import { loadConfig, resolvePath } from '../config.js';
import { log } from '../logger.js';

function ensureDir(file: string): void {
  const dir = resolve(file, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Image generation tool — produces a PNG from a text prompt. */
export const imageGenerationTool = defineTool({
  name: 'generate_image',
  description: 'Generate an image from a text prompt using AI. Saves the PNG to a file and returns the path. Sizes: 1024x1024, 768x1344, 864x1152, 1344x768, 1152x864, 1440x720, 720x1440.',
  schema: z.object({
    prompt: z.string().describe('Detailed image description'),
    size: z.enum(['1024x1024', '768x1344', '864x1152', '1344x768', '1152x864', '1440x720', '720x1440']).optional().describe('Output dimensions'),
    outputPath: z.string().optional().describe('Where to save the PNG. Defaults to download/generated/img-<timestamp>.png'),
  }),
  timeoutMs: 120_000,
  execute: async ({ prompt, size, outputPath }) => {
    const z = rawZai();
    if (!z) return 'Z.ai provider not active. Set AGENT_PROVIDER=zai and ZAI_API_KEY in .env to use image generation.';
    const cfg = loadConfig();
    const out = outputPath || `${cfg.sessionsDir.replace(/\/sessions$/, '/generated')}/img-${Date.now()}.png`;
    const abs = resolvePath(out);
    ensureDir(abs);
    const res = await z.images.generations.create({ prompt, size: size ?? '1024x1024' });
    if (res.data?.[0]?.base64) {
      writeFileSync(abs, Buffer.from(res.data[0].base64, 'base64'));
      log.info('Image generated', { path: abs, prompt: prompt.slice(0, 60) });
      return `Image saved to ${abs}`;
    }
    return 'Image generation returned no data.';
  },
});

/** Vision / image analysis tool — describes or answers questions about an image. */
export const visionAnalysisTool = defineTool({
  name: 'analyze_image',
  description: 'Analyze an image (local file path or URL) and answer questions about its content using a vision model. Returns a textual description/answer.',
  schema: z.object({
    image: z.string().describe('Local file path or HTTP(S) URL of the image'),
    question: z.string().optional().describe('Question about the image. Defaults to a general description.'),
  }),
  timeoutMs: 90_000,
  execute: async ({ image, question }) => {
    const z = rawZai();
    if (!z) return 'Z.ai provider not active. Set AGENT_PROVIDER=zai and ZAI_API_KEY in .env to use vision analysis.';
    let imageUrl = image;
    if (!image.startsWith('http')) {
      const abs = resolvePath(image);
      if (!existsSync(abs)) return `Image file not found: ${abs}`;
      const buf = readFileSync(abs);
      imageUrl = `data:image/png;base64,${buf.toString('base64')}`;
    }
    const res = await z.chat.completions.createVision({
      model: 'glm-4.5v',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: question || 'Describe this image in detail.' },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      }],
    });
    const text = (res as any)?.choices?.[0]?.message?.content ?? '';
    log.info('Vision analysis done', { image: image.slice(0, 60), question: (question || 'describe').slice(0, 40) });
    return text;
  },
});

/** Text-to-speech tool — converts text to an audio file. */
export const ttsTool = defineTool({
  name: 'text_to_speech',
  description: 'Convert text into natural-sounding speech audio. Saves an MP3 file and returns the path.',
  schema: z.object({
    text: z.string().describe('The text to synthesize'),
    voice: z.string().optional().describe('Voice name/ID. Provider default if omitted.'),
    speed: z.number().min(0.5).max(2).optional().describe('Playback speed multiplier'),
    outputPath: z.string().optional().describe('Output audio file path'),
  }),
  timeoutMs: 60_000,
  execute: async ({ text, voice, speed, outputPath }) => {
    const z = rawZai();
    if (!z) return 'Z.ai provider not active. Set AGENT_PROVIDER=zai and ZAI_API_KEY in .env to use TTS.';
    const cfg = loadConfig();
    const out = outputPath || `${cfg.sessionsDir.replace(/\/sessions$/, '/audio')}/tts-${Date.now()}.mp3`;
    const abs = resolvePath(out);
    ensureDir(abs);
    const res = await z.audio.tts.create({ input: text, voice, speed, response_format: 'mp3' } as any);
    const b64 = (res as any)?.data?.[0]?.base64 || (res as any)?.audio;
    if (b64) {
      writeFileSync(abs, Buffer.from(b64, 'base64'));
      log.info('TTS generated', { path: abs, chars: text.length });
      return `Audio saved to ${abs}`;
    }
    return 'TTS returned no audio data.';
  },
});

/** Speech-to-text (ASR) tool — transcribes an audio file. */
export const asrTool = defineTool({
  name: 'transcribe_audio',
  description: 'Transcribe speech from an audio file (MP3, WAV, etc.) to text using speech recognition.',
  schema: z.object({
    filePath: z.string().describe('Path to the audio file to transcribe'),
  }),
  timeoutMs: 90_000,
  execute: async ({ filePath }) => {
    const z = rawZai();
    if (!z) return 'Z.ai provider not active. Set AGENT_PROVIDER=zai and ZAI_API_KEY in .env to use ASR.';
    const abs = resolvePath(filePath);
    if (!existsSync(abs)) return `Audio file not found: ${abs}`;
    const b64 = readFileSync(abs).toString('base64');
    const res = await z.audio.asr.create({ file_base64: b64 } as any);
    const text = (res as any)?.text || JSON.stringify(res);
    log.info('ASR done', { file: abs, chars: text.length });
    return text;
  },
});

/** Web search tool — search the web for current information. */
export const webSearchTool = defineTool({
  name: 'web_search',
  description: 'Search the web for real-time information and current events. Returns ranked results with URLs and snippets.',
  schema: z.object({
    query: z.string().describe('Search query'),
    num: z.number().int().min(1).max(20).optional().describe('Number of results (default 5)'),
    recency_days: z.number().int().optional().describe('Limit to results from last N days'),
  }),
  timeoutMs: 30_000,
  execute: async ({ query, num, recency_days }) => {
    const z = rawZai();
    if (z) {
      const results = await z.functions.invoke('web_search', { query, num: num ?? 5, recency_days } as any);
      const lines = (results as any[]).map((r, i) => `${i + 1}. ${r.name}\n   ${r.snippet}\n   ${r.url}`);
      log.info('Web search (zai)', { query: query.slice(0, 60), count: results.length });
      return lines.join('\n\n') || 'No results found.';
    }
    return 'Web search requires Z.ai provider (AGENT_PROVIDER=zai) or Ollama Cloud API key (OLLAMA_API_KEY).';
  },
});

/** Page reader tool — extract readable content from a URL. */
export const pageReaderTool = defineTool({
  name: 'read_web_page',
  description: 'Fetch a web page and extract its main text content, title, and metadata. Useful for reading articles or documentation.',
  schema: z.object({
    url: z.string().describe('The URL to read'),
  }),
  timeoutMs: 30_000,
  execute: async ({ url }) => {
    const z = rawZai();
    if (z) {
      const result = await z.functions.invoke('page_reader', { url });
      const d = (result as any).data;
      const out = `Title: ${d?.title ?? ''}\nURL: ${d?.url ?? url}\nPublished: ${d?.publishedTime ?? 'unknown'}\n\n${d?.html ?? ''}`;
      log.info('Page read (zai)', { url: url.slice(0, 60) });
      return out;
    }
    return 'Page reader requires Z.ai provider (AGENT_PROVIDER=zai).';
  },
});

/** Image search tool — find images on the web matching a query. */
export const imageSearchTool = defineTool({
  name: 'search_images',
  description: 'Search for images on the web matching a text query. Returns image URLs and metadata.',
  schema: z.object({
    query: z.string().describe('Image search query'),
    count: z.number().int().min(1).max(20).optional().describe('Number of results'),
  }),
  timeoutMs: 30_000,
  execute: async ({ query, count }) => {
    const z = rawZai();
    if (!z) return 'Image search requires Z.ai provider (AGENT_PROVIDER=zai).';
    const res = await z.images.search.create({ query, count: count ?? 5 });
    if (!res.success || !res.results?.length) return `No images found for "${query}".`;
    return res.results.map((r, i) => `${i + 1}. ${r.caption ?? 'image'}\n   ${r.original_url}`).join('\n\n');
  },
});

/** Image edit tool — modify an existing image with a text prompt. */
export const imageEditTool = defineTool({
  name: 'edit_image',
  description: 'Edit an existing image using a text instruction (inpainting/redesign). Saves the result to a file.',
  schema: z.object({
    prompt: z.string().describe('Edit instruction'),
    image: z.string().optional().describe('Base64 of the source image, or a local path'),
    outputPath: z.string().optional(),
  }),
  timeoutMs: 120_000,
  execute: async ({ prompt, image, outputPath }) => {
    const z = rawZai();
    if (!z) return 'Image editing requires Z.ai provider (AGENT_PROVIDER=zai).';
    const cfg = loadConfig();
    const out = outputPath || `${cfg.sessionsDir.replace(/\/sessions$/, '/generated')}/edit-${Date.now()}.png`;
    const abs = resolvePath(out);
    ensureDir(abs);
    let imageBase64 = image;
    if (image && !image.startsWith('data:')) {
      const p = resolvePath(image);
      if (existsSync(p)) imageBase64 = readFileSync(p).toString('base64');
    }
    const res = await z.images.generations.edit({ prompt, image: imageBase64 });
    if (res.data?.[0]?.base64) {
      writeFileSync(abs, Buffer.from(res.data[0].base64, 'base64'));
      return `Edited image saved to ${abs}`;
    }
    return 'Image edit returned no data.';
  },
});

export const zaiTools = [
  imageGenerationTool, visionAnalysisTool, ttsTool, asrTool,
  webSearchTool, pageReaderTool, imageSearchTool, imageEditTool,
];

export function zaiAvailable(): boolean { return Boolean(rawZai()); }
