import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const schema = (properties,required) => ({type:'object',properties,required,additionalProperties:false});
const str = {type:'string'};
export const agentTools = [
  {name:'list_files',description:'List immediate children of a project directory. Use . for project root.',parameters:schema({path:str},['path'])},
  {name:'read_file',description:'Read a UTF-8 file, optionally with 1-based startLine/endLine. Long outputs are truncated.',parameters:schema({path:str,startLine:{type:'integer'},endLine:{type:'integer'}},['path'])},
  {name:'write_file',description:'Create or replace a small UTF-8 project file. Read existing files first. Prefer edit_file for changes.',parameters:schema({path:str,content:str},['path','content'])},
  {name:'edit_file',description:'Replace exactly one matching substring in a UTF-8 project file. Fails if search is missing or ambiguous.',parameters:schema({path:str,search:str,replace:str},['path','search','replace'])},
  {name:'run_command',description:'Execute a program with explicit argv in the project directory. node uses the bundled Node. No shell is automatically used. Ask for a test run after editing.',parameters:schema({command:str,args:{type:'array',items:str}},['command','args'])}
];
const limit = text => text.length > 12000 ? text.slice(0,12000)+'\n[output truncated; request a smaller line range]' : text;
const within = (root,p) => { const rel = path.relative(root,p); return rel !== '..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel); };

export class WorkspaceTools {
  constructor(root,{approve=async()=>false,signal,onEvent=()=>{},changes={},commandTimeoutMs=60000}={}) {
    this.root=path.resolve(root); this.approve=approve; this.signal=signal; this.onEvent=onEvent; this.changes=changes; this.commandTimeoutMs=commandTimeoutMs;
  }
  async init() {
    this.root = await fs.realpath(this.root);
    if (this.root === path.parse(this.root).root || !(await fs.stat(this.root)).isDirectory()) throw new Error('请指定一个项目文件夹，不能使用整个磁盘');
  }
  async resolve(relative) {
    if (typeof relative !== 'string' || !relative || relative.includes('\0') || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) throw new Error('工具路径必须是项目内的相对路径');
    const target = path.resolve(this.root,relative);
    if (!within(this.root,target)) throw new Error('拒绝访问项目目录外的文件');
    const pieces = path.relative(this.root,target).split(/[\\/]/);
    if (pieces.some(p => p === '.git' || /^\.env(?:\.|$)/i.test(p))) throw new Error('不通过 agent 文件工具访问 .git 或 .env');
    let parent=target;
    while (true) {
      try {
        const real=await fs.realpath(parent);
        if (!within(this.root,real)) throw new Error('拒绝通过符号链接访问项目目录外');
        if (path.relative(this.root,real).split(/[\\/]/).some(p => p === '.git' || /^\.env(?:\.|$)/i.test(p))) throw new Error('拒绝通过链接访问 .git 或 .env');
        break;
      }
      catch (e) { if (e.code !== 'ENOENT') throw e; parent=path.dirname(parent); }
    }
    return target;
  }
  validate(name,args) {
    const tool=agentTools.find(t => t.name === name);
    if (!tool || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('未知工具或参数格式错误');
    for (const key of tool.parameters.required) if (!(key in args)) throw new Error(`工具缺少参数 ${key}`);
    for (const [key,value] of Object.entries(args)) {
      const rule=tool.parameters.properties[key];
      if (!rule || (rule.type === 'string' && typeof value !== 'string') || (rule.type === 'integer' && !Number.isInteger(value)) || (rule.type === 'array' && (!Array.isArray(value) || value.some(x => typeof x !== 'string')))) throw new Error(`工具参数 ${key} 类型错误`);
    }
  }
  async read(target) {
    const stat=await fs.stat(target);
    if (!stat.isFile() || stat.size > 512*1024) throw new Error('仅支持不超过 512 KiB 的文本文件');
    const buffer=await fs.readFile(target);
    if (buffer.includes(0)) throw new Error('不读取或修改二进制文件');
    return new TextDecoder('utf-8',{fatal:true}).decode(buffer);
  }
  async write(target,text) {
    if (Buffer.byteLength(text) > 512*1024) throw new Error('文件内容超过 512 KiB');
    const relative=path.relative(this.root,target);
    let before=null;
    try { before=await this.read(target); } catch(e) { if(e.code !== 'ENOENT') throw e; }
    if (!this.changes[relative]) this.changes[relative]={before,after:before};
    await fs.mkdir(path.dirname(target),{recursive:true});
    // Recheck the real parent after mkdir so junctions cannot bypass the boundary.
    await this.resolve(relative);
    await fs.writeFile(target,text,'utf8'); this.changes[relative].after=text;
    this.onEvent({type:'file-change',path:relative,beforeBytes:Buffer.byteLength(before || ''),afterBytes:Buffer.byteLength(text)});
    return {path:relative,writtenBytes:Buffer.byteLength(text)};
  }
  async execute(name,args) {
    this.signal?.throwIfAborted(); this.validate(name,args);
    if (name === 'run_command') return this.command(args);
    const target=await this.resolve(args.path);
    if (name === 'list_files') {
      const entries=await fs.readdir(target,{withFileTypes:true});
      return entries.filter(e => !['.git','node_modules','runtime','models'].includes(e.name) && !/^\.env(?:\.|$)/i.test(e.name)).slice(0,200).map(e => ({name:e.name,type:e.isSymbolicLink()?'link':e.isDirectory()?'directory':'file'}));
    }
    if (name === 'read_file') {
      if ((args.startLine !== undefined && args.startLine < 1) || (args.endLine !== undefined && args.endLine < (args.startLine || 1))) throw new Error('文件行号范围无效');
      const lines=(await this.read(target)).split('\n'); const start=args.startLine || 1;
      return {path:args.path,totalLines:lines.length,text:limit(lines.slice(start-1,args.endLine).map((line,i)=>`${start+i}: ${line}`).join('\n'))};
    }
    if (name === 'write_file') return this.write(target,args.content);
    const before=await this.read(target);
    if (!args.search || before.split(args.search).length !== 2) throw new Error('edit_file 搜索内容必须且只能匹配一次');
    return this.write(target,before.replace(args.search,args.replace));
  }
  async command({command,args}) {
    if (!command || /[\r\n\0]/.test(command) || args.length > 100 || args.some(a => a.includes('\0'))) throw new Error('命令参数无效');
    if (!await this.approve({command,args,workspace:this.root})) return {exitCode:null,denied:true,output:'用户未授权执行此命令。不要重试同一命令。'};
    this.signal?.throwIfAborted();
    const executable=command === 'node' ? process.execPath : command;
    const env={...process.env}; delete env.PORTABLE_API_KEY; delete env.PORTABLE_VAULT_PASSWORD;
    return new Promise((resolve,reject)=>{
      let output='',timedOut=false,aborted=false,stopPromise;
      const child=spawn(executable,args,{cwd:this.root,env,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
      const capture=chunk=>{output=(output+chunk.toString()).slice(-12000);}; child.stdout.on('data',capture); child.stderr.on('data',capture);
      const stop=()=>{
        if (stopPromise) return stopPromise;
        stopPromise=new Promise(done=>{
          if (!child.pid) return done();
          if(process.platform==='win32') {
            const killer=spawn(path.join(process.env.SystemRoot || 'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
            killer.once('error',done); killer.once('close',done);
          } else {try {process.kill(-child.pid,'SIGKILL');} catch{} done();}
        }); return stopPromise;
      };
      const abort=()=>{aborted=true;stop();};
      const timer=setTimeout(()=>{timedOut=true;stop();},this.commandTimeoutMs);
      this.signal?.addEventListener('abort',abort,{once:true});
      const cleanup=()=>{clearTimeout(timer);this.signal?.removeEventListener('abort',abort);};
      child.once('error',error=>{cleanup();reject(new Error(`无法执行 ${command}：${error.code || '启动失败'}`));});
      child.once('close',async code=>{cleanup();if(stopPromise) await stopPromise; if(aborted) reject(this.signal.reason || new Error('任务已取消')); else resolve({exitCode:code,timedOut,output});});
    });
  }
  diff() {
    const lines=text=>!text?[]:(text.endsWith('\n')?text.slice(0,-1):text).split('\n');
    const block=(text,prefix)=>lines(text).map(l=>prefix+l).join('\n')+(text&&!text.endsWith('\n')?'\n\\ No newline at end of file':'');
    return Object.entries(this.changes).filter(([,c])=>c.before !== c.after).map(([file,c])=>`--- ${c.before===null?'/dev/null':'a/'+file}\n+++ b/${file}\n@@ -${lines(c.before).length?1:0},${lines(c.before).length} +${lines(c.after).length?1:0},${lines(c.after).length} @@\n`+(c.before?block(c.before,'-')+'\n':'')+(c.after?block(c.after,'+')+'\n':'')).join('');
  }
}
