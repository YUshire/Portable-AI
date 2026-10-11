const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name=portable-token]').content;
let messages = [], busy = false;
async function api(route, data) {
  const res = await fetch(`/api/${route}`, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Portable-Token': token }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await res.json(); if (!res.ok) throw new Error(result.error || '请求失败'); return result;
}
function render() {
  $('messages').replaceChildren();
  if (!messages.length) {
    const note = document.createElement('p'); note.className = 'hint'; note.textContent = '新对话已准备就绪。可以测试本地模型，或填写云端 API 配置。';
    $('messages').append(note); return;
  }
  for (const message of messages) {
    const box = document.createElement('div'); box.className = `message ${message.role}`;
    const label = document.createElement('small'); label.textContent = message.role === 'user' ? '你' : '模型回复';
    const text = document.createElement('div'); text.textContent = message.content;
    box.append(label, text); $('messages').append(box);
  }
  $('messages').scrollTop = $('messages').scrollHeight;
}
async function refresh(initial = false) {
  try {
    const status = await api('status');
    $('system').textContent = `${status.system.platform} / ${status.system.arch} · ${status.system.memoryGB} GB 内存\n电脑模型：${status.models.length} 个 · U 盘模型：${status.system.bundleReady ? '已携带' : '未导入'}`;
    $('system').style.whiteSpace = 'pre-line';
    const bundle = status.bundle;
    $('bundleHint').textContent = !bundle ? '未携带随盘模型。可使用电脑已有 Ollama，或自行导入一个聊天模型。' : bundle.storage === 'direct' ? `随盘模型：${bundle.model}（${(bundle.bytes / 1e9).toFixed(2)} GB）。完整权重直接从 U 盘读取，无需复制到电脑；速度取决于 U 盘。` : `随盘模型：${bundle.model}（${(bundle.bytes / 1e9).toFixed(2)} GB）。启动时自动检查文件系统和实际权重：优先直接读取，分块能在 U 盘合并就留在盘内；受文件大小、空间或写入条件限制时才使用电脑缓存。`;
    if(status.storageNotes?.length)$('bundleHint').textContent+=' 最近一次随盘存储判断：'+status.storageNotes.join('；');
    $('keyState').textContent = status.keyReady ? 'API 密钥已就绪（不会显示在界面中）' : status.keySaved ? '已有加密密钥，请输入密码解锁' : '未配置 API 密钥，可以直接测试本地模型';
    if (status.busy) $('progress').textContent = status.progress;
    $('send').disabled = busy || status.busy;
    if (initial) {
      for (const id of ['provider', 'baseUrl', 'model']) $(id).value = status.config[id];
      for (const id of ['cloudEnabled', 'autoFallback', 'preferPortable']) $(id).checked = !!status.config[id];
      const names = [...new Set([status.config.localModel, ...status.models.filter(m => m.family !== 'bert').map(m => m.name)])].filter(Boolean);
      const auto = document.createElement('option'); auto.value = ''; auto.textContent = '自动选择电脑聊天模型，缺失时使用随盘模型';
      $('localModel').replaceChildren(auto, ...names.map(name => { const option = document.createElement('option'); option.value = name; option.textContent = name; return option; }));
      $('localModel').value = status.config.localModel;
      $('route').textContent = status.config.cloudEnabled ? (status.config.autoFallback ? '云端优先 · 调用失败回退本地' : '云端 API · 自动降级已关闭') : '使用本地模型';
    }
  } catch { if (!busy) $('progress').textContent = '本机服务已停止，请重新启动'; }
}
$('provider').addEventListener('change', () => { $('baseUrl').value = $('provider').value === 'anthropic' ? 'https://api.anthropic.com/v1' : ''; });
$('settings').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const data = Object.fromEntries(['provider', 'baseUrl', 'model', 'apiKey', 'password', 'localModel'].map(id => [id, $(id).value]));
    for (const id of ['cloudEnabled', 'autoFallback', 'saveEncrypted', 'preferPortable']) data[id] = $(id).checked;
    await api('settings', data); $('apiKey').value = ''; $('password').value = ''; $('settingsNote').textContent = '连接设置已保存'; await refresh(true);
  } catch (error) { $('settingsNote').textContent = error.message; }
});
$('unlock').addEventListener('click', async () => { try { await api('unlock', { password: $('password').value }); $('password').value = ''; $('settingsNote').textContent = '密钥已解锁'; await refresh(); } catch (error) { $('settingsNote').textContent = error.message; } });
$('forgetKey').addEventListener('click', async () => {
  try { const status = await api('status'); await api('settings', { ...status.config, keyAction: 'clear' }); $('apiKey').value = ''; $('settingsNote').textContent = '密钥已清除'; await refresh(); } catch (error) { $('settingsNote').textContent = error.message; }
});
$('chat').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || $('send').disabled) return;
  const content = $('prompt').value.trim(); if (!content) return;
  const previous = [...messages]; messages.push({ role: 'user', content }); render();
  busy = true; $('send').disabled = true; $('prompt').value = ''; $('progress').textContent = '正在请求模型…';
  try {
    const result = await api('chat', { messages, offline: $('offline').checked || $('portableOnly').checked, portableOnly: $('portableOnly').checked });
    messages.push({ role: 'assistant', content: result.text }); render();
    const labels = { cloud: '云端 API', 'host-local': '电脑已有 Ollama', 'usb-local': 'U 盘独立模型' };
    $('route').textContent = `${labels[result.backend]} · ${result.model}`;
    $('progress').textContent = `${result.fallbackReason ? `已自动切换本地：${result.fallbackReason}。` : '回复完成。'}${result.contextTrimmed ? '本地模型已缩短较早的对话上下文。' : ''}`;
  } catch (error) { messages = previous; render(); $('prompt').value = content; $('progress').textContent = error.message; }
  finally { busy = false; $('send').disabled = false; }
});
$('prompt').addEventListener('keydown', event => { if (event.ctrlKey && event.key === 'Enter') $('chat').requestSubmit(); });
$('clear').addEventListener('click', async () => { if (busy) return; try { await api('clear-history', {}); messages = []; $('messages').replaceChildren(); $('progress').textContent = '新对话已开始'; } catch (error) { $('progress').textContent = error.message; } });
$('shutdown').addEventListener('click', async () => { if (busy && !confirm('当前请求尚未完成，确定退出？')) return; try { await api('shutdown', {}); $('progress').textContent = '服务已退出，可以安全弹出 U 盘'; $('send').disabled = true; clearInterval(timer); } catch (error) { $('progress').textContent = error.message; } });
await refresh(true);
try { messages = (await api('history', {})).messages || []; if (messages.length) render(); } catch {}
const timer = setInterval(() => refresh(), 2500);
