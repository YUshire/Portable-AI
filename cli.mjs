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
import { seal, unseal } from './lib/vault.mjs';
import { setupConnection } from './lib/connection-setup.mjs';
import { requestJson, endpoint } from './lib/providers.mjs';
import { agentTools, WorkspaceTools } from './lib/agent-tools.mjs';
import { createAgentRouter } from './lib/agent-provider.mjs';
import { initialState, runAgent } from './lib/agent-loop.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const {values:options}=parseArgs({options:{workspace:{type:'string',short:'w'},task:{type:'string',short:'t'},resume:{type:'string'},offline:{type:'boolean'},usb:{type:'boolean'},'prefer-usb':{type:'boolean'},host:{type:'boolean'},connect:{type:'boolean'},configure:{type:'boolean'},interactive:{type:'boolean'},plain:{type:'boolean'},'allow-commands':{type:'boolean'},'max-steps':{type:'string',default:'16'},'local-protocol':{type:'string',default:'auto'},'local-model':{type:'string'},'api-base':{type:'string'},model:{type:'string'},provider:{type:'string'},doctor:{type:'boolean'},help:{type:'boolean',short:'h'}}});
if(options.help){console.log(`PortableAI coding agent 0.3.3
node cli.mjs --workspace <project>       Persistent terminal workspace
node cli.mjs --workspace <project> --task <request>
  --interactive               Stay in the terminal after --task
  --plain                     Use the simple terminal instead of Ink
  --connect                   Choose cloud API or local model interactively
  --configure                 Configure and save cloud API, then exit
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
Press Esc/Ctrl+C to cancel a task; Ctrl+C while idle exits.
The complete USB package includes terminal dependencies; source checkout: npm ci.`);process.exit(0);}

