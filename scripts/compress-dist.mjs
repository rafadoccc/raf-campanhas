// Pré-compressão do painel compilado: grava .br e .gz ao lado de cada arquivo de texto de
// apps/web/dist. O servidor (@fastify/static com preCompressed) entrega a versão comprimida
// pronta, sem gastar CPU por pedido — importante numa VPS fraca e em conexões lentas.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'dist');
const TEXT = /\.(js|css|html|svg|json|txt|webmanifest)$/;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else yield full;
  }
}

let before = 0, after = 0, count = 0;
for (const file of files(dist)) {
  if (!TEXT.test(file)) continue;
  const data = readFileSync(file);
  if (data.length < 1024) continue; // pequeno demais para valer a pena
  const br = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
  writeFileSync(`${file}.br`, br);
  writeFileSync(`${file}.gz`, gzipSync(data, { level: 9 }));
  before += data.length; after += br.length; count++;
}
console.log(`Painel comprimido: ${count} arquivos, ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB (brotli).`);
