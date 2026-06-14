// Minimal client for the Figma desktop Dev Mode MCP server (streamable HTTP + SSE).
// Best-effort: every method returns null instead of throwing so the pipeline can
// fall back to the REST extraction when the desktop server is unavailable.
import { log } from './util.mjs';

export class FigmaMcp {
  constructor(url) {
    this.url = url;
    this.sessionId = null;
    this.nextId = 1;
    this.available = false;
    this.tools = [];
  }

  async #post(body, { expectResult = true } = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion;
    const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (!expectResult) return null;
    const ctype = res.headers.get('content-type') || '';
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
    let messages = [];
    if (ctype.includes('text/event-stream')) {
      for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('data:')) {
          try { messages.push(JSON.parse(line.slice(5).trim())); } catch { /* keepalive */ }
        }
      }
    } else if (text.trim()) {
      messages.push(JSON.parse(text));
    }
    const reply = messages.find((m) => m.id === body.id);
    if (!reply) throw new Error('MCP: no reply for request id ' + body.id);
    if (reply.error) throw new Error('MCP error: ' + JSON.stringify(reply.error).slice(0, 300));
    return reply.result;
  }

  async #handshake() {
    const result = await this.#post({
      jsonrpc: '2.0', id: this.nextId++, method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'figma-to-eds', version: '1.0.0' },
      },
    });
    this.protocolVersion = result.protocolVersion || '2025-03-26';
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { expectResult: false });
    const list = await this.#post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/list' });
    this.tools = (list.tools || []).map((t) => t.name);
    this.available = true;
    log.info(`MCP connected (${this.url}): ${result.serverInfo?.name || 'unknown'} | tools: ${this.tools.join(', ')}`);
  }

  async connect() {
    const LOCAL_DEFAULT = 'http://127.0.0.1:3845/mcp';
    const candidates = [this.url];
    if (this.url !== LOCAL_DEFAULT) candidates.push(LOCAL_DEFAULT); // remote (OAuth-only) -> local Dev Mode fallback
    for (const url of candidates) {
      this.url = url;
      this.sessionId = null;
      try {
        await this.#handshake();
        return true;
      } catch (err) {
        log.warn(`Figma MCP at ${url} not available (${err.message}).`);
      }
    }
    log.warn('No Figma MCP server reachable — continuing with REST-only extraction.');
    this.available = false;
    return false;
  }

  async callTool(name, args) {
    if (!this.available || !this.tools.includes(name)) return null;
    try {
      const result = await this.#post({
        jsonrpc: '2.0', id: this.nextId++, method: 'tools/call',
        params: { name, arguments: args },
      });
      return result;
    } catch (err) {
      log.warn(`MCP tool ${name} failed: ${err.message}`);
      return null;
    }
  }

  // Returns concatenated text content of a tool result
  static textOf(result) {
    if (!result || !Array.isArray(result.content)) return '';
    return result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  }

  async getDesignContext(nodeId) {
    const result = await this.callTool('get_design_context', {
      nodeId,
      clientLanguages: 'html,css,javascript',
      clientFrameworks: 'bootstrap',
      artifactType: 'WEB_PAGE_OR_APP_SCREEN',
      taskType: 'CREATE_ARTIFACT',
      forceCode: true,
    });
    return FigmaMcp.textOf(result) || null;
  }

  async getVariableDefs(nodeId) {
    const result = await this.callTool('get_variable_defs', { nodeId });
    return FigmaMcp.textOf(result) || null;
  }

  async getScreenshot(nodeId) {
    const result = await this.callTool('get_screenshot', { nodeId });
    if (!result || !Array.isArray(result.content)) return null;
    const img = result.content.find((c) => c.type === 'image');
    return img ? { data: img.data, mediaType: img.mimeType || 'image/png' } : null;
  }
}
