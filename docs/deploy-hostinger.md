# Publicar na Hostinger (hospedagem de sites com Node.js)

O sistema é **um único processo Node** (`server.js`) que entrega o painel e a API na mesma
porta e usa MySQL. É exatamente o formato que a Hostinger roda como "Node.js App".

## Antes de começar

- **Plano:** Node.js só existe nos planos **Business** e **Cloud** (Startup, Professional,
  Enterprise). O plano Premium não roda Node.js.
- **Domínio ou subdomínio** apontado para a Hostinger (ex.: `campanhas.seudominio.com.br`).
  O HTTPS é emitido pela própria Hostinger.
- O repositório `rafadoccc/raf-campanhas` no GitHub.

## 1. Criar o banco MySQL

hPanel → **Bancos de dados** → **Gerenciamento** → criar banco e usuário. Anote o nome do
banco, o usuário e a senha. A Hostinger acrescenta um prefixo (ex.: `u123456789_campanhas`).
Use o **host** que o hPanel mostrar (geralmente `localhost`). As tabelas são criadas
sozinhas no primeiro deploy.

## 2. Criar o app Node.js

hPanel → **Sites** → **Adicionar site** → **Node.js App** → **Importar repositório Git** →
conecte o GitHub e escolha `raf-campanhas`, branch `main`. Configure:

| Campo | Valor |
|---|---|
| Versão do Node.js | **22** |
| Comando de build | `npm run build` |
| Arquivo de entrada | `server.js` |
| Diretório de saída | deixe vazio (é um app de servidor) |

## 3. Variáveis de ambiente

No app, abra **Variáveis de ambiente** e cadastre:

| Variável | Exemplo | Observação |
|---|---|---|
| `DATABASE_URL` | `mysql://u123456789_user:SENHA@localhost:3306/u123456789_campanhas` | Caracteres especiais na senha precisam ser codificados: `@` → `%40`, `#` → `%23`, `/` → `%2F`, `:` → `%3A`. |
| `PUBLIC_URL` | `https://campanhas.seudominio.com.br` | Obrigatória. Com e sem `www.` funcionam. |
| `ADMIN_EMAIL` | `voce@seudominio.com.br` | Cria o primeiro usuário (`SUPER_ADMIN`) na primeira subida. |
| `ADMIN_PASSWORD` | uma senha com 10+ caracteres | **Apague depois do primeiro login.** |
| `ADMIN_NAME` | `Seu nome` | Opcional. |

Não defina `NODE_ENV=production`: com ela o `npm install` deixa de instalar as ferramentas
de build (Vite, TypeScript) e o build falha. Não defina `PORT`, a menos que a Hostinger peça:
ela entrega a porta ao app.

A sessão do WhatsApp é gravada em `~/.local/state/raf-campanhas/sessions`, **fora** da pasta
do app. Isso é essencial: cada deploy troca a pasta do app, e uma sessão guardada lá dentro
se perderia, exigindo ler o QR a cada atualização.

## 4. Primeiro deploy

Clique em **Deploy** e acompanhe o **log de build**. No **log de execução** devem aparecer:

```
All migrations have been successfully applied.
Usuário administrador voce@... criado.
Sistema pronto em https://campanhas.seudominio.com.br
```

Abra o endereço, entre com o e-mail e a senha, e então **apague `ADMIN_PASSWORD`** das
variáveis. O usuário já existe; a variável só serve para a primeira criação.

## 5. Conectar o WhatsApp

Conexão WhatsApp → Conectar → leia o QR com o celular → Sincronizar grupos. A partir daí,
a cada reinício ou deploy o sistema **reconecta sozinho**, sem QR.

## 6. Monitoramento (recomendado)

Cadastre um monitor gratuito (ex.: UptimeRobot) fazendo GET em
`https://campanhas.seudominio.com.br/api/health` a cada 5 minutos. Ele avisa se o sistema ou
o banco cair e mantém o app com tráfego regular.

## Atualizações

Cada `git push` na branch `main` faz a Hostinger reconstruir e reiniciar o app. O
`server.js` aplica migrations pendentes antes de subir, e o WhatsApp reconecta sozinho.
Uma entrega que estava sendo enviada no instante do reinício é marcada como resultado
incerto e **nunca** é reenviada (regra de não duplicar; veja ADR-003).

## Riscos e o que não foi verificado

Estes pontos não constam na documentação pública da Hostinger nem foram testados num
servidor real. Confira nas primeiras semanas:

1. **App sempre ligado.** A fila e a conexão do WhatsApp precisam do processo rodando
   24 horas. A documentação não diz se a hospedagem de sites desliga apps ociosos. Se as
   campanhas pararem sozinhas ou o WhatsApp cair com frequência, o plano não comporta um
   processo contínuo: o mesmo código roda num **VPS da Hostinger** com `node server.js`.
2. **IP de datacenter.** O WhatsApp tende a restringir mais números usados a partir de
   servidores do que de conexões residenciais. Comece com um número que você possa perder.
3. **Tamanho de vídeo.** O MySQL compartilhado pode ter `max_allowed_packet` menor que os
   64 MB aceitos pelo painel. Pelo terminal SSH (plano Business), `npm run db:check` mostra
   o valor. Se for menor, envie vídeos menores.
4. **Uma instância só.** Não publique duas cópias apontando para o mesmo banco: a posse da
   fila (tabela `WorkerLease`) faz a segunda ficar esperando.
5. **Recursos do plano.** A conexão do WhatsApp usa algumas centenas de MB de memória. Em
   planos compartilhados, os limites de memória e processos são do plano.
6. **Local e servidor ao mesmo tempo.** O servidor e o seu computador têm bancos separados.
   Use um só deles para envios reais, para não disparar a mesma campanha duas vezes.

## Backup

O banco entra nos backups automáticos da Hostinger e pode ser exportado pelo phpMyAdmin.
A pasta de sessão não precisa de backup: se ela se perder, basta ler o QR de novo.
