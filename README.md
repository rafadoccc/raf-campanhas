# Central de Campanhas

Painel em Next.js, API Fastify, worker de envio e PostgreSQL via Prisma.
Conector WhatsApp com Baileys e provedor simulado separados.

Sem Docker e sem Redis: o PostgreSQL instalado na máquina é o banco **e** a fila.

## Iniciar no Windows

Pré-requisitos: **Node.js 22+** e **PostgreSQL 18** instalado localmente, com o serviço
`postgresql-x64-18` em execução.

1. Na primeira instalação, copie `.env.example` para `.env` e coloque a senha do seu
   usuário do PostgreSQL em `DATABASE_URL`. Não substitua um `.env` existente.

   ```
   DATABASE_URL=postgresql://postgres:SUA_SENHA@localhost:5432/main_db?schema=campanhas
   ```

   As tabelas ficam no schema `campanhas` dentro de `main_db`, isoladas de qualquer
   outra coisa que você já use nesse banco.

2. Crie o banco, se ainda não existir (pelo pgAdmin, ou pela linha de comando):

   ```powershell
   & "C:\Program Files\PostgreSQL\18\bin\createdb.exe" -U postgres main_db
   ```

3. Instale e confira a conexão:

   ```powershell
   npm install
   npm run db:check
   ```

   O diagnóstico diz se o serviço responde, cria o schema `campanhas` se faltar e
   avisa se as migrations ainda não foram aplicadas. Ele nunca imprime a senha.

4. Aplique as migrations, gere o client e suba:

   ```powershell
   npm run setup:local
   npm run start:local
   ```

   `setup:local` roda diagnóstico, migrations, geração do client Prisma e build.

### Atalho na área de trabalho (.exe)

```powershell
npm.cmd run build:exe -- --desktop
```

Gera "Central de Campanhas.exe" e o copia para a área de trabalho. Um duplo clique:

1. confere Node, `.env`, PostgreSQL e portas 3000-3002;
2. aplica migrations pendentes;
3. recompila **só se o código mudou** (compara o conteúdo, não a data dos arquivos);
4. sobe API, worker e painel e abre o navegador.

Se algo estiver errado, a janela fica aberta explicando o que corrigir. Fechar a janela
encerra o sistema. O executável guarda o caminho desta pasta: se você a mover, rode
`build:exe` de novo. Não é assinado digitalmente, então o Windows pode exibir um aviso do
SmartScreen na primeira vez ("Mais informações" > "Executar assim mesmo").

Abra <http://localhost:3000/configuracoes>. O comando `start:local` mantém API, worker e
painel ativos; `Ctrl+C` encerra os três. Se o painel ou o worker antigos estiverem abertos
em outro terminal, encerre-os antes. `npm test` executa os testes sem WhatsApp.

## Conectar WhatsApp

1. Em Conexão WhatsApp, clique em Conectar / gerar QR Code.
2. No celular: WhatsApp > Aparelhos conectados > Conectar um aparelho.
3. Escaneie o QR no painel. Não compartilhe o QR nem a pasta .sessions.
4. Clique em Sincronizar grupos.
5. Crie uma campanha, selecione os grupos em ordem e escolha intervalo de 1 a 60 minutos.
6. Escolha fila única (início ao ativar) ou os horários diários já existentes.
7. Confira o resumo e a mensagem nos detalhes. Selecione Simulação para testar,
   ou WhatsApp real e confirme a autorização dos destinatários antes de iniciar.

Conectar/importar grupos não ativa campanhas. Grupos cadastrados manualmente
servem para simulação. Campanhas antigas continuam no simulador.
O número da conta fica vinculado à campanha na ativação; retomar com outra conta
é bloqueado. Após reiniciar o sistema, clique em Conectar para reutilizar a sessão.
A sincronização marca grupos que deixaram de aparecer como inativos.

## Fila persistente e estados

