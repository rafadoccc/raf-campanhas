# Registro das operações de tratamento (LGPD, art. 37)

Versão simplificada para agente de tratamento de pequeno porte (Resolução CD/ANPD nº 2/2022).
Documento interno: atualize sempre que o sistema passar a coletar um dado novo ou mudar um prazo.

- **Sistema:** DocDrop (painel de campanhas para grupos de WhatsApp)
- **Responsável:** pessoa física mantenedora do DocDrop, agente de pequeno porte
- **Canal do titular:** o e-mail em `CONTACT_EMAIL`, mostrado em `/privacidade`
- **Encarregado (DPO):** dispensado (art. 11 da Res. 2/2022); o canal acima cumpre o papel
- **Última revisão:** 2026-09-30

## Operações

| # | Dados | Titulares | Finalidade | Base legal | Papel do DocDrop | Onde fica | Prazo |
|---|---|---|---|---|---|---|---|
| 1 | Nome, e-mail, senha cifrada (scrypt), papel, aceite dos termos | Clientes (usuários do painel) | Criar e manter a conta | Execução de contrato (art. 7º, V) | Controlador | Banco MySQL (`User`) | Enquanto a conta existir |
| 2 | IP, navegador, horários de login | Clientes | Segurança, limite de tentativas, investigação de abuso | Legítimo interesse (art. 7º, IX) | Controlador | `AuthSession` | Até a sessão expirar (máx. 30 dias) |
| 3 | Número do WhatsApp conectado e chaves da sessão | Clientes | Enviar as campanhas | Execução de contrato | Controlador | `WhatsAppSession` e pasta de sessões no servidor | Até desconectar ou excluir a conta |
| 4 | Nome, identificador e nº de membros dos grupos | Grupos do cliente | Escolher onde enviar | Definida pelo cliente | Operador | `Group` | Enquanto a conta existir; grupos que saíram do WhatsApp: 6 meses |
| 5 | Textos, imagens, vídeos, horários e histórico de envios | Conteúdo do cliente; pode citar terceiros | Programar e executar os envios | Definida pelo cliente | Operador | `Campaign*`, `Delivery`, `CampaignMedia` | 6 meses após o encerramento; excluída: até 24 h |
| 6 | Hash do número de quem leu (SHA-256 com o id do envio) | Membros dos grupos | Contar leituras | Definida pelo cliente | Operador | `DeliveryRead` (e `PendingRead`, com o número, por até 15 min) | Junto com a campanha |
| 7 | Lista de membros do grupo | Membros dos grupos | "Marcar todos" no envio | Definida pelo cliente | Operador | Só em memória, no envio | Não é guardada |
| 8 | Cópias de segurança do banco e das sessões | Todos acima | Recuperação de desastre | Legítimo interesse | Controlador/operador | Servidor (`/var/backups/campanhas`) e cópia externa cifrada | 7 dias (rotação) |

## Compartilhamento (suboperadores)

| Quem | O quê | Onde |
|---|---|---|
| Hospedagem (Railway, EUA; ou Hostinger VPS, preferir datacenter no Brasil) | Todos os dados, só armazenamento e processamento | Conforme o provedor |
| WhatsApp (Meta) | Mensagens enviadas, pelo próprio protocolo do WhatsApp | Meta |

Transferência internacional (art. 33): enquanto a hospedagem estiver fora do Brasil, a Política
de Privacidade informa, e o provedor precisa oferecer garantias de segurança compatíveis.

## Medidas de segurança (art. 46)

HTTPS; senhas com scrypt; token de sessão guardado só como hash; cookie HttpOnly e SameSite;
isolamento por conta em todas as consultas; limite de tentativas de login e de pedidos por IP;
checagem de origem contra CSRF; CSP; uploads validados pelo conteúdo; conversor de vídeo sem
acesso a arquivos ou rede; backups com permissão só do administrador. Detalhes:
`docs/security-audit-2026-09.md` e `.ai/DECISIONS.md`.

## Direitos do titular (art. 18)

- Acesso e portabilidade: **Minha conta → Baixar meus dados** (JSON).
- Exclusão: **Minha conta → Excluir minha conta**, ou o administrador em **Administração → Excluir conta**
  quando o pedido chegar pelo e-mail.
- Correção de nome ou e-mail e demais pedidos: pelo e-mail de contato, resposta em até 15 dias.
- Membro de grupo pedindo algo: identificar o cliente que enviou e encaminhar a ele, que é o controlador.
