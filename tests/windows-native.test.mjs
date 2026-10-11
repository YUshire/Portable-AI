import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
const source=path.resolve(import.meta.dirname,'..'),ps=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const literal=s=>"'"+s.replaceAll("'","''")+"'";
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function until(check,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const result=await check();if(result)return result;await pause(75);}throw new Error('Native process supervision timed out');}
async function read(file){try{return JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));}catch{return null;}}
function guard(root,entry,args=[]){const script=path.join(root,'guard.ps1');return fs.writeFile(script,`$ErrorActionPreference='Stop'\n. ${literal(path.join(source,'scripts/windows-native.ps1'))}\n$env:PORTABLE_AI_JOB='1'\n$command=[PortableNative]::Quote(${literal(process.execPath)})+' '+[PortableNative]::Quote(${literal(entry)})${args.map(a=>"+' '+[PortableNative]::Quote("+literal(a)+")").join('')}\nexit ([PortableNative]::Guard(${literal(process.execPath)},$command,${literal(os.tmpdir())}))\n`).then(()=>{const child=spawn(ps,['-NoProfile','-ExecutionPolicy','Bypass','-File',script],{cwd:os.tmpdir(),windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stderr.on('data',c=>output+=c);return {child,output:()=>output};});}
test('Windows job closure cleans its child tree and preserves unrelated processes and quoted arguments',{skip:process.platform!=='win32'},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'portable-job-')),record=path.join(root,'pids.json');let supervisor,pids;
 const other=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:os.tmpdir(),windowsHide:true,stdio:'ignore'});
 try{
  await fs.writeFile(path.join(root,'child.mjs'),`import fs from 'node:fs';import{spawn}from'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({parent:process.pid,child:child.pid,args:process.argv.slice(2)}));setInterval(()=>{},1000);`);
  const args=['D:\\','with spaces','quote"value','slashes\\"quoted',''];supervisor=await guard(root,path.join(root,'child.mjs'),args);pids=await until(()=>read(record));assert.deepEqual(pids.args,args);assert.ok(alive(pids.child));
  supervisor.child.kill();await until(()=>!alive(pids.parent)&&!alive(pids.child));assert.ok(alive(other.pid));
 }finally{supervisor?.child.kill();other.kill();if(pids)for(const pid of[pids.parent,pids.child])if(alive(pid))process.kill(pid);await fs.rm(root,{recursive:true,force:true});}
});
test('safe-exit helper survives its app job, closes verified instances, and reclaims a stale exit lock',{skip:process.platform!=='win32'},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'portable-helper-job-'));let supervisor;
 try{
  for(const dir of['lib','scripts'])await fs.cp(path.join(source,dir),path.join(root,dir),{recursive:true});await fs.mkdir(path.join(root,'data/run'),{recursive:true});await fs.writeFile(path.join(root,'data/run/exit.lock'),JSON.stringify({pid:2147483647,id:'stale-helper'}));
  const receipt=path.join(root,'receipt.json'),entry=path.join(root,'helper-app.mjs');
  await fs.writeFile(entry,`import fs from 'node:fs/promises';import{createLifecycle}from'./lib/lifecycle.mjs';import{startSafeExit}from'./lib/safe-exit.mjs';const life=await createLifecycle(${JSON.stringify(root)},'agent',async()=>{await life.close();process.exit(0);});const result=await startSafeExit(${JSON.stringify(root)},{eject:false,quiet:true});await fs.writeFile(${JSON.stringify(receipt)},JSON.stringify(result));`);
  supervisor=await guard(root,entry);const request=await until(()=>read(receipt));const result=await until(()=>read(request.resultFile));assert.equal(result.status,'closed',JSON.stringify(result));assert.equal(result.systemEjectConfirmed,false);await until(()=>supervisor.child.exitCode!==null);assert.equal(supervisor.child.exitCode,0,supervisor.output());await assert.rejects(fs.access(path.join(root,'data/run/exit.lock')));assert.deepEqual(await fs.readdir(path.join(root,'data/run')),[]);
 }finally{supervisor?.child.kill();await fs.rm(root,{recursive:true,force:true});}
});
