# Deploy numa VPS pequena

Guia para rodar o sistema numa VPS simples (1 vCPU, 1 GB de RAM), com Ubuntu 22.04 ou 24.04.
É um processo Node só (`node server.js`), com o painel e a API na mesma porta, e o MySQL na
mesma máquina.

## O que o sistema já faz para caber numa máquina fraca

- **Painel pré-comprimido:** a compilação grava `.br` e `.gz` de cada arquivo
  (`scripts/compress-dist.mjs`). O servidor entrega o arquivo pronto, sem gastar CPU a cada
  pedido: o painel inteiro pesa ~110 KB para baixar. Os arquivos com hash ficam em cache no
  navegador para sempre, então a segunda visita não baixa nada.
- **Telas pré-carregadas e com cache:** depois do login, o navegador baixa as outras telas quando
  fica ocioso. Voltar para uma tela mostra na hora o que ela tinha e atualiza por trás.
- **Senhas:** no máximo 2 verificações de senha (scrypt, ~32 MB cada) ao mesmo tempo e até 32
  esperando. Uma rajada de logins recebe "servidor ocupado" em vez de esgotar a memória.
- **Uploads:** no máximo 1 recebido ao mesmo tempo, porque o corpo fica em memória (até 200 MB
  num vídeo). O login é conferido **antes** de ler o corpo, então um upload sem login não ocupa
  memória nenhuma. A conversão de vídeo roda uma por vez.
- **Imagens:** o sharp roda sem cache de imagens decodificadas.
- **Limite de pedidos:** 300 por IP de uma vez, repondo 5 por segundo. Folgado para o painel,
  mas corta scripts que disparam pedidos sem parar. O `/api/health` fica de fora.
- **Conexões:** pedido que não termina de chegar cai em 15 minutos, e o servidor aceita no
  máximo 1000 conexões abertas.

## 1. Pacotes

```bash
sudo apt update && sudo apt install -y mysql-server git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
```

**Swap de 1 GB** (evita o sistema matar o processo num pico, como a conversão de vídeo):

```bash
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 2. MySQL com pouca memória

Crie `/etc/mysql/mysql.conf.d/pouca-memoria.cnf`:

```ini
[mysqld]
innodb_buffer_pool_size = 128M
performance_schema = OFF
max_connections = 30
table_open_cache = 200
bind-address = 127.0.0.1
```

Com isso o MySQL fica em ~200 MB em vez de ~400 MB.

```bash
sudo systemctl restart mysql
sudo mysql -e "CREATE DATABASE campanhas CHARACTER SET utf8mb4; CREATE USER 'campanhas'@'localhost' IDENTIFIED BY 'TROQUE-ESTA-SENHA'; GRANT ALL ON campanhas.* TO 'campanhas'@'localhost';"
```

## 3. Sistema

```bash
git clone https://github.com/rafadoccc/raf-campanhas.git /opt/campanhas && cd /opt/campanhas
npm ci && npm run build
cp .env.example .env && nano .env
```

No `.env`:

```ini
PUBLIC_URL=https://campanhas.seudominio.com.br
# O proxy HTTPS (Caddy) fica na mesma máquina: o sistema só escuta localmente.
HOST=127.0.0.1
PORT=3000
DATABASE_URL=mysql://campanhas:TROQUE-ESTA-SENHA@localhost:3306/campanhas?connection_limit=5
SESSIONS_DIR=/var/lib/campanhas/sessions
ADMIN_EMAIL=voce@exemplo.com
ADMIN_PASSWORD=uma-senha-com-10-ou-mais-caracteres
```

Depois de entrar pela primeira vez, apague `ADMIN_PASSWORD` do `.env`.

## 4. Serviço (reinicia sozinho)

`/etc/systemd/system/campanhas.service`:

```ini
[Unit]
Description=Central de Campanhas
After=network-online.target mysql.service

[Service]
WorkingDirectory=/opt/campanhas
ExecStart=/usr/bin/node server.js
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=384
Restart=always
RestartSec=5
# Dá tempo de terminar o envio em andamento antes de parar (o sistema espera até 30 s).
TimeoutStopSec=45
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo mkdir -p /var/lib/campanhas/sessions /opt/campanhas/.runtime
sudo chown -R www-data:www-data /var/lib/campanhas/sessions /opt/campanhas/.runtime
sudo chmod 700 /var/lib/campanhas/sessions /opt/campanhas/.runtime
sudo chown root:www-data /opt/campanhas/.env && sudo chmod 640 /opt/campanhas/.env
sudo systemctl daemon-reload && sudo systemctl enable --now campanhas
journalctl -u campanhas -f   # log
```

O código e as dependências em `/opt/campanhas` continuam pertencendo ao usuário de deploy,
não ao serviço `www-data`. Só as sessões e `.runtime` precisam de escrita durante a execução.
O `.env` pode ser lido pelo serviço, mas não por outros usuários.

## 5. HTTPS com Caddy

```bash
sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```
campanhas.seudominio.com.br {
  reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
```

O Caddy emite e renova o certificado sozinho. Não ligue compressão no Caddy: o painel já vai
comprimido.

## 6. Firewall

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
```

O MySQL (3306) e o sistema (3000) ficam fechados para a internet: só o Caddy fala com o
sistema, pela própria máquina.

## 7. Backup diário

Os arquivos contêm mensagens, mídia e credenciais do WhatsApp. Crie uma pasta acessível só
ao administrador. Pode usar a conta MySQL `campanhas` criada acima para o backup. Guarde a senha
em `/etc/campanhas/mysql-backup.cnf` (formato abaixo), nunca no crontab nem no repositório:

```bash
sudo install -d -m 700 -o root /var/backups/campanhas /etc/campanhas
sudo install -m 600 -o root /dev/null /etc/campanhas/mysql-backup.cnf
sudoedit /etc/campanhas/mysql-backup.cnf
```

Conteúdo do arquivo de credenciais (preencha localmente; não o envie pelo chat):

```ini
[client]
user=campanhas
password=SENHA_DA_CONTA_CAMPANHAS
host=localhost
```

Depois, agende o script versionado. Ele só substitui o backup anterior após **confirmar** que
banco e sessões foram exportados; uma falha não publica um gzip vazio como backup válido.

```bash
sudo crontab -e
# 03:30 todo dia, 7 posições semanais; erros aparecem no log do cron.
30 3 * * * /bin/bash /opt/campanhas/scripts/backup-vps.sh
```

Teste manualmente uma vez: `sudo bash /opt/campanhas/scripts/backup-vps.sh` e confira que
os dois arquivos existem e têm conteúdo. Mantenha também cópia criptografada **fora da VPS**:
um backup só no mesmo servidor não protege contra perda do servidor.

Para validar a restauração, use **um banco de teste separado**, nunca o banco de produção.
Pare a aplicação antes de restaurar de verdade. Confira o arquivo escolhido com
`gzip -t /var/backups/campanhas/campanhas-1.sql.gz` e
`tar -tzf /var/backups/campanhas/sessoes-1.tgz`. Depois restaure o dump no banco de teste,
verifique as campanhas e somente então planeje uma recuperação de produção. As sessões
devem voltar para `/var/lib/campanhas/sessions` com o serviço parado e permissões do usuário
`www-data`; não restaure credenciais de WhatsApp em duas instâncias ligadas ao mesmo tempo.

## Atualizar

Fora de uma rodada de campanha:

```bash
cd /opt/campanhas && git pull && npm ci && npm run build && sudo systemctl restart campanhas
```

As migrations do banco são aplicadas sozinhas na partida (`server.js`).
