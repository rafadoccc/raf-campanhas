-- ADR-035: intervalo mínimo entre grupos passa de 3 para 2 minutos (pedido do dono).
-- Só o padrão da coluna muda; campanhas existentes mantêm o intervalo que foi escolhido.
ALTER TABLE `Campaign` ALTER COLUMN `intervalSeconds` SET DEFAULT 120;
