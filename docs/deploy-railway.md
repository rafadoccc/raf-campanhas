# Deploy no Railway

O sistema é um processo único (`node server.js`): aplica as migrations do Prisma, compila o
painel se preciso e sobe o Fastify servindo o painel e a API na mesma porta. `railway.json`
(raiz do repositório) já define o comando de partida e o healthcheck.

## 1. Serviço

1. Crie um serviço a partir do repositório GitHub `rafadoccc/raf-campanhas`, branch `main`.
   Deploy automático a cada push nessa branch (confira em **Settings → Deploy Triggers**).
2. Adicione um serviço **MySQL** (plugin do próprio Railway) ao projeto — ele expõe
   `DATABASE_URL` automaticamente por variável de referência; use-a direto, sem copiar valor.
3. Adicione um **Volume** montado em `/data/sessions` (ou outro caminho persistente do
   plano). Sem volume, cada deploy apaga a sessão do WhatsApp de todo mundo e todos precisam
   ler o QR de novo.

## 2. Variáveis de ambiente

| Variável | Obrigatória | Valor |
|---|---|---|
| `DATABASE_URL` | sim | referência ao plugin MySQL do Railway |
| `SESSIONS_DIR` | sim | caminho dentro do Volume, ex.: `/data/sessions` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | só na primeira subida | cria a primeira conta (`SUPER_ADMIN`) se o banco de usuários estiver vazio. `ADMIN_PASSWORD` precisa de 10+ caracteres. Pode remover depois — não é lido de novo com o banco já populado. |
| `ADMIN_NAME` | não | nome de exibição da primeira conta (padrão "Administrador") |
| `PUBLIC_URL` | não | só se usar domínio próprio; sem ela o sistema usa `RAILWAY_PUBLIC_DOMAIN` sozinho |
| `EXTRA_ORIGINS` | não | origens adicionais aceitas em pedidos que alteram dados, separadas por vírgula |

`PORT` e `HOST` **não precisam ser definidas**: o Railway injeta `PORT` sozinho, e
`loadConfig()` (`apps/server/src/config.ts`) já detecta o ambiente Railway
(`RAILWAY_ENVIRONMENT_ID`/`RAILWAY_PROJECT_ID`) e escuta em `0.0.0.0` automaticamente — o
502 mais comum em plataformas assim é o processo escutando só em `127.0.0.1`, e este projeto
já evita isso. Se precisar confirmar, o log de partida imprime o endereço:
`Sistema pronto em https://... (escutando em 0.0.0.0:PORTA)`.

`WHATSAPP_MIGRATE_LEGACY=0` desliga a migração automática da sessão legada (ADR-024) — só
use se estiver depurando essa migração especificamente; o padrão (migrar) é o certo em
produção. `WHATSAPP_AUTO_CONNECT=0` impede toda reconexão automática na partida — útil só
para depuração, nunca deixe assim em produção (ninguém reconecta sozinho).

## 3. Healthcheck e reinício

`railway.json` já traz:

```json
{ "deploy": { "startCommand": "npm run start", "healthcheckPath": "/api/health",
  "healthcheckTimeout": 180, "restartPolicyType": "ON_FAILURE", "restartPolicyMaxRetries": 10 } }
```

`GET /api/health` confere o banco (MySQL) e responde 200 só se a consulta funcionar — se o
Railway mostrar o deploy travado em "healthcheck failing", o problema quase sempre é
`DATABASE_URL` errada ou o plugin MySQL ainda subindo (o timeout de 180 s costuma bastar).

## 4. Depois do primeiro deploy

1. Confira o log de partida: `Sistema pronto em https://<domínio> (escutando em 0.0.0.0:...)`.
2. Entre com `ADMIN_EMAIL`/`ADMIN_PASSWORD`. Crie as demais contas em **Administração** (cada
   uma conecta o próprio WhatsApp; ninguém herda o número de outra conta).
3. Cada usuário conecta o WhatsApp em **WhatsApp → Conectar**, sincroniza os grupos e passa a
   ver os próprios dados nas telas normais — o painel é o mesmo para todo mundo; só quem é
   `SUPER_ADMIN` vê a tela **Administração** a mais.

## Diferença para o deploy na Hostinger

`docs/deploy-hostinger.md` cobre o deploy antigo (hospedagem Node.js compartilhada, sem
volume dedicado — a sessão fica dentro do próprio disco da hospedagem). O Railway é o alvo
de deploy atual do projeto; mantenha os dois documentos se ainda houver instância rodando na
Hostinger, mas trate este aqui como a referência para deploys novos.
