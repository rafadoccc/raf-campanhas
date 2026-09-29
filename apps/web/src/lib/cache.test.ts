import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenCache } from './cache';

test('resposta atrasada da conta anterior não repopula o cache após logout ou troca de conta', () => {
  screenCache.clear();
  const oldGeneration = screenCache.generation();
  screenCache.setIfCurrent('grupos', ['grupo antigo'], oldGeneration);
  assert.deepEqual(screenCache.get('grupos'), ['grupo antigo']);
  screenCache.clear();
  screenCache.setIfCurrent('grupos', ['resposta atrasada'], oldGeneration);
  assert.equal(screenCache.get('grupos'), undefined);
  screenCache.setIfCurrent('grupos', ['grupo novo'], screenCache.generation());
  assert.deepEqual(screenCache.get('grupos'), ['grupo novo']);
  screenCache.clear();
});
