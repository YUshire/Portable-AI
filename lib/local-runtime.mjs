import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { requestJson, endpoint } from './providers.mjs';
import { prepareModel } from './model-store.mjs';

export class LocalRuntime {
  constructor(root, progress = () => {}) {
    this.root = root; this.progress = progress; this.child = null;
    this.cacheRoot = process.env.PORTABLE_AI_CACHE || path.join(process.env.LOCALAPPDATA || os.homedir(), 'PortableAI', 'models');
  }
  async existing() {
    try {
      const tags = await requestJson('http://127.0.0.1:11434/api/tags', undefined, {}, 1500);
      return tags.models || [];
    } catch { return []; }
  }
  async usable(base, model) {
    try {
      const info = await requestJson(endpoint(base, '/api/show'), { model }, {}, 3000);
      return !info.remote_host && !info.remote_model && (!info.capabilities || info.capabilities.includes('completion'));
    } catch { return false; }
  }
  async choose(config, portableOnly = false) {
    if (!portableOnly) {
      const models = await this.existing();
      const candidates = config.localModel ? models.filter(m => m.name === config.localModel) : models;
      for (const candidate of candidates) {
        if (await this.usable('http://127.0.0.1:11434', candidate.name)) return { base: 'http://127.0.0.1:11434', model: candidate.name, backend: 'host-local' };
      }
    }
    if (!this.starting) this.starting = this.startPortable().catch(async error => { await this.stop(); throw error; });
    return this.starting;
  }
  async startPortable() {
    const binary = path.join(this.root, 'runtime', 'ollama', process.platform === 'win32' ? 'ollama.exe' : 'ollama');
    if (!fs.existsSync(binary)) throw new Error('未找到此系统的便携 Ollama，请使用对应系统的运行包');
    const { model, modelsRoot } = await prepareModel(path.join(this.root, 'models'), this.cacheRoot, this.progress);
    this.progress('正在启动随盘 Ollama，首次加载运行库可能需要等待');
    const probe = net.createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    const logDir = path.join(this.root, 'data');
    await fs.promises.mkdir(logDir, { recursive: true });
    const log = fs.openSync(path.join(logDir, 'ollama.log'), 'a');
    this.child = spawn(binary, ['serve'], { cwd: path.dirname(binary), windowsHide: true, env: { ...process.env, OLLAMA_MODELS: modelsRoot, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_NO_CLOUD: '1', OLLAMA_CONTEXT_LENGTH: '4096', OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_NUM_PARALLEL: '1' }, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    let failure = null;
    this.child.once('error', error => { failure = error; });
    for (let count = 0; count < 60; count++) {
      if (failure || this.child.exitCode !== null) throw new Error('便携 Ollama 启动失败，请查看 data/ollama.log');
      try {
        const tags = await requestJson(endpoint(base, '/api/tags'), undefined, {}, 1000);
        if (tags.models?.some(m => m.name === model)) { this.progress('便携 Ollama 已就绪'); return { base, model, backend: 'usb-local' }; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    await this.stop();
    throw new Error('便携 Ollama 未能及时就绪');
  }
  async chat(config, messages, portableOnly = false) {
    const target = await this.choose(config, portableOnly);
    // Keep local context within a realistic 16 GB / 7B budget. Trim old turns
    // as whole user/assistant pairs; preserve the newest user input.
    let history = messages.slice(-9);
    if (history[0]?.role === 'assistant') history.shift();
    while (history.length > 1 && history.reduce((n, m) => n + m.content.length, 0) > 10000) history.splice(0, 2);
    this.progress(`正在调用本地模型 ${target.model}`);
    const data = await requestJson(endpoint(target.base, '/api/chat'), { model: target.model, messages: history, stream: false, keep_alive: '2m', options: { num_ctx: 4096, num_predict: 1024 } }, {}, 240000);
    if (!data.message?.content) throw new Error('本地模型没有返回文本');
    this.progress('本地回复完成');
    return { text: data.message.content, backend: target.backend, model: target.model, contextTrimmed: history.length !== messages.length };
  }
  async stop() {
    if (this.child) {
      // Terminate only the owned process tree, never a user's existing Ollama.
      if (process.platform === 'win32' && this.child.pid) {
        const pid = this.child.pid;
        await new Promise(resolve => {
          const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('close', resolve); killer.once('error', resolve);
        });
      } else this.child.kill();
      this.child = null;
    }
    this.starting = null;
  }
}
