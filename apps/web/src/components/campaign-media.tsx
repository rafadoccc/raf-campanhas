import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Alert, Button, IconDelete, IconExpand, IconImage, IconRemove, IconShrink, IconUpload, IconVideo, tamanho } from '../design';

export type CampaignMedia = { id?: string; name: string; kind: string; size: number; mimeType: string; color?: string | null; file?: File };

/**
 * Imagem em tela cheia. Abre inteira, ajustada à tela (sem cortar nada); um clique na imagem
 * alterna para o tamanho real, com rolagem. Fecha no X, na tecla Esc ou clicando fora.
 */
export function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [actual, setActual] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close.current(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus(); };
  }, []);
  const tool = 'grid h-8 w-8 place-items-center rounded text-white/80 transition-colors hover:bg-white/10 hover:text-white';
  const outside = (event: MouseEvent) => { if (event.target === event.currentTarget) onClose(); };
  return <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={alt} className="fixed inset-0 z-50 flex animate-overlay-in flex-col bg-ink/90 outline-none">
    <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-2.5" onMouseDown={outside}>
      <span className="truncate text-xs text-white/80">{alt}</span>
      <span className="flex shrink-0 items-center gap-1">
        <button type="button" className={tool} aria-label={actual ? 'Ajustar à tela' : 'Ver no tamanho real'} title={actual ? 'Ajustar à tela' : 'Ver no tamanho real'} onClick={() => setActual(value => !value)}>
          {actual ? <IconShrink className="h-4 w-4" aria-hidden /> : <IconExpand className="h-4 w-4" aria-hidden />}
        </button>
        <button type="button" className={tool} aria-label="Fechar" title="Fechar" onClick={onClose}><IconRemove className="h-4 w-4" aria-hidden /></button>
      </span>
    </div>
    {/* m-auto na imagem: centraliza quando cabe e deixa rolar por inteiro quando é maior que a tela. */}
    <div className="scroll-area flex min-h-0 flex-1 overflow-auto p-4 pt-0" onMouseDown={outside}>
      <img src={src} alt={alt} onClick={() => setActual(value => !value)}
        className={`m-auto block animate-pop-in rounded ${actual ? 'max-w-none cursor-zoom-out' : 'max-h-full max-w-full cursor-zoom-in object-contain'}`} />
    </div>
  </div>;
}

/** Endereço da mídia: o arquivo recém-escolhido (ainda no navegador) ou o já salvo no servidor. */
function useMediaSource(media: CampaignMedia) {
  const [local, setLocal] = useState('');
  useEffect(() => {
    if (!media.file) { setLocal(''); return; }
    const url = URL.createObjectURL(media.file); setLocal(url);
    return () => URL.revokeObjectURL(url);
  }, [media.file]);
  // Mesma origem: o cookie de sessão acompanha a imagem/vídeo.
  return media.file ? local : `/api/media/${media.id}`;
}

/**
 * Miniatura da mídia: a imagem inteira (sem corte), que abre em tela cheia ao clicar; vídeo toca
 * no próprio lugar. `className` dimensiona a moldura e `imageClassName`, a imagem dentro dela.
 */
export function MediaThumb({ media, className = '', imageClassName = 'w-full' }: { media: CampaignMedia; className?: string; imageClassName?: string }) {
  const src = useMediaSource(media);
  const [open, setOpen] = useState(false);
  if (!src) return null;
  if (media.kind !== 'image') return <video src={src} controls preload="metadata" className={`rounded border border-line bg-slate-50 ${className}`} />;
  const label = `Mídia da campanha: ${media.name}`;
  return <>
    <button type="button" onClick={() => setOpen(true)} title="Ampliar a imagem" aria-label={`Ampliar a imagem ${media.name}`}
      className={`group relative block cursor-zoom-in overflow-hidden rounded border border-line bg-slate-50 ${className}`}>
      <img src={src} alt={label} loading="lazy" decoding="async" className={`block h-auto ${imageClassName}`} />
      <span aria-hidden className="absolute bottom-1 right-1 grid h-6 w-6 place-items-center rounded bg-ink/70 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"><IconExpand className="h-3.5 w-3.5" /></span>
    </button>
    {open && <ImageLightbox src={src} alt={media.name} onClose={() => setOpen(false)} />}
  </>;
}

export function MediaPreview({ media }: { media: CampaignMedia }) {
  const Icon = media.kind === 'image' ? IconImage : IconVideo;
  return <div className="mt-3 space-y-2">
    <p className="flex items-center gap-1.5 break-all text-xs text-muted"><Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />{media.name} · {tamanho(media.size)}</p>
    <MediaThumb media={media} className={media.kind === 'image' ? 'w-fit max-w-full' : 'max-h-64 max-w-full'} imageClassName="max-h-56 w-auto max-w-full" />
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
