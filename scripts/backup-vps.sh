#!/usr/bin/env bash
# Backup atômico do MySQL e das sessões do WhatsApp na VPS (executar como root via cron).
set -Eeuo pipefail

backup_dir=/var/backups/campanhas
sessions_dir=/var/lib/campanhas
credentials=/etc/campanhas/mysql-backup.cnf

test -d "$backup_dir" && test -r "$credentials" && test -d "$sessions_dir/sessions" || {
  echo 'Diretório de backup, credenciais ou sessões ausentes.' >&2
  exit 1
}

db_tmp=$(mktemp "$backup_dir/.banco-XXXXXX")
sessions_tmp=$(mktemp "$backup_dir/.sessoes-XXXXXX")
trap 'rm -f -- "$db_tmp" "$sessions_tmp"' EXIT

# pipefail impede publicar um gzip vazio se mysqldump falhar.
mysqldump --defaults-extra-file="$credentials" --single-transaction --quick --no-tablespaces --routines --triggers campanhas | gzip -c > "$db_tmp"
test -s "$db_tmp"
tar -czf "$sessions_tmp" -C "$sessions_dir" sessions
test -s "$sessions_tmp"

day=$(date +%u)
mv -f -- "$db_tmp" "$backup_dir/campanhas-$day.sql.gz"
mv -f -- "$sessions_tmp" "$backup_dir/sessoes-$day.tgz"
echo "Backup concluído: dia $day"
