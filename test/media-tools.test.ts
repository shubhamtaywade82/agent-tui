import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import OpenAI from 'openai';
import * as ops from '../src/toolbox/media-ops.js';
import { sniffImageMime } from '../src/toolbox/media-ops.js';
import { loadConfig } from '../src/config.js';
import {
  analyzeImageTool, editImageTool, generateImageTool, mediaTools, textToSpeechTool, transcribeAudioTool,
} from '../src/toolbox/media.js';
import { json, startStubServer, withEnv, type StubServer } from './helpers/stub-http.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);
const b64Image = (buf: Buffer) => json({ created: 0, data: [{ b64_json: buf.toString('base64') }] });

function clientFor(baseUrl: string): OpenAI {
  return new OpenAI({ apiKey: 'test-key', baseURL: `${baseUrl}/v1` });
}

const MEDIA_ENV = { AGENT_LOG_LEVEL: 'silent', OPENAI_API_KEY: undefined, OPENAI_MEDIA_API_KEY: undefined };

test('sniffImageMime detects supported formats from the bytes', () => {
  assert.equal(sniffImageMime(PNG), 'image/png');
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg');
  assert.equal(sniffImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')])), 'image/webp');
  assert.equal(sniffImageMime(Buffer.from('GIF89a....')), 'image/gif');
  assert.equal(sniffImageMime(Buffer.from('plain text')), null);
  assert.equal(sniffImageMime(Buffer.alloc(0)), null);
});

test('generateImage requests gpt-image-1 with the given size and decodes base64', async () => {
  const s = await startStubServer(() => b64Image(PNG));
  try {
    const out = await ops.generateImage(clientFor(s.baseUrl), { model: 'gpt-image-1', prompt: 'a cat', size: '1536x1024' });
    assert.deepEqual(out, PNG);
    const body = JSON.parse(s.requests[0]!.body.toString('utf8'));
    assert.equal(s.requests[0]!.path, '/v1/images/generations');
    assert.deepEqual({ model: body.model, prompt: body.prompt, size: body.size, n: body.n }, { model: 'gpt-image-1', prompt: 'a cat', size: '1536x1024', n: 1 });
  } finally {
    await s.close();
  }
});

test('generateImage downloads the image when the API returns a URL instead of base64', async () => {
  let s!: StubServer;
  s = await startStubServer((req) => {
    if (req.path === '/v1/images/generations') return json({ created: 0, data: [{ url: `${s.baseUrl}/files/out.png` }] });
    return { headers: { 'content-type': 'image/png' }, body: PNG };
  });
  try {
    const out = await ops.generateImage(clientFor(s.baseUrl), { model: 'dall-e-3', prompt: 'x', size: '1024x1024' });
    assert.deepEqual(out, PNG);
  } finally {
    await s.close();
  }
});

test('generateImage fails when the response carries no image data', async () => {
  const s = await startStubServer(() => json({ created: 0, data: [] }));
  try {
    await assert.rejects(ops.generateImage(clientFor(s.baseUrl), { model: 'gpt-image-1', prompt: 'x', size: 'auto' }), /no image data/);
  } finally {
    await s.close();
  }
});

test('editImage uploads the source image as multipart form data', async () => {
  const s = await startStubServer(() => b64Image(PNG));
  try {
    const out = await ops.editImage(clientFor(s.baseUrl), {
      model: 'gpt-image-1', prompt: 'make it blue', image: PNG, mimeType: 'image/png', filename: 'input.png',
    });
    assert.deepEqual(out, PNG);
    const req = s.requests[0]!;
    assert.equal(req.path, '/v1/images/edits');
    assert.match(req.headers['content-type'] ?? '', /multipart\/form-data/);
    const raw = req.body.toString('latin1');
    assert.match(raw, /name="prompt"\r\n\r\nmake it blue/);
    assert.match(raw, /name="image"; filename="input\.png"/);
    assert.match(raw, /Content-Type: image\/png/);
  } finally {
    await s.close();
  }
});

test('analyzeImage sends an image_url content part and returns the answer', async () => {
  const s = await startStubServer(() => json({ id: 'c', object: 'chat.completion', created: 0, model: 'v', choices: [{ index: 0, message: { role: 'assistant', content: 'A cat.' }, finish_reason: 'stop', logprobs: null }] }));
  try {
    const dataUrl = `data:image/png;base64,${PNG.toString('base64')}`;
    const text = await ops.analyzeImage(clientFor(s.baseUrl), { model: 'gpt-4o-mini', imageUrl: dataUrl, question: 'What is it?' });
    assert.equal(text, 'A cat.');
    const body = JSON.parse(s.requests[0]!.body.toString('utf8'));
    assert.equal(s.requests[0]!.path, '/v1/chat/completions');
    assert.deepEqual(body.messages[0].content, [
      { type: 'text', text: 'What is it?' },
      { type: 'image_url', image_url: { url: dataUrl } },
    ]);
  } finally {
    await s.close();
  }
});

test('synthesizeSpeech returns the binary MP3 payload', async () => {
  const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);
  const s = await startStubServer(() => ({ headers: { 'content-type': 'audio/mpeg' }, body: mp3 }));
  try {
    const out = await ops.synthesizeSpeech(clientFor(s.baseUrl), { model: 'tts-1', voice: 'alloy', input: 'hello', speed: 1.25 });
    assert.deepEqual(out, mp3);
    const body = JSON.parse(s.requests[0]!.body.toString('utf8'));
    assert.equal(s.requests[0]!.path, '/v1/audio/speech');
    assert.deepEqual(body, { model: 'tts-1', voice: 'alloy', input: 'hello', response_format: 'mp3', speed: 1.25 });
  } finally {
    await s.close();
  }
});

