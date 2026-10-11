import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {filesystemCapability} from '../lib/storage-capability.mjs';
import {packModel,prepareModel,chooseImportStorage} from '../lib/model-store.mjs';
async function fixture(callback){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'portable-storage-'));
  try{
    const source=path.join(root,'source'),store=path.join(root,'usb'),cache=path.join(root,'cache');await fs.mkdir(path.join(source,'blobs'),{recursive:true});await fs.mkdir(path.join(source,'manifests'),{recursive:true});
    const bytes=crypto.randomBytes(4096),hash=crypto.createHash('sha256').update(bytes).digest('hex');await fs.writeFile(path.join(source,'blobs','sha256-'+hash),bytes);await fs.writeFile(path.join(source,'manifests','model'),JSON.stringify({config:{digest:'sha256:'+hash,size:bytes.length},layers:[]}));
    await callback({root,source,store,cache,bytes,hash});
  }finally{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'portable-storage-'));await fs.rm(root,{recursive:true,force:true});}
}
const probe=(name,extra={})=>async()=>({...filesystemCapability(name),freeBytes:1024**4,...extra});
test('filesystem limits handle FAT32 boundary and allow small FAT32 models',()=>{
  assert.equal(filesystemCapability('FAT32').maxFileBytes,4294967295);assert.ok(4096<=filesystemCapability('FAT32').maxFileBytes);assert.ok(2**32>filesystemCapability('FAT32').maxFileBytes);
  assert.equal(filesystemCapability('exfat').maxFileBytes,Infinity);assert.equal(filesystemCapability('NTFS').known,true);assert.equal(filesystemCapability('unrecognized').known,false);
});
test('chunked weights on capable USB are assembled on USB and reused without computer cache',()=>fixture(async({source,store,cache,bytes,hash})=>{
  await packModel(source,'manifests/model',store,'fixture',512);
  const result=await prepareModel(store,cache,()=>{},[],{inspect:probe('NTFS')});assert.equal(result.modelsRoot,path.join(store,'.portable-store'));
  assert.deepEqual(await fs.readFile(path.join(result.modelsRoot,'blobs','sha256-'+hash)),bytes);await assert.rejects(fs.access(cache),{code:'ENOENT'});
  await fs.rm(path.join(store,'parts'),{recursive:true});
  assert.equal((await prepareModel(store,cache,()=>{},[],{inspect:probe('NTFS')})).modelsRoot,result.modelsRoot);
}));
test('a complete store takes precedence over a stale chunked catalog and read-only status',()=>fixture(async({source,store,cache})=>{
  const catalog=await packModel(source,'manifests/model',store,'fixture',512,'direct');catalog.storage='chunked';await fs.writeFile(path.join(store,'catalog.json'),JSON.stringify(catalog));
  assert.equal((await prepareModel(store,cache,()=>{},[],{inspect:probe('FAT32',{readOnly:true})})).modelsRoot,store);await assert.rejects(fs.access(cache),{code:'ENOENT'});
}));
test('small chunked models can run from FAT32 without going to computer cache',()=>fixture(async({source,store,cache})=>{
  await packModel(source,'manifests/model',store,'fixture',512);
  assert.equal((await prepareModel(store,cache,()=>{},[],{inspect:probe('FAT32')})).modelsRoot,path.join(store,'.portable-store'));await assert.rejects(fs.access(cache),{code:'ENOENT'});
}));
test('low space, read-only and unknown filesystems use validated computer storage',()=>fixture(async({root,source})=>{
  for(const [name,inspect] of [['space',probe('NTFS',{freeBytes:0})],['readonly',probe('EXFAT',{readOnly:true})],['unknown',probe('unknown')]]){
    const store=path.join(root,name),cache=path.join(root,name+'-cache');await packModel(source,'manifests/model',store,'fixture',512);
    assert.equal((await prepareModel(store,cache,()=>{},[],{inspect})).modelsRoot,cache);await assert.rejects(fs.access(path.join(store,'.portable-store')),{code:'ENOENT'});
  }
}));
test('real write-protection error during USB assembly falls back to computer',()=>fixture(async({source,store,cache})=>{
  await packModel(source,'manifests/model',store,'fixture',512);
  const assemble=async()=>{throw Object.assign(new Error('write protected'),{code:'EROFS'});};
  assert.equal((await prepareModel(store,cache,()=>{},[],{inspect:probe('EXFAT'),assemble})).modelsRoot,cache);
}));
test('auto import picks direct for FAT32 small models and chunked for weights beyond its limit',()=>fixture(async({source,store})=>{
  assert.equal((await chooseImportStorage(source,'manifests/model',store,{inspect:probe('FAT32')})).storage,'direct');
  const manifest=JSON.parse(await fs.readFile(path.join(source,'manifests/model'),'utf8'));manifest.config.size=2**32;await fs.writeFile(path.join(source,'manifests/model'),JSON.stringify(manifest));
  assert.equal((await chooseImportStorage(source,'manifests/model',store,{inspect:probe('FAT32')})).storage,'chunked');
  assert.equal((await chooseImportStorage(source,'manifests/model',store,{inspect:probe('EXFAT')})).storage,'direct');
}));
