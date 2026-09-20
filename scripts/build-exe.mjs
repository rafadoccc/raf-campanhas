#!/usr/bin/env node
// Compila o inicializador "Central de Campanhas.exe" com o csc.exe que já vem no
// Windows (.NET Framework 4). Sem dependências. O caminho do projeto é gravado
// no executável, então ele pode ser copiado para a área de trabalho.
// Uso: npm.cmd run build:exe
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const csc = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe';
if (process.platform !== 'win32' || !existsSync(csc)) {
  console.error('  ✖  csc.exe não encontrado. Este build só funciona no Windows com .NET Framework 4.');
  process.exit(1);
}

const tmp = path.join(root, '.tmp');
mkdirSync(tmp, { recursive: true });
const fonte = path.join(tmp, 'Launcher.cs');
writeFileSync(fonte, readFileSync(path.join(root, 'launcher', 'Launcher.cs'), 'utf8').replaceAll('@@ROOT@@', () => root.replaceAll('"', '""')), 'utf8');

const saida = path.join(root, 'launcher', 'Central de Campanhas.exe');
const r = spawnSync(csc, ['/nologo', '/target:exe', '/optimize+', '/codepage:65001', `/out:${saida}`, fonte], { encoding: 'utf8' });
if (r.status !== 0) {
  console.error('  ✖  Falha na compilação:\n' + (r.stdout || r.stderr));
  process.exit(1);
}
console.log(`  ✔  ${path.relative(root, saida)}`);
console.log(`     Aponta para: ${root}`);

// Cópia opcional para a área de trabalho: npm.cmd run build:exe -- --desktop
// A pasta pode estar redirecionada (ex.: OneDrive\Área de Trabalho) e ter acentos;
// por isso a saída do PowerShell é lida como UTF-8 explicitamente.
if (process.argv.includes('--desktop')) {
  const r2 = spawnSync('powershell', ['-NoProfile', '-Command',
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath('Desktop')"], { encoding: 'utf8' });
  const desktop = r2.stdout.trim();
  if (!desktop || !existsSync(desktop)) {
    console.error(`  ✖  Não encontrei a área de trabalho (${desktop || 'vazio'}). Copie o .exe manualmente.`);
    process.exit(1);
  }
  const destino = path.join(desktop, 'Central de Campanhas.exe');
  copyFileSync(saida, destino);
  console.log(`  ✔  Copiado para ${destino}`);
}
