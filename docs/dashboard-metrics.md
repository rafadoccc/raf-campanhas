# Dashboard e métricas

- Dashboard: hoje é o dia civil em America/Sao_Paulo, usando a referência do servidor; não é uma janela móvel de 24 horas.
- Sucesso hoje: SENT com sentAt hoje / (esses SENT + FAILED com updatedAt hoje), somente provedor real. Sem resultados: null, exibido como —. Uma falha tem apenas a data de atualização disponível; não se inventa uma data de falha nem um histórico de tentativas.
- Leituras hoje usam readAt dos recibos de entregas reais enviadas. O total da campanha e de cada grupo não tem filtro temporal nem filtro de campanha ativa; encerramento não apaga leituras.
- As consultas da Dashboard são somente leitura, com snapshot consistente. Campanhas em andamento incluem apenas ACTIVE não excluídas. O próximo envio é a primeira entrega pendente da sequência de cada campanha, respeitando nextAvailableAt. Uma entrega PROCESSING não é anunciada como novo envio pendente.
- Atividade recente: até oito resultados reais, ordenados pelo horário persistido (sentAt para enviados; updatedAt para falhas). Não representa todos os eventos nem inclui simulações.
- Auditoria antes desta alteração: seis recibos confirmados de 18/09/2026, todos em campanhas encerradas. Havia também recibos pendentes sem associação confirmada; não são visualizações válidas até o processamento confirmar a relação. Leituras nunca recebidas/registradas não podem ser reconstruídas.
- Nenhuma migration ou alteração no processamento da fila nesta etapa.