test('transcribeAudio uploads the file and returns the transcript text', async () => {
  const s = await startStubServer(() => json({ text: 'hello world' }));
  try {
    const text = await ops.transcribeAudio(clientFor(s.baseUrl), { model: 'whisper-1', audio: Buffer.from('ID3-audio'), filename: 'clip.mp3', mimeType: 'audio/mpeg' });
    assert.equal(text, 'hello world');
    const raw = s.requests[0]!.body.toString('latin1');
    assert.equal(s.requests[0]!.path, '/v1/audio/transcriptions');
    assert.match(raw, /name="model"\r\n\r\nwhisper-1/);
    assert.match(raw, /name="file"; filename="clip\.mp3"/);
  } finally {
    await s.close();
  }
});

test('a 401 from the media API rejects with the status attached', async () => {
  const s = await startStubServer(() => json({ error: { message: 'bad key' } }, 401));
  try {
    await assert.rejects(
      ops.synthesizeSpeech(clientFor(s.baseUrl), { model: 'tts-1', voice: 'alloy', input: 'x' }),
      (err: { status?: number }) => err.status === 401,
    );
  } finally {
    await s.close();
  }
});

test('media tools report the missing key without sending any request', async () => {
  const results = await withEnv(MEDIA_ENV, async () => Promise.all([
    generateImageTool.execute({ prompt: 'x' }, {} as never),
    analyzeImageTool.execute({ image: 'https://example.test/a.png' }, {} as never),
    textToSpeechTool.execute({ text: 'x' }, {} as never),
    transcribeAudioTool.execute({ filePath: 'a.mp3' }, {} as never),
    editImageTool.execute({ prompt: 'x', image: 'y' }, {} as never),
  ]));
  for (const r of results) assert.match(r, /requires OPENAI_API_KEY \(or OPENAI_MEDIA_API_KEY\)/);
  assert.equal(mediaTools.length, 5);
});

