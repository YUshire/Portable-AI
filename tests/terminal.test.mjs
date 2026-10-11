import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {safeText,wrapRows} from '../lib/terminal-view.mjs';
import {initialState,runAgent} from '../lib/agent-loop.mjs';
import {WorkspaceTools} from '../lib/agent-tools.mjs';
import {PassThrough,Writable} from 'node:stream';
import {createTerminal} from '../lib/terminal-ui.mjs';

test('multiple turns retain context and changes without inheriting a previous failed verification',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'portable-turns-'));
  try{
    const state=initialState(root),tools=new WorkspaceTools(root,{approve:async()=>true});await tools.init();let n=0;
    await runAgent({state,tools,task:'create a file and run a failing command',request:async()=>{
      const calls=[{id:'write',name:'write_file',arguments:{path:'note.txt',content:'FIRST_TURN'}},{id:'test',name:'run_command',arguments:{command:'node',args:['-e','process.exit(1)']}}];
      return {text:n++?'first turn ended':'',calls:n===1?calls:[]};
    }});
    assert.equal(state.status,'needs-review');assert.equal(state.verification,'failed');
    await runAgent({state,tools,task:'What did you write?',request:async history=>{
      assert.ok(history.some(m=>m.callId==='write'));assert.equal(history.at(-1).content,'What did you write?');
      return {text:'FIRST_TURN',calls:[]};
    }});
    assert.equal(state.status,'completed');assert.equal(state.verification,'not-run');assert.equal(state.summary,'FIRST_TURN');
    assert.ok(state.changes['note.txt']);assert.equal(state.history.filter(m=>m.role==='user').length,2);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('a cancelled turn can be continued with a new signal and records pending calls safely',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'portable-cancel-turn-'));
  try{
    const state=initialState(root),controller=new AbortController(),tools=new WorkspaceTools(root);await tools.init();
    await assert.rejects(runAgent({state,tools,task:'cancel this',signal:controller.signal,request:async()=>{controller.abort(new Error('cancelled'));return {text:'',calls:[{id:'pending',name:'write_file',arguments:{path:'must-not-exist',content:'no'}}]};}}),/cancelled/);
    assert.equal(state.status,'cancelled');
    await runAgent({state,tools,task:'continue safely',signal:new AbortController().signal,request:async history=>{assert.ok(history.some(m=>m.callId==='pending'&&m.error));return {text:'continued',calls:[]};}});
    assert.equal(state.status,'completed');assert.equal(state.error,undefined);await assert.rejects(fs.access(path.join(root,'must-not-exist')));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('terminal escapes are stripped and Chinese lines wrap by display width',()=>{
  assert.equal(safeText('\x1b[2Jhello\x1b]0;malicious title\x07\x1b[31m!'),'hello!');
  assert.deepEqual(wrapRows('中文hello',5),['中文h','ello']);
  assert.equal(safeText('a\rb\x00'),'ab');
});

test('Ink shows its first prompt, accepts successive inputs and masks secrets without a polling render',async()=>{
  const stdin=new PassThrough();stdin.isTTY=true;stdin.setRawMode=()=>{};stdin.ref=()=>{};stdin.unref=()=>{};
  let output='';const stdout=new Writable({write(c,e,done){output+=c.toString();done();}});stdout.isTTY=true;stdout.columns=80;stdout.rows=24;
  const pause=()=>new Promise(r=>setTimeout(r,80));
  const ui=createTerminal({workspace:'test-project',session:'test-session',connection:'cloud fixture',onCancel:()=>{},streams:{stdin,stdout,stderr:stdout}});
  try{
    ui.add('info','Welcome');const first=ui.read('FIRST_PROMPT',{task:true});await pause();
    assert.match(safeText(output),/FIRST_PROMPT/);stdin.write('first task');await pause();stdin.write('\r');assert.equal(await first,'first task');
    const second=ui.read('SECOND_PROMPT',{task:true});await pause();stdin.write('second task');await pause();stdin.write('\r');assert.equal(await second,'second task');
    const secret=ui.read('API_KEY',{secret:true});await pause();stdin.write('PRIVATE_TEST_SECRET');await pause();assert.ok(!output.includes('PRIVATE_TEST_SECRET'));stdin.write('\r');assert.equal(await secret,'PRIVATE_TEST_SECRET');
  }finally{ui.close();stdin.destroy();stdout.destroy();}
});
