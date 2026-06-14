// Figma REST API client: node trees, rendered screenshots, image-fill URLs, asset export.
import { fetchRetry, chunk, pool, log } from './util.mjs';

const API = 'https://api.figma.com';

export class FigmaRest {
  constructor(fileKey, token) {
    this.fileKey = fileKey;
    this.headers = { 'X-Figma-Token': token };
  }

  async #getJson(url, label) {
    const res = await fetchRetry(url, { headers: this.headers }, { label });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Figma API ${label} failed: HTTP ${res.status} ${body.slice(0, 300)}`);
    }
    return res.json();
  }

  // Shallow file structure (pages + top-level frames)
  async getFileShallow(depth = 2) {
    return this.#getJson(`${API}/v1/files/${this.fileKey}?depth=${depth}`, 'file(shallow)');
  }

  // Full subtree document for one or more node ids
  async getNodes(ids, { geometry = '' } = {}) {
    const out = {};
    for (const batch of chunk(ids, 20)) {
      const q = geometry ? `&geometry=${geometry}` : '';
      const data = await this.#getJson(
        `${API}/v1/files/${this.fileKey}/nodes?ids=${encodeURIComponent(batch.join(','))}${q}`,
        'nodes'
      );
      for (const [id, entry] of Object.entries(data.nodes || {})) {
        if (entry && entry.document) out[id] = entry.document;
      }
    }
    return out;
  }

  // Render node(s) to images. Returns {nodeId: url|null}
  async renderImages(ids, { format = 'png', scale = 1 } = {}) {
    const urls = {};
    for (const batch of chunk(ids, 50)) {
      try {
        const data = await this.#getJson(
          `${API}/v1/images/${this.fileKey}?ids=${encodeURIComponent(batch.join(','))}&format=${format}&scale=${scale}`,
          `images(${format})`
        );
        Object.assign(urls, data.images || {});
      } catch (err) {
        log.warn(`render batch failed (${format} x${batch.length}): ${err.message}`);
        for (const id of batch) urls[id] = urls[id] ?? null;
      }
    }
    return urls;
  }

  // Map of imageRef -> download URL for all image fills in the file
  async getImageFillUrls() {
    const data = await this.#getJson(`${API}/v1/files/${this.fileKey}/images`, 'image-fills');
    return (data.meta && data.meta.images) || {};
  }

  async downloadBinary(url, label) {
    const res = await fetchRetry(url, {}, { label: label || 'download' });
    if (!res.ok) throw new Error(`download failed HTTP ${res.status} for ${label}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // Download many {url, dest} entries concurrently via fs writes
  async downloadAll(entries, fsPromises, limit = 8) {
    return pool(
      entries.map(({ url, dest, label }) => async () => {
        const buf = await this.downloadBinary(url, label);
        await fsPromises.writeFile(dest, buf);
        return { dest, bytes: buf.length };
      }),
      limit
    );
  }
}
