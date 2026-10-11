import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
export function filesystemCapability(filesystem){
  const name=String(filesystem||'unknown').trim().toUpperCase();
  if(['FAT','FAT16'].includes(name))return {filesystem:name,known:true,maxFileBytes:2**31-1};
  if(['FAT32','VFAT','MSDOS'].includes(name))return {filesystem:name,known:true,maxFileBytes:2**32-1};
  if(['EXFAT','NTFS','APFS','HFS','HFS+','HFSPLUS','EXT2','EXT3','EXT4','XFS','BTRFS','ZFS','REFS','OVERLAY','TMPFS'].includes(name))return {filesystem:name,known:true,maxFileBytes:Infinity};
  return {filesystem:name,known:false,maxFileBytes:null};
}
export async function inspectFilesystem(directory){
  let existing=path.resolve(directory);
  for(;;){try{existing=await fs.realpath(existing);break;}catch(e){if(e.code!=='ENOENT')throw e;const parent=path.dirname(existing);if(parent===existing)throw e;existing=parent;}}
  const stat=await fs.statfs(existing);let filesystem='unknown';
  try{
    if(process.platform==='win32'){
      const drive=path.parse(existing).root.slice(0,1);if(!/^[A-Za-z]$/.test(drive))throw new Error('Network volume');
      const script=`(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}:'").FileSystem`;
      const binary=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
      const result=await execute(binary,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:5000});filesystem=result.stdout.trim();
    }else if(process.platform==='darwin'){
      const result=await execute('/usr/bin/stat',['-f','%T',existing],{timeout:3000});filesystem=result.stdout.trim();
    }else{
      const result=await execute('df',['-PT',existing],{timeout:3000});filesystem=result.stdout.trim().split('\n').at(-1).trim().split(/\s+/)[1];
    }
  }catch{}
  return {...filesystemCapability(filesystem),freeBytes:stat.bavail*stat.bsize,path:existing};
}
