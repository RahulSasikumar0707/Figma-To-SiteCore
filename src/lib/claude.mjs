// Anthropic Messages API client (native fetch, SSE streaming, retries,
// automatic continuation when output hits the max_tokens cap).
// Two instances are used: KEY 1 = extractor/generator, KEY 2 = design reviewer.
import { sleep, log } from './util.mjs';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024; // stay under the 5MB/image API limit
const MAX_IMAGE_SIDE = 7900; // API rejects images over 8000px on a side

function pngDims(buffer) {
  // PNG signature + IHDR: width/height are big-endian uint32 at offsets 16/20
  if (buffer.length < 24 || buffer[0] !== 0x89 || buffer[1] !== 0x50) return null;
  return { w: buffer.readUInt32BE(16), h: buffer.readUInt32BE(20) };
}

export function imageBlock(buffer, mediaType) {
  if (!buffer || buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return null;
  // sniff the real format from magic bytes — never trust self-reported mime
  // types (Figma's MCP server is known to mislabel PNG bytes as image/jpeg)
  if (!mediaType) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8) mediaType = 'image/jpeg';
    else if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) mediaType = 'image/gif';
    else if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') mediaType = 'image/webp';
    else if (buffer[0] === 0x89 && buffer[1] === 0x50) mediaType = 'image/png';
    else return null; // unknown format would 400 the whole request
  }
  const dims = mediaType === 'image/png' ? pngDims(buffer) : null;
  if (dims && (dims.w > MAX_IMAGE_SIDE || dims.h > MAX_IMAGE_SIDE)) return null;
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') },
  };
}

// Anthropic allows at most 100 images/request, but >20 images tightens the
// per-image dimension cap to 2000px — our tall section renders exceed that,
// so keep every request at <=20 images.
export const MAX_IMAGES_PER_REQUEST = 20;

export class Claude {
  constructor({ apiKey, model, maxTokens = 32000, label = 'claude' }) {
    this.apiKey = apiKey;
    this.model = model;
    this.maxTokens = maxTokens;
    this.label = label;
    this.usage = { input_tokens: 0, output_tokens: 0, calls: 0 };
  }

  async #streamOnce(body) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...body, stream: true }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const err = new Error(`[${this.label}] HTTP ${res.status}: ${errText.slice(0, 400)}`);
      err.status = res.status;
      throw err;
    }

    let text = '';
    let stopReason = null;
    let outTokens = 0;
    let buffer = '';
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(payload); } catch { continue; }
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          text += evt.delta.text;
        } else if (evt.type === 'message_delta') {
          if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
          if (evt.usage?.output_tokens) outTokens = evt.usage.output_tokens; // cumulative — keep latest
        } else if (evt.type === 'message_start' && evt.message?.usage) {
          const u = evt.message.usage;
          this.usage.input_tokens += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        } else if (evt.type === 'error') {
          const err = new Error(`[${this.label}] stream error: ${JSON.stringify(evt.error).slice(0, 300)}`);
          err.status = evt.error?.type === 'overloaded_error' ? 529 : 500;
          throw err;
        }
      }
    }
    this.usage.output_tokens += outTokens;
    this.usage.calls += 1;
    return { text, stopReason };
  }

  // messages: [{role, content: string | blocks[]}]. Auto-continues on max_tokens.
  async complete({ system, messages, maxTokens }) {
    const normalized = messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : m.content.filter(Boolean),
    }));
    // cache the (large, image-laden) first user turn so max_tokens continuations
    // re-read it from the prompt cache instead of re-billing the full input
    const first = normalized[0];
    if (first?.content?.length) {
      const last = first.content[first.content.length - 1];
      first.content[first.content.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };
    }
    // no sampling params: Opus 4.7+/Fable 5 removed temperature/top_p/top_k
    // and return 400 if any are present
    const body = {
      model: this.model,
      max_tokens: maxTokens || this.maxTokens,
      system,
      messages: normalized,
    };

    let fullText = '';
    let convo = [...body.messages];
    for (let segment = 0; segment < 6; segment++) {
      let result = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          result = await this.#streamOnce({ ...body, messages: convo });
          break;
        } catch (err) {
          const retriable = err.status === 429 || err.status === 529 || err.status >= 500
            || /fetch failed|network|ECONNRESET|aborted|terminated|premature|socket|other side closed/i.test(err.message);
          if (!retriable || attempt === 4) throw err;
          const wait = 3000 * Math.pow(2, attempt);
          log.warn(`${err.message} — retrying in ${Math.round(wait / 1000)}s`);
          await sleep(wait);
        }
      }
      fullText += result.text;
      if (result.stopReason !== 'max_tokens') return fullText;
      log.info(`[${this.label}] output hit max_tokens, continuing (segment ${segment + 2})...`);
      convo = [
        ...convo,
        { role: 'assistant', content: result.text },
        { role: 'user', content: 'Continue EXACTLY where you left off. Do not repeat anything already produced, do not add commentary — just continue the output stream.' },
      ];
    }
    log.warn(`[${this.label}] continuation cap (6 segments) reached — output may be incomplete`);
    return fullText;
  }
}
