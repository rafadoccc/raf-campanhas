import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Conversão automática de vídeo (ADR-032). O WhatsApp só toca bem MP4 com vídeo H.264 e áudio
// AAC; o celular grava em MOV e, no iPhone, em HEVC ("Alta eficiência"). Em vez de recusar,
// o sistema converte. MP4 H.264 que já está no formato certo passa intacto (sem perder
// qualidade nem tempo).

/** Tipos de vídeo aceitos no envio; tudo que não for MP4 H.264 é convertido. */
export const VIDEO_UPLOAD_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/3gpp', 'video/x-m4v', 'video/x-msvideo', 'video/mpeg'];
/** Limite do ARQUIVO ENVIADO (antes de converter); o resultado ainda precisa caber em VIDEO_LIMIT. */
export const VIDEO_UPLOAD_LIMIT = 200_000_000;
const CONVERT_TIMEOUT_MS = 10 * 60_000;

// O pacote do ffmpeg é carregado só quando precisa: se ainda não estiver instalado (ex.: a
// produção atualizou o código mas não rodou npm install), o sistema liga normalmente e só a
// conversão fica indisponível — MP4 H.264 continua funcionando.
function ffmpegPath(): string | null {
  try { return (require('@ffmpeg-installer/ffmpeg') as { path: string }).path; } catch { return null; }
}
export const conversionAvailable = () => ffmpegPath() !== null;

// Uma conversão por vez: converter vídeo usa a CPU inteira, e o despachante de envios não
// pode ficar sem fôlego no meio de uma campanha.
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

function runFfmpeg(binary: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    const timer = setTimeout(() => {
      child.kill();
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000).unref();
      reject(Error('A conversão do vídeo demorou demais. Tente um vídeo mais curto.'));
    }, CONVERT_TIMEOUT_MS);
    child.on('error', () => { clearTimeout(timer); reject(Error('Conversor de vídeo indisponível.')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      console.warn('[Vídeo] ffmpeg falhou:', stderr.split('\n').filter(Boolean).slice(-3).join(' | '));
      reject(Error('Não foi possível converter este vídeo. Confira se o arquivo abre no computador.'));
    });
  });
}

/** Converte para MP4 H.264 + AAC, no máximo 1280 px no lado maior, pronto para o WhatsApp. */
async function convert(data: Buffer) {
  const binary = ffmpegPath();
  if (!binary) throw Error('Este vídeo precisa ser convertido, e o conversor não está instalado neste computador. Rode npm install com o sistema fechado, ou envie um MP4 (H.264).');
  const base = path.join(tmpdir(), `campanhas-video-${randomUUID()}`);
  const input = `${base}-entrada`;
  const output = `${base}-saida.mp4`;
  try {
    await writeFile(input, data);
    await runFfmpeg(binary, [
      '-hide_banner', '-nostdin', '-y', '-i', input,
      '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1',
      // Lado maior até 1280 px, sem aumentar vídeo pequeno; dimensões pares (exigência do H.264).
      '-vf', "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))',scale=trunc(iw/2)*2:trunc(ih/2)*2",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      '-movflags', '+faststart', '-f', 'mp4', output,
    ]);
    return await readFile(output);
  } finally {
    await rm(input, { force: true }).catch(() => undefined);
    await rm(output, { force: true }).catch(() => undefined);
  }
}

/**
 * Deixa um vídeo enviado pronto para o WhatsApp. Devolve o MP4 final e se houve conversão.
 * Nunca devolve algo que não passe na validação de MP4 H.264/AAC de até 64 MB.
 */
export async function prepareVideo(data: Buffer, mimeType: string, rules: { limit: number; validateMp4(data: Buffer): Promise<unknown> }): Promise<{ data: Buffer; converted: boolean }> {
  if (!data.length) throw Error('Arquivo vazio.');
  if (!VIDEO_UPLOAD_TYPES.includes(mimeType)) throw Error('Formato de vídeo não suportado.');
  if (mimeType === 'video/mp4') {
    try {
      await rules.validateMp4(data);
      return { data, converted: false }; // já está pronto: vai como veio
    } catch { /* fora do padrão (HEVC, grande demais…): converte */ }
  }
  const converted = await oneAtATime(() => convert(data));
  if (converted.length > rules.limit) throw Error('Mesmo convertido, o vídeo passou de 64 MB. Corte o vídeo ou envie um mais curto.');
  await rules.validateMp4(converted);
  return { data: converted, converted: true };
}
