// Shared small helpers: logging, retry-fetch, concurrency pool, slugs, JSON digging.

export const log = {
  info: (...a) => console.log('  [info]', ...a),
  step: (...a) => console.log('\n==>', ...a),
  warn: (...a) => console.warn('  [warn]', ...a),
  error: (...a) => console.error('  [ERROR]', ...a),
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const round1 = (n) => Math.round(n * 10) / 10;

export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'node';
}

// fetch with retries on network errors / 429 / 5xx
export async function fetchRetry(url, options = {}, { retries = 4, baseDelay = 1500, label = '' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        const wait = Math.max(retryAfter * 1000, baseDelay * Math.pow(2, attempt));
        if (attempt === retries) return res;
        log.warn(`${label || url} -> HTTP ${res.status}, retrying in ${Math.round(wait / 1000)}s (${attempt + 1}/${retries})`);
        await sleep(wait);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt === retries) throw err;
      const wait = baseDelay * Math.pow(2, attempt);
      log.warn(`${label || url} -> ${err.message}, retrying in ${Math.round(wait / 1000)}s (${attempt + 1}/${retries})`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// Run async tasks with limited concurrency. tasks: array of () => Promise
export async function pool(tasks, limit = 6) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = await tasks[i]();
      } catch (err) {
        results[i] = { error: err.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Extract the first JSON object/array from LLM output (handles ```json fences and prose).
export function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  candidates.push(text);
  for (const c of candidates) {
    for (const open of ['{', '[']) {
      const close = open === '{' ? '}' : ']';
      const start = c.indexOf(open);
      const end = c.lastIndexOf(close);
      if (start !== -1 && end > start) {
        try { return JSON.parse(c.slice(start, end + 1)); } catch { /* try next */ }
      }
    }
  }
  throw new Error('No parseable JSON found in model output:\n' + text.slice(0, 500));
}

// Parse "===FILE: path===\n...content..." delimited multi-file LLM output.
export function parseFileBlocks(text) {
  const files = {};
  const re = /^[ \t]*=+\s*FILE:\s*([^\s=][^=\n]*?)\s*=+\s*$/gim;
  let match;
  const marks = [];
  while ((match = re.exec(text)) !== null) {
    marks.push({ path: match[1].trim(), start: match.index, end: re.lastIndex });
  }
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].end;
    const stop = i + 1 < marks.length ? marks[i + 1].start : text.length;
    let content = text.slice(start, stop);
    // strip a single wrapping code fence if present
    content = content.replace(/^\s*```[a-z]*\s*\n/i, '').replace(/\n```\s*$/i, '\n');
    files[marks[i].path] = content.replace(/^\n+/, '').replace(/\s+$/, '') + '\n';
  }
  return files;
}
