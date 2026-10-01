import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { FEEDBACK_MAX_LENGTH, feedbackKindLabel, feedbackKinds, feedbackStatus, type Feedback, type FeedbackKind } from '../lib/feedback';
import { Alert, Badge, Button, Card, EmptyState, Field, Page, PageHeader, Segmented, IconFeedback, IconSent, dataHora, inputClass } from '../design';

// Sugestões e críticas (ADR-045): o usuário conta o que quer, o que quebrou ou o que incomoda, e
// acompanha aqui a situação e a resposta. Só os próprios envios aparecem.

export default function FeedbackPage() {
  const [kind, setKind] = useState<FeedbackKind>('sugestao');
  const [message, setMessage] = useState('');
  const [items, setItems] = useState<Feedback[] | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [sent, setSent] = useState(false);
  const load = () => api<Feedback[]>('/feedback').then(setItems).catch(e => setError(errorMessage(e)));
  useEffect(() => { void load(); }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(''); setSent(false);
    try {
      const created = await api<Feedback>('/feedback', { method: 'POST', json: { kind, message } });
      setItems(current => [created, ...(current ?? [])]);
      setMessage(''); setSent(true);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }

  const placeholder = feedbackKinds.find(k => k.value === kind)!.placeholder;
  return <Page scroll>
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <PageHeader title="Sugestões e críticas" subtitle={<>O que você escrever aqui chega direto para quem cuida do sistema. As novidades saem nas <Link to="/notas" className="underline">notas de atualização</Link>.</>} />
      <Card as="div" className="p-5">
        <form onSubmit={submit} className="space-y-4">
          <div>
            <span className="mb-1 block text-xs font-medium text-muted">Sobre o que é?</span>
            <Segmented label="Tipo da mensagem" value={kind} onChange={setKind} options={feedbackKinds} />
          </div>
          <Field label="Sua mensagem" hint={`${message.length} de ${FEEDBACK_MAX_LENGTH} caracteres`}>
            <textarea required minLength={10} maxLength={FEEDBACK_MAX_LENGTH} value={message} onChange={e => { setMessage(e.target.value); setSent(false); }} placeholder={placeholder} className={`${inputClass} min-h-32`} />
          </Field>
          {error && <Alert>{error}</Alert>}
          {sent && <Alert tone="brand">Recebido, obrigado. Você acompanha a situação aqui embaixo.</Alert>}
          <Button type="submit" variant="primary" icon={IconSent} loading={busy} disabled={busy || message.trim().length < 10}>Enviar</Button>
        </form>
      </Card>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Seus envios</h2>
        {items === null
          ? <p className="text-sm text-muted">Carregando…</p>
          : items.length === 0
            ? <Card as="div"><EmptyState icon={IconFeedback} title="Você ainda não enviou nada." hint="Ideias, problemas e críticas ajudam a decidir o que entra nas próximas versões." /></Card>
            : <ul className="space-y-2">
              {items.map(item => {
                const status = feedbackStatus[item.status];
                return <Card as="li" key={item.id} className="animate-fade-in space-y-2 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-2xs font-medium uppercase tracking-wide text-muted">{feedbackKindLabel[item.kind]} · {dataHora(item.createdAt)}</span>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm">{item.message}</p>
                  {item.reply && <div className="rounded border-l-2 border-brand-500 bg-slate-50 px-3 py-2">
                    <p className="text-2xs font-medium uppercase tracking-wide text-muted">Resposta{item.repliedAt ? ` · ${dataHora(item.repliedAt)}` : ''}</p>
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-sm">{item.reply}</p>
                  </div>}
                </Card>;
              })}
            </ul>}
      </section>
    </div>
  </Page>;
}
