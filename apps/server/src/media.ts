import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { prisma } from '@campaign/database';
import { publicMessage } from './security';
import { prepareVideo, VIDEO_UPLOAD_LIMIT, VIDEO_UPLOAD_TYPES } from './video-convert';

// Compatibility policy, NOT claimed as universal Baileys protocol limits.
export const IMAGE_LIMIT = 16_000_000;
export const VIDEO_LIMIT = 64_000_000;
const ffprobe = require('ffprobe-static') as { path: string };
export const mediaMetadata = { id: true, name: true, mimeType: true, kind: true, size: true, color: true } as const;

// Cor predominante e miniatura (ADR-026). A lista de campanhas usa só isto: nunca a mídia
// inteira, que pode ter 16 MB.
export async function imagePreview(data: Buffer) {
  const image = sharp(data, { limitInputPixels: 32_000_000 });
  const { dominant } = await image.stats();
  const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  const color = `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`;
  const thumbnail = await sharp(data, { limitInputPixels: 32_000_000 }).rotate().resize(320, 320, { fit: 'cover' }).webp({ quality: 72 }).toBuffer();
  return { color, thumbnail };
}

/** Imagens antigas sem cor/miniatura ganham as duas, uma de cada vez (roda na partida). */
export async function backfillMediaPreviews(limit = 200) {
  const pending = await prisma.campaignMedia.findMany({ where: { kind: 'image', OR: [{ color: null }, { thumbnail: null }] }, select: { id: true }, take: limit });
  for (const { id } of pending) {
    const media = await prisma.campaignMedia.findUnique({ where: { id }, select: { data: true } });
    if (!media) continue;
    try { await prisma.campaignMedia.update({ where: { id }, data: await imagePreview(Buffer.from(media.data)) }); }
    catch { /* imagem que não decodifica: segue sem prévia */ }
  }
  return pending.length;
}

// Mídia nunca muda depois de salva (o id identifica o conteúdo): pode ficar em cache no navegador.
const PRIVATE_CACHE = 'private, max-age=86400, immutable';
// Pedido aberto (bytes=N-) de vídeo recebe no máximo este pedaço; o navegador pede o resto.
const MAX_CHUNK = 2 * 1024 * 1024;

async function inspectVideo(data: Buffer): Promise<{ streams: { codec_type: string; codec_name: string }[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobe.path, ['-v', 'error', '-protocol_whitelist', 'pipe', '-f', 'mov', '-i', 'pipe:0', '-show_streams', '-of', 'json'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) {
        child.kill();
        // Processo que ignora o SIGTERM não pode ficar preso ocupando memória.
        setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000).unref();
        reject(error);
      }
      else { try { resolve(JSON.parse(output)); } catch { reject(Error('Vídeo inválido.')); } }
    };
    const timer = setTimeout(() => finish(Error('Não foi possível validar o vídeo a tempo.')), 15000);
    child.on('error', () => finish(Error('Validador de vídeo indisponível.')));
    child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 2_000_000) finish(Error('Metadados de vídeo excessivos.')); });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('close', code => finish(code === 0 ? undefined : Error('Vídeo inválido ou incompleto.')));
    child.stdin.end(data);
  });
}

