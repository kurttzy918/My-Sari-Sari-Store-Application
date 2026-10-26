/* theme.js — Locked brand palette: Cyan #22D3EE + Slate #0B1220 (minimal) */

const BRAND_HEX = {
  "--brand":     "#22D3EE",
  "--brand-700": "#0E7490",
  "--brand-600": "#0891B2",
  "--brand-500": "#22D3EE",
  "--brand-400": "#67E8F9",
  "--brand-300": "#A5F3FC",
  "--brand-100": "#CFFAFE",
  "--brand-50":  "#ECFEFF",
  "--brand-ink": "#04202A"
};

const SLATE_HEX = {
  "--slate-900": "#0B1220",
  "--slate-800": "#111B2A",
  "--slate-700": "#1F2D3D",
  "--slate-600": "#2E4054",
  "--slate-500": "#5B7083",
  "--slate-400": "#8AA0B2",
  "--slate-300": "#C3D1DC",
  "--slate-200": "#E2EAF0",
  "--slate-100": "#F1F5F8",
  "--slate-50":  "#F8FBFC"
};

function applyPalette() {
  const root = document.documentElement;
  Object.entries(BRAND_HEX).forEach(([k, v]) => root.style.setProperty(k, v));
  Object.entries(SLATE_HEX).forEach(([k, v]) => root.style.setProperty(k, v));
  root.setAttribute("data-palette", "cyan");
}

export function loadThemePalette() {
  applyPalette();
  console.log("[theme] Locked to Cyan #22D3EE + Slate #0B1220");
  return { changed: false, palette: { name: "Cyan" } };
}

export function checkThemeRotation() { return false; }
export function startThemeRotationTicker() { /* no rotation */ }
export function stopThemeRotationTicker() { /* no rotation */ }
export function getPaletteForToday() {
  return { name: "Cyan", hue: 189, sat: 94 };
}