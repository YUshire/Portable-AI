import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const alive=pid=>{if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
export async function probeInstance(record){
  if(!record||!/^http:\/\/127\.0\.0\.1:\d+$/.test(record.controlUrl)||!record.secret)return null;
  try{const res=await fetch(record.controlUrl+'/health',{headers:{'x-portable-control':record.secret},signal:AbortSignal.timeout(800)});const value=await res.json();return res.ok&&value.id===record.id&&value.pid===record.pid&&value.root===record.root?value:null;}catch{return null;}
}
export async function createLifecycle(root,role,onStop){
  root=path.resolve(root);const dir=path.join(root,'data','run');await fs.mkdir(dir,{recursive:true});
  try{const lock=JSON.parse(await fs.readFile(path.join(dir,'exit.lock'),'utf8'));if(alive(lock.pid))throw new Error('PortableAI 正在安全退出，请等待系统结果');await fs.rm(path.join(dir,'exit.lock'),{force:true});}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
  const record={version:1,id:crypto.randomUUID(),pid:process.pid,root,role,secret:crypto.randomBytes(32).toString('hex'),controlUrl:'',appUrl:null};
  let closing=false,closed=false,ownsBrowser=false;const lock=path.join(dir,'browser.lock'),file=path.join(dir,record.id+'.json');
  const server=http.createServer((req,res)=>{
    if(req.headers.host!==new URL(record.controlUrl).host||req.headers.origin||req.headers['x-portable-control']!==record.secret){res.writeHead(403);res.end();return;}
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
    if(req.url==='/health'&&req.method==='GET'){res.end(JSON.stringify({id:record.id,pid:record.pid,root,role,appUrl:record.appUrl,closing}));return;}
    if(req.url==='/stop'&&req.method==='POST'){res.writeHead(202);res.end(JSON.stringify({accepted:true}));if(!closing){closing=true;setImmediate(()=>Promise.resolve(onStop()).catch(e=>console.error('退出清理失败：'+e.message)));}return;}
    res.writeHead(404);res.end();
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});record.controlUrl=`http://127.0.0.1:${server.address().port}`;
  const write=async()=>{await fs.writeFile(file+'.tmp',JSON.stringify(record),{mode:0o600});await fs.rename(file+'.tmp',file);};await write();
  return {
    record,
    async browser(){
      for(let i=0;i<40;i++){
        try{await fs.mkdir(lock);ownsBrowser=true;await fs.writeFile(path.join(lock,'owner.json'),JSON.stringify(record),{mode:0o600});return null;}
        catch(error){if(error.code!=='EEXIST')throw error;}
        let owner;try{owner=JSON.parse(await fs.readFile(path.join(lock,'owner.json'),'utf8'));}catch{}
        const state=await probeInstance(owner);if(state?.appUrl&&!state.closing)return state.appUrl;
        if(owner&&!alive(owner.pid)){
          // A stale lock is reclaimed only when the recorded process is absent.
          const current=JSON.parse(await fs.readFile(path.join(lock,'owner.json'),'utf8'));
          if(current.id===owner.id){await fs.unlink(path.join(lock,'owner.json'));await fs.rmdir(lock);}continue;
        }
        await new Promise(r=>setTimeout(r,100));
      }
      throw new Error('已有网页服务正在启动或退出，请稍后再试或使用安全退出入口');
    },
    async setUrl(url){record.appUrl=url;await write();},
    async close(){
      if(closed)return;closed=true;closing=true;
      if(ownsBrowser){try{const owner=JSON.parse(await fs.readFile(path.join(lock,'owner.json'),'utf8'));if(owner.id===record.id){await fs.unlink(path.join(lock,'owner.json'));await fs.rmdir(lock);}}catch(e){if(e.code!=='ENOENT')throw e;}}
      await fs.rm(file,{force:true});await fs.rm(file+'.tmp',{force:true});
      await new Promise(r=>{server.close(r);server.closeAllConnections();});
    }
  };
}
