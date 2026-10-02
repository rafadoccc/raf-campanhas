// Gera os ícones PNG e a imagem de compartilhamento a partir do desenho em apps/web/public/favicon.svg.
// Rode só quando o ícone mudar:  node scripts/make-icons.cjs   (os PNGs ficam versionados).
const path = require('node:path');
const fs = require('node:fs');
const sharp = require('sharp');

const dir = path.join(__dirname, '..', 'apps', 'web', 'public');
const icon = fs.readFileSync(path.join(dir, 'favicon.svg'));
// Imagem de compartilhamento (WhatsApp, redes sociais): o nome no estilo da logo, em tons neutros.
const share = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#f5f6f8"/>
  <text x="600" y="320" text-anchor="middle" font-family="Inter, 'Segoe UI', Arial, sans-serif" font-size="150" letter-spacing="-5"><tspan fill="#94a3b8" font-weight="400">doc</tspan><tspan fill="#161b22" font-weight="600">drop</tspan></text>
  <text x="600" y="405" text-anchor="middle" font-family="Inter, 'Segoe UI', Arial, sans-serif" font-size="36" fill="#5b6573">Campanhas para grupos de WhatsApp</text>
</svg>`);

(async () => {
  for (const [name, size] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
    await sharp(icon, { density: 72 * size / 32 }).resize(size, size).png().toFile(path.join(dir, name));
  }
  await sharp(share).png().toFile(path.join(dir, 'og.png'));
  console.log('Ícones gerados em', dir);
})();
