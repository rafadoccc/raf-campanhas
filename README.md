# Central de Campanhas

Gerenciador de campanhas para grupos de WhatsApp. **Um único processo Node** entrega o
painel (React + Vite) e a API (Fastify) na mesma porta, roda a fila de envios e mantém a
conexão com o WhatsApp (Baileys). Os dados ficam no **MySQL 8**, que também é a fila: não há
Docker nem Redis.

Para publicar no Railway (alvo de deploy atual), veja
**[docs/deploy-railway.md](docs/deploy-railway.md)**; para a Hostinger (deploy anterior),
**[docs/deploy-hostinger.md](docs/deploy-hostinger.md)**.

## Iniciar no Windows

Pré-requisitos: **Node.js 22+** e **MySQL 8** (serviço `MySQL80` em execução).

1. Copie `.env.example` para `.env` e coloque a senha do MySQL em `DATABASE_URL`.
   O banco `campanhas` é criado sozinho. Não substitua um `.env` existente.
2. Instale as dependências uma vez: `npm.cmd install`
3. Gere o atalho: `npm.cmd run build:exe -- --desktop`
4. Dê duplo clique em **Central de Campanhas.exe** na área de trabalho.

O inicializador confere Node, `.env`, MySQL e a porta 3000, aplica migrations, recompila
só se o código mudou, e **no primeiro uso pede o e-mail e a senha** do usuário do painel.
Depois abre <http://localhost:3000>. Fechar a janela encerra o sistema. Se algo estiver
errado, a janela fica aberta explicando o que corrigir.

Sem o atalho: `npm.cmd run user:create` (uma vez) e `npm.cmd run start:local`.
No PowerShell use `npm.cmd`; o `npm` puro é bloqueado pela política de scripts do Windows.

### Login

Todo o painel e toda a API exigem login. Não há cadastro público. Papéis: `SUPER_ADMIN`
(administra o sistema) e `USER`. A primeira conta — criada pelo inicializador, por
`npm run user:create` com o banco vazio ou, num servidor, por `ADMIN_EMAIL`/`ADMIN_PASSWORD` —
é `SUPER_ADMIN`. Depois, `npm run user:create` cria `USER`; um novo `SUPER_ADMIN` exige
`npm run user:create -- --super-admin` e confirmação digitada. O mesmo comando redefine a
senha de uma conta existente (sem mudar o papel). A senha é trocada em **Minha conta**.
O login se renova com o uso, até um teto absoluto de 30 dias desde a entrada.

### Multiusuário e administração

Cada conta é independente: campanhas, grupos, mídia e histórico de um usuário nunca aparecem
para outro. Todas as telas são as mesmas para todo mundo; a única diferença de quem é
`SUPER_ADMIN` é a tela extra **Administração**, com métricas do sistema inteiro (contas,
envios/falhas de hoje, fila, últimos 7 dias, erros mais comuns, WhatsApp conectados,
despachante) e a gestão de contas — nunca o conteúdo de campanhas ou mensagens de ninguém.

## Conectar WhatsApp

Cada usuário conecta o **próprio** número; não há conexão compartilhada entre contas.

1. Em **WhatsApp**, clique em **Conectar / gerar QR Code**.
2. No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho.
3. Leia o QR na tela (ele se renova sozinho a cada 20 segundos).
4. Clique em **Sincronizar grupos**.
5. Crie uma campanha, busque e selecione os grupos em ordem, e escolha o intervalo (mínimo de
   3 minutos entre grupos — piso fixo, protege o número contra bloqueio). Marque **"Marcar
   todos os membros (@todos)"** se quiser que cada participante receba notificação de menção
   sem mudar o texto da mensagem.
6. Escolha fila única (início ao ativar) ou horários diários.
7. Confira o resumo. Use **Simulação** para testar, ou **WhatsApp real** confirmando a
   autorização dos destinatários.

Depois de pareado, o sistema **reconecta sozinho** ao iniciar (sem QR). Conectar ou
sincronizar não ativa campanhas. A sessão fica fora da pasta do projeto
(`%LOCALAPPDATA%\raf-campanhas\sessions`, uma subpasta por usuário) e nunca entra no Git;
"Desconectar" apaga essa cópia local. O número fica vinculado à campanha na ativação; retomar
com outro é bloqueado.

## Fila persistente e estados

- Datas inicial e final inclusivas; horários interpretados em America/Sao_Paulo.
- Fila única: primeiro grupo elegível ao ativar; duração mínima `(grupos - 1) × intervalo`.
- Horários diários: cada horário inicia uma rodada; rodadas nunca se sobrepõem na campanha.
- No modo agendado, as mensagens alternam por rodada. No modo imediato, alternam por grupo.
- Só a primeira ativação cria entregas, com sequência e identidade persistidas no MySQL.
- Worker reconcilia a fila a cada 5 segundos; a espera não depende do navegador.
- Só o primeiro item pendente da campanha pode ser reservado; existe uma espera mínima
  entre a finalização de uma tentativa e o início da próxima, inclusive após falhas.
- Pausa conserva os pendentes e o restante do intervalo. Retomar não recria entregas.
- Fechar o navegador não interrompe. Desligar o computador interrompe: ao voltar, inicie
  os serviços e conecte WhatsApp; os pendentes continuam em ordem, sem rajada de atrasados.
