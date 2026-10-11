import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { inspectFilesystem } from './storage-capability.mjs';

export async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function inside(root, relative) {
  const resolved = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), resolved);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Invalid model path');
  return resolved;
}

// Parts are below FAT32's single-file limit. The original Ollama manifest and
// content-addressed blobs are retained; nothing is quantized or re-downloaded.
export async function packModel(sourceRoot, manifestRelative, targetRoot, model, partSize = 1024 ** 3, storage = 'chunked') {
  if (!['chunked', 'direct'].includes(storage)) throw new Error('Invalid model storage');
  if (path.resolve(sourceRoot) === path.resolve(targetRoot)) throw new Error('Source and target stores must differ');
  const manifest = JSON.parse(await fs.promises.readFile(inside(sourceRoot, manifestRelative), 'utf8'));
  const entries = new Map([manifest.config, ...manifest.layers].map(x => [x.digest, x]));
  await fs.promises.mkdir(targetRoot, { recursive: true });
  const files = [];
  for (const entry of entries.values()) {
    if (!/^sha256:[a-f0-9]{64}$/.test(entry.digest)) throw new Error('Invalid model digest');
    const name = entry.digest.replace(':', '-');
    const source = inside(sourceRoot, `blobs/${name}`);
    const size = (await fs.promises.stat(source)).size;
    if (size !== entry.size) throw new Error(`Model size mismatch: ${name}`);
    const parts = [];
    const hash = crypto.createHash('sha256');
    if (storage === 'direct') {
      const dest = inside(targetRoot, `blobs/${name}`);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.copyFile(source, dest);
      if (await hashFile(dest) !== entry.digest.slice(7)) throw new Error(`Model hash mismatch: ${name}`);
      files.push({ path: `blobs/${name}`, size, sha256: entry.digest.slice(7) });
      continue;
    }
    for (let offset = 0, index = 0; offset < size; offset += partSize, index++) {
      const relative = `parts/${name}.${String(index).padStart(3, '0')}`;
      const dest = inside(targetRoot, relative);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      const tap = new Transform({ transform(chunk, enc, cb) { hash.update(chunk); cb(null, chunk); } });
      await pipeline(fs.createReadStream(source, { start: offset, end: Math.min(size, offset + partSize) - 1 }), tap, fs.createWriteStream(dest));
      parts.push({ path: relative, size: Math.min(partSize, size - offset) });
      console.log(`Packed ${name.slice(0, 20)} part ${index + 1}`);
    }
    if (hash.digest('hex') !== entry.digest.slice(7)) throw new Error(`Model hash mismatch: ${name}`);
    files.push({ path: `blobs/${name}`, size, sha256: entry.digest.slice(7), parts });
  }
  // Remove host-specific provenance paths from the exported manifest.
  for (const layer of manifest.layers) delete layer.from;
  const catalog = { version: 1, storage, model, manifestRelative, manifest, files };
  if (storage === 'direct') {
    const dest = inside(targetRoot, manifestRelative);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, JSON.stringify(manifest));
  }
  await fs.promises.writeFile(path.join(targetRoot, 'catalog.json'), JSON.stringify(catalog, null, 2));
  return catalog;
}

