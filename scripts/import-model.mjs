import path from 'node:path';
import { packModel } from '../lib/model-store.mjs';
const [source, manifest, target, model, mode] = process.argv.slice(2);
if (!model) throw new Error('Usage: node scripts/import-model.mjs <model-root> <manifest-relative> <target-store> <model-name>');
if (mode && mode !== '--direct') throw new Error('Optional argument: --direct (requires a filesystem supporting the full model file)');
await packModel(path.resolve(source), manifest, path.resolve(target), model, 1024 ** 3, mode === '--direct' ? 'direct' : 'chunked');
console.log('Model exported and SHA-256 verified.');
