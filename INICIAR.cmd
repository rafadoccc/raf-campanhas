@echo off
cd /d "%~dp0"
echo Verifique se o servico do PostgreSQL esta em execucao.
echo Para parar o sistema, pressione Ctrl+C nesta janela.
call npm.cmd run start:local
if errorlevel 1 pause
