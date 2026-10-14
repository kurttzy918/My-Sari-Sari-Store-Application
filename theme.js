/* theme.js — Locked brand palette: Orange #FF9900 + Slate #111827
   No rotation. No HSL. Just fixed hex values. */

const BRAND_HEX = {
  "--brand":     "#FF9900",
  "--brand-700": "#CC7A00",
  "--brand-600": "#E68A00",
  "--brand-500": "#FF9900",
  "--brand-400": "#FFAD33",
  "--brand-300": "#FFC266",
  "--brand-100": "#FFE5B3",
  "--brand-50":  "#FFF7EB",
  "--brand-ink": "#111827"
};

const SLATE_HEX = {
  "--slate-900": "#111827",
  "--slate-800": "#1F2937",
  "--slate-700": "#374151",
  "--slate-600": "#4B5563",
  "--slate-500": "#6B7280",
  "--slate-400": "#9CA3AF",
  "--slate-300": "#D1D5DB",
  "--slate-200": "#E5E7EB",
  "--slate-100": "#F3F4F6",
  "--slate-50":  "#F9FAFB"
};

function applyPalette() {
  const root = document.documentElement;
  Object.entries(BRAND_HEX).forEach(([k, v]) => root.style.setProperty(k, v));
  Object.entries(SLATE_HEX).forEach(([k, v]) => root.style.setProperty(k, v));
  root.setAttribute("data-palette", "orange");
}

export function loadThemePalette() {
  applyPalette();
  console.log("[theme] Locked to Orange #FF9900 + Slate #111827");
  return { changed: false, palette: { name: "Orange" } };
}

export function checkThemeRotation() { return false; }
export function startThemeRotationTicker() { /* no rotation */ }
export function stopThemeRotationTicker() { /* no rotation */ }
export function getPaletteForToday() {
  return { name: "Orange", hue: 36, sat: 100 };
}