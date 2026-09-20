# Atualização da fila — análise e decisões

## Arquitetura encontrada

Next 15/React apresenta dashboard, criação/lista de campanhas, grupos, conexão e histórico.
Fastify em loopback é a única API do painel. Prisma/PostgreSQL guarda Campaign, Group,
CampaignGroup, Message, Schedule e Delivery; Redis/BullMQ apenas despacha trabalhos.
O worker possui adaptadores simulado/Baileys e mantém autenticação fora do Git.

Antes: todos os grupos do horário tinham o mesmo scheduledAt; worker global de 1,5s;
pausa deixava jobs finalizados no Redis e cancelava horários vencidos; retomada reconstruía
entregas; COMPLETED existia mas nunca era aplicado automaticamente. A tabela de entregas
já era a base correta para histórico/idempotência, por isso não houve troca de stack.

## Mudanças incrementais

- Campaign: mode, intervalSeconds, nextAvailableAt, pausedAt, deletedAt.
- CampaignGroup.position preserva seleção/reordenação; Delivery.sequence identifica a fila.
- Reserva transacional com lock da campanha, verificação do primeiro pendente e estado.
- Chamada externa fora da transação; marca PROCESSING durável protege contra repetição
  após crash. Finalização avança o relógio e encerra ao esgotar os pendentes.
- Ações concorrentes pause/stop/delete usam o mesmo lock. Uma reserva anterior à pausa
  é considerada em andamento e pode concluir; nenhuma nova reserva passa depois da pausa.
- Redis pode ser reconstruído a partir do banco. A interface não processa envios.
- A exclusão lógica mantém relacionamentos e métricas; grupos e APIs foram preservados.
- Recibos de leitura deduplicados no banco, separados do status de envio.

## Riscos e limites explícitos

Não há transação distribuída com WhatsApp: resultado incerto não é reenviado, sacrificando
eventualmente uma entrega para não produzir duplicatas. Campanhas encerradas não reabrem.
As leituras são recibos observados, não analytics completos. A compatibilidade de Baileys
continua sujeita a alterações externas. Produção pública requer autenticação/TLS/backups
e armazenamento protegido de sessões em uma etapa futura, fora desta solicitação.
As quatro campanhas existentes foram preservadas. Fixtures automatizadas ficam em schema
isolado; o teste visual usa exclusivamente provedor simulado.

## Verificação realizada

- 14 testes unitários e 9 de integração passaram; TypeScript e build de produção passaram.
- Teste no navegador: criação com dois grupos simulados, reordenação, resumo, ativação,
  primeiro envio, pausa durante intervalo, refresh após horário original, retomada e
  encerramento automático. Foram exatamente duas entregas, sem repetição da primeira.
- A campanha QA foi excluída logicamente ao final; só seu histórico simulado permanece.
- Migração aplicada no banco local sem remover as quatro campanhas preexistentes.
- Não houve envio real nem validação de recibo real nesta atualização.
- Git: tentativa de branch/staging bloqueada pelo Windows em HEAD.lock/index.lock,
  mesmo com permissão solicitada. Nenhum commit foi criado.
