// Última resposta de cada tela, em memória. Voltar para uma tela mostra na hora o que ela tinha
// (sem esqueleto de carregamento) enquanto os dados novos chegam por trás. Some ao recarregar a
// página e é apagado ao sair ou trocar de conta: dados de um usuário nunca aparecem para outro.
const store = new Map<string, unknown>();

export const screenCache = {
  get: <T>(key: string | undefined) => (key ? store.get(key) as T | undefined : undefined),
  set: (key: string | undefined, value: unknown) => { if (key) store.set(key, value); },
  delete: (key: string) => store.delete(key),
  clear: () => store.clear(),
};