const maxSteps=Number(options['max-steps']);
if(!Number.isInteger(maxSteps)||maxSteps<1||maxSteps>100) throw new Error('--max-steps 必须在 1 到 100 之间');
if(!['auto','native','json'].includes(options['local-protocol'])) throw new Error('--local-protocol 只支持 auto/native/json');
if((options.usb||options['prefer-usb'])&&options.host) throw new Error('--usb/--prefer-usb 与 --host 不能同时使用');
let controller=new AbortController(),ui,running=false,terminating=false;
const abort=()=>{if(ui&&!running){ui.exitInput();return;}if(!controller.signal.aborted) controller.abort(new Error('用户已取消任务'));};
const terminate=()=>{terminating=true;abort();ui?.exitInput();};
process.on('SIGINT',abort);process.once('SIGTERM',terminate);
let rl;
const ask=async prompt=>{if(ui)return ui.read(prompt,{signal:controller.signal});if(!process.stdin.isTTY) throw new Error('非交互运行需显式提供参数');if(!rl){rl=readline.createInterface({input:process.stdin,output:process.stdout});rl.on('SIGINT',abort);}return rl.question(prompt,{signal:controller.signal});};
async function secret(prompt){
  if(ui)return ui.read(prompt,{secret:true,signal:controller.signal});
  if(!process.stdin.isTTY) throw new Error('需要 API 密钥，请设置 PORTABLE_API_KEY 或在终端解锁密钥');
  // Avoid two readline interfaces handling the same keystrokes or echoing secrets.
  rl?.close();rl=undefined;
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
let local,state,sessionFile,diffFile,key=process.env.PORTABLE_API_KEY || '';
const event=e=>{
  if(ui){ui.event(e);return;}
  if(e.type==='fallback')console.log(`[降级] ${e.reason}`);
  if(e.type==='model')console.log(`[第 ${e.step} 轮 · ${e.backend} · ${e.model}${e.protocol?' · '+e.protocol:''}]${e.text?'\n'+e.text:''}`);
  if(e.type==='tool-start')console.log(`[工具] ${e.name} ${JSON.stringify(e.arguments).slice(0,240)}`);
  if(e.type==='file-change')console.log(`[修改] ${e.path} ${e.beforeBytes} → ${e.afterBytes} 字节`);
  if(e.type==='tool-result')console.log(`[结果${e.error?' · 错误':''}] ${JSON.stringify(e.result).slice(0,1500)}`);
};
try{
  const unlockSaved=async()=>{
    try{return unseal(JSON.parse(await fs.readFile(path.join(root,'data','key.enc.json'),'utf8')),process.env.PORTABLE_VAULT_PASSWORD || await secret('解锁已保存密钥的密码（不显示）： '));}
    catch(e){if(e.code==='ENOENT')return '';throw e;}
  };
  if(options.connect||options.configure||(!options.task&&!options.resume&&!options.doctor&&!options.offline&&!options.usb&&!options['api-base']&&process.stdin.isTTY)){
    const connection=await setupConnection({config,key,ask,secret,unlockSaved,configureOnly:!!options.configure,saveConfig:async value=>{await fs.mkdir(path.join(root,'data'),{recursive:true});await fs.writeFile(path.join(root,'data','config.json'),JSON.stringify(value,null,2));},saveKey:async(value,password)=>{const vault=seal(value,password);await fs.mkdir(path.join(root,'data'),{recursive:true});await fs.writeFile(path.join(root,'data','key.enc.json'),JSON.stringify(vault),{mode:0o600});}});
    config=connection.config;key=connection.key;options.offline=connection.offline;options.usb=connection.portableOnly;
    if(options.configure){console.log(`云端 API 配置已保存：${config.provider} · ${config.model}。未加载本地模型。`);}
  }
  if(!options.doctor&&!options.configure)console.log(options.usb?'连接：仅用 U 盘模型':options.offline?'连接：仅用电脑本地模型':config.cloudEnabled?`连接：云端 API 优先 · ${config.provider} · ${config.model} · ${config.autoFallback?'失败后降级':'不自动降级'}`:'连接：云端 API 未启用，使用本地模型。配置云端可运行 --configure。');
  local=new LocalRuntime(root,value=>ui?ui.progress(value):console.log(`[本地] ${value}`));
  if(options.configure){
    // Configuration must not restore model weights or create an agent session.
  }else if(options.doctor){
    const models=await local.existing();const capabilities=[];
    for(const m of models){try {const info=await requestJson('http://127.0.0.1:11434/api/show',{model:m.name},{},3000);capabilities.push({name:m.name,capabilities:info.capabilities,remote:!!(info.remote_host||info.remote_model)});}catch{capabilities.push({name:m.name,error:'无法读取能力'});}}
    console.log(JSON.stringify({version:'0.3.3',platform:process.platform,arch:process.arch,node:process.version,memoryGB:Math.round(os.totalmem()/1e9),bundle:await bundleInfo(path.join(root,'models')),cacheRoot:local.cacheRoot,hostModels:capabilities,cloudEnabled:config.cloudEnabled,keyInEnvironment:!!process.env.PORTABLE_API_KEY,commandApproval:'terminal confirmation unless --allow-commands'},null,2));
  }else{
    const sessionDir=path.join(root,'data','agent-sessions');await fs.mkdir(sessionDir,{recursive:true});
    const newId=()=>new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(4).toString('hex');
    let sessionId=options.resume || newId();
    if(!/^[A-Za-z0-9_-]{1,100}$/.test(sessionId))throw new Error('会话 ID 无效');
    sessionFile=path.join(sessionDir,sessionId+'.json');diffFile=path.join(sessionDir,sessionId+'.diff');
    if(options.resume){state=JSON.parse(await fs.readFile(sessionFile,'utf8'));if(state.version!==1||!Array.isArray(state.history))throw new Error('会话格式不支持');}
    const workspace=await fs.realpath(options.workspace || state?.workspace || (process.stdin.isTTY?await ask('项目文件夹路径： '):process.cwd()));
    if(state && state.workspace!==workspace)throw new Error('恢复会话必须使用原项目目录');
    if(!state)state=initialState(workspace);
    if(!options.offline&&!options.usb&&config.cloudEnabled&&!key){
      try {const vault=JSON.parse(await fs.readFile(path.join(root,'data','key.enc.json'),'utf8'));key=unseal(vault,process.env.PORTABLE_VAULT_PASSWORD || await secret('解锁密钥密码（不显示）：'));}
      catch(e){if(e.code!=='ENOENT'){if(!config.autoFallback)throw e;console.log(`[密钥未解锁] ${e.message}，按设置降级`);}}
      if(!key&&process.stdin.isTTY)key=await secret('API 密钥（留空按设置降级）：');
    }
    const connectionLabel=()=>options.usb?'U 盘模型 · 离线':options.offline?'电脑 Ollama · 离线':config.cloudEnabled?`云端优先 · ${config.provider} / ${config.model} · ${config.autoFallback?'失败降级':'不降级'}`:'本地模型 · 云端尚未配置';
    const interactive=(!options.task||options.interactive)&&process.stdin.isTTY;
    if(interactive&&!options.plain){
      rl?.close();rl=undefined;
      if(!process.env.NO_COLOR&&!process.env.FORCE_COLOR)process.env.FORCE_COLOR='1';
      const {createTerminal}=await import('./lib/terminal-ui.mjs');
      ui=createTerminal({workspace,session:sessionId,connection:connectionLabel(),onCancel:abort});
      ui.add('info','欢迎来到 Portable AI','输入任务后，Agent 会读取文件、修改代码并执行验证。\n/help 查看命令，/connect 配置云端 API；任务结束后可直接继续提问。');
      if(options.resume)for(const m of state.history.filter(m=>['user','assistant'].includes(m.role)&&m.content).slice(-8))ui.add(m.role,m.role==='user'?'你 · 已恢复':'Agent · 已恢复',m.content);
    }
    const save=async value=>{const temp=sessionFile+'.tmp';await fs.writeFile(temp,JSON.stringify(value,null,2),'utf8');await fs.rename(temp,sessionFile);};
    const say=(kind,title,body='')=>ui?ui.add(kind,title,body):console.log(`${title}\n${body}`);
    let tools;
    const execute=async task=>{
      controller=new AbortController();running=true;ui?.busy(true);
      if(task)say('user','你',task);
      tools=new WorkspaceTools(workspace,{signal:controller.signal,changes:state.changes,onEvent:event,approve:async command=>{
        if(options['allow-commands'])return true;if(!process.stdin.isTTY)return false;
        say('tool','需要确认命令',`${command.command} ${command.args.map(a=>JSON.stringify(a)).join(' ')}\n目录：${workspace}\n命令以当前电脑用户权限运行。`);
        return /^(y|yes)$/i.test((await ask('执行此命令？输入 y 确认，其余拒绝：')).trim());
      }});
      // A fresh router retries the preferred cloud on each new user turn.
      const request=createAgentRouter({config,key,local,tools:agentTools,offline:!!options.offline||!!options.usb,portableOnly:!!options.usb,protocol:options['local-protocol'],signal:controller.signal,onEvent:event});
      try{
        await tools.init();await runAgent({state,task,request,tools,maxSteps,signal:controller.signal,onEvent:event,save});
        say(state.status==='completed'?'info':'error',`本轮结束 · ${state.status} · 验证 ${state.verification||'not-run'}`,state.status==='completed'?(interactive?'继续输入下一项任务。':'任务已完成。'):state.summary||'');
        if(!interactive){console.log(state.summary||'');if(state.status!=='completed')process.exitCode=2;}
      }catch(error){if(!interactive)throw error;say('error',controller.signal.aborted?'任务已取消，可继续输入':'本轮出错，可重试或 /connect',error.message);}
      finally{await fs.writeFile(diffFile,tools.diff(),'utf8');running=false;ui?.busy(false);controller=new AbortController();}
    };
    const command=async text=>{
      const [name,...args]=text.trim().split(/\s+/);const value=args.join(' ');
      if(name==='/exit'||name==='/quit')return false;
      if(name==='/help')say('info','终端命令','/connect 交互配置 API 和降级方式\n/model cloud|usb|host 切换调用方式\n/new 开始新会话（保留实际文件修改）\n/sessions 列出会话；/resume <ID> 恢复本项目会话\n/status 当前设置；/diff 查看文件工具修改\n/exit 退出；Esc/Ctrl+C 取消正在执行的任务\nEnter 提交，↑↓ 输入历史，PgUp/PgDn 回看。');
      else if(name==='/status'||name==='/model'&&!value)say('info','当前连接',`${connectionLabel()}\nAPI：${config.baseUrl}\n本地模型：${config.localModel||'自动选择'}\n命令：${options['allow-commands']?'本次会话已授权':'逐条确认'}\n会话：${sessionId}\n累计模型步骤：${state.steps}`);
      else if(name==='/model'){
        if(!['cloud','usb','host'].includes(value))throw new Error('用法：/model cloud|usb|host');
        if(value==='cloud'&&(!config.cloudEnabled||!key))throw new Error('请先用 /connect 配置云端地址、模型和密钥');
        options.usb=value==='usb';options.offline=value!=='cloud';config.hostOnly=value==='host';if(value==='host')config.preferPortable=false;
        ui?.context({connection:connectionLabel()});say('info','调用方式已切换',connectionLabel());
      }else if(name==='/connect'){
        running=true;controller=new AbortController();
        try{
          const connection=await setupConnection({config,key,ask,secret,unlockSaved,saveConfig:async v=>fs.writeFile(path.join(root,'data','config.json'),JSON.stringify(v,null,2)),saveKey:async(v,password)=>fs.writeFile(path.join(root,'data','key.enc.json'),JSON.stringify(seal(v,password)),{mode:0o600})});
          config=connection.config;key=connection.key;options.offline=connection.offline;options.usb=connection.portableOnly;ui?.context({connection:connectionLabel()});say('info','连接设置完成',connectionLabel());
        }finally{running=false;controller=new AbortController();}
      }else if(name==='/new'){
        state=initialState(workspace);sessionId=newId();sessionFile=path.join(sessionDir,sessionId+'.json');diffFile=path.join(sessionDir,sessionId+'.diff');await save(state);
        ui?.clear();ui?.context({session:sessionId,connection:connectionLabel()});say('info','新会话',sessionId);
      }else if(name==='/sessions'){
        const files=(await fs.readdir(sessionDir)).filter(f=>f.endsWith('.json')).sort().reverse().slice(0,20);
        const lines=[];for(const f of files){try{const s=JSON.parse(await fs.readFile(path.join(sessionDir,f),'utf8'));lines.push(`${f.slice(0,-5)} · ${s.status}\n  ${s.workspace}`);}catch{}}
        say('info','最近 20 个会话',lines.join('\n')||'暂无记录');
      }else if(name==='/resume'){
        if(!/^[A-Za-z0-9_-]{1,100}$/.test(value))throw new Error('用法：/resume <会话 ID>');
        const candidate=JSON.parse(await fs.readFile(path.join(sessionDir,value+'.json'),'utf8'));
        if(candidate.version!==1||!Array.isArray(candidate.history)||candidate.workspace!==workspace)throw new Error('只能恢复当前项目的有效会话');
        state=candidate;sessionId=value;sessionFile=path.join(sessionDir,value+'.json');diffFile=path.join(sessionDir,value+'.diff');ui?.clear();ui?.context({session:sessionId});
        for(const m of state.history.filter(m=>['user','assistant'].includes(m.role)&&m.content).slice(-8))say(m.role,m.role==='user'?'你 · 已恢复':'Agent · 已恢复',m.content);
      }else if(name==='/diff'){
        const view=new WorkspaceTools(workspace,{changes:state.changes});say('info','文件工具差异',view.diff()||'暂无文件修改');
      }else throw new Error('未知命令，输入 /help 查看');
      return true;
    };
    if(!interactive)console.log(`项目：${workspace}\n会话：${sessionId}\n命令权限：${options['allow-commands']?'本次已授权':'逐条确认'}`);
    if(options.task||(!interactive&&options.resume))await execute(options.task||'');
    if(interactive){
      for(;;){
        if(terminating)break;
        const task=(ui?await ui.read('描述任务或输入 /help',{task:true}):await ask('PortableAI ❯ ')).trim();
        if(!task)continue;
        if(task.startsWith('/')){try{if(!await command(task))break;}catch(e){say('error','操作未完成',e.message);}}
        else await execute(task);
      }
    }else if(!options.task&&!options.resume)throw new Error('非交互运行必须指定 --task');
    ui?.close();ui=undefined;
    console.log(`会话记录：${sessionFile}\n文件差异：${diffFile}`);
  }
}catch(error){console.error(error.message);process.exitCode=controller.signal.aborted?130:1;}
finally{ui?.close();rl?.close();await local?.stop();process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',terminate);}
