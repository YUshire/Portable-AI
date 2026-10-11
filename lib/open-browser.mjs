import path from 'node:path';
import {spawn} from 'node:child_process';
const literal=value=>"'"+value.replaceAll("'","''")+"'";
export async function openBrowser(url,root){
  if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(url))throw new Error('浏览器入口地址无效');
  if(process.platform==='win32'){
    const exe=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
    const explorer=path.join(process.env.SystemRoot||'C:\\Windows','explorer.exe');
    const script=`$ErrorActionPreference='Stop'; . ${literal(path.join(root,'scripts/windows-native.ps1'))}; [PortableNative]::Detached(${literal(explorer)},[PortableNative]::Quote(${literal(explorer)})+' '+${literal(url)},$env:TEMP,($env:PORTABLE_AI_JOB -eq '1')) | Out-Null`;
    await new Promise((resolve,reject)=>{const child=spawn(exe,['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{cwd:process.env.TEMP,windowsHide:true,stdio:'ignore'});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('无法打开浏览器')));});
  }else spawn(process.platform==='darwin'?'open':'xdg-open',[url],{stdio:'ignore'}).on('error',()=>{});
}
