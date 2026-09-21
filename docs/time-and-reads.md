# Horário, recibos e polling — segunda etapa

## Horário

As colunas Prisma DateTime existentes permanecem em UTC por convenção (MySQL DATETIME(3) sem fuso; nunca compare essas colunas com NOW() em SQL bruto); Prisma recebe objetos Date e a API devolve ISO com Z. Não foi aplicada migration nem deslocamento aos registros antigos.
startsAt/endsAt de campanhas agendadas representam datas de calendário inclusivas, armazenadas à meia-noite UTC como codificação de YYYY-MM-DD, não instantes de início de envio. O planner combina essa data com HH:mm e America/Sao_Paulo, convertendo então a entrega para UTC. A lista exibe essas datas sem conversão que mudaria o dia.

O servidor calibra UTC usando o cabeçalho Date de duas fontes HTTPS independentes (Google e Cloudflare), com respostas não cacheadas e concordância máxima de 5 segundos. Não há deslocamento fixo de horas. Depois da calibração, usa tempo monotônico, independente de mudanças no relógio do Windows. Revalida em segundo plano a cada 5 minutos; indisponibilidade não interrompe pausa/retomada/encerramento. A primeira consulta aguarda no máximo o timeout de rede de 3 segundos por fonte (em paralelo). A correção é salva atomicamente em .runtime/clock.json, ignorado pelo Git, e reaproveitada no reinício offline. API e worker usam a mesma implementação e arquivo. O formulário exibe 24 horas explicitamente. Sem rede e sem cache, a hora real não pode ser inferida: mantém operações disponíveis com o relógio do servidor e a tela informa que não há referência confirmada. Ao reiniciar offline, o cache supõe que o relógio do host não mudou desde a calibração; mantenha NTP habilitado para operação prolongada offline. Não se reescrevem datas antigas por adivinhação.

Criação, validação de horários futuros, ativação, pausa/retomada, seleção/reserva/finalização dos envios, métricas diárias e cálculo do próximo envio usam a referência do servidor. /time fornece a mesma referência para o formulário. Instantes são exibidos em America/Sao_Paulo (Horário de Brasília). Não foi alterado o relógio do Windows.

Os metadados históricos e datas que já foram gravados com o relógio antigo não são corrigidos por adivinhação. Campos de auditoria internos gerados automaticamente pelo banco/Prisma ainda requerem relógio do host sincronizado; eles não comandam a fila. Os horários de agendamentos já existentes são preservados: revise campanhas previamente cadastradas interpretando outro fuso antes de ativar.

## Visualizações

Não existem páginas públicas, links rastreados ou contagem de abertura de grupo. A fonte é message-receipt.update do Baileys. Recibos de leitura de mensagens próprias em grupos são associados por mensagem do provedor + grupo + número conectado, e só persistem quando há exatamente uma entrega real enviada correspondente. Recibos são inseridos primeiro em PendingRead (migration 20260919000100_pending_reads, somente aditiva). Pendências sem associação permanecem no banco e são revisitadas em lotes; só são removidas após registro idempotente da leitura. Reiniciar depois da gravação preserva o processamento. Associações ambíguas não são atribuídas.

DeliveryRead referencia Delivery, que identifica campaignId/groupId. A restrição única deliveryId/recipientHash deduplica retransmissões; os totais da campanha e de cada grupo somam todas as leituras, independentemente da página do histórico. A mesma pessoa lendo mensagens diferentes conta mais de uma vez. Simulações não contam. Não é uma contagem de pessoas únicas nem de todos os membros que abriram o grupo.

Limites: recibos podem não chegar; a morte do processo antes do commit inicial ou uma falha do banco durante o recebimento ainda pode perder o evento externo, pois o Baileys não fornece confirmação transacional com o banco. Recibos já confirmados no banco sobrevivem a reinício; pendências sem associação não são descartadas automaticamente. IDs PN/LID distintos não são mesclados sem mapeamento confirmado. A associação e deduplicação foram testadas com fixtures em schema isolado; o recebimento de recibos reais depende do teste pelo usuário. Nenhum envio real foi feito nesta etapa.

Teste real sugerido: enviar uma mensagem autorizada para dois grupos de teste; alguém lê só no grupo A, depois no B; conferir incremento por grupo, total igual à soma e estabilidade ao atualizar a página. Repetir leitura da mesma mensagem não deve incrementar. A ausência de recibo não prova que ninguém leu.

## Polling

Conexão: 2,5s durante pareamento/reconexão, 15s quando conectada, 30s se servidor indisponível, sem timer se desconectada/com erro. Ao esconder a aba, cancela timer e requisição; ao voltar, consulta imediatamente. Desmontagem remove listeners e impede respostas antigas de recriarem timers. O relógio do formulário também suspende suas consultas quando a aba fica oculta.
