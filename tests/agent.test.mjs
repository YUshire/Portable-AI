import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WorkspaceTools,agentTools } from '../lib/agent-tools.mjs';
import { initialState,runAgent } from '../lib/agent-loop.mjs';
import { cloudAgent,localAgent,createAgentRouter,compatibleMessages,anthropicMessages } from '../lib/agent-provider.mjs';

async function project(callback){const root=await fs.mkdtemp(path.join(os.tmpdir(),'portable-agent-'));try{return await callback(root);}finally{await fs.rm(root,{recursive:true,force:true});}}
async function mock(callback){const server=http.createServer(async(req,res)=>{try{let body='';for await(const c of req)body+=c;await callback(req,res,JSON.parse(body||'{}'));}catch(e){res.writeHead(500);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));return {base:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(r=>server.close(r))};}
const call=(name,args,n)=>({text:'',calls:[{id:'test-'+n,name,arguments:args}],backend:'cloud',model:'fixture'});
test('real repair loop reads, edits, sees failing tests, corrects and passes',()=>project(async root=>{
  await fs.writeFile(path.join(root,'add.mjs'),'export const add=(a,b)=>a-b;\n');
  await fs.writeFile(path.join(root,'add.test.mjs'),"import assert from 'node:assert/strict';import {add} from './add.mjs';assert.equal(add(2,3),5);console.log('TEST_PASSED');\n");
  const state=initialState(root),tools=new WorkspaceTools(root,{approve:async()=>true});await tools.init();
  let round=0;
  const request=async history=>{
    round++;
    if(round===1)return call('read_file',{path:'add.mjs'},round);
    if(round===2)return call('edit_file',{path:'add.mjs',search:'a-b',replace:'a*b'},round);
    if(round===3)return call('run_command',{command:'node',args:['add.test.mjs']},round);
    if(round===4){const result=JSON.parse(history.at(-1).content);assert.equal(result.exitCode,1);assert.match(result.output,/AssertionError/);return call('edit_file',{path:'add.mjs',search:'a*b',replace:'a+b'},round);}
    if(round===5)return call('run_command',{command:'node',args:['add.test.mjs']},round);
    assert.equal(JSON.parse(history.at(-1).content).exitCode,0);return {text:'修复完成，测试通过',calls:[],backend:'cloud'};
  };
  await runAgent({state,task:'修复加法并测试',request,tools});
  assert.equal(state.status,'completed');assert.match(await fs.readFile(path.join(root,'add.mjs'),'utf8'),/a\+b/);assert.match(tools.diff(),/-export.*a-b/);assert.match(tools.diff(),/\+export.*a\+b/);
}));
test('workspace paths reject traversal, absolute paths, secrets and junction escape',()=>project(async root=>{
  const work=path.join(root,'work'),outside=path.join(root,'outside');await fs.mkdir(work);await fs.mkdir(outside);await fs.writeFile(path.join(outside,'secret.txt'),'SECRET');
  const tools=new WorkspaceTools(work);await tools.init();
  await assert.rejects(tools.execute('write_file',{path:'../bad',content:'x'}),/目录外/);
  await assert.rejects(tools.execute('read_file',{path:path.join(outside,'secret.txt')}),/相对路径/);
  await assert.rejects(tools.execute('read_file',{path:'.env'}),/\.env/);
  await fs.symlink(outside,path.join(work,'escape'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(tools.execute('read_file',{path:'escape/secret.txt'}),/符号链接/);
  await assert.rejects(tools.execute('write_file',{path:'escape/new/file.txt',content:'x'}),/符号链接/);
}));
test('commands require approval, use argv, bound output and terminate on timeout',()=>project(async root=>{
  const denied=new WorkspaceTools(root);await denied.init();assert.equal((await denied.execute('run_command',{command:'node',args:['-e','process.exit(0)']})).denied,true);
  const tools=new WorkspaceTools(root,{approve:async()=>true,commandTimeoutMs:150});await tools.init();
  const timed=await tools.execute('run_command',{command:'node',args:['-e','setInterval(()=>{},1000)']});assert.equal(timed.timedOut,true);
  const output=await tools.execute('run_command',{command:'node',args:['-e','console.log("x".repeat(20000))']});assert.equal(output.exitCode,0);assert.ok(output.output.length<=12000);
}));
test('edit conflicts fail without modifying a file',()=>project(async root=>{
  await fs.writeFile(path.join(root,'a.txt'),'duplicate duplicate');const tools=new WorkspaceTools(root);await tools.init();
  await assert.rejects(tools.execute('edit_file',{path:'a.txt',search:'duplicate',replace:'new'}),/只能匹配一次/);assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'duplicate duplicate');
  await assert.rejects(tools.execute('read_file',{path:'a.txt',startLine:'1'}),/类型/);
}));
test('failure guard and step limit stop runaway loops',()=>project(async root=>{
  const tools=new WorkspaceTools(root);await tools.init();let n=0;const state=initialState(root);
  await assert.rejects(runAgent({state,task:'read',tools,request:async()=>call('read_file',{path:'missing'},++n)}),/连续失败三次/);assert.equal(n,3);
  n=0;const limited=initialState(root);await runAgent({state:limited,task:'list',tools,maxSteps:2,request:async()=>call('list_files',{path:'.'},++n)});assert.equal(limited.status,'step-limit');assert.equal(n,2);
}));
test('failed final verification remains needs-review instead of completed',()=>project(async root=>{
  const tools=new WorkspaceTools(root,{approve:async()=>true});await tools.init();let n=0;const state=initialState(root);
  await runAgent({state,task:'test',tools,request:async()=>++n===1?call('run_command',{command:'node',args:['-e','process.exit(1)']},n):{text:'done',calls:[]}});
  assert.equal(state.status,'needs-review');assert.match(state.summary,/不能确认/);
}));
test('resume records unknown interrupted command without executing it again',()=>project(async root=>{
  const state=initialState(root);state.history.push({role:'user',content:'test'},{role:'assistant',content:'',calls:[{id:'pending',name:'run_command',arguments:{command:'node',args:['x']}}]});
  const tools=new WorkspaceTools(root);tools.execute=()=>assert.fail('must not repeat');
  await runAgent({state,tools,request:async history=>{assert.match(history.at(-1).content,/Interrupted/);return {text:'inspect next',calls:[]};}});
  assert.equal(state.status,'needs-review');
}));
test('tool history maps across compatible and Anthropic providers with paired IDs',()=>{
  const history=[{role:'system',content:'system'},{role:'user',content:'task'},{role:'assistant',content:'',calls:[{id:'id-1',name:'read_file',arguments:{path:'x'}}]},{role:'tool',name:'read_file',callId:'id-1',content:'output'}];
  const compatible=compatibleMessages(history);assert.equal(compatible[2].tool_calls[0].id,compatible[3].tool_call_id);
  const anthropic=anthropicMessages(history);assert.equal(anthropic[1].content[0].id,anthropic[2].content[0].tool_use_id);
});
test('cloud adapters send tools and parse structured calls without dropping them',async()=>{
  for(const provider of ['compatible','anthropic']){
    let received;
    const fixture=await mock((req,res,body)=>{received=body;res.end(JSON.stringify(provider==='compatible'?{choices:[{message:{content:null,tool_calls:[{id:'id-1',type:'function',function:{name:'read_file',arguments:'{"path":"x"}'}}]}}]}:{content:[{type:'tool_use',id:'id-1',name:'read_file',input:{path:'x'}}]}));});
    try{const reply=await cloudAgent({provider,baseUrl:fixture.base+'/v1',model:'test'},'test',initialState('.').history.concat({role:'user',content:'task'}),agentTools);assert.equal(reply.calls[0].name,'read_file');assert.equal(received.tools.length,5);}finally{await fixture.close();}
  }
});
test('cloud failure switches once to local and preserves prior tool history',async()=>{
  let cloudCalls=0,localCalls=0;
  const fixture=await mock((req,res,body)=>{
    if(req.url.startsWith('/v1/')){cloudCalls++;res.writeHead(503);res.end();return;}
    if(req.url==='/api/show'){res.end(JSON.stringify({capabilities:['completion','tools']}));return;}
    localCalls++;assert.equal(body.messages.at(-1).tool_name,'read_file');res.end(JSON.stringify({message:{content:'done'}}));
  });
  try{
    const local={choose:async()=>({base:fixture.base,model:'local',backend:'usb-local'})};
    const request=createAgentRouter({config:{provider:'compatible',baseUrl:fixture.base+'/v1',model:'cloud',cloudEnabled:true,autoFallback:true},key:'test',local,tools:agentTools});
    const history=[...initialState('.').history,{role:'user',content:'task'},{role:'assistant',content:'',calls:[{id:'old',name:'read_file',arguments:{path:'x'}}]},{role:'tool',callId:'old',name:'read_file',content:'result'}];
    assert.equal((await request(history)).backend,'usb-local');await request(history);assert.equal(cloudCalls,1);assert.equal(localCalls,2);
  }finally{await fixture.close();}
});
test('empty Anthropic result is an error instead of false completion',async()=>{
  const fixture=await mock((req,res)=>res.end(JSON.stringify({content:[]})));
  try{await assert.rejects(cloudAgent({provider:'anthropic',baseUrl:fixture.base+'/v1',model:'test'},'test',initialState('.').history,agentTools),/未返回文本/);}finally{await fixture.close();}
});
test('completion-only Ollama uses schema JSON decisions; native mode refuses unsupported model',async()=>{
  const fixture=await mock((req,res,body)=>{if(req.url==='/api/show'){res.end(JSON.stringify({capabilities:['completion']}));return;}assert.equal(body.format.type,'object');assert.equal(body.tools,undefined);res.end(JSON.stringify({message:{content:JSON.stringify({action:'write_file',text:'',arguments:{path:'x',content:'y'}})}}));});
  try{const target={base:fixture.base,model:'custom'};const result=await localAgent(target,initialState('.').history,agentTools);assert.equal(result.calls[0].name,'write_file');assert.equal(result.protocol,'json-experimental');await assert.rejects(localAgent(target,[],agentTools,'native'),/未声明/);}finally{await fixture.close();}
});

test('JSON finish returns the actual answer and keeps a follow-up question in context',async()=>{
  const model='custom-model-alias';let calls=0;
  const fixture=await mock((req,res,body)=>{
    if(req.url==='/api/show'){res.end(JSON.stringify({capabilities:['completion']}));return;}
    const system=body.messages[0].content;
    assert.match(system,/text MUST contain the actual complete answer/);assert.match(system,/A question is a valid request/);assert.match(system,/Runtime model identifier.*custom-model-alias/);
    assert.ok(!system.includes('text is your summary'));
    if(++calls===2){assert.equal(body.messages.at(-1).content,'You did not answer my question');assert.ok(body.messages.some(m=>m.content==='What model are you?'));}
    res.end(JSON.stringify({message:{content:JSON.stringify({action:'finish',text:'The loaded model is custom-model-alias.',arguments:{}})}}));
  });
  try{
    const history=[...initialState('.').history,{role:'user',content:'What model are you?'}];
    const first=await localAgent({base:fixture.base,model},history,agentTools);
    assert.equal(first.text,'The loaded model is custom-model-alias.');assert.deepEqual(first.calls,[]);
    history.push({role:'assistant',content:first.text,calls:[]},{role:'user',content:'You did not answer my question'});
    assert.equal((await localAgent({base:fixture.base,model},history,agentTools)).text,first.text);
  }finally{await fixture.close();}
});
test('cancellation aborts owned command and checkpoints the session',()=>project(async root=>{
  const controller=new AbortController(),tools=new WorkspaceTools(root,{signal:controller.signal,approve:async()=>true});await tools.init();const state=initialState(root);let saved;
  const timer=setTimeout(()=>controller.abort(new Error('test cancelled')),200);
  try{await assert.rejects(runAgent({state,task:'cancel',tools,signal:controller.signal,save:async s=>{saved=structuredClone(s);},request:async()=>call('run_command',{command:'node',args:['-e','setInterval(()=>{},1000)']},1)}),/cancelled/);assert.equal(saved.status,'cancelled');}finally{clearTimeout(timer);}
}));
test('CLI transport completes a tool task and resumes the recorded project session',()=>project(async root=>{
  const app=path.join(root,'app'),work=path.join(root,'project');await fs.mkdir(app);await fs.mkdir(work);await fs.mkdir(path.join(app,'data'));
  const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  await fs.copyFile(path.join(source,'cli.mjs'),path.join(app,'cli.mjs'));await fs.cp(path.join(source,'lib'),path.join(app,'lib'),{recursive:true});
  let stage=0;
  const fixture=await mock((req,res,body)=>{
    stage++;let reply;
    if(stage===1)reply={content:'',tool_calls:[{id:'cli-write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'hello.mjs',content:'console.log("CLI_OK");\n'})}}]};
    else if(stage===2){assert.equal(body.messages.at(-1).tool_call_id,'cli-write');reply={content:'',tool_calls:[{id:'cli-run',type:'function',function:{name:'run_command',arguments:JSON.stringify({command:'node',args:['hello.mjs']})}}]};}
    else if(stage===3){assert.match(body.messages.at(-1).content,/CLI_OK/);reply={content:'完成并验证'};}
    else{assert.ok(body.messages.some(m=>m.tool_call_id==='cli-run'));reply={content:'已恢复原项目会话'};}
    res.end(JSON.stringify({choices:[{message:reply}]}));
  });
  const run=args=>new Promise((resolve,reject)=>{let output='';const child=spawn(process.execPath,[path.join(app,'cli.mjs'),...args],{env:{...process.env,PORTABLE_API_KEY:'fake-test-key'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);child.on('error',reject);child.on('close',code=>resolve({code,output}));});
  try{
    const config={provider:'compatible',baseUrl:fixture.base+'/v1',model:'fixture',cloudEnabled:true,autoFallback:false};await fs.writeFile(path.join(app,'data','config.json'),JSON.stringify(config));
    const first=await run(['--workspace',work,'--task','写一个脚本并执行','--allow-commands']);assert.equal(first.code,0,first.output);
    const session=(await fs.readdir(path.join(app,'data','agent-sessions'))).find(f=>f.endsWith('.json'));const state=JSON.parse(await fs.readFile(path.join(app,'data','agent-sessions',session),'utf8'));assert.equal(state.status,'completed');assert.equal(state.verification,'passed');assert.ok(!JSON.stringify(state).includes('fake-test-key'));
    const second=await run(['--resume',session.slice(0,-5),'--task','报告当前状态']);assert.equal(second.code,0,second.output);assert.match(second.output,/已恢复/);
  }finally{await fixture.close();}
}));
