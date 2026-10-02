import type { FastifyInstance } from 'fastify';
import { prisma, LOCKING_TRANSACTION } from '@campaign/database';

// Listas de grupos (ADR-047): um nome para um conjunto de grupos, para marcar todos de uma vez ao
// montar a campanha. Tudo pelo usuário da sessão; o banco também recusa grupo de outra conta
// (chave composta com userId em GroupListItem).

export const MAX_LISTS = 50;
export const MAX_LIST_GROUPS = 500;
const MAX_NAME = 80;

class ListError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

type Body = { name?: unknown; groupIds?: unknown } | null;
const view = (list: { id: string; name: string; items: { groupId: string }[] }) => ({ id: list.id, name: list.name, groupIds: list.items.map(item => item.groupId) });
const withItems = { id: true, name: true, items: { select: { groupId: true } } } as const;

function parseName(value: unknown) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > MAX_NAME) throw new ListError(`Dê um nome à lista (até ${MAX_NAME} caracteres).`);
  return name;
}
async function parseGroups(value: unknown, userId: string) {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string')) throw new ListError('Grupos inválidos.');
  const ids = [...new Set(value as string[])];
  if (!ids.length) throw new ListError('Selecione ao menos um grupo para a lista.');
  if (ids.length > MAX_LIST_GROUPS) throw new ListError(`Uma lista pode ter até ${MAX_LIST_GROUPS} grupos.`);
  // Só grupos do próprio usuário: de outra conta responde igual a inexistente.
  if (await prisma.group.count({ where: { id: { in: ids }, userId } }) !== ids.length) throw new ListError('Um ou mais grupos não existem mais. Sincronize os grupos e tente de novo.');
  return ids;
}
const duplicated = (error: unknown) => (error as { code?: string }).code === 'P2002';

export function registerGroupListRoutes(app: FastifyInstance) {
  app.get('/api/group-lists', async request => (await prisma.groupList.findMany({ where: { userId: request.user!.id }, orderBy: { name: 'asc' }, select: withItems })).map(view));

  app.post('/api/group-lists', async (request, reply) => {
    const userId = request.user!.id;
    try {
      const body = request.body as Body;
      const name = parseName(body?.name);
      const groupIds = await parseGroups(body?.groupIds, userId);
      const list = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM \`User\` WHERE id = ${userId} FOR UPDATE`;
        if (await tx.groupList.count({ where: { userId } }) >= MAX_LISTS) throw new ListError(`Você já tem ${MAX_LISTS} listas. Exclua uma para criar outra.`);
        return tx.groupList.create({ data: { userId, name, items: { create: groupIds.map(groupId => ({ groupId })) } }, select: withItems });
      }, LOCKING_TRANSACTION);
      return reply.code(201).send(view(list));
    } catch (error) {
      if (error instanceof ListError) return reply.code(error.status).send({ error: error.message });
      if (duplicated(error)) return reply.code(409).send({ error: 'Já existe uma lista com esse nome.' });
      throw error;
    }
  });

  // Renomear e/ou trocar os grupos da lista.
  app.patch('/api/group-lists/:id', async (request, reply) => {
    const userId = request.user!.id;
    const { id } = request.params as { id: string };
    try {
      const body = request.body as Body;
      const name = body?.name === undefined ? undefined : parseName(body.name);
      const groupIds = body?.groupIds === undefined ? undefined : await parseGroups(body.groupIds, userId);
      if (name === undefined && groupIds === undefined) throw new ListError('Nada a alterar.');
      const list = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM \`GroupList\` WHERE id = ${id} FOR UPDATE`;
        if (!await tx.groupList.count({ where: { id, userId } })) throw new ListError('Lista não encontrada.', 404);
        return tx.groupList.update({
          where: { id },
          data: { ...(name === undefined ? {} : { name }), ...(groupIds === undefined ? {} : { items: { deleteMany: {}, create: groupIds.map(groupId => ({ groupId })) } }) },
          select: withItems,
        });
      }, LOCKING_TRANSACTION);
      return view(list);
    } catch (error) {
      if (error instanceof ListError) return reply.code(error.status).send({ error: error.message });
      if (duplicated(error)) return reply.code(409).send({ error: 'Já existe uma lista com esse nome.' });
      throw error;
    }
  });

  app.delete('/api/group-lists/:id', async (request, reply) => {
    const { count } = await prisma.groupList.deleteMany({ where: { id: (request.params as { id: string }).id, userId: request.user!.id } });
    return count ? { deleted: true } : reply.code(404).send({ error: 'Lista não encontrada.' });
  });
}