test('media tools use OPENAI_MEDIA_* settings even when chat points at another host', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-tools-'));
  const outPath = join(dir, 'out.png');
  const s = await startStubServer(() => b64Image(PNG));
  try {
    const reply = await withEnv({
      AGENT_LOG_LEVEL: 'silent',
      OPENAI_API_KEY: 'chat-key-for-zai',
      OPENAI_BASE_URL: 'https://api.z.ai/api/paas/v4',
      OPENAI_MEDIA_API_KEY: 'media-key',
      OPENAI_MEDIA_BASE_URL: `${s.baseUrl}/v1`,
      OPENAI_IMAGE_MODEL: 'gpt-image-1',
    }, () => generateImageTool.execute({ prompt: 'a lighthouse', size: '1024x1536', outputPath: outPath }, {} as never));
    assert.equal(reply, `Image saved to ${outPath}`);
    assert.deepEqual(readFileSync(outPath), PNG);
    assert.equal(s.requests[0]!.path, '/v1/images/generations');
    assert.equal(s.requests[0]!.headers.authorization, 'Bearer media-key');
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edit_image and analyze_image accept raw base64 and data: URLs as image input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-tools-'));
  const outPath = join(dir, 'edited.png');
  const s = await startStubServer((req) => {
    if (req.path === '/v1/images/edits') return b64Image(PNG);
    return json({ id: 'c', object: 'chat.completion', created: 0, model: 'v', choices: [{ index: 0, message: { role: 'assistant', content: 'seen' }, finish_reason: 'stop', logprobs: null }] });
  });
  try {
    const env = { AGENT_LOG_LEVEL: 'silent', OPENAI_MEDIA_API_KEY: 'k', OPENAI_MEDIA_BASE_URL: `${s.baseUrl}/v1` };
    const b64 = PNG.toString('base64');
    const edited = await withEnv(env, () => editImageTool.execute({ prompt: 'brighter', image: b64, outputPath: outPath }, {} as never));
    assert.equal(edited, `Edited image saved to ${outPath}`);
    assert.deepEqual(readFileSync(outPath), PNG);
    const seen = await withEnv(env, () => analyzeImageTool.execute({ image: `data:image/png;base64,${b64}`, question: 'what?' }, {} as never));
    assert.equal(seen, 'seen');
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('input guards return messages without calling the API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-tools-'));
  const badAudio = join(dir, 'notes.txt');
  writeFileSync(badAudio, 'not audio');
  const s = await startStubServer(() => json({ text: 'unreachable' }));
  try {
    const env = { AGENT_LOG_LEVEL: 'silent', OPENAI_MEDIA_API_KEY: 'k', OPENAI_MEDIA_BASE_URL: `${s.baseUrl}/v1` };
    const tooLong = await withEnv(env, () => textToSpeechTool.execute({ text: 'a'.repeat(4097) }, {} as never));
    assert.match(tooLong, /limited to 4096 characters/);
    const unsupported = await withEnv(env, () => transcribeAudioTool.execute({ filePath: badAudio }, {} as never));
    assert.match(unsupported, /Unsupported audio format "\.txt"/);
    const missing = await withEnv(env, () => transcribeAudioTool.execute({ filePath: join(dir, 'absent.mp3') }, {} as never));
    assert.match(missing, /Audio file not found/);
    const missingImage = await withEnv(env, () => analyzeImageTool.execute({ image: join(dir, 'absent.png') }, {} as never));
    assert.match(missingImage, /Image file not found/);
    assert.equal(existsSync(join(dir, 'absent.mp3')), false);
    assert.equal(s.requests.length, 0);
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edit_image rejects input that is neither a file nor image data', async () => {
  await assert.rejects(
    withEnv({ AGENT_LOG_LEVEL: 'silent', OPENAI_MEDIA_API_KEY: 'k' }, () => editImageTool.execute({ prompt: 'x', image: 'not-an-image-path.png' }, {} as never)),
    /neither an existing file nor PNG, JPEG, WEBP or GIF data/,
  );
});

test('edit_image rejects GIF input before any request, since the edit endpoint does not accept it', async () => {
  const s = await startStubServer(() => b64Image(PNG));
  try {
    const gif = `data:image/gif;base64,${Buffer.from('GIF89a....').toString('base64')}`;
    const reply = await withEnv({ AGENT_LOG_LEVEL: 'silent', OPENAI_MEDIA_API_KEY: 'k', OPENAI_MEDIA_BASE_URL: `${s.baseUrl}/v1` }, () =>
      editImageTool.execute({ prompt: 'x', image: gif }, {} as never));
    assert.equal(reply, 'edit_image accepts PNG, JPEG or WEBP input, not image/gif.');
    assert.equal(s.requests.length, 0);
  } finally {
    await s.close();
  }
});

test('transcribe_audio rejects .oga, which the transcription endpoint does not list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-tools-'));
  const oga = join(dir, 'clip.oga');
  writeFileSync(oga, 'OggS');
  const s = await startStubServer(() => json({ text: 'unreachable' }));
  try {
    const reply = await withEnv({ AGENT_LOG_LEVEL: 'silent', OPENAI_MEDIA_API_KEY: 'k', OPENAI_MEDIA_BASE_URL: `${s.baseUrl}/v1` }, () =>
      transcribeAudioTool.execute({ filePath: oga }, {} as never));
    assert.match(reply, /Unsupported audio format "\.oga"/);
    assert.equal(s.requests.length, 0);
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a generated image that is not an image is rejected rather than saved as .png', async () => {
  const s = await startStubServer(() => b64Image(Buffer.from('<html>error page</html>')));
  try {
    await assert.rejects(
      ops.generateImage(clientFor(s.baseUrl), { model: 'gpt-image-1', prompt: 'x', size: 'auto' }),
      /not a PNG, JPEG, WEBP or GIF image/,
    );
  } finally {
    await s.close();
  }
});

test('OPENAI_API_KEY is reused for media only when chat and media both use api.openai.com', async () => {
  const base = { AGENT_LOG_LEVEL: 'silent', OPENAI_API_KEY: 'sk-openai', OPENAI_BASE_URL: undefined, OPENAI_MEDIA_API_KEY: undefined, OPENAI_MEDIA_BASE_URL: undefined };
  assert.equal(await withEnv(base, () => loadConfig().media.apiKey), 'sk-openai');
  assert.equal(await withEnv({ ...base, OPENAI_BASE_URL: 'https://api.z.ai/api/paas/v4' }, () => loadConfig().media.apiKey), undefined);
  assert.equal(await withEnv({ ...base, OPENAI_MEDIA_BASE_URL: 'https://gw.example/v1' }, () => loadConfig().media.apiKey), undefined);
  assert.equal(
    await withEnv({ ...base, OPENAI_BASE_URL: 'https://api.z.ai/api/paas/v4', OPENAI_MEDIA_API_KEY: 'sk-media' }, () => loadConfig().media.apiKey),
    'sk-media',
  );
});
