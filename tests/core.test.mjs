import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { cloudChat, routeChat } from '../lib/providers.mjs';
import { packModel, restoreModel, prepareModel, bundleInfo, inside } from '../lib/model-store.mjs';
import { LocalRuntime } from '../lib/local-runtime.mjs';
import { seal, unseal } from '../lib/vault.mjs';
const messages = [{ role: 'user', content: 'hello' }];
test('model paths support drive roots and reject traversal', () => {
  const root = path.parse(process.cwd()).root;
  assert.equal(inside(root, 'blobs/model'), path.join(root, 'blobs', 'model'));
  assert.throws(() => inside(path.join(root, 'store'), '../outside'), /Invalid/);
});
async function mock(callback) {
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    callback(req, res, body ? JSON.parse(body) : null);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise(resolve => server.close(resolve)) };
}
test('compatible API forwards only correct auth and retains conversation', async () => {
  const fixture = await mock((req, res, body) => {
    assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer test-secret');
    assert.deepEqual(body.messages, messages); assert.equal(body.model, 'test-model');
    res.end(JSON.stringify({ choices: [{ message: { content: 'cloud-ok' } }] }));
  });
  try { assert.equal(await cloudChat({ provider: 'compatible', baseUrl: fixture.baseUrl, model: 'test-model' }, 'test-secret', messages), 'cloud-ok'); }
  finally { await fixture.close(); }
});
test('Anthropic adapter uses messages endpoint, API key and version header', async () => {
  const fixture = await mock((req, res, body) => {
    assert.equal(req.url, '/v1/messages'); assert.equal(req.headers['x-api-key'], 'test-secret'); assert.equal(req.headers['anthropic-version'], '2023-06-01');
    assert.equal(body.max_tokens, 2048); res.end(JSON.stringify({ content: [{ type: 'text', text: 'claude-ok' }] }));
  });
  try { assert.equal(await cloudChat({ provider: 'anthropic', baseUrl: fixture.baseUrl, model: 'test-model' }, 'test-secret', messages), 'claude-ok'); }
  finally { await fixture.close(); }
});
test('server outage automatically falls back and preserves the conversation', async () => {
  const fixture = await mock((req, res) => { res.writeHead(503); res.end('upstream-secret-must-not-appear'); });
  let calls = 0;
  try {
    const result = await routeChat({ config: { provider: 'compatible', baseUrl: fixture.baseUrl, model: 'test', cloudEnabled: true, autoFallback: true }, key: 'test', messages, local: async history => { calls++; assert.deepEqual(history, messages); return { text: 'offline-ok', backend: 'usb-local' }; } });
    assert.equal(calls, 1); assert.equal(result.backend, 'usb-local'); assert.match(result.fallbackReason, /503/); assert.doesNotMatch(result.fallbackReason, /secret/);
  } finally { await fixture.close(); }
});
test('bad API key falls back with a visible reason when enabled', async () => {
  const fixture = await mock((req, res) => { res.writeHead(401); res.end(); });
  try {
    const config = { provider: 'compatible', baseUrl: fixture.baseUrl, model: 'test', cloudEnabled: true, autoFallback: true };
    const result = await routeChat({ config, key: 'bad', messages, local: async () => ({ text: 'local', backend: 'usb-local' }) });
    assert.equal(result.backend, 'usb-local'); assert.match(result.fallbackReason, /密钥/);
    await assert.rejects(routeChat({ config: { ...config, autoFallback: false }, key: 'bad', messages, local: async () => assert.fail('must not call local') }), /密钥/);
  }
  finally { await fixture.close(); }
});
test('cloud success takes priority and never prepares local models', async () => {
  const fixture = await mock((req, res) => res.end(JSON.stringify({ choices: [{ message: { content: 'cloud' } }] })));
  try {
    const result = await routeChat({ config: { provider: 'compatible', baseUrl: fixture.baseUrl, model: 'test', cloudEnabled: true, autoFallback: true }, key: 'test', messages, local: async () => assert.fail('must not call local') });
    assert.equal(result.backend, 'cloud');
  } finally { await fixture.close(); }
});
test('all unsuccessful cloud replies can fall back with reasons', async () => {
  for (const status of [400, 402, 403, 404, 408, 429, 500]) {
    const fixture = await mock((req, res) => { res.writeHead(status); res.end(); });
    try {
      const result = await routeChat({ config: { provider: 'compatible', baseUrl: fixture.baseUrl, model: 'test', cloudEnabled: true, autoFallback: true }, key: 'test', messages, local: async () => ({ text: 'fallback', backend: 'usb-local' }) });
      assert.equal(result.backend, 'usb-local'); assert.ok(result.fallbackReason);
    } finally { await fixture.close(); }
  }
});
test('missing API key falls back and combined failure reports both causes', async () => {
  const config = { provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'test', cloudEnabled: true, autoFallback: true };
  const result = await routeChat({ config, key: '', messages, local: async () => ({ text: 'local' }) });
  assert.match(result.fallbackReason, /密钥/);
  await assert.rejects(routeChat({ config, key: '', messages, local: async () => { throw new Error('no model'); } }), /云端调用失败.*本地降级失败.*no model/);
});
test('portable preference bypasses host discovery and automatic host choice skips embeddings', async () => {
  const runtime = new LocalRuntime(process.cwd());
  runtime.existing = async () => [{name:'embedding'}, {name:'someone-else-model'}];
  runtime.usable = async (base, model) => model !== 'embedding';
  runtime.startPortable = async () => ({model:'usb-custom',backend:'usb-local'});
  assert.equal((await runtime.choose({localModel:''})).model, 'someone-else-model');
  assert.equal((await runtime.choose({localModel:'missing'}, true)).model, 'usb-custom');
});
test('direct model storage uses USB weights and does not create a computer model cache', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-direct-test-'));
  try {
    const source = path.join(temp, 'source'), store = path.join(temp, 'store'), cache = path.join(temp, 'unused-cache');
    await fs.mkdir(path.join(source, 'blobs'), {recursive:true}); await fs.mkdir(path.join(source, 'manifests'), {recursive:true});
    const data = crypto.randomBytes(4096), digest = crypto.createHash('sha256').update(data).digest('hex');
    await fs.writeFile(path.join(source, 'blobs', `sha256-${digest}`), data);
    await fs.writeFile(path.join(source, 'manifests', 'custom'), JSON.stringify({config:{digest:`sha256:${digest}`,size:data.length},layers:[]}));
    await packModel(source, 'manifests/custom', store, 'other-person-model:latest', 512, 'direct');
    assert.deepEqual(await bundleInfo(store), {model:'other-person-model:latest',bytes:4096,storage:'direct'});
    assert.deepEqual(await prepareModel(store, cache), {model:'other-person-model:latest',modelsRoot:store});
    await assert.rejects(fs.stat(cache), {code:'ENOENT'});
    await fs.writeFile(path.join(store, 'blobs', `sha256-${digest}`), Buffer.alloc(4096));
    await assert.rejects(prepareModel(store, cache), /校验/);
  } finally { await fs.rm(temp, {recursive:true,force:true}); }
});
test('forced offline mode never sends a cloud request', async () => {
  const result = await routeChat({ config: { cloudEnabled: true }, offline: true, messages, local: async () => ({ text: 'local', backend: 'host-local' }) });
  assert.equal(result.backend, 'host-local');
});
test('encrypted key vault detects wrong password and ciphertext tampering', () => {
  const vault = seal('private-api-key', 'password-123');
  assert.equal(unseal(vault, 'password-123'), 'private-api-key');
  assert.ok(!JSON.stringify(vault).includes('private-api-key'));
  assert.throws(() => unseal(vault, 'wrong-password'), /密码/);
  assert.throws(() => unseal({ ...vault, data: Buffer.from('tampered').toString('base64') }, 'password-123'), /密码/);
});
test('FAT32-style chunks restore exactly and corrupted parts are rejected', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-test-'));
  try {
    const source = path.join(temp, 'source'), store = path.join(temp, 'store'), cache = path.join(temp, 'cache');
    await fs.mkdir(path.join(source, 'blobs'), { recursive: true });
    await fs.mkdir(path.join(source, 'manifests'), { recursive: true });
    const data = crypto.randomBytes(1800), digest = crypto.createHash('sha256').update(data).digest('hex');
    await fs.writeFile(path.join(source, 'blobs', `sha256-${digest}`), data);
    await fs.writeFile(path.join(source, 'manifests', 'test'), JSON.stringify({ config: { digest: `sha256:${digest}`, size: data.length }, layers: [] }));
    const catalog = await packModel(source, 'manifests/test', store, 'test:latest', 512);
    assert.equal(catalog.files[0].parts.length, 4);
    assert.equal(await restoreModel(store, cache), 'test:latest');
    assert.deepEqual(await fs.readFile(path.join(cache, 'blobs', `sha256-${digest}`)), data);
    await fs.writeFile(path.join(store, catalog.files[0].parts[0].path), Buffer.alloc(512));
    // Timestamp changes must reuse a valid cache even when the USB parts are
    // temporarily unavailable or corrupted, rather than copying them again.
    await fs.utimes(path.join(cache, 'blobs', `sha256-${digest}`), new Date(), new Date(Date.now() + 5000));
    assert.equal(await restoreModel(store, cache), 'test:latest');
    await assert.rejects(restoreModel(store, path.join(temp, 'new-cache')), /校验/);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
