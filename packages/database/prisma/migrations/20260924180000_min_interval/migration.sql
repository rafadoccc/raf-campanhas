-- ADR-028: intervalo mínimo de 3 minutos entre envios.
-- Campanhas antigas com intervalo menor passam a 3 minutos. Nada mais muda: envios, horários
-- já enviados e métricas ficam como estão. (A fila também aplica esse piso em tempo de envio.)
UPDATE `Campaign` SET `intervalSeconds` = 180 WHERE `intervalSeconds` < 180;
