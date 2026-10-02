import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Button, Logo, IconBack, IconDocument, IconShare, IconDisable, IconCheck, campaignStatus, dataHora, dia, numero, useConfirm } from '../design';

// Relatório da campanha (ADR-045): os números, numa página limpa para mostrar ao sócio ou ao
// cliente. A MESMA tela serve ao dono (/campanhas/:id/relatorio, com login) e a quem recebe o
// link (/r/:codigo, sem login e sem botões de gerenciar). "Imprimir" abre a impressão do
// navegador, que salva em PDF.

type Report = {
  generatedAt: string;
  campaign: { name: string; status: string; mode: string; startsAt: string; endsAt: string; createdAt: string; mentionAll: boolean; times: string[] };
  totals: { groups: number; groupsReached: number; membersReached: number; sent: number; delivered: number; failed: number; pending: number; reads: number; deliveryRate: number | null; successRate: number | null };
  byGroup: { name: string; participants: number | null; sent: number; delivered: number; failed: number; pending: number; reads: number }[];
  byDay: { day: string; sent: number; delivered: number }[];
  shareToken?: string | null;
};

const percent = (value: number | null) => (value === null ? '—' : `${value}%`);
const shortDay = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="rounded-md border border-line p-3.5">
    <p className="text-2xs font-medium uppercase tracking-wide text-muted">{label}</p>
    <p className="tabular mt-1 text-2xl font-semibold leading-none text-ink">{value}</p>
    {hint && <p className="mt-1.5 text-2xs text-muted">{hint}</p>}
  </div>;
}

