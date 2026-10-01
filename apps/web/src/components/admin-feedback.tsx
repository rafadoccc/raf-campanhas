import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { FEEDBACK_MAX_LENGTH, feedbackKindLabel, feedbackStatus, type Feedback, type FeedbackStatus } from '../lib/feedback';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Segmented, Select, IconFeedback, dataHora, inputClass } from '../design';

// Sugestões e críticas de todas as contas (ADR-045), para o administrador ler, mudar a situação e
// responder. Quem enviou vê a situação e a resposta na tela "Sugestões e críticas".

type Item = Feedback & { user: { name: string; email: string } };
type Filter = FeedbackStatus | 'todos';
const filters: { value: Filter; label: string }[] = [
  { value: 'novo', label: 'Novos' }, { value: 'analisando', label: 'Em análise' }, { value: 'feito', label: 'Feitos' }, { value: 'recusado', label: 'Recusados' }, { value: 'todos', label: 'Todos' },
];
const statusOptions = (Object.keys(feedbackStatus) as FeedbackStatus[]).map(value => ({ value, label: feedbackStatus[value].label }));

function Row({ item, onChanged }: { item: Item; onChanged: (item: Item) => void }) {
  const [reply, setReply] = useState(item.reply ?? '');
  const [status, setStatus] = useState<FeedbackStatus>(item.status);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const dirty = reply.trim() !== (item.reply ?? '') || status !== item.status;
  async function save() {
    setBusy(true); setError('');
    try { onChanged(await api<Item>(`/admin/feedback/${item.id}`, { method: 'PATCH', json: { status, reply } })); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  return <li className="space-y-2.5 px-4 py-3.5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="min-w-0 truncate text-xs"><span className="font-medium text-ink">{item.user.name}</span> <span className="text-muted">· {item.user.email} · {dataHora(item.createdAt)}</span></p>
      <span className="flex items-center gap-1.5"><Badge tone="muted">{feedbackKindLabel[item.kind]}</Badge><Badge tone={feedbackStatus[item.status].tone}>{feedbackStatus[item.status].label}</Badge></span>
    </div>
    <p className="whitespace-pre-wrap break-words text-sm">{item.message}</p>
    <textarea value={reply} maxLength={FEEDBACK_MAX_LENGTH} onChange={e => setReply(e.target.value)} placeholder="Resposta para quem enviou (opcional)" aria-label="Resposta" className={`${inputClass} min-h-16`} />
    {error && <Alert>{error}</Alert>}
    <div className="flex flex-wrap items-center gap-2">
      <Select label="Situação" value={status} onChange={value => setStatus(value as FeedbackStatus)} options={statusOptions} className="w-44" />
      <Button variant="primary" size="sm" loading={busy} disabled={busy || !dirty} onClick={() => void save()}>Salvar</Button>
    </div>
  </li>;
}

export function AdminFeedback() {
  const [filter, setFilter] = useState<Filter>('novo');
  const [data, setData] = useState<{ items: Item[]; counts: Partial<Record<FeedbackStatus, number>> } | null>(null);
  const [error, setError] = useState('');
  const load = (current: Filter) => api<{ items: Item[]; counts: Partial<Record<FeedbackStatus, number>> }>(`/admin/feedback${current === 'todos' ? '' : `?status=${current}`}`)
    .then(result => { setData(result); setError(''); }).catch(e => setError(errorMessage(e)));
  useEffect(() => { setData(null); void load(filter); }, [filter]);
  const fresh = data?.counts.novo ?? 0;

  return <Card>
    <CardHeader title={<span className="inline-flex items-center gap-2">Sugestões e críticas{fresh > 0 && <Badge tone="brand">{fresh} {fresh === 1 ? 'nova' : 'novas'}</Badge>}</span>} />
    <div className="border-b border-line px-4 py-3"><Segmented label="Filtrar por situação" value={filter} onChange={setFilter} options={filters} /></div>
    {error && <div className="p-4"><Alert>{error}</Alert></div>}
    {!data && !error && <p className="p-4 text-sm text-muted">Carregando…</p>}
    {data && data.items.length === 0 && <EmptyState icon={IconFeedback} title="Nada por aqui." hint={filter === 'novo' ? 'Nenhuma mensagem nova dos usuários.' : 'Nenhuma mensagem nesta situação.'} />}
    {data && data.items.length > 0 && <ul className="divide-y divide-line">
      {/* Salvou: a lista é buscada de novo, para a mensagem ir para o filtro certo e a contagem acertar. */}
      {data.items.map(item => <Row key={`${item.id}-${item.status}-${item.repliedAt ?? ''}`} item={item} onChanged={() => void load(filter)} />)}
    </ul>}
  </Card>;
}
