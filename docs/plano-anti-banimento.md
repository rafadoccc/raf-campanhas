# Plano: proteção contra banimento do número (T-131 a T-135)

**Status:** T-131, T-132, T-135 e o intervalo por grupo (T-136) **implementados** (ADR-041, 2026-10-01).
Intervalo aleatório de 1:45 a 3:00 **implementado** (T-137, ADR-042). Aquecimento de número novo
**implementado** (T-134, ADR-043), perguntado uma vez por número. T-133 (variações de texto) aguarda
decisão do dono.

Decisões do dono: silêncio a partir das 22:00; limite diário de 150; intervalo de 2 h no mesmo
grupo, configurável de 30 min a 24 h; o limite diário conta envios (mandar 5 vezes para 20 grupos
= 100 envios); o mesmo flyer pode continuar.

## Por que

O WhatsApp bane ou restringe números que parecem robôs: muitos envios seguidos no mesmo ritmo,
mensagens idênticas, envio de madrugada, número novo que já sai mandando muito, e denúncias. Um
cliente que perde o número cancela. Hoje o sistema já tem um intervalo mínimo de 2 minutos entre
grupos por número (ADR-006/035). As cinco peças abaixo completam a proteção.

## Configuração (uma por conta)

Tabela nova `SendingPolicy` (migration aditiva), editada na tela **WhatsApp**, num bloco
"Proteção do número", com padrões seguros já preenchidos:

| Campo | Padrão | Para quê |
|---|---|---|
| `quietStart` / `quietEnd` | `22:00` / `08:00` | Janela sem envios (T-131) |
| `dailyLimit` | 150 grupos/dia | Teto diário (T-132) |
| `jitterPercent` | 50 % | Intervalo aleatório (T-134) |
| `warmup` | ligado | Limite menor nos primeiros dias do número (T-134) |
| `autoPause` | ligado | Pausar quando houver sinal de bloqueio (T-135) |

## As cinco peças

### T-131 · Janela de horário (sem madrugada)
- **Onde:** `claimDelivery` / `accountAllows` (queue.ts). Fora da janela, o número fica
  indisponível até o próximo `quietEnd` (grava `WhatsAppAccount.nextAvailableAt`), sem falhar o envio.
- **Tela:** a previsão da fila (`queue-forecast.ts`) mostra "Aguardando 08:00 (horário de
  silêncio)". O formulário avisa quando um horário escolhido cai dentro da janela.
- **Esforço:** pequeno.

### T-132 · Limite diário por número
- **Onde:** no mesmo ponto: conta envios `SENT` + `PROCESSING` do número no dia (fuso de São
  Paulo). Chegou ao teto: indisponível até o início da janela do dia seguinte.
- **Tela:** "Hoje: 45 de 150 envios" no Início e na tela WhatsApp; a previsão mostra "Limite do
  dia atingido, continua amanhã às 08:00".
- **Esforço:** pequeno a médio (índice em `Delivery(status, sentAt)` para a contagem ficar barata).

### T-133 · Variações do texto `{Bora|Partiu|Vem}`
- **Onde:** `planDeliveries` (schedule.ts). Cada envio já guarda o próprio texto
  (`Delivery.messageBody`), então a variação é sorteada **na ativação**, uma por grupo, e fica
  gravada: o que a tela mostra é exatamente o que sai.
- **Regra:** só vira variação o que tem `|` dentro de chaves. Assim `{faltam}` (a contagem
  regressiva, feature futura) não conflita.
- **Tela:** no editor da mensagem, a prévia mostra uma das versões e um botão "Ver outra
  variação"; um aviso quando todas as mensagens são idênticas e há muitos grupos.
- **Esforço:** médio (parser, validação de chaves abertas e testes).

### T-134 · Intervalo aleatório e aquecimento do número novo
- **Intervalo aleatório:** em vez de exatamente 2 min, sorteia entre o intervalo e
  intervalo × (1 + `jitterPercent`), por exemplo de 2 a 3 min. Muda `effectiveInterval`, o ponto
  mais delicado: o sorteio vai para quem grava `nextAvailableAt`, e o piso de 2 min continua valendo.
- **Aquecimento:** coluna `WhatsAppSession.pairedAt` (gravada no primeiro pareamento). Limite
  diário reduzido: dias 1 a 3: 30; dias 4 a 7: 80; depois, o `dailyLimit`.
- **Esforço:** médio.

### T-135 · Pausa automática ao detectar sinal de bloqueio
- **Sinais:** desconexão com motivo 403 (número restrito ou banido); várias recusas do servidor
  seguidas (`serverRejectedAt`) no mesmo número; limite de taxa do WhatsApp (erro 429 / "rate-overlimit").
- **Ação:** pausa **todas** as campanhas ativas daquele número, registra o motivo e mostra um
  aviso vermelho no Início e na tela WhatsApp ("Pausamos seus envios: o WhatsApp deu sinais de
  restrição. Espere 24 h antes de retomar"). Retomar é manual.
- **Esforço:** médio (os sinais já chegam no `whatsapp.ts`; falta juntar e agir).

## Ordem sugerida

1. **T-131 + T-132 juntas:** mesmo ponto do código, maior proteção pelo menor esforço.
2. **T-135:** evita o pior caso (continuar mandando depois de uma restrição).
3. **T-133:** o que mais ajuda contra "mensagem idêntica em massa".
4. **T-134:** ajuste fino.

## Testes

- Unitários: parser de variações; cálculo da próxima janela, com virada de dia e fuso.
- Integração: a fila não reivindica envio na janela de silêncio nem acima do limite do dia;
  a variação gravada na ativação é a que sai no envio; a pausa automática para todas as
  campanhas do número e só dele.
- Previsão (`queue-forecast.test.ts`): motivos novos de espera.
