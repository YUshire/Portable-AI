import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { LocalRuntime } from './lib/local-runtime.mjs';
import { bundleInfo } from './lib/model-store.mjs';
import { unseal } from './lib/vault.mjs';
import { requestJson, endpoint } from './lib/providers.mjs';
import { agentTools, WorkspaceTools } from './lib/agent-tools.mjs';
import { createAgentRouter } from './lib/agent-provider.mjs';
import { initialState, runAgent } from './lib/agent-loop.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const {values:options}=parseArgs({options:{workspace:{type:'string',short:'w'},task:{type:'string',short:'t'},resume:{type:'string'},offline:{type:'boolean'},usb:{type:'boolean'},'prefer-usb':{type:'boolean'},host:{type:'boolean'},'allow-commands':{type:'boolean'},'max-steps':{type:'string',default:'16'},'local-protocol':{type:'string',default:'auto'},'local-model':{type:'string'},'api-base':{type:'string'},model:{type:'string'},provider:{type:'string'},doctor:{type:'boolean'},help:{type:'boolean',short:'h'}}});
if(options.help){console.log(`PortableAI coding agent 0.2.0
node cli.mjs --workspace <project> --task <request>
  --offline                   Skip cloud APIs
  --usb                       Skip cloud and host Ollama; use USB model
  --prefer-usb                Use USB model when falling back from cloud
  --host                      Prefer host Ollama instead of saved USB preference
  --local-model <name>         Select host model
  --local-protocol auto|native|json
  --api-base <url> --model <id> --provider anthropic|compatible
  --allow-commands             Authorize command execution in this session
  --max-steps <1..100>         Limit model iterations (default 16)
  --resume <session-id>        Continue a recorded session
  --doctor                    Inspect runtime and model capabilities
Cloud key: PORTABLE_API_KEY, or unlock the encrypted USB vault interactively.
Commands run with host permissions; workspace restrictions apply to file tools.
Press Ctrl+C to cancel. No npm installation is required.`);process.exit(0);}

