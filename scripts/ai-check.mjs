#!/usr/bin/env node
// Validador do protocolo multi-agente (AGENTS.md).
// Roda antes de encerrar uma sessão e em CI. Sai com código 1 se houver erro.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const AGENTES = new Set(['claude', 'codex', '—']);
const LOCK_MAX_HORAS = 24;

const erros = [];
const avisos = [];
const falha = (onde, msg) => erros.push(`${onde}: ${msg}`);
const alerta = (onde, msg) => avisos.push(`${onde}: ${msg}`);

const ler = file => {
  const full = path.join(root, file);
  if (!existsSync(full)) { falha(file, 'arquivo obrigatório do protocolo não existe'); return null; }
  return readFileSync(full, 'utf8');
};

// ------------------------------------------------------------ 1. arquivos base
for (const f of ['AGENTS.md', 'CLAUDE.md', '.ai/STATE.md', '.ai/TASKS.md', '.ai/DECISIONS.md', '.ai/HANDOFF.md']) ler(f);

const claude = existsSync(path.join(root, 'CLAUDE.md')) ? readFileSync(path.join(root, 'CLAUDE.md'), 'utf8') : '';
if (claude && !claude.includes('@AGENTS.md')) {
  falha('CLAUDE.md', 'não importa @AGENTS.md — Claude Code não vai ler o contrato compartilhado');
}

// ------------------------------------------------------------ 2. tarefas e locks
const tasks = ler('.ai/TASKS.md');
if (tasks) {
  const linhas = [...tasks.matchAll(/^\[(.)\]\s+(T-\d+)\s+(.+?)\s{2,}owner:\s*(\S+)\s+since:\s*(\S+)\s*$/gm)];
  const brutas = [...tasks.matchAll(/^\[.\]\s+T-\d+.*$/gm)];
  if (brutas.length !== linhas.length) {
    falha('.ai/TASKS.md', `${brutas.length - linhas.length} linha(s) de tarefa fora do formato "[x] T-000  Título  owner: nome  since: data"`);
  }

  const vistos = new Map();
  for (const [, mark, id, titulo, owner, since] of linhas) {
    if (vistos.has(id)) falha('.ai/TASKS.md', `ID duplicado ${id} (IDs nunca são reutilizados)`);
    vistos.set(id, true);

    if (!AGENTES.has(owner)) falha('.ai/TASKS.md', `${id}: dono "${owner}" desconhecido — use claude, codex ou —`);
    if (!'  ~x!'.includes(mark)) falha('.ai/TASKS.md', `${id}: marcador "[${mark}]" inválido — use [ ] [~] [x] [!]`);

    if (mark === '~' && owner === '—') falha('.ai/TASKS.md', `${id}: marcada em andamento sem dono — reivindique ou volte para [ ]`);
    if (mark === '~' && since === '—') falha('.ai/TASKS.md', `${id}: em andamento sem "since" — registre o horário UTC da reivindicação`);
    if (mark === 'x' && owner !== '—') falha('.ai/TASKS.md', `${id}: concluída mas ainda com dono "${owner}" — libere o lock`);
    if (mark === '!' && !titulo.trim()) falha('.ai/TASKS.md', `${id}: bloqueada sem explicação do que a desbloqueia`);

    if (mark === '~' && since !== '—') {
      const t = Date.parse(since);
      if (!Number.isFinite(t)) {
        falha('.ai/TASKS.md', `${id}: "since: ${since}" não é uma data ISO-8601 válida`);
      } else {
        const horas = (Date.now() - t) / 3_600_000;
        if (horas > LOCK_MAX_HORAS) {
          alerta('.ai/TASKS.md', `${id}: lock de "${owner}" com ${Math.floor(horas)}h — expirado, pode ser assumido`);
        }
        if (horas < -1) falha('.ai/TASKS.md', `${id}: "since" está no futuro`);
      }
    }
  }
}