- Datas inicial e final inclusivas; horários interpretados em America/Sao_Paulo.
- Fila única: primeiro grupo elegível ao ativar; duração mínima `(grupos - 1) × intervalo`.
- Horários diários: cada horário inicia uma rodada; rodadas nunca se sobrepõem na campanha.
- No modo agendado, as mensagens alternam por rodada. No modo imediato, alternam por grupo.
- Só a primeira ativação cria entregas, com sequência e identidade persistidas no PostgreSQL.
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
- Falhas depois de iniciar o envio não são repetidas automaticamente: o resultado pode ser incerto.
  Confira no celular antes de qualquer reenvio.
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

PostgreSQL controla a reserva PENDING → PROCESSING antes da chamada externa, e é também
a fila: o worker varre o banco a cada 5 segundos, sem serviço externo. Ele valida estado,
ordem e intervalo sob lock da campanha, então uma varredura atrasada não contorna
pausa/encerramento. Um lease em WorkerLease garante um processador por vez. PROCESSING encontrado
ao reiniciar vira FAILED com aviso de resultado incerto e nunca é repetido automaticamente.
Não existe promessa de exactly-once através do WhatsApp: uma queda entre o envio e a
resposta pode deixar o resultado desconhecido. Por segurança, esta versão NÃO oferece
Tentar novamente para falhas; não é possível provar que uma mensagem não foi entregue.
É uma escolha conservadora para evitar duplicatas, podendo deixar mensagens sem envio.

## Estrutura e limites

- apps/web: painel e conexão por QR.
- apps/api: campanhas, grupos, histórico e ativação.
- apps/worker: fila, controle local do conector e adaptador Baileys.
- packages/database: modelo Prisma e migrações versionadas.
- scripts/start-local.cjs: inicia os serviços a partir da raiz, carregando .env.
- Não há Docker nem Redis: PostgreSQL local é banco e fila (ver .ai/DECISIONS.md, ADR-008).

Versão local, um número e um worker. API, worker e painel iniciam no endereço
de loopback. Não publique esses serviços na internet sem implementar autenticação,
TLS, armazenamento protegido de sessão, backups e gerenciamento dos processos.
O diretório .sessions está excluído do Git; os arquivos de autenticação ficam
locais, sem criptografia adicional. Desconectar tenta revogar a sessão e arquiva
os arquivos localmente; também é possível remover o aparelho pelo celular.

Baileys é não oficial; não há garantia contra bloqueio ou mudanças no WhatsApp.
A versão 7.0.0-rc14 foi fixada no package-lock.json; é uma versão candidata.
Não há mecanismos de evasão de restrições, criação de grupos ou adição de pessoas.

## Testar e atualizar

Antes de atualizar, pare API/worker/painel com Ctrl+C; mantenha o serviço do PostgreSQL ativo.
Execute `npm run db:deploy`, `npm run db:generate`, `npm run build` e `npm run start:local`.
A migração interval_queue é aditiva; não exclui dados. Não rode uma versão antiga do
worker junto da nova. Não há autenticação: mantenha acesso somente local.

- `npm test`: testes de planejamento, protocolo e adaptador, sem WhatsApp.
- `npm run test:integration`: aplica migrations num schema PostgreSQL aleatório e isolado,
  testa API/estados/reserva concorrente/ordem/falhas/retomada/recibos e remove somente esse
  schema ao terminar. Não usa nem apaga campanhas do schema principal.
- `npm run lint`: verificação TypeScript de todos os pacotes.
- `npm run build`: build completo, inclusive Next.js.

Os testes de reinício automatizados simulam perda do cliente após a reserva persistente;
não simulam queda da rede do WhatsApp. Recibos reais dependem de teste com celular e
outro participante. Atualizações visuais ocorrem a cada 15 segundos só com a aba visível.

npm audit também apontou problemas em dependências transitivas existentes
(Prisma/deepmerge-ts e PostCSS do Next). Não houve atualização forçada para outra
versão principal. Este projeto ainda não deve ser considerado pronto para produção.
# Mídia opcional (V1)

Na criação/edição de rascunhos, use **Adicionar mídia** para escolher uma imagem JPEG/PNG ou vídeo MP4 H.264/AAC. É possível visualizar, trocar e remover antes de salvar. A mídia fica no PostgreSQL e acompanha o backup do banco; não apague o volume postgres_data. Aplique migrations com `npm run db:deploy` após atualizar. Consulte [formatos, limites e validação](docs/campaign-media.md).
