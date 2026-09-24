import { useEffect, useRef, useState } from 'react';
import { Alert, Button, IconDelete, IconImage, IconUpload, IconVideo, tamanho } from '../design';

export type CampaignMedia = { id?: string; name: string; kind: string; size: number; mimeType: string; color?: string | null; file?: File };

export function MediaPreview({ media }: { media: CampaignMedia }) {
  const [local, setLocal] = useState('');
  useEffect(() => {
    if (!media.file) { setLocal(''); return; }
    const url = URL.createObjectURL(media.file); setLocal(url);
    return () => URL.revokeObjectURL(url);
  }, [media.file]);
  // Mesma origem: o cookie de sessão acompanha a imagem/vídeo.
  const src = media.file ? local : `/api/media/${media.id}`;
  const Icon = media.kind === 'image' ? IconImage : IconVideo;
  return <div className="mt-3 space-y-2">
    <p className="flex items-center gap-1.5 break-all text-xs text-muted"><Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />{media.name} · {tamanho(media.size)}</p>
    {src && (media.kind === 'image'
      ? <img src={src} alt={`Mídia da campanha: ${media.name}`} loading="lazy" decoding="async" className="max-h-64 max-w-full rounded object-contain" />
      : <video src={src} controls preload="metadata" className="max-h-64 max-w-full rounded" />)}
  </div>;
}

// Os mesmos tipos que o servidor aceita (video-convert.ts). Alguns sistemas não informam o tipo
// de MKV/AVI/3GP: aí vale a extensão do arquivo.
const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/3gpp', 'video/x-m4v', 'video/x-msvideo', 'video/mpeg'];
const BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', '3gp': 'video/3gpp', m4v: 'video/x-m4v', avi: 'video/x-msvideo', mpg: 'video/mpeg', mpeg: 'video/mpeg',
};
function mimeOf(file: File) {
  if (['image/jpeg', 'image/png', ...VIDEO_TYPES].includes(file.type)) return file.type;
  return BY_EXTENSION[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? null;
}

export function CampaignMediaInput({ value, onChange, disabled }: { value: CampaignMedia | null; onChange(value: CampaignMedia | null): void; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null); const [error, setError] = useState('');
  return <section className="space-y-3 rounded-lg border border-line bg-white p-4 shadow-card">
    <div>
      <h2 className="text-sm font-semibold">Mídia <span className="font-normal text-slate-400">(opcional)</span></h2>
      <p className="text-2xs text-muted">Imagem JPEG/PNG até 16 MB ou vídeo até 200 MB (MP4, MOV do iPhone, WebM, MKV, AVI…). Vídeo fora do padrão do WhatsApp é convertido para MP4 ao salvar. A mensagem vira a legenda, e a cor da imagem vira a cor da campanha.</p>
    </div>
    <input ref={input} type="file" accept={`image/jpeg,image/png,${VIDEO_TYPES.join(',')},.mov,.mkv,.m4v,.3gp,.avi,.webm`} className="hidden" disabled={disabled} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ''; setError(''); if (!file) return;
      const mimeType = mimeOf(file);
      if (!mimeType) { setError('Formato não suportado. Use JPEG, PNG ou um vídeo (MP4, MOV, WebM, MKV, AVI).'); return; }
      const kind = mimeType.startsWith('video/') ? 'video' : 'image';
      if (!file.size) { setError('Arquivo vazio.'); return; }
      if (file.size > (kind === 'image' ? 16_000_000 : 200_000_000)) { setError(kind === 'image' ? 'Imagem acima de 16 MB.' : 'Vídeo acima de 200 MB.'); return; }
      onChange({ name: file.name, size: file.size, mimeType, kind, file });
    }} />
    <div className="flex flex-wrap gap-2">
      <Button icon={IconUpload} disabled={disabled} onClick={() => input.current?.click()}>{value ? 'Trocar mídia' : 'Adicionar mídia'}</Button>
      {value && <Button variant="danger" icon={IconDelete} disabled={disabled} onClick={() => { onChange(null); setError(''); }}>Remover</Button>}
    </div>
    {value && <MediaPreview media={value} />}
    {error && <Alert>{error}</Alert>}
  </section>;
}
