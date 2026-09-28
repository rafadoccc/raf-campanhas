// Sobe o sistema local: um único processo serve o painel e a API na porta PORT (3000).
const { spawn } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const child = spawn(process.execPath, ['--env-file=.env', 'server.js'], { cwd: root, stdio: 'inherit' });
let forcing;
child.on('exit', code => {
  clearTimeout(forcing);
  if (code) console.error('O sistema parou. Confira o erro acima.');
  process.exitCode = code ?? 0;
});
// Ctrl+C e fechar a janela chegam também ao servidor (mesmo console), que se encerra sozinho
// gravando a sessão do WhatsApp. Matar o filho aqui era, no Windows, encerramento forçado no meio
// dessa gravação (ADR-036): só força se ele não sair em 40 s.
const waitThenKill = () => { forcing ??= setTimeout(() => child.kill(), 40_000); };
process.on('SIGINT', waitThenKill);
process.on('SIGHUP', waitThenKill);
// SIGTERM vem só para este processo (gerenciador de serviço): repassa. Fora do Windows é um pedido
// educado de encerramento, e o servidor grava tudo antes de sair.
process.on('SIGTERM', () => { if (process.platform === 'win32') waitThenKill(); else child.kill('SIGTERM'); });
