import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';

export async function startSafeExit(root,{eject=true,checkOnly=false,quiet=false}={}){
  if(process.platform!=='win32')throw new Error('系统安全弹出入口目前支持 Windows；其他系统请先退出程序，再使用系统弹出');
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'PortableAI-exit-'));
  for(const name of ['windows-native.ps1','safe-exit-windows.ps1','start-exit-helper.ps1','usb-disk-info.ps1'])await fs.copyFile(path.join(root,'scripts',name),path.join(temp,name));
  const manifest=path.join(temp,'request.json');await fs.writeFile(manifest,JSON.stringify({root:path.resolve(root),eject,checkOnly,quiet}),{mode:0o600});
  const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  await new Promise((resolve,reject)=>{
    const child=spawn(powershell,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(temp,'start-exit-helper.ps1'),'-Manifest',manifest],{cwd:temp,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let error='';child.stderr.on('data',c=>error+=c);child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('安全退出助手启动失败：'+error.slice(-400))));
  });
  return {accepted:true,resultFile:path.join(temp,'result.json')};
}
