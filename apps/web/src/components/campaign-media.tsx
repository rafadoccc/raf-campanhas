import { useEffect, useRef, useState } from 'react';
export type CampaignMedia = { id?: string; name: string; kind: string; size: number; mimeType: string; file?: File };
export function MediaPreview({ media }: { media: CampaignMedia }) {
  const [local, setLocal] = useState('');
  useEffect(() => {
    if (!media.file) { setLocal(''); return; }
    const url = URL.createObjectURL(media.file); setLocal(url);
    return () => URL.revokeObjectURL(url);
  }, [media.file]);
  // Mesma origem: o cookie de sessão acompanha a imagem/vídeo.
  const src = media.file ? local : `/api/media/${media.id}`;
  return <div className="mt-3 space-y-2"><p className="break-all text-sm">{media.name} · {(media.size / 1_000_000).toFixed(2)} MB</p>{src && (media.kind === 'image' ? <img src={src} alt={`Mídia da campanha: ${media.name}`} className="max-h-64 max-w-full rounded-lg object-contain" /> : <video src={src} controls preload="metadata" className="max-h-64 max-w-full rounded-lg" />)}</div>;
}
export function CampaignMediaInput({ value, onChange, disabled }: { value: CampaignMedia | null; onChange(value: CampaignMedia | null): void; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null); const [error, setError] = useState('');
  return <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"><h2 className="font-bold">Mídia opcional</h2><p className="text-sm text-slate-500">Uma imagem JPEG/PNG (até 16 MB) ou vídeo MP4 H.264 com áudio AAC opcional (até 64 MB). Limites de compatibilidade desta aplicação; o arquivo será validado ao salvar. O texto será a legenda de uma única mensagem.</p>
    <input ref={input} type="file" accept="image/jpeg,image/png,video/mp4" className="hidden" disabled={disabled} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ''; setError(''); if (!file) return;
      if (!['image/jpeg', 'image/png', 'video/mp4'].includes(file.type)) { setError('Selecione JPEG, PNG ou MP4.'); return; }
      const kind = file.type === 'video/mp4' ? 'video' : 'image';
      if (!file.size || file.size > (kind === 'image' ? 16_000_000 : 64_000_000)) { setError('Arquivo vazio ou acima do limite informado.'); return; }
      onChange({ name: file.name, size: file.size, mimeType: file.type, kind, file });
    }} />
    <button type="button" disabled={disabled} onClick={() => input.current?.click()} className="rounded border px-3 py-2 text-emerald-700 disabled:opacity-50">{value ? 'Trocar mídia' : 'Adicionar mídia'}</button>
    {value && <><button type="button" disabled={disabled} onClick={() => { onChange(null); setError(''); }} className="ml-3 text-sm text-red-700">Remover mídia</button><MediaPreview media={value} /></>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
  </section>;
}
