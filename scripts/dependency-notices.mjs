import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const lock=JSON.parse(await fs.readFile(path.join(root,'package-lock.json'),'utf8'));
let text='# Terminal dependency notices\n\nPortableAI uses Ink (React for CLI) and ink-text-input. The complete USB package retains each dependency’s original license files inside node_modules. Dependencies are locked in package-lock.json.\n\n';
for(const relative of Object.keys(lock.packages).filter(p=>p.startsWith('node_modules/')).sort()){
  const directory=path.join(root,relative),pkg=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8'));
  text+=`## ${pkg.name} ${pkg.version}\n\nLicense: ${pkg.license||'See package license'}.\n\n`;
  for(const name of (await fs.readdir(directory)).filter(n=>/^(license|copying|notice)(\.|$)/i.test(n))){
    if(!(await fs.stat(path.join(directory,name))).isFile())continue;
    text+=`### ${name}\n\n${await fs.readFile(path.join(directory,name),'utf8')}\n\n`;
  }
}
await fs.writeFile(path.join(root,'THIRD-PARTY-NOTICES.md'),text.trimEnd()+'\n');
