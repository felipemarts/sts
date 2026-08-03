// Gera assets/icon.png (512) e assets/icon.ico a partir de assets/icon.svg.
// Uso: node scripts/gen-icon.mjs   (precisa de devDeps @resvg/resvg-js e png-to-ico)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'assets', 'icon.svg'));

function render(size) {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  return r.render().asPng();
}

// PNG principal (janela/Linux) em 512.
writeFileSync(join(root, 'assets', 'icon.png'), render(512));

// ICO multi-resolução (Windows) — tamanhos padrão de ícone.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const ico = await pngToIco(sizes.map(render));
writeFileSync(join(root, 'assets', 'icon.ico'), ico);

console.log('ok: assets/icon.png e assets/icon.ico gerados');
