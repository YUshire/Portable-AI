import React, {useEffect, useState, useSyncExternalStore} from 'react';
import {render, Box, Text, useInput, useStdout} from 'ink';
import TextInput from 'ink-text-input';
import {safeText, wrapRows} from './terminal-view.mjs';

const h=React.createElement;
// Let the terminal choose readable primary text (usually white on dark themes).
// Color is reserved for semantic status; borders and metadata stay neutral.
const colors={user:undefined,assistant:undefined,tool:undefined,result:'gray',error:'red',info:'gray'};

// The renderer owns stdin while mounted. No parallel readline or console logger.
export function createTerminal({workspace,session,connection,onCancel,streams={}}) {
  const model={workspace,session,connection,cards:[],busy:false,started:0,query:null,offset:0,inputHistory:[],historyIndex:0,listeners:new Set(),revision:0};
  const update=()=>{model.revision++;for(const notify of model.listeners)notify();};
  const subscribe=notify=>{model.listeners.add(notify);return()=>model.listeners.delete(notify);};
  const snapshot=()=>model.revision;
  const add=(kind,title,body='')=>{model.cards.push({kind,title:safeText(title),body:safeText(body)});if(model.cards.length>400)model.cards.shift();model.offset=0;update();};
  function App(){
    useSyncExternalStore(subscribe,snapshot);
    const [input,setInput]=useState('');
    const {stdout}=useStdout();const [size,setSize]=useState([stdout.columns||80,stdout.rows||30]);
    useEffect(()=>{const resize=()=>setSize([stdout.columns||80,stdout.rows||30]);stdout.on('resize',resize);const timer=setInterval(()=>{if(model.busy)update();},250);return()=>{clearInterval(timer);stdout.off('resize',resize);};},[]);
    useEffect(()=>setInput(''),[model.query]);
    useInput((value,key)=>{
      if((key.ctrl&&value==='c')||(key.escape&&model.busy)){onCancel();return;}
      if(key.pageUp){model.offset+=Math.max(3,size[1]-15);update();}
      if(key.pageDown){model.offset=Math.max(0,model.offset-Math.max(3,size[1]-15));update();}
      if(model.query?.task&&(key.upArrow||key.downArrow)){
        model.historyIndex=Math.max(0,Math.min(model.inputHistory.length,model.historyIndex+(key.upArrow?-1:1)));
        setInput(model.inputHistory[model.historyIndex]||'');
      }
    });
    const width=Math.max(12,size[0]-6);
    const prompt=safeText(model.query?.prompt||'正在处理任务… Esc / Ctrl+C 取消').trim();
    const promptRows=wrapRows(prompt,width).length,inputRows=wrapRows(model.query?.secret?'•'.repeat(input.length):input,width-2).length;
    const height=Math.max(1,size[1]-12-promptRows-inputRows);
    const rows=[];
    for(const card of model.cards){rows.push({text:'',color:'gray'});for(const text of wrapRows('● '+card.title,width))rows.push({text,color:colors[card.kind],bold:true});for(const text of wrapRows(card.body,width))rows.push({text});}
    const offset=Math.min(model.offset,Math.max(0,rows.length-height));
    const end=rows.length-offset,visible=rows.slice(Math.max(0,end-height),end);
    const elapsed=model.busy?`${Math.floor((Date.now()-model.started)/1000)}s`:'';
    const spinner='◐◓◑◒'[Math.floor(Date.now()/250)%4];
    return h(Box,{flexDirection:'column',width:Math.max(20,size[0])},
      h(Box,{borderStyle:'round',borderColor:'gray',paddingX:1,flexDirection:'column'},
        h(Text,{bold:true},' PORTABLE AI  /  CODING WORKSPACE   v0.3.5'),
        h(Text,{color:'gray',wrap:'truncate-end'},safeText(model.workspace)),
        h(Text,{wrap:'truncate-end'},safeText(model.connection)),
        h(Text,{color:'gray',wrap:'truncate-end'},'Session '+model.session)),
      h(Box,{flexDirection:'column',height,paddingX:2,overflow:'hidden'},...visible.map((row,i)=>h(Text,{key:i,color:row.color,bold:row.bold,wrap:'truncate-end'},row.text||' '))),
      h(Box,{paddingX:2,justifyContent:'space-between'},h(Text,{},h(Text,{color:model.busy?undefined:'green'},model.busy?spinner:'●'),model.busy?` 执行中 · ${elapsed}`:' 就绪 · 可继续输入任务'),h(Text,{color:'gray'},offset?`回看 ↑ ${offset} 行`:'PgUp / PgDn 回看')),
      h(Box,{borderStyle:'round',borderColor:'gray',paddingX:1,flexDirection:'column'},
        h(Text,{bold:true},prompt),
        h(Box,{},h(Text,{bold:true},'❯ '),model.query?h(TextInput,{value:input,onChange:value=>setInput(safeText(value)),mask:model.query.secret?'•':undefined,onSubmit:value=>{
          const query=model.query;if(!query)return;if(query.task&&value.trim()){model.inputHistory.push(value);model.historyIndex=model.inputHistory.length;}
          setInput('');model.query=null;query.cleanup?.();update();query.resolve(value);
        }}):h(Text,{color:'gray'},'等待模型或工具结果'))),
      h(Text,{color:'gray',wrap:'truncate-end'},' /help 帮助  /connect API  /model 模型  /eject 安全弹出  /exit 退出 · ↑↓ 历史 · Ctrl+C 取消/退出'));
  }
  const instance=render(h(App),{...streams,exitOnCtrlC:false,patchConsole:false});
  return {
    add,
    event(e){
      if(e.type==='model'){model.connection=`${e.backend} · ${e.model} · ${e.protocol||'tools'}`;if(e.text)add('assistant',`Agent · 第 ${e.step} 步`,e.text);else update();}
      if(e.type==='tool-start')add('tool','工具 · '+e.name,JSON.stringify(e.arguments,null,2));
      if(e.type==='tool-result')add(e.error||e.result?.denied||e.result?.timedOut||(typeof e.result?.exitCode==='number'&&e.result.exitCode!==0)?'error':'result',e.name+' · 结果',JSON.stringify(e.result,null,2));
      if(e.type==='file-change')add('info','修改 · '+e.path,`${e.beforeBytes} → ${e.afterBytes} 字节`);
      if(e.type==='fallback')add('error','云端未成功 → 本地降级',e.reason);
    },
    progress(value){if(/文件系统|单文件上限|完整权重|完整模型|缓存位置|转用电脑缓存|无法确认/.test(value)){add('info','模型存储判断',value);return;}const last=model.cards.at(-1);if(last?.title==='本地模型准备'){last.body=safeText(value);update();}else add('info','本地模型准备',value);},
    context(values){Object.assign(model,values);update();},
    busy(value){model.busy=value;if(value)model.started=Date.now();update();},
    read(prompt,{secret=false,task=false,signal}={}){
      if(model.query)throw new Error('终端已有待回答的问题');
      return new Promise((resolve,reject)=>{
        const abort=()=>{model.query=null;signal?.removeEventListener('abort',abort);update();reject(signal.reason);};
        if(signal?.aborted){reject(signal.reason);return;}
        model.query={prompt,secret,task,resolve,reject,cleanup:()=>signal?.removeEventListener('abort',abort)};
        signal?.addEventListener('abort',abort,{once:true});model.historyIndex=model.inputHistory.length;update();
      });
    },
    exitInput(){const q=model.query;if(q){q.cleanup?.();model.query=null;q.resolve('/exit');update();}},
    clear(){model.cards=[];model.offset=0;update();},
    close(){model.query?.cleanup?.();instance.unmount();}
  };
}
