import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
const [appRoot,reportPath,mode='usb']=process.argv.slice(2);
if(!appRoot||!reportPath||!['usb','fallback'].includes(mode))throw new Error('Usage: node scripts/smoke-agent.mjs <app-root> <report.json> [usb|fallback]');
const app=path.resolve(appRoot),project=await fs.mkdtemp(path.join(os.tmpdir(),'portable-agent-smoke-'));
let mock,requests=0;
try{
  await fs.writeFile(path.join(project,'add.mjs'),'export const add=(a,b)=>a-b;\n');
  await fs.writeFile(path.join(project,'add.test.mjs'),"import assert from 'node:assert/strict';import {add} from './add.mjs';assert.equal(add(2,3),5);assert.equal(add(-1,4),3);console.log('ALL_TESTS_PASSED');\n");
  const args=[path.join(app,'cli.mjs'),'--workspace',project,'--allow-commands','--max-steps','10','--task','Fix add.mjs so add(a,b) returns a+b. Read the file, use edit_file to fix it, run node add.test.mjs, and finish only after tests pass. Modify the actual file.'];
  if(mode==='usb')args.push('--usb');
  else{
    mock=http.createServer((req,res)=>{requests++;res.writeHead(503);res.end('simulated outage');});await new Promise(r=>mock.listen(0,'127.0.0.1',r));
    args.push('--api-base',`http://127.0.0.1:${mock.address().port}/v1`,'--model','smoke-cloud','--provider','compatible','--prefer-usb');
  }
  const startedAt=new Date().toISOString();
  const executable=path.join(app,'runtime','node','node.exe');
  const node=process.platform==='win32'?executable:process.execPath;
  const result=await new Promise((resolve,reject)=>{
    let output='';const child=spawn(node,args,{cwd:app,env:{...process.env,PORTABLE_API_KEY:'fake-smoke-key'},windowsHide:true,stdio:['ignore','pipe','pipe']});
    const capture=c=>{const text=c.toString();output+=text;process.stdout.write(text);};child.stdout.on('data',capture);child.stderr.on('data',capture);child.once('error',reject);child.once('close',code=>resolve({exitCode:code,output}));
  });
  const sessionId=result.output.match(/会话：([^\r\n]+)/)?.[1];
  if(!sessionId)throw new Error('Agent did not create a session');
  const state=JSON.parse(await fs.readFile(path.join(app,'data','agent-sessions',sessionId+'.json'),'utf8'));
  const source=await fs.readFile(path.join(project,'add.mjs'),'utf8');
  const commands=state.history.filter(m=>m.role==='tool'&&m.name==='run_command').map(m=>JSON.parse(m.content));
  const passed=result.exitCode===0&&state.status==='completed'&&state.backend==='usb-local'&&state.verification==='passed'&&/a\s*\+\s*b/.test(source)&&commands.some(c=>c.exitCode===0&&c.output?.includes('ALL_TESTS_PASSED'))&&(mode!=='fallback'||requests===1);
  const report={mode,startedAt,finishedAt:new Date().toISOString(),passed,exitCode:result.exitCode,sessionId,backend:state.backend,model:state.model,protocol:state.protocol,status:state.status,verification:state.verification,steps:state.steps,cloudRequests:requests,commands,changedSource:source,output:result.output};
  await fs.writeFile(path.resolve(reportPath),JSON.stringify(report,null,2),'utf8');
  if(!passed)throw new Error('Actual agent repair did not pass all checks; see report');
  console.log(`Agent smoke PASSED: ${mode}`);
}finally{if(mock)await new Promise(r=>mock.close(r));await fs.rm(project,{recursive:true,force:true});}
