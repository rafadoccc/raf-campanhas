@echo off
cd /d "%~dp0"
echo Deixe o Docker Desktop aberto antes de iniciar.
echo Para parar o sistema, pressione Ctrl+C nesta janela.
call npm.cmd run start:local
if errorlevel 1 pause