// ------------------------------------------------------------ 3. handoff
const handoff = ler('.ai/HANDOFF.md');
let ultimoHandoff = null;
if (handoff) {
  const cabecalhos = [...handoff.matchAll(/^## (\S+) · (\S+)\s*$/gm)];
  if (!cabecalhos.length) {
    alerta('.ai/HANDOFF.md', 'nenhuma entrada registrada ainda');
  } else {
    const datas = [];
    for (const [, quando, quem] of cabecalhos) {
      if (!AGENTES.has(quem)) falha('.ai/HANDOFF.md', `autor "${quem}" desconhecido — use claude ou codex`);
      const t = Date.parse(quando);
      if (!Number.isFinite(t)) falha('.ai/HANDOFF.md', `"${quando}" não é uma data ISO-8601 válida`);
      else datas.push(t);
    }
    ultimoHandoff = datas[0] ?? null;
    for (let i = 1; i < datas.length; i++) {
      if (datas[i] > datas[i - 1]) {
        falha('.ai/HANDOFF.md', 'entradas fora de ordem — a mais recente deve estar no topo');
        break;
      }
    }
    const primeira = handoff.split(/^## /m)[1] ?? '';
    for (const campo of ['**Fiz:**', '**Arquivos:**', '**Estado:**', '**Próximo passo sugerido:**']) {
      if (!primeira.includes(campo)) alerta('.ai/HANDOFF.md', `entrada mais recente sem o campo ${campo}`);
    }
  }
}

// ------------------------------------------------------------ 4. higiene do repositório
try {
  const rastreados = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n');
  for (const f of rastreados) {
    if (!f) continue;
    if (f === '.env' || f.startsWith('.sessions/') || f.startsWith('outputs/') || /\.tsbuildinfo$/.test(f)) {
      falha('git', `"${f}" está versionado e não deveria estar`);
    }
  }
  const sujo = execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim();
  const fonteAlterada = sujo.split('\n').filter(l => /\.(ts|tsx|prisma|mjs|cjs|json)$/.test(l));
  if (fonteAlterada.length && ultimoHandoff !== null) {
    const horas = (Date.now() - ultimoHandoff) / 3_600_000;
    if (horas > 12) {
      alerta('.ai/HANDOFF.md', `há ${fonteAlterada.length} arquivo(s) de código alterado(s) e o último handoff tem ${Math.floor(horas)}h — registre a sessão antes de encerrar`);
    }
  }
} catch {
  alerta('git', 'não foi possível inspecionar o repositório');
}

// ------------------------------------------------------------ 5. estado atualizado
const state = existsSync(path.join(root, '.ai/STATE.md')) ? readFileSync(path.join(root, '.ai/STATE.md'), 'utf8') : '';
const carimbo = state.match(/\*\*Última atualização:\*\*\s*(\S+)/);
if (!carimbo) {
  alerta('.ai/STATE.md', 'sem carimbo "**Última atualização:**"');
} else {
  const t = Date.parse(carimbo[1]);
  if (Number.isFinite(t) && (Date.now() - t) / 86_400_000 > 30) {
    alerta('.ai/STATE.md', `não é atualizado há ${Math.floor((Date.now() - t) / 86_400_000)} dias — pode estar descrevendo uma arquitetura que não existe mais`);
  }
}

// ------------------------------------------------------------ relatório
const linha = '─'.repeat(72);
console.log(`\n${linha}\n  VERIFICAÇÃO DO PROTOCOLO MULTI-AGENTE\n${linha}`);
for (const a of avisos) console.log(`  ⚠  ${a}`);
for (const e of erros) console.log(`  ✖  ${e}`);
if (!erros.length && !avisos.length) console.log('  ✔  Protocolo íntegro.');
console.log(linha);
if (erros.length) {
  console.log(`  ${erros.length} erro(s). Corrija antes de encerrar a sessão. Contrato: AGENTS.md\n`);
  process.exit(1);
}
console.log(`  Sem erros${avisos.length ? `, ${avisos.length} aviso(s)` : ''}.\n`);
