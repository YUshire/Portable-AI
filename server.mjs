import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { LocalRuntime } from './lib/local-runtime.mjs';
import { routeChat, validateCloud } from './lib/providers.mjs';
import { seal, unseal } from './lib/vault.mjs';
import { bundleInfo } from './lib/model-store.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
await fs.promises.mkdir(dataDir, { recursive: true });
const configFile = path.join(dataDir, 'config.json'), vaultFile = path.join(dataDir, 'key.enc.json');
let config = { provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: '', cloudEnabled: false, autoFallback: true, localModel: '' };
try { config = { ...config, ...JSON.parse(await fs.promises.readFile(configFile, 'utf8')) }; } catch {}
let apiKey = '', progress = '就绪', busy = false;
const storageNotes=[];
const token = crypto.randomBytes(32).toString('hex');
const local = new LocalRuntime(root, value => { progress = value;if(/文件系统|单文件上限|完整权重|完整模型|缓存位置|转用电脑缓存|无法确认/.test(value)){storageNotes.push(value);if(storageNotes.length>6)storageNotes.shift();} });
const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
async function body(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 512 * 1024) throw new Error('请求过大'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const expectedHost = `127.0.0.1:${server.address().port}`;
  if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== `http://${expectedHost}`)) return json(res, 403, { error: '拒绝跨站请求' });
  const route = new URL(req.url, `http://${expectedHost}`).pathname;
  if (files[route] && req.method === 'GET') {
    let content = await fs.promises.readFile(path.join(root, 'web', files[route][0]), 'utf8');
    if (route === '/') content = content.replace('__TOKEN__', token);
    res.writeHead(200, { 'Content-Type': files[route][1], 'Cache-Control': 'no-store' }); return res.end(content);
  }
  if (!route.startsWith('/api/')) return json(res, 404, { error: '未找到' });
  if (req.headers['x-portable-token'] !== token) return json(res, 403, { error: '请从启动入口打开界面' });
  try {
    if (route === '/api/status' && req.method === 'GET') {
      const models = await local.existing();
      const bundle = await bundleInfo(path.join(root, 'models'));
      return json(res, 200, { config, keyReady: !!apiKey, keySaved: fs.existsSync(vaultFile), busy, progress, bundle, storageNotes, models: models.map(m => ({ name: m.name, size: m.size, family: m.details?.family })), system: { platform: process.platform, arch: process.arch, memoryGB: Math.round(os.totalmem() / 1024 ** 3), bundleReady: !!bundle } });
    }
    if (req.method !== 'POST') return json(res, 405, { error: '不支持的请求方法' });
    const input = await body(req);
    if (route === '/api/settings') {
      if (busy) return json(res, 409, { error: '请等待当前回复完成后修改配置' });
      const next = { provider: input.provider, baseUrl: String(input.baseUrl || '').trim(), model: String(input.model || '').trim(), cloudEnabled: !!input.cloudEnabled, autoFallback: !!input.autoFallback, localModel: String(input.localModel ?? config.localModel).trim(), preferPortable: !!input.preferPortable };
      if (next.cloudEnabled) validateCloud(next);
      if (input.keyAction === 'clear') { apiKey = ''; await fs.promises.rm(vaultFile, { force: true }); }
      else if (input.apiKey) {
        apiKey = String(input.apiKey).trim();
        if (input.saveEncrypted) await fs.promises.writeFile(vaultFile, JSON.stringify(seal(apiKey, String(input.password || ''))), { mode: 0o600 });
        else await fs.promises.rm(vaultFile, { force: true });
      }
      await fs.promises.writeFile(configFile, JSON.stringify(next, null, 2)); config = next;
      return json(res, 200, { ok: true, keyReady: !!apiKey });
    }
    if (route === '/api/unlock') {
      const vault = JSON.parse(await fs.promises.readFile(vaultFile, 'utf8'));
      apiKey = unseal(vault, String(input.password || ''));
      return json(res, 200, { ok: true });
    }
    if (route === '/api/history') {
      try { return json(res, 200, JSON.parse(await fs.promises.readFile(path.join(dataDir, 'history.json'), 'utf8'))); }
      catch { return json(res, 200, { messages: [] }); }
    }
    if (route === '/api/clear-history') {
      await fs.promises.writeFile(path.join(dataDir, 'history.json'), '{"messages":[]}'); return json(res, 200, { ok: true });
    }
    if (route === '/api/chat') {
      if (busy) return json(res, 409, { error: '已有任务正在运行' });
      const messages = input.messages;
      if (!Array.isArray(messages) || !messages.length || messages.length > 100 || messages.some(m => !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 10000) || messages.at(-1).role !== 'user') throw new Error('对话格式无效，单条消息最多 10000 字符');
      busy = true; progress = input.offline ? '离线模式：准备本地模型' : '正在选择模型';
      try {
        const result = await routeChat({ config, key: apiKey, messages, offline: !!input.offline || !!input.portableOnly, local: history => local.chat(config, history, !!input.portableOnly || config.preferPortable) });
        await fs.promises.writeFile(path.join(dataDir, 'history.json'), JSON.stringify({ messages: [...messages, { role: 'assistant', content: result.text }], lastBackend: result.backend }, null, 2));
        progress = '回复完成'; return json(res, 200, result);
      } finally { busy = false; }
    }
    if (route === '/api/shutdown') { json(res, 200, { ok: true }); setTimeout(shutdown, 150); return; }
    return json(res, 404, { error: '未找到' });
  } catch (error) { progress = error.message; return json(res, 400, { error: error.message }); }
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await local.stop();
  server.close();
  setTimeout(() => process.exit(0), 200).unref();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
// If the launcher is terminated without sending SIGINT (for example the user
// closes its console), clean up the Ollama child instead of leaving it running.
const parentPid = process.ppid;
const parentWatch = setInterval(() => { try { process.kill(parentPid, 0); } catch { shutdown(); } }, 5000);
parentWatch.unref();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.PORTABLE_AI_PORT || 0), '127.0.0.1', resolve); });
const url = `http://127.0.0.1:${server.address().port}`;
await fs.promises.writeFile(path.join(dataDir, 'service.json'), JSON.stringify({ url, pid: process.pid }));
console.log(`PortableAI ${url}\n只监听本机。首次 API 配置在界面中完成。关闭时点击“退出并清理”。`);
if (process.argv.includes('--open')) {
  if (process.platform === 'win32') spawn('explorer.exe', [url], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' }).on('error', () => {});
}
