import { validateCloud } from './providers.mjs';

export async function setupConnection({config,key='',ask,secret,saveConfig,saveKey,unlockSaved=async()=>'',configureOnly=false}) {
  const current=config.cloudEnabled?'云端优先':config.preferPortable?'U 盘模型':'电脑本地模型';
  const selection=configureOnly?'1':(await ask(`\n选择模型连接：\n  1. 配置云端 API（优先调用云端）\n  2. 仅用 U 盘模型\n  3. 仅用电脑本地模型\n  4. 使用已保存设置（${current}）\n请选择 [1]： `)).trim() || '1';
  if(selection==='2')return {config:{...config,hostOnly:false,preferPortable:true},key,offline:true,portableOnly:true};
  if(selection==='3')return {config:{...config,preferPortable:false,hostOnly:true},key,offline:true,portableOnly:false};
  if(selection==='4')return {config:{...config,hostOnly:false},key,offline:false,portableOnly:false};
  if(selection!=='1')throw new Error('请选择 1、2、3 或 4');
  const previous=config.provider==='compatible'?'2':'1';
  const type=(await ask(`接口类型：1 Claude / Anthropic，2 兼容 Chat Completions [${previous}]： `)).trim() || previous;
  if(!['1','2'].includes(type))throw new Error('接口类型只支持 1 或 2');
  const provider=type==='1'?'anthropic':'compatible';
  const defaultBase=provider===config.provider?config.baseUrl:(provider==='anthropic'?'https://api.anthropic.com/v1':'');
  const baseUrl=(await ask(`API 基础地址${defaultBase?' ['+defaultBase+']':''}： `)).trim() || defaultBase;
  const model=(await ask(`云端模型 ID${config.model?' ['+config.model+']':''}： `)).trim() || config.model;
  const next={...config,provider,baseUrl,model,cloudEnabled:true,hostOnly:false};validateCloud(next);
  const entered=(await secret(key?'API 密钥（不显示，留空保留本次密钥）： ':'API 密钥（不显示；留空尝试解锁已保存密钥）： ')).trim();
  key=entered || key || await unlockSaved();
  if(!key)throw new Error('没有 API 密钥，云端配置未完成；不会开始还原本地模型');
  next.autoFallback=!/^(n|no)$/i.test((await ask('云端失败时自动降级本地？[Y/n]： ')).trim());
  if(next.autoFallback){const fallback=(await ask('降级模型：1 U 盘模型，2 电脑本地模型 [1]： ')).trim() || '1';if(!['1','2'].includes(fallback))throw new Error('降级模型只支持 1 或 2');next.preferPortable=fallback==='1';}
  const encrypted=/^(y|yes)$/i.test((await ask('用密码加密保存密钥到 U 盘？[y/N]（不保存则仅本次有效）： ')).trim());
  if(encrypted){const password=await secret('加密密码（至少 8 个字符，不显示）： ');await saveKey(key,password);}
  await saveConfig(next);
  return {config:next,key,offline:false,portableOnly:false};
}
