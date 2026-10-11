import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { setupConnection } from '../lib/connection-setup.mjs';
import { packModel, prepareModel } from '../lib/model-store.mjs';
import { LocalRuntime } from '../lib/local-runtime.mjs';
const config={provider:'anthropic',baseUrl:'https://api.anthropic.com/v1',model:'',cloudEnabled:false,autoFallback:true};
const wizard=(answers,secrets,extra={})=>{
  const prompts=[],saved={};return {prompts,saved,run:()=>setupConnection({config,ask:async p=>{prompts.push(p);assert.ok(answers.length,'unexpected prompt');return answers.shift();},secret:async()=>{assert.ok(secrets.length,'unexpected secret');return secrets.shift();},saveConfig:async c=>saved.config=c,saveKey:async(key,password)=>saved.vault={key,password},...extra})};
};
test('default interactive startup exposes cloud API and saves no plaintext key',async()=>{
  const w=wizard(['','2','http://127.0.0.1:32100/v1','custom-model','','',''],['fake-key']);
  const result=await w.run();assert.match(w.prompts[0],/云端 API/);assert.equal(result.config.provider,'compatible');assert.equal(result.config.cloudEnabled,true);assert.equal(result.config.preferPortable,true);assert.equal(result.key,'fake-key');assert.equal(result.offline,false);assert.ok(!JSON.stringify(w.saved.config).includes('fake-key'));assert.equal(w.saved.vault,undefined);
});
test('encrypted saving is explicit and keeps credentials out of connection config',async()=>{
  const w=wizard(['1','1','','claude-user-model','n','y'],['fake-key','password-123']);const result=await w.run();assert.equal(result.config.autoFallback,false);assert.deepEqual(w.saved.vault,{key:'fake-key',password:'password-123'});assert.ok(!JSON.stringify(w.saved.config).includes('password'));
});
test('local choices bypass all API key prompts and do not rewrite cloud settings',async()=>{
  for(const selection of ['2','3','4']){const w=wizard([selection],[]);const result=await w.run();assert.equal(w.saved.config,undefined);assert.equal(result.portableOnly,selection==='2');assert.equal(result.offline,selection!=='4');if(selection==='3')assert.equal(result.config.hostOnly,true);}
});
test('missing cloud key stops setup before any model restoration',async()=>{
  const w=wizard(['1','1','','test-model'],['']);await assert.rejects(w.run(),/没有 API 密钥/);assert.equal(w.saved.config,undefined);
});
test('standalone configure skips mode menu and can reuse unlocked key',async()=>{
  const w=wizard(['1','','test-model','n',''],[''],{configureOnly:true,key:'existing-test-key'});const result=await w.run();assert.ok(!w.prompts[0].includes('选择模型连接'));assert.equal(result.key,'existing-test-key');assert.equal(result.config.cloudEnabled,true);
});
test('complete model in another cache is reused even when USB parts are unavailable',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'portable-cache-reuse-'));
  try{
    const source=path.join(root,'source'),store=path.join(root,'usb'),firstCache=path.join(root,'normal-cache');await fs.mkdir(path.join(source,'blobs'),{recursive:true});await fs.mkdir(path.join(source,'manifests'),{recursive:true});
    const bytes=crypto.randomBytes(4096),hash=crypto.createHash('sha256').update(bytes).digest('hex');await fs.writeFile(path.join(source,'blobs','sha256-'+hash),bytes);await fs.writeFile(path.join(source,'manifests','test'),JSON.stringify({config:{digest:'sha256:'+hash,size:bytes.length},layers:[]}));
    const catalog=await packModel(source,'manifests/test',store,'custom-model',512);await fs.rm(path.join(store,'parts'),{recursive:true,force:true});
    const progress=[];const prepared=await prepareModel(store,firstCache,m=>progress.push(m),[source]);assert.equal(prepared.modelsRoot,source);assert.match(progress.join('\n'),/无需从 U 盘还原/);await assert.rejects(fs.stat(firstCache),{code:'ENOENT'});
    await fs.writeFile(path.join(source,'blobs','sha256-'+hash),Buffer.alloc(4096));await assert.rejects(prepareModel(store,firstCache,()=>{},[source]),/ENOENT/);
    assert.equal(catalog.model,'custom-model');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('host-only mode never starts a portable runtime when host model is absent',async()=>{
  const local=new LocalRuntime(process.cwd());local.existing=async()=>[];local.startPortable=()=>assert.fail('must not restore USB model');await assert.rejects(local.choose({hostOnly:true}),/不会还原/);
});

test('switching the connection wizard from host-only to USB clears the restriction and selects USB',async()=>{
  const host=await wizard(['3'],[]).run();assert.equal(host.config.hostOnly,true);
  const usb=await wizard(['2'],[],{config:host.config}).run();
  assert.equal(usb.config.hostOnly,false);assert.equal(usb.config.preferPortable,true);assert.equal(usb.portableOnly,true);
  const local=new LocalRuntime(process.cwd());local.existing=()=>assert.fail('USB mode must not look for host models');
  const target={backend:'usb-local',model:'fixture',base:'http://127.0.0.1:1'};local.startPortable=async()=>target;
  assert.deepEqual(await local.choose(usb.config,usb.portableOnly),target);
});
test('explicit USB mode overrides stale host-only config at the runtime boundary',async()=>{
  const local=new LocalRuntime(process.cwd());local.existing=()=>assert.fail('must skip host discovery');
  let starts=0;local.startPortable=async()=>{starts++;return {backend:'usb-local'};};
  assert.equal((await local.choose({hostOnly:true},true)).backend,'usb-local');
  assert.equal((await local.choose({hostOnly:true},true)).backend,'usb-local');assert.equal(starts,1);
});
test('returning from host-only to saved cloud settings permits local fallback',async()=>{
  const saved={...config,hostOnly:true,cloudEnabled:true};
  const result=await wizard(['4'],[],{config:saved}).run();
  assert.equal(result.config.hostOnly,false);assert.equal(result.offline,false);assert.equal(result.portableOnly,false);
});