- Encerrar cancela pendentes definitivamente. Um envio já reservado/em andamento pode terminar.
- COMPLETED (todas as tentativas terminaram) e CANCELLED (encerramento manual) aparecem
  como Encerrada, sem Retomar. O histórico distingue sucessos, falhas e cancelamentos.
- Excluir só é permitido em rascunhos/encerradas e sem tentativa em andamento. É exclusão
  lógica (`deletedAt`): sai da lista, mas histórico e métricas não são apagados.
- O padrão de 3 minutos também é aplicado às campanhas antigas; entregas existentes não
  são recriadas. A nova migração numera a ordem antiga por horário/criação/ID.
- Falhas depois de iniciar o envio não são repetidas automaticamente: o resultado pode ser
  incerto. Uma falha **certa** (nada saiu) pode ser tentada de novo, por envio ou em lote pela
  campanha; uma falha de resultado **incerto** exige confirmação explícita antes de tentar de
  novo (risco de duplicar).
- SENT significa que o provedor retornou um identificador, não confirmação de entrega/leitura.
- O histórico identifica os envios simulados.

### Leituras de mensagens

Não contamos refreshs, acessos ao painel nem entradas em grupos. O conector escuta
`message-receipt.update` e registra apenas recibos individuais com `readTimestamp`,
para mensagens enviadas pelo sistema, grupo e conta correspondentes. Uma restrição
única em `(deliveryId, recipientHash)` elimina recibos repetidos. Não exibimos números
dos leitores; persistimos um hash por mensagem do identificador fornecido pelo WhatsApp.
O contador é aproximado: recibos ausentes, períodos desconectados, mudanças de identidade
PN/LID ou mensagens anteriores à atualização podem causar sub/supercontagem. Não há
backfill garantido. Zero recibos não comprova zero leitores. Um buffer limitado em memória
absorve recibos que chegam antes da gravação do ID do envio; um reinício nessa janela pode
perder esse recibo. O dashboard conta leituras por mensagem (não pessoas únicas entre campanhas).
Mostra hoje e ontem no fuso de São Paulo. Simulações não entram em sucesso/envios reais.

### Idempotência e resultados incertos

O MySQL controla a reserva PENDING → PROCESSING antes da chamada externa, e é também
a fila: o servidor varre o banco a cada 5 segundos, sem serviço externo. Ele valida estado,
ordem e intervalo sob lock da campanha, então uma varredura atrasada não contorna
pausa/encerramento. Um lease em WorkerLease garante um processador por vez. PROCESSING encontrado
ao reiniciar vira FAILED com aviso de resultado incerto e nunca é repetido automaticamente.
Não existe promessa de exactly-once através do WhatsApp: uma queda entre o envio e a
resposta pode deixar o resultado desconhecido. Por isso "Tentar de novo" trata as duas
situações de formas diferentes: falha **certa** (nada chegou a sair) tenta de novo sem
perguntar; falha de resultado **incerto** exige confirmar explicitamente, avisando do risco de
duplicar a mensagem se ela já tiver chegado (ADR-030).

## Estrutura

- `server.js`: ponto de entrada. Aplica migrations pendentes e sobe o servidor.
- `apps/server`: Fastify com a API em `/api`, login, segurança, entrega do painel, fila de
  envios e conector Baileys.
- `apps/web`: painel React (Vite + React Router + Tailwind), compilado para `apps/web/dist`.
  Design system documentado em [docs/design-system.md](docs/design-system.md).
- `packages/database`: schema Prisma (MySQL), migrations e a lógica transacional da fila.
- `scripts/`: inicializador, diagnóstico do banco, criação de usuário e testes.
- `.ai/`: protocolo entre os agentes de IA (ver `AGENTS.md`).

Baileys é uma integração não oficial: o WhatsApp pode mudar o protocolo ou restringir o
número. O pareamento por QR inclui uma correção para a mudança de julho/2026 que o
Baileys 7.0.0-rc14 ainda não trata (ver `apps/server/src/pairing.ts`).

## Testar e atualizar

- `npm test`: testes sem banco nem WhatsApp (planejamento, relógio, pareamento, reconexão).
- `npm run test:integration`: cria um banco MySQL descartável (`campaign_test_*`), testa API,
  login, segurança, fila concorrente, recibos e o painel servido, e apaga o banco no fim.
- `npm run lint`: TypeScript de todos os pacotes. `npm run build`: build completo.
- Desenvolvimento: `npm run dev:server` e, em outro terminal, `npm run dev:web` (Vite na
  5173 repassando `/api` para a 3000).

Para atualizar, feche a janela do sistema e abra o `.exe` de novo: ele recompila o que mudou.
Envio real e recibos de leitura só são validados com celular; os testes usam simulação.

## Mídia opcional

Na criação/edição de rascunhos, use **Adicionar mídia** para escolher uma imagem JPEG/PNG (até 16 MB) ou um vídeo de até 200 MB em MP4, MOV (inclusive o HEVC "Alta eficiência" do iPhone), WebM, MKV, 3GP ou AVI. Vídeo fora do padrão do WhatsApp é convertido automaticamente para MP4 H.264/AAC (até 1280 px, resultado de até 64 MB) ao salvar; MP4 H.264 já no padrão vai intacto. É possível visualizar, trocar e remover antes de salvar. A mídia fica no MySQL e acompanha o backup do banco. Aplique migrations com `npm run db:deploy` após atualizar. Consulte [formatos, limites e validação](docs/campaign-media.md).
