import stringWidth from 'string-width';

// Model/tool text must never be allowed to send terminal control sequences.
export function safeText(value){
  return String(value??'').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'').replace(/\t/g,'  ');
}
export function wrapRows(value,width){
  const rows=[];
  for(const line of safeText(value).split('\n')){
    let row='',used=0;
    for(const char of line){const size=stringWidth(char);if(used+size>width&&row){rows.push(row);row='';used=0;}row+=char;used+=size;}
    rows.push(row);
  }
  return rows;
}