export async function validateMedia(data: Buffer, mimeType: string) {
  if (!data.length) throw Error('Arquivo vazio.');
  if (mimeType === 'image/jpeg' || mimeType === 'image/png') {
    if (data.length > IMAGE_LIMIT) throw Error('Imagem excede 16 MB.');
    const image = sharp(data, { limitInputPixels: 32_000_000, failOn: 'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== (mimeType === 'image/png' ? 'png' : 'jpeg') || (metadata.pages ?? 1) !== 1) throw Error('Use uma imagem JPEG ou PNG estática válida.');
    await image.stats(); // Decode: extension and declared MIME alone are insufficient.
    return 'image';
  }
  if (mimeType === 'video/mp4') {
    if (data.length > VIDEO_LIMIT) throw Error('Vídeo excede 64 MB.');
    if (data.length < 16 || data.toString('ascii', 4, 8) !== 'ftyp' || data.toString('ascii', 8, 12) === 'qt  ') throw Error('Use vídeo MP4.');
    const { streams } = await inspectVideo(data);
    if (!Array.isArray(streams) || streams.filter(s => s.codec_type === 'video').length !== 1 || streams.filter(s => s.codec_type === 'audio').length > 1 || streams.some(s => s.codec_type === 'video' ? s.codec_name !== 'h264' : s.codec_type !== 'audio' || s.codec_name !== 'aac')) throw Error('Use MP4 com vídeo H.264 e áudio AAC opcional.');
    return 'video';
  }
  throw Error('Formatos aceitos: JPEG, PNG e MP4 (H.264/AAC).');
}

export function registerMediaRoutes(app: FastifyInstance) {
  // Limite por tipo já na leitura do corpo: uma imagem acima de 16 MB é recusada antes de
  // ocupar 64 MB de memória.
  app.addContentTypeParser(['image/jpeg', 'image/png'], { parseAs: 'buffer', bodyLimit: IMAGE_LIMIT }, (_request, body, done) => done(null, body));
  // Vídeo em qualquer formato comum (MOV do iPhone, HEVC, WebM…) até 200 MB: vira MP4 H.264
  // de até 64 MB antes de ser guardado (ADR-032).
  app.addContentTypeParser(VIDEO_UPLOAD_TYPES, { parseAs: 'buffer', bodyLimit: VIDEO_UPLOAD_LIMIT }, (_request, body, done) => done(null, body));
  // Sem bodyLimit na rota: ele venceria o limite de cada tipo definido nos parsers acima.
  app.post('/api/media', async (request, reply) => {
    try {
      if (!Buffer.isBuffer(request.body)) throw Error('Envie exatamente um arquivo.');
      let data: Buffer = request.body;
      let mimeType = String(request.headers['content-type']).split(';')[0];
      const rawName = (request.query as { name?: string }).name;
      let name = (typeof rawName === 'string' ? rawName.split(/[\\/]/).pop()! : 'mídia').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180) || 'mídia';
      let converted = false;
      if (VIDEO_UPLOAD_TYPES.includes(mimeType)) {
        ({ data, converted } = await prepareVideo(data, mimeType, { limit: VIDEO_LIMIT, validateMp4: mp4 => validateMedia(mp4, 'video/mp4') }));
        mimeType = 'video/mp4';
        if (converted) name = `${name.replace(/\.[^.]{1,5}$/, '')}.mp4`.slice(0, 180);
      }
      const kind = await validateMedia(data, mimeType);
      const preview = kind === 'image' ? await imagePreview(data) : {};
      const media = await prisma.campaignMedia.create({ data: { userId: request.user!.id, name, mimeType, kind, size: data.length, data: data as Uint8Array<ArrayBuffer>, ...preview }, select: mediaMetadata });
      return reply.code(201).send({ ...media, converted });
    } catch (error) { return reply.code(400).send({ error: publicMessage(error, 'Arquivo inválido.') }); }
  });
  app.get('/api/media/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    // Só a mídia do próprio usuário; de outro usuário responde igual a inexistente (ADR-018).
    // Primeiro só os metadados: o conteúdo é lido depois, e só o trecho pedido.
    const media = await prisma.campaignMedia.findFirst({ where: { id, userId: request.user!.id }, select: { mimeType: true, size: true } });
    if (!media) return reply.code(404).send({ error: 'Mídia não encontrada.' });
    reply.header('Content-Type', media.mimeType).header('X-Content-Type-Options', 'nosniff').header('Accept-Ranges', 'bytes').header('Cache-Control', PRIVATE_CACHE);
    const total = media.size;
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const start = match?.[1] ? Number(match[1]) : match?.[2] ? Math.max(0, total - Number(match[2])) : NaN;
      const requestedEnd = match?.[1] && match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start > requestedEnd || start >= total) return reply.code(416).header('Content-Range', `bytes */${total}`).send();
      // Pedido aberto (bytes=N-) vem em pedaços; um pedido com fim explícito é respeitado.
      const end = match?.[2] ? requestedEnd : Math.min(requestedEnd, start + MAX_CHUNK - 1);
      // SUBSTRING no banco: nunca carrega o vídeo inteiro para servir um pedaço (T-048).
      const [row] = await prisma.$queryRaw<{ chunk: Uint8Array }[]>`SELECT SUBSTRING(data, ${start + 1}, ${end - start + 1}) AS chunk FROM \`CampaignMedia\` WHERE id = ${id} AND userId = ${request.user!.id}`;
      if (!row) return reply.code(404).send({ error: 'Mídia não encontrada.' });
      return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${total}`).send(Buffer.from(row.chunk));
    }
    const full = await prisma.campaignMedia.findFirst({ where: { id, userId: request.user!.id }, select: { data: true } });
    return full ? reply.send(Buffer.from(full.data)) : reply.code(404).send({ error: 'Mídia não encontrada.' });
  });

  // Miniatura para a lista de campanhas (poucos KB). Imagem antiga sem miniatura ganha uma agora.
  app.get('/api/media/:id/thumb', async (request, reply) => {
    const where = { id: (request.params as { id: string }).id, userId: request.user!.id };
    const media = await prisma.campaignMedia.findFirst({ where, select: { id: true, kind: true, thumbnail: true } });
    if (!media || media.kind !== 'image') return reply.code(404).send({ error: 'Mídia não encontrada.' });
    let thumbnail = media.thumbnail ? Buffer.from(media.thumbnail) : null;
    if (!thumbnail) {
      const full = await prisma.campaignMedia.findFirst({ where, select: { data: true } });
      if (!full) return reply.code(404).send({ error: 'Mídia não encontrada.' });
      const preview = await imagePreview(Buffer.from(full.data));
      await prisma.campaignMedia.update({ where: { id: media.id }, data: preview });
      thumbnail = preview.thumbnail;
    }
    return reply.header('Content-Type', 'image/webp').header('Cache-Control', PRIVATE_CACHE).send(thumbnail);
  });
}
