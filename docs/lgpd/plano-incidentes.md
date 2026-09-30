# Plano de resposta a incidentes de segurança (LGPD, art. 48)

Base: Resolução CD/ANPD nº 15/2024. Agente de pequeno porte tem prazo **em dobro**
(Res. 2/2022): comunicar a ANPD e os titulares em até **6 dias úteis** a partir de quando
soube que o incidente afetou dados pessoais. Na dúvida, comunique antes.

## Exemplos de incidente

- Alguém entrou numa conta que não é dele, ou no painel de administração.
- O banco de dados, um backup ou a pasta de sessões do WhatsApp vazou ou foi copiado.
- O servidor foi invadido, ou uma senha do servidor, do GitHub ou da hospedagem foi exposta.
- Dados de um cliente apareceram para outro cliente.

## Passo a passo

1. **Conter (na hora).**
   - Trocar a senha do servidor, da hospedagem, do GitHub e do MySQL que possam estar expostas.
   - Encerrar sessões: no painel, *Administração → Encerrar sessões* de cada conta afetada,
     ou `DELETE FROM AuthSession;` para derrubar todas.
   - Se as sessões do WhatsApp vazaram: desconectar cada número (o cliente remove o aparelho
     em *WhatsApp → Aparelhos conectados*) e parear de novo.
   - Se preciso, desligar o sistema (`sudo systemctl stop campanhas`).
2. **Avaliar (até 2 dias).** Anotar num arquivo: o que aconteceu, quando começou, quando foi
   descoberto, quais contas e quais dados (tabela do `registro-operacoes.md`), quantas pessoas,
   e se há risco relevante (ex.: mensagens, telefones, credenciais expostas).
3. **Comunicar, se houver risco ou dano relevante.**
   - **ANPD:** formulário de comunicação de incidente no site gov.br/anpd.
   - **Titulares afetados:** e-mail aos clientes com o que aconteceu, quais dados, o que já foi
     feito e o que eles devem fazer (ex.: trocar a senha, reconectar o WhatsApp). Clientes são
     controladores dos dados dos grupos: eles decidem se avisam os membros.
4. **Corrigir.** Tapar a falha, atualizar o sistema, registrar no `.ai/HANDOFF.md` e, se for
   decisão de arquitetura, em `.ai/DECISIONS.md`.
5. **Guardar o registro** do incidente por 5 anos (Res. 15/2024, art. 10), mesmo se não houve
   comunicação: data, o que aconteceu, dados afetados, avaliação de risco e medidas tomadas.

## Contatos

| Quem | Como |
|---|---|
| Responsável pelo DocDrop | e-mail em `CONTACT_EMAIL` |
| Hospedagem | painel/suporte do provedor |
| ANPD | gov.br/anpd |
