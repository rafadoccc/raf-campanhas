const { spawn } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const children = [];
for (const args of [
  ['--env-file=.env', 'apps/api/dist/server.js'],
  ['--env-file=.env', 'apps/worker/dist/index.js'],
  ['node_modules/next/dist/bin/next', 'start', 'apps/web', '-H', '127.0.0.1', '-p', '3000']
]) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
  children.push(child);
  child.on('exit', code => { if (code) { console.error('Um serviço parou. Confira o erro acima.'); for (const other of children) if (other !== child) other.kill(); process.exitCode = code; } });
}
process.on('SIGINT', () => { for (const child of children) child.kill(); });