export async function bundleInfo(storeRoot) {
  try {
    const catalog = JSON.parse(await fs.promises.readFile(path.join(storeRoot, 'catalog.json'), 'utf8'));
    if (catalog.version !== 1 || typeof catalog.model !== 'string' || !Array.isArray(catalog.files)) throw new Error('Invalid model catalog');
    return { model: catalog.model, bytes: catalog.files.reduce((n, item) => n + item.size, 0), storage: catalog.storage || 'chunked' };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function reusableStore(catalog, candidates, progress = () => {}) {
  const normalize = manifest => {const copy=JSON.parse(JSON.stringify(manifest));for(const layer of copy.layers || [])delete layer.from;return JSON.stringify(copy);};
  for(const root of [...new Set(candidates.filter(Boolean).map(p=>path.resolve(p)))]){
    try{
      const manifest=JSON.parse(await fs.promises.readFile(inside(root,catalog.manifestRelative),'utf8'));
      if(normalize(manifest)!==normalize(catalog.manifest))continue;
      let valid=true;
      for(const item of catalog.files){
        const file=inside(root,item.path),stat=await fs.promises.stat(file);
        if(stat.size!==item.size){valid=false;break;}
        let verified=false;
        try{const saved=JSON.parse(await fs.promises.readFile(path.join(root,'.portable-verified',item.sha256+'.json'),'utf8'));verified=saved.sha256===item.sha256&&saved.mtimeMs===stat.mtimeMs;}catch{}
        if(!verified){progress(`正在校验已有完整模型：${root}`);if(await hashFile(file)!==item.sha256){valid=false;break;}}
      }
      if(valid){progress(`复用已有完整模型：${root}（无需从 U 盘还原）`);return root;}
    }catch{}
  }
  return null;
}

export async function prepareModel(storeRoot, cacheRoot, progress = () => {}, candidates = [], {inspect=inspectFilesystem,assemble=restoreModel} = {}) {
  const info = await bundleInfo(storeRoot);
  if (!info) throw new Error('未导入随盘模型，请先导入一个 Ollama 聊天模型');
  const catalog = JSON.parse(await fs.promises.readFile(path.join(storeRoot, 'catalog.json'), 'utf8'));
  const disk=await inspect(storeRoot);
  const largest=Math.max(0,...catalog.files.map(f=>f.size));
  progress(`模型所在文件系统：${disk.filesystem}；最大权重文件 ${(largest/1024**3).toFixed(2)} GiB`);
  if(info.storage !== 'direct'){
    // Trust the actual complete store, even if its old catalog still says chunked.
    const portable=await reusableStore(catalog,[storeRoot,path.join(storeRoot,'.portable-store')],progress);
    if(portable){progress('直接读取 U 盘中的完整权重，无需回迁电脑');return {model:catalog.model,modelsRoot:portable};}
    if(disk.known&&largest<=disk.maxFileBytes){
      const portableRoot=path.join(storeRoot,'.portable-store');
      try{
        if(disk.readOnly)throw Object.assign(new Error('U 盘为只读'),{code:'EROFS'});
        if(disk.freeBytes<info.bytes+256*1024**2)throw Object.assign(new Error('U 盘剩余空间不足以合并完整权重'),{code:'ENOSPC'});
        progress(`${disk.filesystem} 可以容纳完整权重，优先在 U 盘内合并分块`);
        const model=await assemble(storeRoot,portableRoot,value=>progress(value.replace('正在从 U 盘还原模型','正在 U 盘内合并模型')));
        progress('U 盘完整权重已就绪，直接从 U 盘运行');return {model,modelsRoot:portableRoot};
      }catch(error){
        if(!['EACCES','EPERM','EROFS','ENOSPC','EFBIG','ENOENT'].includes(error.code)&&!error.message.startsWith('缓存空间不足'))throw error;
        progress(`U 盘内合并不可用：${error.message}；转用电脑缓存`);
      }
    }else progress(disk.known?`${disk.filesystem} 单文件上限 ${(disk.maxFileBytes/1024**3).toFixed(2)} GiB，当前完整权重超限，需要电脑缓存`:'无法确认此文件系统的单文件能力；分块权重采用电脑缓存');
    progress(`模型缓存位置：${cacheRoot}`);
    const existing=await reusableStore(catalog,[cacheRoot,...candidates],progress);
    if(existing)return {model:catalog.model,modelsRoot:existing};
    const cacheDisk=await inspect(cacheRoot);
    if(cacheDisk.known&&largest>cacheDisk.maxFileBytes)throw new Error(`指定缓存文件系统 ${cacheDisk.filesystem} 也无法容纳完整权重，请将 PORTABLE_AI_CACHE 指向支持大文件的磁盘`);
    progress(`没有找到通过校验的完整模型，将从分块还原到：${cacheRoot}`);
    return {model:await restoreModel(storeRoot,cacheRoot,progress),modelsRoot:cacheRoot};
  }
  progress(`正在校验随盘模型 ${info.model}，权重直接从 U 盘读取`);
  for (const item of catalog.files) {
    const file = inside(storeRoot, item.path);
    if ((await fs.promises.stat(file)).size !== item.size || await hashFile(file) !== item.sha256) throw new Error('随盘完整模型校验失败');
  }
  const manifestPath = inside(storeRoot, catalog.manifestRelative);
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  if (JSON.stringify(manifest) !== JSON.stringify(catalog.manifest)) throw new Error('随盘模型清单不匹配');
  return { model: info.model, modelsRoot: storeRoot };
}

export async function chooseImportStorage(sourceRoot,manifestRelative,targetRoot,{inspect=inspectFilesystem}={}){
  const manifest=JSON.parse(await fs.promises.readFile(inside(sourceRoot,manifestRelative),'utf8'));
  const largest=Math.max(...[manifest.config,...manifest.layers].map(f=>f.size));
  const disk=await inspect(targetRoot);
  return {storage:disk.known&&largest<=disk.maxFileBytes?'direct':'chunked',filesystem:disk.filesystem,largestBytes:largest};
}

export async function restoreModel(storeRoot, cacheRoot, progress = () => {}) {
  const catalog = JSON.parse(await fs.promises.readFile(path.join(storeRoot, 'catalog.json'), 'utf8'));
  if (catalog.version !== 1) throw new Error('Unsupported model catalog');
  await fs.promises.mkdir(cacheRoot, { recursive: true });
  const required = catalog.files.reduce((sum, item) => {
    try { return sum + (fs.statSync(inside(cacheRoot, item.path)).size === item.size ? 0 : item.size); }
    catch { return sum + item.size; }
  }, 0);
  const disk = await fs.promises.statfs(cacheRoot);
  if (disk.bavail * disk.bsize < required + 256 * 1024 ** 2) throw new Error(`缓存空间不足，需要约 ${((required + 256 * 1024 ** 2) / 1024 ** 3).toFixed(2)} GiB 可用空间`);
  const verificationDir = path.join(cacheRoot, '.portable-verified');
  await fs.promises.mkdir(verificationDir, { recursive: true });
  for (const item of catalog.files) {
    if (!/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid model checksum');
    const dest = inside(cacheRoot, item.path);
    const marker = path.join(verificationDir, item.sha256 + '.json');
    let verified = false;
    try {
      const stat = await fs.promises.stat(dest);
      const saved = JSON.parse(await fs.promises.readFile(marker, 'utf8'));
      verified = stat.size === item.size && saved.sha256 === item.sha256 && saved.mtimeMs === stat.mtimeMs;
    } catch {}
    if (!verified) {
      // Ollama may touch model timestamps. Revalidate the SSD cache before
      // deciding to read gigabytes from a slow USB drive again.
      try {
        if ((await fs.promises.stat(dest)).size === item.size) {
          progress('正在校验电脑已有模型缓存');
          verified = await hashFile(dest) === item.sha256;
          if (verified) {
            const stat = await fs.promises.stat(dest);
            await fs.promises.writeFile(marker, JSON.stringify({ sha256: item.sha256, mtimeMs: stat.mtimeMs }));
            await fs.promises.rm(dest + '.partial', { force: true });
          }
        }
      } catch {}
    }
    if (!verified) {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      const temp = dest + '.partial';
      const output = await fs.promises.open(temp, 'w');
      const hash = crypto.createHash('sha256');
      let total = 0;
      let lastProgress = 0;
      try {
        for (const part of item.parts) {
          progress(`正在从 U 盘还原模型：${Math.round(total / item.size * 100)}%`);
          const input = inside(storeRoot, part.path);
          if ((await fs.promises.stat(input)).size !== part.size) throw new Error('U 盘模型分块不完整');
          for await (const chunk of fs.createReadStream(input)) {
            hash.update(chunk);
            let offset = 0;
            while (offset < chunk.length) offset += (await output.write(chunk, offset, chunk.length - offset)).bytesWritten;
            total += chunk.length;
            if (total - lastProgress >= 64 * 1024 ** 2) {
              progress(`正在从 U 盘还原模型：${Math.round(total / item.size * 100)}%`);
              lastProgress = total;
            }
          }
        }
      } finally { await output.close(); }
      if (total !== item.size || hash.digest('hex') !== item.sha256) {
        await fs.promises.rm(temp, { force: true });
        throw new Error('模型校验失败，请重新复制 U 盘模型');
      }
      await fs.promises.rename(temp, dest);
      const stat = await fs.promises.stat(dest);
      await fs.promises.writeFile(marker, JSON.stringify({ sha256: item.sha256, mtimeMs: stat.mtimeMs }));
    }
  }
  const manifestPath = inside(cacheRoot, catalog.manifestRelative);
  await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.promises.writeFile(manifestPath, JSON.stringify(catalog.manifest));
  return catalog.model;
}
