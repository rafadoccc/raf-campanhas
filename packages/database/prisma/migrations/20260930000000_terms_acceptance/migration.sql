-- ADR-040 (LGPD): registro do aceite dos Termos de Uso e da Política de Privacidade.
-- Aditiva: contas existentes ficam sem aceite e o painel pede no próximo acesso.
ALTER TABLE `User` ADD COLUMN `termsAcceptedAt` DATETIME(3) NULL,
    ADD COLUMN `termsVersion` VARCHAR(20) NULL;
