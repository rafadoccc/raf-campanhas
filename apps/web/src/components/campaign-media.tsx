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

export function CampaignMediaInput({ value, onChange, disabled }: { value: CampaignMedia | null; onChange(value: CampaignMedia | null): void; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null); const [error, setError] = useState('');
  return <section className="space-y-3 rounded-lg border border-line bg-white p-4 shadow-card">
    <div>
      <h2 className="text-sm font-semibold">Mídia <span className="font-normal text-slate-400">(opcional)</span></h2>
      <p className="text-2xs text-muted">Imagem JPEG/PNG até 16 MB ou vídeo MP4 até 64 MB. A mensagem vira a legenda, e a cor da imagem vira a cor da campanha.</p>
    </div>
    <input ref={input} type="file" accept="image/jpeg,image/png,video/mp4" className="hidden" disabled={disabled} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ''; setError(''); if (!file) return;
      if (!['image/jpeg', 'image/png', 'video/mp4'].includes(file.type)) { setError('Selecione JPEG, PNG ou MP4.'); return; }
      const kind = file.type === 'video/mp4' ? 'video' : 'image';
      if (!file.size || file.size > (kind === 'image' ? 16_000_000 : 64_000_000)) { setError('Arquivo vazio ou acima do limite.'); return; }
      onChange({ name: file.name, size: file.size, mimeType: file.type, kind, file });
    }} />
    <div className="flex flex-wrap gap-2">
      <Button icon={IconUpload} disabled={disabled} onClick={() => input.current?.click()}>{value ? 'Trocar mídia' : 'Adicionar mídia'}</Button>
      {value && <Button variant="danger" icon={IconDelete} disabled={disabled} onClick={() => { onChange(null); setError(''); }}>Remover</Button>}
    </div>
    {value && <MediaPreview media={value} />}
    {error && <Alert>{error}</Alert>}
  </section>;
}
