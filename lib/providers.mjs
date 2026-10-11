export class ProviderError extends Error {
  constructor(message, recoverable = false, status = 0) { super(message); this.recoverable = recoverable; this.status = status; }
}
export function endpoint(base, suffix) { return base.replace(/\/+$/, '') + suffix; }
export async function requestJson(url, body, headers = {}, timeout = 20000, signal) {
  let response;
  try {
    response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
  } catch { if (signal?.aborted) throw signal.reason || new Error('任务已取消'); throw new ProviderError('服务连接失败或超时', true); }
  if (!response.ok) {
    const recoverable = [408, 429].includes(response.status) || response.status >= 500;
    const reason = response.status === 401 || response.status === 403 ? '密钥无效或没有访问权限，请检查 API 配置' : response.status === 402 ? '账户余额不足，请检查 API 账户' : `服务返回 HTTP ${response.status}`;
    // Do not echo upstream bodies: some gateways include credentials in errors.
    throw new ProviderError(reason, recoverable, response.status);
  }
  try { return await response.json(); } catch { throw new ProviderError('服务返回了无效的 JSON'); }
}
export function validateCloud(config) {
  if (!['anthropic', 'compatible'].includes(config.provider)) throw new Error('不支持的 API 类型');
  const url = new URL(config.baseUrl);
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含密码、查询参数或片段');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('云端 API 必须使用 HTTPS');
  if (!config.model?.trim()) throw new Error('请填写云端模型名称');
}
export async function cloudChat(config, key, messages) {
  validateCloud(config);
  if (!key) throw new ProviderError('请填写 API 密钥');
  let data;
  if (config.provider === 'anthropic') {
    data = await requestJson(endpoint(config.baseUrl, '/messages'), { model: config.model, max_tokens: 2048, messages }, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, config.cloudTimeoutMs || 20000);
    const text = data.content?.filter(x => x.type === 'text').map(x => x.text).join('\n');
    if (!text) throw new ProviderError('云端模型没有返回文本');
    return text;
  }
  data = await requestJson(endpoint(config.baseUrl, '/chat/completions'), { model: config.model, messages, stream: false }, { Authorization: `Bearer ${key}` }, config.cloudTimeoutMs || 20000);
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text) throw new ProviderError('云端模型没有返回文本');
  return text;
}
export async function routeChat({ config, key, messages, local, offline = false }) {
  if (!offline && config.cloudEnabled) {
    try { return { text: await cloudChat(config, key, messages), backend: 'cloud', model: config.model }; }
    catch (error) {
      if (!config.autoFallback) throw error;
      let result;
      try { result = await local(messages); }
      catch (localError) { throw new Error(`云端调用失败：${error.message}；本地降级失败：${localError.message}`); }
      return { ...result, fallbackReason: error.message };
    }
  }
  return local(messages);
}