const maxSteps=Number(options['max-steps']);
if(!Number.isInteger(maxSteps)||maxSteps<1||maxSteps>100) throw new Error('--max-steps 必须在 1 到 100 之间');
if(!['auto','native','json'].includes(options['local-protocol'])) throw new Error('--local-protocol 只支持 auto/native/json');
if((options.usb||options['prefer-usb'])&&options.host) throw new Error('--usb/--prefer-usb 与 --host 不能同时使用');
const controller=new AbortController();
const abort=()=>{if(!controller.signal.aborted) controller.abort(new Error('用户已取消任务'));};
process.once('SIGINT',abort);process.once('SIGTERM',abort);
let rl;
const ask=async prompt=>{if(!process.stdin.isTTY) throw new Error('非交互运行需显式提供参数');rl ||= readline.createInterface({input:process.stdin,output:process.stdout});rl.on('SIGINT',abort);return rl.question(prompt,{signal:controller.signal});};
async function secret(prompt){
  if(!process.stdin.isTTY) throw new Error('需要 API 密钥，请设置 PORTABLE_API_KEY 或在终端解锁密钥');
  process.stdout.write(prompt);
  const hidden=new Writable({write(chunk,encoding,done){done();}});
  const reader=readline.createInterface({input:process.stdin,output:hidden,terminal:true}); reader.on('SIGINT',abort);
  try{return await reader.question('',{signal:controller.signal});} finally{reader.close();process.stdout.write('\n');}
}
let config={provider:'anthropic',baseUrl:'https://api.anthropic.com/v1',model:'',cloudEnabled:false,autoFallback:true,localModel:''};
try {config={...config,...JSON.parse(await fs.readFile(path.join(root,'data','config.json'),'utf8'))};}catch(e){if(e.code!=='ENOENT')throw new Error('连接配置无法读取，请先在聊天界面保存有效配置');}
if(options['api-base']){config.baseUrl=options['api-base'];config.cloudEnabled=true;}
if(options.model){config.model=options.model;config.cloudEnabled=true;}
if(options.provider)config.provider=options.provider;
if(options['local-model']){config.localModel=options['local-model'];config.preferPortable=false;}
if(options.host)config.preferPortable=false;
if(options['prefer-usb'])config.preferPortable=true;
let local,state,sessionFile,diffFile;
const event=e=>{
  if(e.type==='fallback')console.log(`[降级] ${e.reason}`);
  if(e.type==='model')console.log(`[第 ${e.step} 轮 · ${e.backend} · ${e.model}${e.protocol?' · '+e.protocol:''}]${e.text?'\n'+e.text:''}`);
  if(e.type==='tool-start')console.log(`[工具] ${e.name} ${JSON.stringify(e.arguments).slice(0,240)}`);
  if(e.type==='file-change')console.log(`[修改] ${e.path} ${e.beforeBytes} → ${e.afterBytes} 字节`);
  if(e.type==='tool-result')console.log(`[结果${e.error?' · 错误':''}] ${JSON.stringify(e.result).slice(0,1500)}`);
};
try{
  local=new LocalRuntime(root,value=>console.log(`[本地] ${value}`));
  if(options.doctor){
    const models=await local.existing();const capabilities=[];
    for(const m of models){try {const info=await requestJson('http://127.0.0.1:11434/api/show',{model:m.name},{},3000);capabilities.push({name:m.name,capabilities:info.capabilities,remote:!!(info.remote_host||info.remote_model)});}catch{capabilities.push({name:m.name,error:'无法读取能力'});}}
    console.log(JSON.stringify({version:'0.2.0',platform:process.platform,arch:process.arch,node:process.version,memoryGB:Math.round(os.totalmem()/1e9),bundle:await bundleInfo(path.join(root,'models')),hostModels:capabilities,cloudEnabled:config.cloudEnabled,keyInEnvironment:!!process.env.PORTABLE_API_KEY,commandApproval:'terminal confirmation unless --allow-commands'},null,2));
  }else{
    const sessionDir=path.join(root,'data','agent-sessions');await fs.mkdir(sessionDir,{recursive:true});
    const sessionId=options.resume || new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(4).toString('hex');
    if(!/^[A-Za-z0-9_-]{1,100}$/.test(sessionId))throw new Error('会话 ID 无效');
    sessionFile=path.join(sessionDir,sessionId+'.json');diffFile=path.join(sessionDir,sessionId+'.diff');
    if(options.resume){state=JSON.parse(await fs.readFile(sessionFile,'utf8'));if(state.version!==1||!Array.isArray(state.history))throw new Error('会话格式不支持');}
    const workspace=await fs.realpath(options.workspace || state?.workspace || process.cwd());
    if(state && state.workspace!==workspace)throw new Error('恢复会话必须使用原项目目录');
    if(!state)state=initialState(workspace);
    let key=process.env.PORTABLE_API_KEY || '';
    if(!options.offline&&!options.usb&&config.cloudEnabled&&!key){
      try {const vault=JSON.parse(await fs.readFile(path.join(root,'data','key.enc.json'),'utf8'));key=unseal(vault,process.env.PORTABLE_VAULT_PASSWORD || await secret('解锁密钥密码（不显示）：'));}
      catch(e){if(e.code!=='ENOENT'){if(!config.autoFallback)throw e;console.log(`[密钥未解锁] ${e.message}，按设置降级`);}}
      if(!key&&process.stdin.isTTY)key=await secret('API 密钥（留空按设置降级）：');
    }
    const tools=new WorkspaceTools(workspace,{signal:controller.signal,changes:state.changes,onEvent:event,approve:async command=>{
      if(options['allow-commands'])return true;
      if(!process.stdin.isTTY)return false;
      console.log(`即将执行：${command.command} ${command.args.map(a=>JSON.stringify(a)).join(' ')}\n目录：${workspace}`);
      return /^(y|yes)$/i.test((await ask('执行此命令？[y/N] ')).trim());
    }});await tools.init();
    const request=createAgentRouter({config,key,local,tools:agentTools,offline:!!options.offline||!!options.usb,portableOnly:!!options.usb,protocol:options['local-protocol'],signal:controller.signal,onEvent:event});
    const save=async value=>{const temp=sessionFile+'.tmp';await fs.writeFile(temp,JSON.stringify(value,null,2),'utf8');await fs.rename(temp,sessionFile);};
    const task=options.task || (!options.resume?await ask('任务： '):'');
    if(!task.trim()&&!options.resume)throw new Error('任务不能为空');
    console.log(`项目：${workspace}\n会话：${sessionId}\n命令权限：${options['allow-commands']?'本次已授权':'逐条确认'}`);
    try{
      await runAgent({state,task,request,tools,maxSteps,signal:controller.signal,onEvent:event,save});
      console.log(`状态：${state.status}\n${state.summary || ''}`);
      if(state.status!=='completed')process.exitCode=2;
    }finally{await fs.writeFile(diffFile,tools.diff(),'utf8');console.log(`会话记录：${sessionFile}\n文件差异：${diffFile}`);}
  }
}catch(error){console.error(error.message);process.exitCode=controller.signal.aborted?130:1;}
finally{rl?.close();await local?.stop();process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
