/* theme.js — Modern Emerald & Slate palette for Kurt Inventory POS
   Important: this file sets brand accents only. Light/dark surfaces are
   controlled by style.css through the document's data-theme attribute.
*/

const BRAND_HEX = {
  "--brand": "#0F8A68",
  "--brand-700": "#087453",
  "--brand-600": "#0B8060",
  "--brand-500": "#0F8A68",
  "--brand-400": "#34A987",
  "--brand-300": "#83D0B6",
  "--brand-100": "#DDF4EA",
  "--brand-50": "#EFF9F4",
  "--brand-ink": "#064E3B"
};

function applyPalette() {
  const root = document.documentElement;

  Object.entries(BRAND_HEX).forEach(([key, value]) => {
    root.style.setProperty(key, value);
  });

  // Do not set --bg, --surface, --text, --border, or data-theme here.
  // Those values must remain controlled by the user's Light/Dark toggle.
  root.setAttribute("data-palette", "emerald");
}

export function loadThemePalette() {
  applyPalette();
  return { changed: true, palette: { name: "Modern Emerald & Slate" } };
}

export function checkThemeRotation() { return false; }
export function startThemeRotationTicker() { /* palette is static */ }
export function stopThemeRotationTicker() { /* palette is static */ }

export function getPaletteForToday() {
  return { name: "Modern Emerald & Slate", hue: 160, sat: 70 };
}
