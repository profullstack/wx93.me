// Renders design/og.svg to public/icons/og.png, the social card every shared
// page shows. Run after editing the SVG: bun apps/web/scripts/og.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Resvg, initWasm } from '@resvg/resvg-wasm';

const fonts = process.env.FONT_DIR ?? `${process.env.HOME}/.local/share/fonts`;
await initWasm(readFileSync(createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm')));
const svg = readFileSync(new URL('../../../design/og.svg', import.meta.url), 'utf8');
const png = new Resvg(svg, {
  font: {
    fontBuffers: ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf'].map((f) => readFileSync(`${fonts}/${f}`)),
    defaultFontFamily: 'DejaVu Sans',
    loadSystemFonts: false,
  },
})
  .render()
  .asPng();
writeFileSync(new URL('../public/icons/og.png', import.meta.url), png);
console.log(`og.png ${png.length} bytes`);
