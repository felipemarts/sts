// Gera assets/icon.png (512), assets/icon.ico (Windows) e assets/icon.icns
// (macOS) a partir de assets/icon.svg.
// Uso: node scripts/gen-icon.mjs   (precisa de devDeps @resvg/resvg-js e png-to-ico)
// O .icns só é gerado no macOS (usa o `iconutil` do sistema); por isso os três
// arquivos são versionados no git — o CI empacota sem rodar este script.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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

// ICNS (macOS) — sem ele o electron-packager usa o electron.icns padrão e o
// app aparece com o ícone do Electron no Dock/Finder.
if (process.platform === 'darwin') {
  const iconset = join(mkdtempSync(join(tmpdir(), 'sts-icon-')), 'icon.iconset');
  execFileSync('mkdir', ['-p', iconset]);
  // Nomes exigidos pelo iconutil: base 16/32/128/256/512 + variante @2x.
  for (const base of [16, 32, 128, 256, 512]) {
    writeFileSync(join(iconset, `icon_${base}x${base}.png`), render(base));
    writeFileSync(join(iconset, `icon_${base}x${base}@2x.png`), render(base * 2));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(root, 'assets', 'icon.icns')]);
  rmSync(dirname(iconset), { recursive: true, force: true });
  console.log('ok: assets/icon.png, assets/icon.ico e assets/icon.icns gerados');
} else {
  console.log('ok: assets/icon.png e assets/icon.ico gerados');
  console.log('aviso: assets/icon.icns NÃO foi regenerado (precisa de macOS/iconutil)');
}
