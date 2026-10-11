import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createLifecycle,probeInstance} from '../lib/lifecycle.mjs';
import {startSafeExit} from '../lib/safe-exit.mjs';
const source=path.resolve(import.meta.dirname,'..');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,ms=8000){const end=Date.now()+ms;while(Date.now()<end){const result=await check();if(result)return result;await pause(50);}throw new Error('Timed out waiting for shutdown condition');}
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'portable-exit-test-'));for(const dir of ['lib','web','scripts'])await fs.cp(path.join(source,dir),path.join(root,dir),{recursive:true});await fs.copyFile(path.join(source,'server.mjs'),path.join(root,'server.mjs'));return root;}
function run(root,args=[]){const child=spawn(process.execPath,[path.join(root,'server.mjs'),...args],{cwd:os.tmpdir(),windowsHide:true,env:{...process.env,PORTABLE_AI_PORT:'0'},stdio:['ignore','pipe','pipe']});let text='';child.stdout.on('data',c=>text+=c);child.stderr.on('data',c=>text+=c);return {child,output:()=>text};}
async function connect(app){const url=await until(()=>app.output().match(/PortableAI (http:\/\/127\.0\.0\.1:\d+)/)?.[1]);const html=await(await fetch(url)).text();const token=html.match(/name="portable-token" content="([^"]+)"/)[1];return {url,async api(route,value){return fetch(url+'/api/'+route,{method:value===undefined?'GET':'POST',headers:{'X-Portable-Token':token,'Content-Type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});}};}
async function stop(app){if(app.child.exitCode!==null||app.child.signalCode!==null)return;try{const c=await connect(app);await c.api('shutdown',{});await until(()=>app.child.exitCode!==null||app.child.signalCode!==null);}catch{app.child.kill();}}

test('control identity authentication and single browser ownership',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'portable-control-'));let first,second,calls=0;
  try{first=await createLifecycle(root,'web',()=>calls++);assert.equal(await first.browser(),null);await first.setUrl('http://127.0.0.1:9876');second=await createLifecycle(root,'web',()=>{});assert.equal(await second.browser(),'http://127.0.0.1:9876');
    assert.equal((await fetch(first.record.controlUrl+'/stop',{method:'POST',headers:{'x-portable-control':'incorrect'}})).status,403);assert.equal(calls,0);
    assert.equal(await probeInstance({...first.record,id:'wrong'}),null);assert.equal((await probeInstance(first.record)).pid,process.pid);
    await second.close();await fs.access(path.join(root,'data/run/browser.lock/owner.json'));
    await fetch(first.record.controlUrl+'/stop',{method:'POST',headers:{'x-portable-control':first.record.secret}});await pause(20);assert.equal(calls,1);
  }finally{await second?.close();await first?.close();await fs.rm(root,{recursive:true,force:true});}
});
test('stale browser lock is reclaimed and live exit operation blocks launches',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'portable-lock-'));let lifecycle;
  try{const dir=path.join(root,'data/run');await fs.mkdir(path.join(dir,'browser.lock'),{recursive:true});await fs.writeFile(path.join(dir,'browser.lock/owner.json'),JSON.stringify({id:'stale',pid:2147483647}));lifecycle=await createLifecycle(root,'web',()=>{});assert.equal(await lifecycle.browser(),null);await fs.writeFile(path.join(dir,'exit.lock'),JSON.stringify({pid:process.pid}));await assert.rejects(createLifecycle(root,'agent',()=>{}),/正在安全退出/);}finally{await lifecycle?.close();await fs.rm(root,{recursive:true,force:true});}
});
test('a second server reuses the first; shutdown removes service and control records',async()=>{
  const root=await fixture(),first=run(root);let second;
  try{const a=await connect(first);second=run(root);await until(()=>second.child.exitCode!==null);assert.equal(second.child.exitCode,0);assert.ok(second.output().includes(a.url));assert.ok((await fetch(a.url)).ok);
    const res=await a.api('shutdown',{});assert.equal(res.status,202);assert.deepEqual(await res.json(),{accepted:true});await until(()=>first.child.exitCode!==null);assert.equal(first.child.exitCode,0);
    await assert.rejects(fs.access(path.join(root,'data/service.json')));assert.equal((await fs.readdir(path.join(root,'data/run'))).length,0);
  }finally{await stop(first);if(second)await stop(second);await fs.rm(root,{recursive:true,force:true});}
});
test('shutdown aborts an in-flight cloud request, preserves input, and does not load fallback',async()=>{
  const root=await fixture(),app=run(root);let requested=false;
  const cloud=http.createServer(async(req,res)=>{for await(const chunk of req){}requested=true;});await new Promise(r=>cloud.listen(0,'127.0.0.1',r));
  try{const c=await connect(app);assert.ok((await c.api('settings',{provider:'compatible',baseUrl:`http://127.0.0.1:${cloud.address().port}/v1`,model:'test',cloudEnabled:true,autoFallback:true,apiKey:'test-key'})).ok);
    const chat=c.api('chat',{messages:[{role:'user',content:'SAVE_PENDING_INPUT'}]}).catch(()=>null);await until(()=>requested);await c.api('shutdown',{});await until(()=>app.child.exitCode!==null);await chat;
    const history=JSON.parse(await fs.readFile(path.join(root,'data/history.json'),'utf8'));assert.equal(history.messages[0].content,'SAVE_PENDING_INPUT');assert.equal(history.interrupted,true);assert.equal(app.child.exitCode,0);assert.ok(!app.output().includes('退出未完成'));
  }finally{await stop(app);cloud.closeAllConnections();await new Promise(r=>cloud.close(r));await fs.rm(root,{recursive:true,force:true});}
});
test('last browser tab closes service; reload and another tab keep it alive',async()=>{
  const root=await fixture(),app=run(root,['--open','--no-browser']);
  try{const c=await connect(app);await c.api('client',{id:'tab-one'});await c.api('client',{id:'tab-two'});await c.api('client',{id:'tab-one',closed:true});await pause(3300);assert.equal(app.child.exitCode,null);
    await c.api('client',{id:'tab-two',closed:true});await c.api('client',{id:'reloaded'});await pause(3300);assert.equal(app.child.exitCode,null);
    await c.api('client',{id:'reloaded',closed:true});await until(()=>app.child.exitCode!==null);assert.equal(app.child.exitCode,0);
  }finally{await stop(app);await fs.rm(root,{recursive:true,force:true});}
});
test('Windows safety helper read-only check leaves instances alive', {skip:process.platform!=='win32'},async()=>{
  const root=await fixture();let lifecycle;
  try{lifecycle=await createLifecycle(root,'agent',()=>assert.fail('Check must not stop the app'));const result=await startSafeExit(root,{checkOnly:true,quiet:true});const data=await until(async()=>{try{return JSON.parse((await fs.readFile(result.resultFile,'utf8')).replace(/^\uFEFF/,''));}catch{return null;}},15000);assert.equal(data.status,'checked');assert.equal(data.systemEjectConfirmed,false);assert.ok(await probeInstance(lifecycle.record));}
  finally{await lifecycle?.close();await fs.rm(root,{recursive:true,force:true});}
});