function ReportView({ report }: { report: Report }) {
  const { campaign, totals, byGroup, byDay } = report;
  const status = campaignStatus[campaign.status] ?? campaignStatus.DRAFT;
  const period = campaign.mode === 'IMMEDIATE' ? `Fila única · criada em ${dia(campaign.createdAt)}` : `${dia(campaign.startsAt)} a ${dia(campaign.endsAt)} · ${campaign.times.join(', ')}`;
  const peak = Math.max(1, ...byDay.map(d => d.sent));
  return <article className="space-y-7">
    <header className="space-y-1.5 border-b border-line pb-5">
      <p className="text-2xs font-medium uppercase tracking-wide text-muted">Relatório da campanha</p>
      <h1 className="text-2xl font-bold leading-tight tracking-tight">{campaign.name}</h1>
      <p className="text-sm text-muted">{period} · {status.label.toLowerCase()}</p>
    </header>

    <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Metric label="Envios feitos" value={numero(totals.sent)} hint={totals.pending ? `${numero(totals.pending)} ainda na fila` : totals.failed ? `${numero(totals.failed)} com falha` : totals.sent ? 'todos concluídos' : 'nenhum envio realizado'} />
      <Metric label="Entregues" value={numero(totals.delivered)} hint={`${percent(totals.deliveryRate)} dos envios`} />
      <Metric label="Visualizações" value={numero(totals.reads)} hint="leituras confirmadas pelo WhatsApp" />
      <Metric label="Alcance" value={numero(totals.membersReached)} hint={`membros em ${numero(totals.groupsReached)} ${totals.groupsReached === 1 ? 'grupo' : 'grupos'}`} />
    </section>

    {byDay.length > 0 && <section className="space-y-3 break-inside-avoid">
      <h2 className="text-sm font-semibold">Envios por dia</h2>
      <div className="flex h-36 items-end gap-2 rounded-md border border-line p-4" role="img" aria-label={`Envios por dia: ${byDay.map(d => `${shortDay(d.day)} ${d.sent}`).join(', ')}`}>
        {byDay.map(d => <div key={d.day} className="flex min-w-0 flex-1 flex-col items-center gap-1">
          <span className="tabular text-2xs text-muted">{d.sent}</span>
          <div className="w-full max-w-14 rounded-sm bg-slate-700" style={{ height: `${Math.max(4, (d.sent / peak) * 80)}px` }} />
          <span className="tabular text-2xs text-slate-400">{shortDay(d.day)}</span>
        </div>)}
      </div>
    </section>}

    <section className="space-y-3">
      <h2 className="text-sm font-semibold">Por grupo</h2>
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full min-w-[30rem] text-left text-sm">
          <thead className="bg-slate-50 text-2xs uppercase tracking-wide text-muted">
            <tr><th className="px-3 py-2 font-medium">Grupo</th><th className="px-3 py-2 text-right font-medium">Membros</th><th className="px-3 py-2 text-right font-medium">Envios</th><th className="px-3 py-2 text-right font-medium">Entregues</th><th className="px-3 py-2 text-right font-medium">Visualizações</th></tr>
          </thead>
          <tbody className="tabular divide-y divide-line">
            {byGroup.map((g, i) => <tr key={`${g.name}-${i}`} className="break-inside-avoid">
              <td className="max-w-[16rem] truncate px-3 py-2 font-medium" title={g.name}>{g.name}</td>
              <td className="px-3 py-2 text-right text-muted">{g.participants === null ? '—' : numero(g.participants)}</td>
              <td className="px-3 py-2 text-right">{numero(g.sent)}{g.failed > 0 && <span className="text-red-700"> · {g.failed} falha{g.failed > 1 ? 's' : ''}</span>}</td>
              <td className="px-3 py-2 text-right">{numero(g.delivered)}</td>
              <td className="px-3 py-2 text-right font-medium">{numero(g.reads)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </section>

    <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4 text-2xs text-muted">
      <span>Gerado em {dataHora(report.generatedAt)}. Visualizações são as leituras que o WhatsApp confirma; quem desativa a confirmação de leitura não entra na conta.</span>
      <Logo className="text-sm" />
    </footer>
  </article>;
}

function Frame({ children, back }: { children: ReactNode; back?: { to: string; label: string } }) {
  return <div className="print-flow h-dvh overflow-y-auto bg-white text-ink">
    <header className="sticky top-0 z-10 bg-white/90 backdrop-blur print:hidden">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-5 py-3.5 sm:px-7">
        {back ? <Link to={back.to} className="group inline-flex items-center gap-1.5 py-1.5 pr-2 text-sm font-medium text-muted transition-colors hover:text-ink">
          <IconBack className="h-4 w-4 transition-transform group-hover:-translate-x-0.5" aria-hidden />{back.label}
        </Link> : <span />}
        <Logo className="text-sm" />
      </div>
    </header>
    <main className="mx-auto w-full max-w-3xl animate-fade-in px-5 pb-16 pt-2 sm:px-7 print:max-w-none print:animate-none print:p-0">{children}</main>
  </div>;
}

/** Relatório do dono, com imprimir/PDF e o link para compartilhar. */
export default function CampaignReportPage() {
  const id = useParams().id ?? '';
  const { user } = useAuth();
  const confirm = useConfirm();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!user) return;
    document.title = 'Relatório · DocDrop';
    api<Report>(`/campaigns/${encodeURIComponent(id)}/report`).then(setReport).catch(e => setError(errorMessage(e)));
    return () => { document.title = 'DocDrop'; };
  }, [id, user]);
  if (user === undefined) return null;
  if (!user) return <Navigate to="/login" replace state={{ from: `/campanhas/${id}/relatorio` }} />;

  const link = report?.shareToken ? `${window.location.origin}/r/${report.shareToken}` : '';
  async function share(method: 'POST' | 'DELETE') {
    setBusy(true); setError(''); setCopied(false);
    try {
      const { shareToken } = await api<{ shareToken: string | null }>(`/campaigns/${encodeURIComponent(id)}/report/share`, { method, json: method === 'POST' ? {} : undefined });
      setReport(current => current && { ...current, shareToken });
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true); }
    catch { setError('Não foi possível copiar. Selecione o link e copie manualmente.'); }
  }

  return <Frame back={{ to: `/campanhas/${id}`, label: 'Voltar à campanha' }}>
    {error && <div className="mb-4 print:hidden"><Alert>{error}</Alert></div>}
    {!report && !error && <p className="py-10 text-sm text-muted">Montando o relatório…</p>}
    {report && <>
      <div className="mb-6 space-y-3 rounded-md border border-line bg-slate-50 p-4 print:hidden">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" icon={IconDocument} onClick={() => window.print()}>Imprimir ou salvar em PDF</Button>
          {!report.shareToken && <Button icon={IconShare} loading={busy} disabled={busy} onClick={() => void share('POST')}>Criar link para compartilhar</Button>}
        </div>
        {report.shareToken && <div className="space-y-2">
          <p className="text-xs text-muted">Quem tiver este link vê só os números desta campanha, sem precisar de login. O texto das mensagens e os telefones não aparecem.</p>
          <div className="flex flex-wrap items-center gap-2">
            <input readOnly value={link} aria-label="Link do relatório" onFocus={e => e.currentTarget.select()} className="min-w-0 flex-1 rounded border border-line bg-white px-2.5 py-2 text-xs text-ink" />
            <Button icon={copied ? IconCheck : IconShare} onClick={() => void copy()}>{copied ? 'Copiado' : 'Copiar link'}</Button>
            <Button variant="danger" icon={IconDisable} disabled={busy} onClick={async () => {
              if (await confirm({ title: 'Desativar o link?', description: 'Quem já recebeu o endereço deixa de conseguir abrir. Você pode criar outro depois (será um endereço novo).', confirmLabel: 'Desativar', danger: true })) void share('DELETE');
            }}>Desativar</Button>
          </div>
        </div>}
      </div>
      <ReportView report={report} />
    </>}
  </Frame>;
}

/** Relatório aberto pelo link (/r/:codigo): sem login, só leitura. */
export function SharedReportPage() {
  const token = useParams().token ?? '';
  const [report, setReport] = useState<Report | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    document.title = 'Relatório · DocDrop';
    api<Report>(`/public/report/${encodeURIComponent(token)}`).then(setReport)
      .catch(e => { if (e instanceof ApiError) setMissing(true); });
    return () => { document.title = 'DocDrop'; };
  }, [token]);
  return <Frame>
    {missing && <div className="py-16 text-center">
      <h1 className="text-lg font-semibold">Relatório não disponível</h1>
      <p className="mt-1 text-sm text-muted">O link foi desativado ou o endereço está incompleto. Peça um novo link a quem enviou.</p>
    </div>}
    {!report && !missing && <p className="py-10 text-sm text-muted">Carregando o relatório…</p>}
    {report && <>
      <div className="mb-6 print:hidden"><Button icon={IconDocument} onClick={() => window.print()}>Imprimir ou salvar em PDF</Button></div>
      <ReportView report={report} />
    </>}
  </Frame>;
}
