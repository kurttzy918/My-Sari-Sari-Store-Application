/* theme.js — Date-driven color palette rotation
   -------------------------------------------------
   Palette is chosen by the CURRENT DATE, so it stays the
   SAME for the whole rotation window and changes on schedule.
   Default: rotate every 2 days.
   -------------------------------------------------
   Change ROTATION_DAYS below to adjust:
     1  = daily
     2  = every other day  ← current
     7  = weekly
     14 = bi-weekly
*/

/* =========================================================
   ROTATION SWITCH
   -------------------------------------------------
   Set to FALSE  → app stays locked to Teal (original brand)
   Set to TRUE   → app rotates palettes automatically
                   every ROTATION_DAYS
   ========================================================= */
const ROTATION_ENABLED = false;      // ← change to true when you want rotation
const ROTATION_DAYS    = 2;
const CACHE_KEY        = "kurtPaletteV1";

/* =========================================================
   CURATED PALETTES — hue (0-360) + saturation (0-100)
   The full brand scale (50 → 900) is derived from these.
   ========================================================= */

const PALETTES = [
  { name: "Teal",     hue: 175, sat: 55 },   // original brand
  { name: "Lavender", hue: 262, sat: 65 },
  { name: "Ocean",    hue: 210, sat: 60 },
  { name: "Forest",   hue: 145, sat: 45 },
  { name: "Sunset",   hue: 18,  sat: 70 },
  { name: "Rose",     hue: 335, sat: 60 },
  { name: "Amber",    hue: 38,  sat: 75 },
  { name: "Slate",    hue: 220, sat: 20 },
  { name: "Indigo",   hue: 245, sat: 55 },
  { name: "Coral",    hue: 8,   sat: 68 },
  { name: "Mint",     hue: 158, sat: 50 },
  { name: "Plum",     hue: 300, sat: 55 }
];

/* =========================================================
   HSL → hex
   ========================================================= */
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/* =========================================================
   Build the full brand scale from one hue
   ========================================================= */
function buildPalette(hue, sat = 55) {
  const s = Math.max(20, Math.min(90, sat));
  return {
    "--brand":     hslToHex(hue, s,       30),
    "--brand-700": hslToHex(hue, s,       22),
    "--brand-600": hslToHex(hue, s,       26),
    "--brand-500": hslToHex(hue, s,       36),
    "--brand-400": hslToHex(hue, s - 5,   52),
    "--brand-300": hslToHex(hue, s - 10,  68),
    "--brand-100": hslToHex(hue, s - 25,  92),
    "--brand-50":  hslToHex(hue, s - 35,  97),
    "--brand-ink": hslToHex(hue, s,       15)
  };
}

/* =========================================================
   Deterministic palette picker — same for the whole
   rotation window, no matter how often the page reloads.
   ========================================================= */
function getPaletteIndexForDate(date = new Date()) {
  const daysSinceEpoch = Math.floor(date.getTime() / 86400000);
  const block = Math.floor(daysSinceEpoch / ROTATION_DAYS);
  return ((block % PALETTES.length) + PALETTES.length) % PALETTES.length;
}

export function getPaletteForToday() {
  return PALETTES[getPaletteIndexForDate()];
}

/* =========================================================
   Apply to :root
   ========================================================= */
function applyPalette(palette) {
  const root = document.documentElement;
  const vars = buildPalette(palette.hue, palette.sat);
  Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v));
  root.setAttribute("data-palette", palette.name || "custom");

  // Keep mobile status-bar in sync
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && document.documentElement.getAttribute("data-theme") === "dark") {
    meta.setAttribute("content", vars["--brand"]);
  }
}

/* =========================================================
   Cache — remembers which day block was last applied
   ========================================================= */
function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p.block === "number" && typeof p.hue === "number") return p;
  } catch {}
  return null;
}

function saveCache(block, palette) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      block,
      hue: palette.hue,
      sat: palette.sat,
      name: palette.name
    }));
  } catch {}
}

/* =========================================================
   PUBLIC — apply today's palette
   ========================================================= */
export function loadThemePalette() {
  // When rotation is disabled → always apply Teal (first palette)
  if (!ROTATION_ENABLED) {
    const teal = PALETTES[0];   // { name: "Teal", hue: 175, sat: 55 }
    applyPalette(teal);
    console.log("[theme] Locked to Teal (rotation disabled)");
    return { changed: false, palette: teal };
  }

  // Rotation ON → date-driven
  const today = new Date();
  const daysSinceEpoch = Math.floor(today.getTime() / 86400000);
  const block = Math.floor(daysSinceEpoch / ROTATION_DAYS);

  const cache = loadCache();
  const palette = PALETTES[getPaletteIndexForDate(today)];

  if (!cache || cache.block !== block) {
    applyPalette(palette);
    saveCache(block, palette);
    console.log(
      `[theme] Rotated → ${palette.name} ` +
      `(block ${block}, changes every ${ROTATION_DAYS} day(s))`
    );
    return { changed: true, palette };
  }

  applyPalette(cache);
  return { changed: false, palette: cache };
}

/* =========================================================
   PUBLIC — force-check (used by the hourly ticker)
   Returns true if a rotation just occurred.
   ========================================================= */
export function checkThemeRotation() {
  // Rotation disabled → nothing to check
  if (!ROTATION_ENABLED) return false;

  const daysSinceEpoch = Math.floor(Date.now() / 86400000);
  const currentBlock = Math.floor(daysSinceEpoch / ROTATION_DAYS);
  const cache = loadCache();

  if (!cache || cache.block !== currentBlock) {
    const palette = PALETTES[getPaletteIndexForDate()];
    applyPalette(palette);
    saveCache(currentBlock, palette);
    return true;
  }
  return false;
}

/* =========================================================
   PUBLIC — hourly ticker keeps long-open tabs in sync
   ========================================================= */
let _rotationTimer = null;

export function startThemeRotationTicker() {
  stopThemeRotationTicker();
  // Check every hour — cheap, guarantees refresh within an hour
  // of crossing a rotation boundary (e.g. midnight).
  _rotationTimer = setInterval(() => {
    if (checkThemeRotation()) {
      import("./utils.js").then(({ showToast }) => {
        showToast(`New theme today: ${getPaletteForToday().name} 🎨`);
      }).catch(() => {});
    }
  }, 60 * 60 * 1000);
}

export function stopThemeRotationTicker() {
  if (_rotationTimer) { clearInterval(_rotationTimer); _rotationTimer = null; }
}