#!/usr/bin/env node
// Abertura de sessão para agentes de IA. Imprime tudo que um agente precisa saber
// antes da primeira edição: estado, tarefas com dono, handoffs recentes e commits.
// Ver AGENTS.md, Seção 1.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = file => {
  const full = path.join(root, file);
  return existsSync(full) ? readFileSync(full, 'utf8') : null;
};

const rule = title => console.log(`\n${'─'.repeat(72)}\n  ${title}\n${'─'.repeat(72)}`);

console.log('\n  BRIEFING DE SESSÃO · raf-campanhas');
console.log('  Leia tudo antes de editar qualquer arquivo. Contrato: AGENTS.md\n');

// ---------------------------------------------------------------- estado
rule('ESTADO ATUAL  (.ai/STATE.md)');
const state = read('.ai/STATE.md');
if (!state) {
  console.log('  ⚠  .ai/STATE.md não existe. O protocolo não foi inicializado.');
} else {
  // Fase + tabela de fases + o que está quebrado: o suficiente para orientar.
  const fase = state.match(/## Fase atual[\s\S]*?(?=\n## )/);
  const quebrado = state.match(/## O que está quebrado[\s\S]*?(?=\n## )/);
  console.log(fase ? fase[0].trim() : '  (seção "Fase atual" ausente)');
  if (quebrado) console.log(`\n${quebrado[0].trim()}`);
}

// ---------------------------------------------------------------- tarefas
rule('TAREFAS  (.ai/TASKS.md)');
const tasks = read('.ai/TASKS.md') ?? '';
const rows = [...tasks.matchAll(/^\[(.)\]\s+(T-\d+)\s+(.+?)\s{2,}owner:\s*(\S+)\s+since:\s*(\S+)/gm)]
  .map(([, mark, id, title, owner, since]) => ({ mark, id, title: title.trim(), owner, since }));

const open = rows.filter(r => r.mark !== 'x');
const mine = rows.filter(r => r.mark === '~');
if (!rows.length) {
  console.log('  (nenhuma tarefa registrada)');
} else {
  console.log(`  ${rows.length} tarefas · ${open.length} abertas · ${mine.length} em andamento\n`);
  for (const r of mine) {
    const idade = horas(r.since);
    const aviso = idade !== null && idade > 24 ? `  ⚠ LOCK EXPIRADO (${Math.floor(idade)}h)` : '';
    console.log(`  [~] ${r.id}  ${r.title.padEnd(46)} ${r.owner}${aviso}`);
  }
  if (mine.length) console.log('');
  const livres = open.filter(r => r.mark === ' ').slice(0, 8);
  for (const r of livres) console.log(`  [ ] ${r.id}  ${r.title}`);
  const resto = open.filter(r => r.mark === ' ').length - livres.length;
  if (resto > 0) console.log(`      … e mais ${resto} abertas em .ai/TASKS.md`);
}

// ---------------------------------------------------------------- decisões
rule('DECISÕES FECHADAS  (.ai/DECISIONS.md)  — não contrarie sem falar com o humano');
const adrs = [...(read('.ai/DECISIONS.md') ?? '').matchAll(/^## (ADR-\d+) — (.+)$/gm)];
if (!adrs.length) console.log('  (nenhuma ADR registrada)');
for (const [, id, titulo] of adrs) console.log(`  ${id}  ${titulo}`);

// ---------------------------------------------------------------- handoff
rule('ÚLTIMAS SESSÕES  (.ai/HANDOFF.md)');
const handoff = read('.ai/HANDOFF.md') ?? '';
const entradas = handoff.split(/^## /m).slice(1).slice(0, 3);
if (!entradas.length) {
  console.log('  (nenhuma sessão registrada ainda — você é o primeiro)');
}
for (const entrada of entradas) {
  console.log(`\n  ── ${entrada.trim().split('\n')[0]}`);
  for (const linha of entrada.trim().split('\n').slice(1)) {
    if (linha.trim()) console.log(`     ${linha.trim()}`);
  }
}

// ---------------------------------------------------------------- git
rule('COMMITS RECENTES');
try {
  const log = execFileSync('git', ['log', '--oneline', '-12'], { cwd: root, encoding: 'utf8' });
  console.log(log.trimEnd().split('\n').map(l => `  ${l}`).join('\n'));
  const sujo = execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trimEnd();
  if (sujo) {
    console.log('\n  Working tree com alterações não commitadas:');
    console.log(sujo.split('\n').map(l => `  ${l}`).join('\n'));
    console.log('\n  ⚠  Pode ser trabalho em andamento do outro agente. Verifique os locks acima.');
  }
} catch {
  console.log('  (git indisponível)');
}

console.log(`\n${'─'.repeat(72)}`);
console.log('  Próximo passo: reivindique sua tarefa em .ai/TASKS.md antes de editar.');
console.log(`${'─'.repeat(72)}\n`);

function horas(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (Date.now() - t) / 3_600_000 : null;
}
