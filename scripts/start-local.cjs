// Sobe o sistema local: um único processo serve o painel e a API na porta PORT (3000).
const { spawn } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const child = spawn(process.execPath, ['--env-file=.env', 'server.js'], { cwd: root, stdio: 'inherit' });
child.on('exit', code => { if (code) console.error('O sistema parou. Confira o erro acima.'); process.exitCode = code ?? 0; });
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
