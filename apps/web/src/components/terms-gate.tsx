import { useState } from 'react';
import { Link } from 'react-router-dom';
import { errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Button, Checkbox, IconPrivacy } from '../design';

// Aceite dos Termos de Uso e da Política de Privacidade (LGPD, ADR-040). Aparece no primeiro
// acesso e sempre que a versão dos termos muda; o painel só abre depois do aceite.
export function TermsGate() {
  const { user, acceptTerms, signOut } = useAuth();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function accept() {
    setBusy(true); setError('');
    try { await acceptTerms(); } catch (e) { setError(errorMessage(e)); setBusy(false); }
  }
  const link = 'font-medium text-brand-700 underline';
  return <div className="flex h-dvh items-center justify-center overflow-y-auto bg-slate-50 p-4">
    <div className="w-full max-w-md animate-pop-in space-y-4 rounded-lg border border-line bg-white p-6 shadow-card">
      <header className="space-y-1">
        <IconPrivacy className="h-5 w-5 text-brand-700" aria-hidden />
        <h1 className="text-lg font-semibold leading-tight">Antes de continuar, {user?.name?.split(' ')[0] ?? 'bem-vindo'}</h1>
      </header>
      {/* O essencial em duas frases; a íntegra fica nos dois links do aceite. */}
      <p className="text-sm text-muted">Envie só para grupos em que você tem autorização para divulgar. A conexão com o WhatsApp é não oficial: existe o risco de o WhatsApp restringir o número.</p>
      {error && <Alert>{error}</Alert>}
      <Checkbox checked={agreed} onChange={setAgreed} label={<>Li e aceito os <Link className={link} to="/termos" target="_blank">Termos de Uso</Link> e a <Link className={link} to="/privacidade" target="_blank">Política de Privacidade</Link></>} />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" loading={busy} disabled={!agreed || busy} onClick={() => void accept()}>Aceitar e continuar</Button>
        <Button variant="ghost" disabled={busy} onClick={() => void signOut().catch(() => undefined)}>Sair</Button>
      </div>
    </div>
  </div>;
}
