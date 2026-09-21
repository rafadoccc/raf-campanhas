import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { prisma } from '@campaign/database';

// Compatibility policy, NOT claimed as universal Baileys protocol limits.
export const IMAGE_LIMIT = 16_000_000;
export const VIDEO_LIMIT = 64_000_000;
const ffprobe = require('ffprobe-static') as { path: string };
export const mediaMetadata = { id: true, name: true, mimeType: true, kind: true, size: true } as const;

async function inspectVideo(data: Buffer): Promise<{ streams: { codec_type: string; codec_name: string }[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobe.path, ['-v', 'error', '-protocol_whitelist', 'pipe', '-f', 'mov', '-i', 'pipe:0', '-show_streams', '-of', 'json'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); }
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
  app.addContentTypeParser(['image/jpeg', 'image/png', 'video/mp4'], { parseAs: 'buffer', bodyLimit: VIDEO_LIMIT }, (_request, body, done) => done(null, body));
  app.post('/api/media', { bodyLimit: VIDEO_LIMIT }, async (request, reply) => {
    try {
      const data = request.body;
      if (!Buffer.isBuffer(data)) throw Error('Envie exatamente um arquivo.');
      const mimeType = String(request.headers['content-type']).split(';')[0];
      const kind = await validateMedia(data, mimeType);
      const rawName = (request.query as { name?: string }).name;
      const name = (typeof rawName === 'string' ? rawName.split(/[\\/]/).pop()! : 'mídia').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180) || 'mídia';
      return reply.code(201).send(await prisma.campaignMedia.create({ data: { name, mimeType, kind, size: data.length, data: new Uint8Array(data) }, select: mediaMetadata }));
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Arquivo inválido.' }); }
  });
  app.get('/api/media/:id', async (request, reply) => {
    const media = await prisma.campaignMedia.findUnique({ where: { id: (request.params as { id: string }).id } });
    if (!media) return reply.code(404).send({ error: 'Mídia não encontrada.' });
    reply.header('Content-Type', media.mimeType).header('X-Content-Type-Options', 'nosniff').header('Accept-Ranges', 'bytes');
    const buffer = Buffer.from(media.data); const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const start = match?.[1] ? Number(match[1]) : match?.[2] ? Math.max(0, buffer.length - Number(match[2])) : NaN;
      const end = match?.[1] && match[2] ? Math.min(Number(match[2]), buffer.length - 1) : buffer.length - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= buffer.length) return reply.code(416).header('Content-Range', `bytes */${buffer.length}`).send();
      return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${buffer.length}`).send(buffer.subarray(start, end + 1));
    }
    return reply.send(buffer);
  });
}
