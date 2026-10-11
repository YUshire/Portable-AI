import fs from 'node:fs/promises';
import http from 'node:http';
const [base, reportPath, mode = 'host'] = process.argv.slice(2);
if (!base || !reportPath) throw new Error('Usage: smoke-test.mjs <local-url> <report-path> [host|portable]');
const page = await (await fetch(base)).text();
const token = page.match(/name="portable-token" content="([a-f0-9]+)"/)?.[1];
if (!token) throw new Error('Page token missing');
async function api(name, data) {
  const response = await fetch(`${base}/api/${name}`, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Portable-Token': token }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error); return result;
}
const report = { mode, startedAt: new Date().toISOString(), checks: [] };
const status = await api('status');
if (status.keyReady || status.keySaved) throw new Error('Run smoke tests in a disposable instance without personal API keys');
report.system = status.system;
const denied = await fetch(`${base}/api/status`);
if (denied.status !== 403) throw new Error('Unauthenticated API was not blocked');
report.checks.push({ name: 'request-token', passed: true });
const crossOrigin = await fetch(`${base}/api/status`, { headers: { 'X-Portable-Token': token, Origin: 'https://untrusted.example' } });
if (crossOrigin.status !== 403) throw new Error('Cross-origin request was not blocked');
report.checks.push({ name: 'cross-origin', passed: true });
const started = Date.now();
const local = await api('chat', { offline: true, portableOnly: mode === 'portable', messages: [{ role: 'user', content: '这是运行测试，请只回复一句中文介绍。' }] });
if (!local.text || local.backend !== (mode === 'portable' ? 'usb-local' : 'host-local')) throw new Error('Wrong local backend');
report.checks.push({ name: 'real-local-generation', passed: true, backend: local.backend, model: local.model, response: local.text, seconds: (Date.now() - started) / 1000 });
console.log(`Real local generation passed: ${local.backend}`);
{
  const mock = http.createServer((req, res) => { res.writeHead(503); res.end('test outage'); });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  try {
    await api('settings', { ...status.config, preferPortable: mode === 'portable', provider: 'compatible', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model: 'test-only', apiKey: 'test-only-not-a-real-key', cloudEnabled: true, autoFallback: true });
    const fallback = await api('chat', { messages: [{ role: 'user', content: '这是自动切换测试，请简短回复收到。' }] });
    if (fallback.backend !== (mode === 'portable' ? 'usb-local' : 'host-local') || !fallback.fallbackReason) throw new Error('Real automatic fallback failed');
    report.checks.push({ name: 'outage-to-real-local', passed: true, backend: fallback.backend, reason: fallback.fallbackReason });
    console.log('API outage -> real local model passed.');
  } finally {
    await new Promise(resolve => mock.close(resolve));
    await api('settings', { ...status.config, keyAction: 'clear' });
  }
}
report.finishedAt = new Date().toISOString();
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(`Report saved: ${reportPath}`);
