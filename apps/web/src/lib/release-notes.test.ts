import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RELEASES, NOTE_KINDS, LATEST_RELEASE, noteParts, dataPorExtenso } from './release-notes';

// As notas são texto que vai direto para o cliente: estes testes barram o erro comum de editar
// à mão (versão fora do formato, fora de ordem, data que não bate, HTML no texto).

test('versões no formato ano.mês.sequência, únicas, batendo com a data', () => {
  const seen = new Set<string>();
  for (const { versao, data } of RELEASES) {
    assert.match(versao, /^\d{2}\.\d{2}\.[1-9]\d*$/, versao);
    assert.match(data, /^\d{4}-\d{2}-\d{2}$/, data);
    assert.ok(!seen.has(versao), `versão repetida: ${versao}`);
    seen.add(versao);
    const [ano, mes] = versao.split('.');
    assert.equal(`${ano}.${mes}`, `${data.slice(2, 4)}.${data.slice(5, 7)}`, `${versao} não é de ${data}`);
  }
});

test('a mais nova primeiro, e a sequência sobe dentro do mês', () => {
  const key = (v: string) => v.split('.').map(Number);
  for (let i = 1; i < RELEASES.length; i++) {
    const [a, b] = [key(RELEASES[i - 1].versao), key(RELEASES[i].versao)];
    const newer = a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));
    assert.ok(newer, `${RELEASES[i - 1].versao} deveria vir antes de ${RELEASES[i].versao}`);
    assert.ok(RELEASES[i - 1].data >= RELEASES[i].data, 'datas fora de ordem');
  }
  assert.equal(LATEST_RELEASE, RELEASES[0].versao);
});

test('grupos conhecidos, na ordem combinada, sem grupo vazio, sem HTML e com negrito fechado', () => {
  const order = NOTE_KINDS.map(k => k.tipo);
  for (const { versao, grupos } of RELEASES) {
    assert.ok(grupos.length, `${versao} sem grupos`);
    const kinds = grupos.map(g => order.indexOf(g.tipo));
    assert.ok(kinds.every(k => k >= 0), `${versao}: tipo desconhecido`);
    assert.deepEqual(kinds, [...kinds].sort((a, b) => a - b), `${versao}: grupos fora da ordem Novo, Melhorado...`);
    assert.equal(new Set(kinds).size, kinds.length, `${versao}: grupo repetido`);
    for (const { itens } of grupos) {
      assert.ok(itens.length, `${versao}: grupo vazio`);
      for (const item of itens) {
        assert.doesNotMatch(item, /[<>]/, `HTML no texto: ${item}`);
        assert.equal((item.match(/\*\*/g) ?? []).length % 2, 0, `negrito sem fechar: ${item}`);
        assert.ok(item.trim() === item && item.length > 0, `espaço sobrando: ${item}`);
      }
    }
  }
});

test('negrito e data por extenso', () => {
  assert.deepEqual(noteParts('**Novo:** texto'), [{ text: 'Novo:', bold: true }, { text: ' texto', bold: false }]);
  assert.deepEqual(noteParts('sem destaque'), [{ text: 'sem destaque', bold: false }]);
  assert.equal(dataPorExtenso('2026-09-03'), '3 de setembro de 2026');
});
