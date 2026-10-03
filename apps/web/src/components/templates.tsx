import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { CampaignMeta } from './campaign-meta';
import { plainSummary } from './message-editor';
import { Alert, Button, EmptyState, IconButton, Skeleton, IconDelete, IconEdit, IconStart, IconTemplate, IconVideo, accent, useConfirm } from '../design';

// Modelos de campanha (ADR-047): textos, mídia, grupos e horários guardados para reaproveitar.
// "Usar" cria uma campanha nova em rascunho e abre o formulário; o modelo fica como está.

export type Template = {
  id: string; name: string; mode: string; mentionAll: boolean; updatedAt: string; groupCount: number; preview: string;
  schedules: { time: string }[]; media: { id: string; kind: string; color: string | null } | null;
};

export const loadTemplates = (signal?: AbortSignal) => api<Template[]>('/templates', { signal });
/** Cria a campanha a partir do modelo e devolve o id do rascunho novo. */
export const startFromTemplate = async (id: string) => (await api<{ id: string }>(`/campaigns/${id}/duplicate`, { method: 'POST', json: {} })).id;
/** Guarda uma campanha como modelo. */
export const saveAsTemplate = (campaignId: string) => api<{ id: string; name: string }>(`/campaigns/${campaignId}/duplicate`, { method: 'POST', json: { asTemplate: true } });

export function TemplateList() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    loadTemplates(controller.signal).then(setTemplates).catch(e => { if ((e as Error).name !== 'AbortError') setError(errorMessage(e)); });
    return () => controller.abort();
  }, []);
  async function run(id: string, action: () => Promise<void>) {
    setBusy(id); setError('');
    try { await action(); } catch (e) { setError(errorMessage(e, 'Não foi possível concluir a ação.')); }
    finally { setBusy(null); }
  }

  if (error && !templates) return <Alert tone="warning">{error}</Alert>;
  if (!templates) return <ul className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <li key={i}><Skeleton className="h-36" /></li>)}</ul>;
  if (!templates.length) return <EmptyState icon={IconTemplate} title="Nenhum modelo ainda."
    hint="Num cartão de campanha, use o botão Salvar como modelo: o texto, a mídia, os grupos e os horários ficam guardados aqui para as próximas." />;
  return <>
    {error && <div className="mb-3"><Alert>{error}</Alert></div>}
    <ul className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{templates.map(template => {
      const color = accent(template.media?.color);
      return <li key={template.id} className="flex min-w-0 animate-fade-in rounded-lg border border-line bg-white shadow-card">
        <div className="flex min-w-0 flex-1 flex-col p-4">
          <div className="flex items-start gap-3">
            {template.media?.kind === 'image'
              ? <img src={`/api/media/${template.media.id}/thumb`} alt="" loading="lazy" decoding="async" width={48} height={48} className="h-12 w-12 shrink-0 rounded object-cover" style={{ background: color.soft }} />
              : template.media?.kind === 'video'
                ? <div className="grid h-12 w-12 shrink-0 place-items-center rounded bg-slate-100 text-slate-400"><IconVideo className="h-5 w-5" aria-hidden /></div>
                : null}
            <div className="min-w-0 flex-1">
              <h2 className="truncate font-semibold" title={template.name}>{template.name}</h2>
              <div className="mt-1.5"><CampaignMeta groups={template.groupCount} mode={template.mode} schedules={template.schedules} /></div>
            </div>
          </div>
          <p className="mt-3 line-clamp-2 text-xs text-muted">{plainSummary(template.preview) || 'Sem texto'}</p>
          <div className="mt-auto flex items-center gap-1.5 pt-4">
            <Button variant="primary" size="sm" icon={IconStart} loading={busy === template.id} disabled={busy !== null}
              onClick={() => run(template.id, async () => navigate(`/campanhas/${await startFromTemplate(template.id)}/editar`))}>Usar</Button>
            <Button size="sm" icon={IconEdit} disabled={busy !== null} onClick={() => navigate(`/campanhas/${template.id}/editar`)}>Editar</Button>
            <IconButton icon={IconDelete} label="Excluir modelo" variant="danger" className="ml-auto" disabled={busy !== null} onClick={() => run(template.id, async () => {
              if (!await confirm({ title: `Excluir o modelo "${template.name}"?`, description: 'As campanhas já criadas a partir dele continuam como estão.', confirmLabel: 'Excluir', danger: true })) return;
              await api(`/campaigns/${template.id}`, { method: 'DELETE' });
              setTemplates(current => current?.filter(t => t.id !== template.id) ?? null);
            })} />
          </div>
        </div>
      </li>;
    })}</ul>
  </>;
}
