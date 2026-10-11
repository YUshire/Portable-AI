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
import {createLifecycle} from './lib/lifecycle.mjs';
import {startSafeExit} from './lib/safe-exit.mjs';
import {openBrowser} from './lib/open-browser.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
await fs.promises.mkdir(dataDir, { recursive: true });
let closing=false,shutdownPromise;
const requestJobs=new Set(),abortController=new AbortController(),clients=new Map();
let closeTabTimer,parentWatch,clientWatch,sawClient=false,ready=false,stopRequested=false;
const lifecycle=await createLifecycle(root,'web',()=>{if(!ready){stopRequested=true;return;}return shutdown();});
let existingUrl;try{existingUrl=await lifecycle.browser();}catch(error){await lifecycle.close();throw error;}
if(existingUrl){await lifecycle.close();console.log(`PortableAI ${existingUrl}\n复用已有服务，没有启动第二套后台进程。`);if(process.argv.includes('--open')&&!process.argv.includes('--no-browser'))await openBrowser(existingUrl,root);process.exit(0);}
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
async function handleRequest(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const expectedHost = `127.0.0.1:${server.address().port}`;
  if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== `http://${expectedHost}`)) return json(res, 403, { error: '拒绝跨站请求' });
  const route = new URL(req.url, `http://${expectedHost}`).pathname;
  if(closing)return json(res,503,{error:'正在退出，请等待安全退出结果'});
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
    if(route==='/api/client'){
      if(typeof input.id!=='string'||!/^[-a-zA-Z0-9]{1,80}$/.test(input.id))throw new Error('客户端标识无效');
      sawClient=true;clearTimeout(closeTabTimer);closeTabTimer=undefined;
      if(input.closed)clients.delete(input.id);else clients.set(input.id,Date.now());
      if(process.argv.includes('--open')&&!clients.size)closeTabTimer=setTimeout(()=>{closeTabTimer=undefined;if(!clients.size)void shutdown();},3000);
      return json(res,200,{ok:true});
    }
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
      if(busy)return json(res,409,{error:'请等待当前任务结束'});
      await fs.promises.writeFile(path.join(dataDir, 'history.json'), '{"messages":[]}'); return json(res, 200, { ok: true });
    }
    if (route === '/api/chat') {
      if (busy) return json(res, 409, { error: '已有任务正在运行' });
      const messages = input.messages;
      if (!Array.isArray(messages) || !messages.length || messages.length > 100 || messages.some(m => !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 10000) || messages.at(-1).role !== 'user') throw new Error('对话格式无效，单条消息最多 10000 字符');
      busy = true; progress = input.offline ? '离线模式：准备本地模型' : '正在选择模型';
      try {
        await saveHistory({messages,interrupted:true});
        const result = await routeChat({ config, key: apiKey, messages, signal:abortController.signal,offline: !!input.offline || !!input.portableOnly, local: history => local.chat(config, history, !!input.portableOnly || config.preferPortable,abortController.signal) });
        await saveHistory({ messages: [...messages, { role: 'assistant', content: result.text }], lastBackend: result.backend });
        progress = '回复完成'; return json(res, 200, result);
      } finally { busy = false; }
    }
    if(route==='/api/eject'){const result=await startSafeExit(root);return json(res,202,{accepted:result.accepted,message:'正在保存、退出并请求 Windows 安全弹出，请等待系统结果窗口'});}
    if (route === '/api/shutdown') { json(res, 202, { accepted: true }); setImmediate(()=>void shutdown()); return; }
    return json(res, 404, { error: '未找到' });
  } catch (error) { progress = error.message; return json(res, 400, { error: error.message }); }
}
const server=http.createServer((req,res)=>{const job=handleRequest(req,res);requestJobs.add(job);job.catch(error=>{if(!res.headersSent)json(res,500,{error:error.message});}).finally(()=>requestJobs.delete(job));});
async function saveHistory(value){const file=path.join(dataDir,'history.json');await fs.promises.writeFile(file+'.tmp',JSON.stringify(value,null,2));await fs.promises.rename(file+'.tmp',file);}
function shutdown(){
  if(shutdownPromise)return shutdownPromise;
  closing=true;abortController.abort(new Error('用户退出，任务已取消'));clearTimeout(closeTabTimer);clearInterval(parentWatch);clearInterval(clientWatch);
  shutdownPromise=(async()=>{
    await Promise.allSettled([...requestJobs]);await local.stop();
    try{const service=JSON.parse(await fs.promises.readFile(path.join(dataDir,'service.json'),'utf8'));if(service.pid===process.pid)await fs.promises.unlink(path.join(dataDir,'service.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
    await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});await lifecycle.close();process.exit(0);
  })().catch(error=>{console.error('退出未完成：'+error.message);process.exitCode=1;});return shutdownPromise;
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
// If the launcher is terminated without sending SIGINT (for example the user
// closes its console), clean up the Ollama child instead of leaving it running.
const parentPid = process.ppid;
parentWatch = setInterval(() => { try { process.kill(parentPid, 0); } catch { shutdown(); } }, 5000);
parentWatch.unref();
clientWatch=setInterval(()=>{for(const [id,last]of clients)if(Date.now()-last>180000)clients.delete(id);if(process.argv.includes('--open')&&sawClient&&!clients.size&&!closeTabTimer)void shutdown();},5000);clientWatch.unref();
try{await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.PORTABLE_AI_PORT || 0), '127.0.0.1', resolve); });}
catch(error){await local.stop();await lifecycle.close();throw error;}
const url = `http://127.0.0.1:${server.address().port}`;
await fs.promises.writeFile(path.join(dataDir, 'service.json'), JSON.stringify({ url, pid: process.pid }));
await lifecycle.setUrl(url);
ready=true;if(stopRequested){await shutdown();}
console.log(`PortableAI ${url}\n只监听本机。关闭时点击“退出并安全弹出”，并等待系统确认。`);
if (process.argv.includes('--open')&&!process.argv.includes('--no-browser')) {
  try{await openBrowser(url,root);}catch(error){console.error(error.message);await shutdown();}
}
