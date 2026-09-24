import path from 'node:path';
import { existsSync } from 'node:fs';

export type AppConfig = {
  port: number;
  host: string;
  publicUrl: URL;
  /** true quando PUBLIC_URL não é localhost (ex.: Hostinger). */
  deployed: boolean;
  /** Origens aceitas em requisições que alteram dados (proteção contra CSRF). */
  allowedOrigins: string[];
  /** Nomes aceitos no cabeçalho Host (proteção contra DNS rebinding); null = não checa. */
  allowedHosts: string[] | null;
  secureCookies: boolean;
  /** false, ou a lista de proxies confiáveis (formato do Fastify/proxy-addr). */
  trustProxy: boolean | string;
  sessionTtlMs: number;
  /** Pasta do painel compilado (apps/web/dist); null se ainda não foi compilado. */
  webDist: string | null;
};

const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

// Proxies em quem o servidor confia para informar o IP real: só os da rede interna (a borda
// da hospedagem chega por endereço privado, pela faixa interna de operadora 100.64.0.0/10 —
// usada pela borda do Railway — ou pelo próprio computador). Nenhum cliente da internet chega
// por essas faixas. NUNCA `true`: com
// `true` o Fastify aceita o X-Forwarded-For que o próprio cliente manda, e qualquer um
// contorna o limite de tentativas de login trocando de "IP" a cada pedido.
export const TRUSTED_PROXIES = 'loopback, uniquelocal, 100.64.0.0/10';

function trustProxyFrom(value: string | undefined, deployed: boolean): boolean | string {
  if (value === undefined || value === '') return deployed ? TRUSTED_PROXIES : false;
  if (value === '0') return false;
  if (value === '1') return TRUSTED_PROXIES;
  return value; // lista explícita, ex.: "10.0.0.0/8, 127.0.0.1"
}

// Lê e valida o ambiente uma vez, na partida. Configuração inválida derruba o processo
// com uma mensagem clara em vez de um comportamento estranho depois.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT inválida: "${env.PORT}".`);

  // No Railway o domínio público vem em RAILWAY_PUBLIC_DOMAIN (sem protocolo, sempre HTTPS);
  // PUBLIC_URL, se definida, tem prioridade (ex.: domínio próprio).
  const onRailway = Boolean(env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID);
  const railwayUrl = env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined;

  let publicUrl: URL;
  try {
    publicUrl = new URL(env.PUBLIC_URL ?? railwayUrl ?? `http://localhost:${port}`);
  } catch {
    throw new Error(`PUBLIC_URL inválida: "${env.PUBLIC_URL}". Exemplo: https://campanhas.seudominio.com.br`);
  }
  if (!['http:', 'https:'].includes(publicUrl.protocol)) throw new Error('PUBLIC_URL precisa começar com http:// ou https://');
  const deployed = !LOCAL_HOSTS.includes(publicUrl.hostname);

  const origins = new Set([publicUrl.origin]);
  // O mesmo site com e sem "www.": abrir pelo outro endereço não pode bloquear o login.
  if (deployed) {
    const twin = new URL(publicUrl.origin);
    twin.hostname = twin.hostname.startsWith('www.') ? twin.hostname.slice(4) : `www.${twin.hostname}`;
    origins.add(twin.origin);
  }
  if (!deployed) {
    // Painel local e servidor de desenvolvimento do Vite.
    for (const host of LOCAL_HOSTS) for (const p of [port, 5173]) origins.add(`http://${host}:${p}`);
  }
  for (const extra of (env.EXTRA_ORIGINS ?? '').split(',').map(o => o.trim()).filter(Boolean)) {
    try { origins.add(new URL(extra).origin); } catch { throw new Error(`EXTRA_ORIGINS contém uma origem inválida: "${extra}".`); }
  }
  const allowedOrigins = [...origins];
  // Publicado, o proxy da hospedagem pode entregar um Host interno; ali quem protege é o
  // login (cookie SameSite) e a checagem de Origin. A checagem de Host vale no modo local,
  // contra DNS rebinding; localhost fica aceito para chamadas do próprio computador.
  const allowedHosts = deployed ? null : [...new Set([...allowedOrigins.map(o => new URL(o).hostname), ...LOCAL_HOSTS])];

  const ttlHours = Number(env.SESSION_TTL_HOURS ?? 168);
  if (!Number.isFinite(ttlHours) || ttlHours < 1 || ttlHours > 720) throw new Error('SESSION_TTL_HOURS deve ficar entre 1 e 720 horas.');

  const dist = path.resolve(env.WEB_DIST ?? path.join(__dirname, '..', '..', 'web', 'dist'));

  return {
    port,
    // Local: só o próprio computador (127.0.0.1). Publicado ou em contêiner de plataforma: o
    // proxy chega por outra interface, então precisa de 0.0.0.0.
    host: env.HOST ?? (deployed || onRailway ? '0.0.0.0' : '127.0.0.1'),
    publicUrl,
    deployed,
    allowedOrigins,
    allowedHosts,
    secureCookies: publicUrl.protocol === 'https:',
    // Publicado atrás do proxy da hospedagem: IP e protocolo reais vêm do X-Forwarded-*,
    // mas só quando quem os envia é um proxy da rede interna.
    trustProxy: trustProxyFrom(env.TRUST_PROXY?.trim(), deployed),
    sessionTtlMs: ttlHours * 3_600_000,
    webDist: existsSync(path.join(dist, 'index.html')) ? dist : null,
  };
}
