/**
 * Generate the PWA / Apple icons from the brand mark in public/icons/icon.svg.
 *   npx tsx scripts/generate-icons.ts
 * Uses `sharp` (installed with Next.js). Output PNGs are committed to public/icons/.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const OUT = path.join(process.cwd(), "public/icons");
const INK = "#1c1917";
const PAPER = "#fafaf9";
const TEAL = "#2dd4bf";

/** The "K" mark on a 64×64 grid, scaled about the centre. */
const glyph = (scale = 1, color = PAPER, dot = TEAL) => `
  <g transform="translate(32 32) scale(${scale}) translate(-32 -32)">
    <path d="M20 18v28M20 32l14-14M24 30l12 16" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <circle cx="45" cy="21" r="4" fill="${dot}"/>
  </g>`;

const svg = (body: string, viewBox = "0 0 64 64") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;

/** Full-bleed square (platforms apply their own mask). */
const fullBleed = (scale: number) => svg(`<rect width="64" height="64" fill="${INK}"/>${glyph(scale)}`);

/** Lucide-style shortcut glyph on an ink circle (24×24 grid). */
const shortcut = (paths: string) =>
  svg(
    `<circle cx="12" cy="12" r="12" fill="${INK}"/>
     <g transform="translate(5 5) scale(0.5833)" stroke="${PAPER}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none">${paths}</g>`,
    "0 0 24 24",
  );

async function png(source: string | Buffer, size: number, file: string, opts: { flatten?: boolean } = {}) {
  let img = sharp(typeof source === "string" ? Buffer.from(source) : source, { density: 512 }).resize(size, size);
  if (opts.flatten) img = img.flatten({ background: INK });
  await img.png({ compressionLevel: 9 }).toFile(path.join(OUT, file));
  console.log(`✓ ${file} (${size}×${size})`);
}

async function main() {
  const master = await readFile(path.join(OUT, "icon.svg"));
  await png(master, 192, "icon-192.png");
  await png(master, 512, "icon-512.png");
  // Maskable: keep the mark inside the 80% safe zone.
  await png(fullBleed(0.72), 512, "icon-maskable-512.png");
  // iOS rounds the corners itself and renders transparency as black — use an opaque square.
  await png(fullBleed(0.92), 180, "apple-touch-icon.png", { flatten: true });
  // Android status-bar badge: monochrome white silhouette on transparent.
  await png(svg(glyph(1.15, "#ffffff", "#ffffff")), 72, "badge-72.png");
  // App shortcuts.
  await png(shortcut('<path d="M5 12h14"/><path d="M12 5v14"/>'), 96, "shortcut-add.png");
  await png(shortcut('<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>'), 96, "shortcut-transactions.png");
  await png(
    shortcut('<path d="M21 12c.552 0 1.005-.449.95-.998a10 10 0 0 0-8.953-8.951c-.55-.055-.998.398-.998.95v8a1 1 0 0 0 1 1z"/><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/>'),
    96,
    "shortcut-budgets.png",
  );
}

main().catch((e) => {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exit(1);
});
