"use strict";

/* =========================================================================
   Champs de vecteurs : gradient, divergence, rotationnel
   Visualisation interactive (canvas 2D, dérivées numériques).
   ========================================================================= */

const canvas = document.getElementById("field");
const ctx = canvas.getContext("2d");
const SIZE = canvas.width;          // résolution interne (px)
const R = 3.0;                      // demi-étendue du domaine en coords "monde"
const HRES = 160;                   // résolution de la grille du fond coloré
const H = 1e-3;                     // pas des différences finies (coords monde)

/* ----- couche statique (fond + flèches + contours), recalculée à la demande */
const staticCv = document.createElement("canvas");
staticCv.width = staticCv.height = SIZE;
const sctx = staticCv.getContext("2d");

/* petit canvas pour le fond coloré (mis à l'échelle ensuite) */
const heatCv = document.createElement("canvas");
heatCv.width = heatCv.height = HRES;
const hctx = heatCv.getContext("2d");

/* ========================================================================= */
/*  Définition des champs                                                    */
/* ========================================================================= */
/*  Les fonctions reçoivent des coordonnées déjà mises à l'échelle (X,Y).    */

const PRESETS = {
  gradient: [
    { name: "Colline gaussienne", formula: "f(x,y) = exp(−(x² + y²))",
      f: (x, y) => Math.exp(-(x * x + y * y)) },
    { name: "Point-col (selle)", formula: "f(x,y) = ½(x² − y²)",
      f: (x, y) => 0.5 * (x * x - y * y) },
    { name: "Vagues sinusoïdales", formula: "f(x,y) = sin(x)·cos(y)",
      f: (x, y) => Math.sin(x) * Math.cos(y) },
    { name: "Ondes radiales", formula: "f(x,y) = cos(2·√(x²+y²))",
      f: (x, y) => Math.cos(2 * Math.sqrt(x * x + y * y)) },
    { name: "Double puits", formula: "f = −[ e^(−|p−A|²) + e^(−|p−B|²) ]",
      f: (x, y) => -(Math.exp(-((x - 1) ** 2 + y * y)) +
                     Math.exp(-((x + 1) ** 2 + y * y))) },
  ],
  divergence: [
    { name: "Source / puits radial", formula: "F(x,y) = (x, y)   →  ∇·F = 2",
      F: (x, y) => [x, y] },
    { name: "Tourbillon pur", formula: "F(x,y) = (−y, x)   →  ∇·F = 0",
      F: (x, y) => [-y, x] },
    { name: "Dipôle (source + puits)", formula: "source en (−1,0), puits en (1,0)",
      F: (x, y) => {
        const s = pointSource(x, y, -1, 0, +1);
        const p = pointSource(x, y, 1, 0, -1);
        return [s[0] + p[0], s[1] + p[1]];
      } },
    { name: "Cisaillement", formula: "F(x,y) = (y, 0)   →  ∇·F = 0",
      F: (x, y) => [y, 0] },
    { name: "Compression sinusoïdale", formula: "F(x,y) = (sin x, sin y)",
      F: (x, y) => [Math.sin(x), Math.sin(y)] },
  ],
  curl: [
    { name: "Tourbillon pur", formula: "F(x,y) = (−y, x)   →  ∇×F = 2",
      F: (x, y) => [-y, x] },
    { name: "Cisaillement", formula: "F(x,y) = (y, 0)   →  ∇×F = −1",
      F: (x, y) => [y, 0] },
    { name: "Double vortex", formula: "vortex anti-horaire + horaire",
      F: (x, y) => {
        const a = vortex(x, y, -1, 0, +1);
        const b = vortex(x, y, 1, 0, -1);
        return [a[0] + b[0], a[1] + b[1]];
      } },
    { name: "Source radiale", formula: "F(x,y) = (x, y)   →  ∇×F = 0",
      F: (x, y) => [x, y] },
    { name: "Onde rotationnelle", formula: "F(x,y) = (sin y, sin x)",
      F: (x, y) => [Math.sin(y), Math.sin(x)] },
  ],
};

/* source ponctuelle régularisée (champ radial décroissant) */
function pointSource(x, y, cx, cy, sign) {
  const dx = x - cx, dy = y - cy;
  const r2 = dx * dx + dy * dy + 0.15;
  return [sign * dx / r2, sign * dy / r2];
}
/* vortex ponctuel régularisé */
function vortex(x, y, cx, cy, sign) {
  const dx = x - cx, dy = y - cy;
  const r2 = dx * dx + dy * dy + 0.15;
  return [-sign * dy / r2, sign * dx / r2];
}

/* ========================================================================= */
/*  État                                                                     */
/* ========================================================================= */
const DEFAULTS = {
  op: "gradient", preset: 0, amp: 1, freq: 1, grid: 22,
  parts: 900, speed: 1,
  showArrows: true, showHeat: true, showFlux: true,
  showContours: false, showProbe: true,
};
let state = { ...DEFAULTS };
let dirty = true;          // la couche statique doit être recalculée
let maxMag = 1;            // amplitude max du champ affiché (pour normaliser)
let heatGrid = null;       // valeurs du fond (pour les contours)
let heatMaxAbs = 1;
let mouse = { x: null, y: null, inside: false };

/* ========================================================================= */
/*  Évaluateurs (appliquent amplitude / échelle spatiale)                    */
/* ========================================================================= */
function scalarAt(x, y) {                 // champ scalaire f (mode gradient)
  const p = PRESETS.gradient[state.op === "gradient" ? state.preset : 0];
  return state.amp * p.f(x * state.freq, y * state.freq);
}
function vectorPreset() {
  return PRESETS[state.op][state.preset];
}
function rawVectorAt(x, y) {               // champ F (modes divergence / curl)
  const v = vectorPreset().F(x * state.freq, y * state.freq);
  return [state.amp * v[0], state.amp * v[1]];
}

/* Le vecteur réellement dessiné (flèches + particules) */
function fieldAt(x, y) {
  if (state.op === "gradient") return gradAt(x, y);
  return rawVectorAt(x, y);
}
/* Le scalaire affiché en fond (l'opérateur) */
function heatAt(x, y) {
  if (state.op === "gradient") return scalarAt(x, y);
  if (state.op === "divergence") return divAt(x, y);
  return curlAt(x, y);
}

/* --- dérivées numériques (différences centrées) --- */
function gradAt(x, y) {
  const fx = (scalarAt(x + H, y) - scalarAt(x - H, y)) / (2 * H);
  const fy = (scalarAt(x, y + H) - scalarAt(x, y - H)) / (2 * H);
  return [fx, fy];
}
function divAt(x, y) {
  const ux = (rawVectorAt(x + H, y)[0] - rawVectorAt(x - H, y)[0]) / (2 * H);
  const vy = (rawVectorAt(x, y + H)[1] - rawVectorAt(x, y - H)[1]) / (2 * H);
  return ux + vy;
}
function curlAt(x, y) {
  const vx = (rawVectorAt(x + H, y)[1] - rawVectorAt(x - H, y)[1]) / (2 * H);
  const uy = (rawVectorAt(x, y + H)[0] - rawVectorAt(x, y - H)[0]) / (2 * H);
  return vx - uy;
}

/* ========================================================================= */
/*  Conversions monde <-> écran                                              */
/* ========================================================================= */
const worldToScreen = (x, y) => [
  ((x + R) / (2 * R)) * SIZE,
  ((R - y) / (2 * R)) * SIZE,
];
const screenToWorld = (sx, sy) => [
  (sx / SIZE) * 2 * R - R,
  R - (sy / SIZE) * 2 * R,
];

/* ========================================================================= */
/*  Couleurs                                                                 */
/* ========================================================================= */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function mix(c1, c2, t) {
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * t),
    Math.round(c1[1] + (c2[1] - c1[1]) * t),
    Math.round(c1[2] + (c2[2] - c1[2]) * t),
  ];
}
const DARK = [12, 20, 34], BLUE = [88, 166, 255], BLUE2 = [43, 109, 240];
const ORANGE = [255, 157, 87], RED = [255, 77, 77];
function heatColor(t) {                    // t dans [-1, 1] : palette divergente
  t = clamp(t, -1, 1);
  if (t >= 0) {
    return t < 0.5 ? mix(DARK, ORANGE, t / 0.5)
                   : mix(ORANGE, RED, (t - 0.5) / 0.5);
  }
  const a = -t;
  return a < 0.5 ? mix(DARK, BLUE, a / 0.5)
                 : mix(BLUE, BLUE2, (a - 0.5) / 0.5);
}

/* ========================================================================= */
/*  Construction de la couche statique                                       */
/* ========================================================================= */
function rebuildStatic() {
  computeHeatGrid();
  computeMaxMag();

  sctx.clearRect(0, 0, SIZE, SIZE);
  sctx.fillStyle = "#060912";
  sctx.fillRect(0, 0, SIZE, SIZE);

  if (state.showHeat) drawHeat();
  if (state.showContours) drawContours();
  if (state.showArrows) drawArrows();

  drawAxes();
  dirty = false;
}

/* --- grille de valeurs du fond + image colorée --- */
function computeHeatGrid() {
  heatGrid = new Float32Array(HRES * HRES);
  let maxAbs = 1e-6;
  for (let j = 0; j < HRES; j++) {
    const y = R - (j / (HRES - 1)) * 2 * R;
    for (let i = 0; i < HRES; i++) {
      const x = -R + (i / (HRES - 1)) * 2 * R;
      const val = heatAt(x, y);
      heatGrid[j * HRES + i] = val;
      const a = Math.abs(val);
      if (a > maxAbs) maxAbs = a;
    }
  }
  heatMaxAbs = maxAbs;

  const img = hctx.createImageData(HRES, HRES);
  for (let k = 0; k < HRES * HRES; k++) {
    const c = heatColor(heatGrid[k] / heatMaxAbs);
    img.data[k * 4] = c[0];
    img.data[k * 4 + 1] = c[1];
    img.data[k * 4 + 2] = c[2];
    img.data[k * 4 + 3] = 255;
  }
  hctx.putImageData(img, 0, 0);
}

function drawHeat() {
  sctx.save();
  sctx.globalAlpha = 0.92;
  sctx.imageSmoothingEnabled = true;
  sctx.drawImage(heatCv, 0, 0, SIZE, SIZE);
  sctx.restore();
}

/* --- amplitude maximale du champ affiché (pour normaliser flèches/flux) --- */
function computeMaxMag() {
  let m = 1e-6;
  const N = 26;
  for (let j = 0; j <= N; j++) {
    const y = R - (j / N) * 2 * R;
    for (let i = 0; i <= N; i++) {
      const x = -R + (i / N) * 2 * R;
      const v = fieldAt(x, y);
      const mag = Math.hypot(v[0], v[1]);
      if (mag > m) m = mag;
    }
  }
  maxMag = m;
}

/* --- flèches du champ --- */
function drawArrows() {
  const g = state.grid;
  const cell = SIZE / g;
  const maxLen = cell * 0.46;
  sctx.lineCap = "round";
  for (let j = 0; j < g; j++) {
    for (let i = 0; i < g; i++) {
      const sx = (i + 0.5) * cell;
      const sy = (j + 0.5) * cell;
      const [wx, wy] = screenToWorld(sx, sy);
      const v = fieldAt(wx, wy);
      const mag = Math.hypot(v[0], v[1]);
      if (mag < 1e-9) continue;
      const norm = clamp(mag / maxMag, 0, 1);
      const len = maxLen * (0.25 + 0.75 * Math.sqrt(norm));
      const dx = (v[0] / mag) * len;
      const dy = -(v[1] / mag) * len;   // y écran inversé
      const alpha = 0.25 + 0.6 * norm;
      sctx.strokeStyle = `rgba(228,236,248,${alpha})`;
      sctx.lineWidth = 1.1 + 1.2 * norm;
      drawArrow(sctx, sx - dx / 2, sy - dy / 2, sx + dx / 2, sy + dy / 2);
    }
  }
}
function drawArrow(c, x0, y0, x1, y1) {
  c.beginPath();
  c.moveTo(x0, y0);
  c.lineTo(x1, y1);
  c.stroke();
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const hs = 4 + c.lineWidth * 1.4;
  c.beginPath();
  c.moveTo(x1, y1);
  c.lineTo(x1 - hs * Math.cos(ang - 0.42), y1 - hs * Math.sin(ang - 0.42));
  c.lineTo(x1 - hs * Math.cos(ang + 0.42), y1 - hs * Math.sin(ang + 0.42));
  c.closePath();
  c.fill();
}

/* --- lignes de niveau du fond (marching squares programmatique) --- */
function drawContours() {
  const levels = 11;
  sctx.lineWidth = 1;
  for (let l = 1; l < levels; l++) {
    const L = (-1 + (2 * l) / levels) * heatMaxAbs;
    const shade = clamp(0.35 + Math.abs(L) / heatMaxAbs * 0.4, 0.3, 0.8);
    sctx.strokeStyle = `rgba(232,237,245,${shade * 0.5})`;
    sctx.beginPath();
    marchLevel(L);
    sctx.stroke();
  }
}
function gpt(gi, gj) {                       // indice grille -> point écran
  return [(gi / (HRES - 1)) * SIZE, (gj / (HRES - 1)) * SIZE];
}
function marchLevel(L) {
  const g = heatGrid;
  for (let j = 0; j < HRES - 1; j++) {
    for (let i = 0; i < HRES - 1; i++) {
      const va = g[j * HRES + i];
      const vb = g[j * HRES + i + 1];
      const vc = g[(j + 1) * HRES + i + 1];
      const vd = g[(j + 1) * HRES + i];
      const aA = va > L, aB = vb > L, aC = vc > L, aD = vd > L;
      const pts = [];
      // arête haute (a-b)
      if (aA !== aB) {
        const t = (L - va) / (vb - va);
        const [x0, y0] = gpt(i, j), [x1] = gpt(i + 1, j);
        pts.push([x0 + (x1 - x0) * t, y0]);
      }
      // arête droite (b-c)
      if (aB !== aC) {
        const t = (L - vb) / (vc - vb);
        const [x0, y0] = gpt(i + 1, j), [, y1] = gpt(i + 1, j + 1);
        pts.push([x0, y0 + (y1 - y0) * t]);
      }
      // arête basse (c-d)
      if (aC !== aD) {
        const t = (L - vc) / (vd - vc);
        const [x0, y0] = gpt(i + 1, j + 1), [x1] = gpt(i, j + 1);
        pts.push([x0 + (x1 - x0) * t, y0]);
      }
      // arête gauche (d-a)
      if (aD !== aA) {
        const t = (L - vd) / (va - vd);
        const [x0, y0] = gpt(i, j + 1), [, y1] = gpt(i, j);
        pts.push([x0, y0 + (y1 - y0) * t]);
      }
      if (pts.length === 2) {
        sctx.moveTo(pts[0][0], pts[0][1]);
        sctx.lineTo(pts[1][0], pts[1][1]);
      } else if (pts.length === 4) {       // cas selle : deux segments
        sctx.moveTo(pts[0][0], pts[0][1]);
        sctx.lineTo(pts[1][0], pts[1][1]);
        sctx.moveTo(pts[2][0], pts[2][1]);
        sctx.lineTo(pts[3][0], pts[3][1]);
      }
    }
  }
}

function drawAxes() {
  const [ox, oy] = worldToScreen(0, 0);
  sctx.strokeStyle = "rgba(255,255,255,0.10)";
  sctx.lineWidth = 1;
  sctx.beginPath();
  sctx.moveTo(0, oy); sctx.lineTo(SIZE, oy);
  sctx.moveTo(ox, 0); sctx.lineTo(ox, SIZE);
  sctx.stroke();
}

/* ========================================================================= */
/*  Particules de flux                                                       */
/* ========================================================================= */
let particles = [];
function makeParticle() {
  return {
    x: (Math.random() * 2 - 1) * R,
    y: (Math.random() * 2 - 1) * R,
    px: 0, py: 0,
    age: 0,
    maxAge: 60 + Math.random() * 140,
    init: false,
  };
}
function syncParticles() {
  const n = state.parts;
  if (particles.length < n) {
    while (particles.length < n) particles.push(makeParticle());
  } else if (particles.length > n) {
    particles.length = n;
  }
}
function resetParticle(p) {
  p.x = (Math.random() * 2 - 1) * R;
  p.y = (Math.random() * 2 - 1) * R;
  p.age = 0;
  p.maxAge = 60 + Math.random() * 140;
  p.init = false;
}
function stepParticles() {
  if (!state.showFlux || state.speed === 0) return;
  const k = (R * 0.014) / maxMag * state.speed;
  for (const p of particles) {
    const v = fieldAt(p.x, p.y);
    const mag = Math.hypot(v[0], v[1]);
    p.px = p.x; p.py = p.y;
    p.x += v[0] * k;
    p.y += v[1] * k;
    p.age++;
    p.lastMag = mag;
    if (!p.init) { p.px = p.x; p.py = p.y; p.init = true; }
    if (p.age > p.maxAge || Math.abs(p.x) > R || Math.abs(p.y) > R || mag < 1e-7) {
      resetParticle(p);
    }
  }
}
function drawParticles() {
  if (!state.showFlux) return;
  ctx.lineCap = "round";
  for (const p of particles) {
    if (!p.init) continue;
    const [sx, sy] = worldToScreen(p.x, p.y);
    const [px, py] = worldToScreen(p.px, p.py);
    const norm = clamp((p.lastMag || 0) / maxMag, 0, 1);
    // fondu en entrée/sortie de vie
    const fade = Math.sin((p.age / p.maxAge) * Math.PI);
    const alpha = clamp(0.15 + 0.7 * norm, 0, 0.85) * fade;
    ctx.strokeStyle = `rgba(150,225,255,${alpha})`;
    ctx.lineWidth = 0.8 + 1.6 * norm;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(sx, sy);
    ctx.stroke();
  }
}

/* ========================================================================= */
/*  Sonde locale (souris)                                                     */
/* ========================================================================= */
const readout = document.getElementById("probe-readout");
function drawProbe() {
  if (!state.showProbe || !mouse.inside) { readout.style.display = "none"; return; }
  const [wx, wy] = screenToWorld(mouse.x, mouse.y);
  const [sx, sy] = [mouse.x, mouse.y];

  let txt = "";
  ctx.save();

  if (state.op === "gradient") {
    const f = scalarAt(wx, wy);
    const gr = gradAt(wx, wy);
    const gm = Math.hypot(gr[0], gr[1]);
    // flèche du gradient
    if (gm > 1e-9) {
      const len = 46;
      const dx = (gr[0] / gm) * len, dy = -(gr[1] / gm) * len;
      ctx.strokeStyle = "#ffd166"; ctx.fillStyle = "#ffd166"; ctx.lineWidth = 2.4;
      drawArrow(ctx, sx, sy, sx + dx, sy + dy);
    }
    txt = `f        = ${fmt(f)}\n∇f       = (${fmt(gr[0])}, ${fmt(gr[1])})\n|∇f|     = ${fmt(gm)}`;
  } else if (state.op === "divergence") {
    const v = rawVectorAt(wx, wy);
    const d = divAt(wx, wy);
    drawProbeRing(sx, sy, d);
    txt = `F        = (${fmt(v[0])}, ${fmt(v[1])})\n∇·F      = ${fmt(d)}\n${d > 0 ? "→ source" : d < 0 ? "→ puits" : "→ incompressible"}`;
  } else {
    const v = rawVectorAt(wx, wy);
    const c = curlAt(wx, wy);
    drawProbeRing(sx, sy, c);
    txt = `F        = (${fmt(v[0])}, ${fmt(v[1])})\n(∇×F)_z  = ${fmt(c)}\n${c > 0 ? "↺ anti-horaire" : c < 0 ? "↻ horaire" : "→ irrotationnel"}`;
  }

  // marqueur
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.beginPath(); ctx.arc(sx, sy, 2.4, 0, 7); ctx.fill();
  ctx.restore();

  readout.style.display = "block";
  readout.textContent = txt;
}
function drawProbeRing(sx, sy, val) {
  const norm = clamp(val / heatMaxAbs, -1, 1);
  const c = heatColor(norm);
  const rad = 14 + 22 * Math.abs(norm);
  ctx.strokeStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  if (state.op === "divergence") {
    ctx.arc(sx, sy, rad, 0, 7);
    ctx.stroke();
    // petites flèches radiales (sortant si source, entrant si puits)
    const sign = val >= 0 ? 1 : -1;
    for (let a = 0; a < 7; a += Math.PI / 3) {
      const ix = sx + Math.cos(a) * rad * 0.55, iy = sy + Math.sin(a) * rad * 0.55;
      const ox = sx + Math.cos(a) * rad * 0.95, oy = sy + Math.sin(a) * rad * 0.95;
      if (sign > 0) drawArrow(ctx, ix, iy, ox, oy);
      else drawArrow(ctx, ox, oy, ix, iy);
    }
  } else {
    // arc orienté (rotationnel)
    const dir = val >= 0 ? -1 : 1;   // anti-horaire si val>0 (y écran inversé)
    ctx.arc(sx, sy, rad, 0, dir * Math.PI * 1.5, dir < 0);
    ctx.stroke();
    const a = dir < 0 ? -Math.PI * 1.5 : Math.PI * 1.5;
    const tx = sx + Math.cos(a) * rad, ty = sy + Math.sin(a) * rad;
    const ta = a + dir * Math.PI / 2;
    drawArrow(ctx, tx - Math.cos(ta) * 6, ty - Math.sin(ta) * 6, tx, ty);
  }
}
function fmt(v) {
  if (!isFinite(v)) return "∞";
  const a = Math.abs(v);
  if (a !== 0 && (a < 0.01 || a >= 1000)) return v.toExponential(2);
  return v.toFixed(2).replace("-0.00", "0.00");
}

/* ========================================================================= */
/*  Boucle d'animation                                                       */
/* ========================================================================= */
function loop() {
  if (dirty) rebuildStatic();
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.drawImage(staticCv, 0, 0);
  stepParticles();
  drawParticles();
  drawProbe();
  requestAnimationFrame(loop);
}

/* ========================================================================= */
/*  Interface                                                                */
/* ========================================================================= */
const els = {
  opSeg: document.getElementById("op-seg"),
  opDesc: document.getElementById("op-desc"),
  preset: document.getElementById("preset"),
  formula: document.getElementById("formula"),
  amp: document.getElementById("amp"), ampVal: document.getElementById("amp-val"),
  freq: document.getElementById("freq"), freqVal: document.getElementById("freq-val"),
  grid: document.getElementById("grid"), gridVal: document.getElementById("grid-val"),
  parts: document.getElementById("parts"), partsVal: document.getElementById("parts-val"),
  speed: document.getElementById("speed"), speedVal: document.getElementById("speed-val"),
  showArrows: document.getElementById("show-arrows"),
  showHeat: document.getElementById("show-heat"),
  showFlux: document.getElementById("show-flux"),
  showContours: document.getElementById("show-contours"),
  showProbe: document.getElementById("show-probe"),
  legendDesc: document.getElementById("legend-desc"),
  legMin: document.getElementById("leg-min"), legMax: document.getElementById("leg-max"),
  reset: document.getElementById("reset"),
};

const OP_DESC = {
  gradient: "Le gradient ∇f pointe vers la plus forte croissance de f, perpendiculairement aux lignes de niveau.",
  divergence: "La divergence ∇·F mesure le flux net sortant : positive pour une source, négative pour un puits.",
  curl: "Le rotationnel ∇×F mesure la tendance du champ à tourner autour d'un point (tourbillon).",
};
const LEGEND_DESC = {
  gradient: "Fond = valeur du champ scalaire f (bleu : faible, rouge : élevé).",
  divergence: "Fond = ∇·F (rouge : source, bleu : puits).",
  curl: "Fond = (∇×F)_z (rouge : anti-horaire, bleu : horaire).",
};

function fillPresets() {
  els.preset.innerHTML = "";
  PRESETS[state.op].forEach((p, i) => {
    const o = document.createElement("option");
    o.value = i; o.textContent = p.name;
    els.preset.appendChild(o);
  });
  els.preset.value = state.preset;
  els.formula.textContent = PRESETS[state.op][state.preset].formula;
}
function syncOpUI() {
  els.opSeg.querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.op === state.op));
  els.opDesc.textContent = OP_DESC[state.op];
  els.legendDesc.textContent = LEGEND_DESC[state.op];
}

/* écouteurs */
els.opSeg.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  state.op = btn.dataset.op;
  state.preset = 0;
  syncOpUI(); fillPresets(); dirty = true;
});
els.preset.addEventListener("change", () => {
  state.preset = +els.preset.value;
  els.formula.textContent = PRESETS[state.op][state.preset].formula;
  dirty = true;
});
function bindSlider(el, valEl, key, isInt) {
  el.addEventListener("input", () => {
    state[key] = isInt ? parseInt(el.value, 10) : parseFloat(el.value);
    valEl.textContent = isInt ? state[key] : state[key].toFixed(1);
    if (key === "parts") syncParticles();
    if (key !== "parts" && key !== "speed") dirty = true;
  });
}
bindSlider(els.amp, els.ampVal, "amp", false);
bindSlider(els.freq, els.freqVal, "freq", false);
bindSlider(els.grid, els.gridVal, "grid", true);
bindSlider(els.parts, els.partsVal, "parts", true);
bindSlider(els.speed, els.speedVal, "speed", false);

function bindCheck(el, key, needsRebuild) {
  el.addEventListener("change", () => {
    state[key] = el.checked;
    if (needsRebuild) dirty = true;
  });
}
bindCheck(els.showArrows, "showArrows", true);
bindCheck(els.showHeat, "showHeat", true);
bindCheck(els.showFlux, "showFlux", false);
bindCheck(els.showContours, "showContours", true);
bindCheck(els.showProbe, "showProbe", false);

els.reset.addEventListener("click", () => {
  state = { ...DEFAULTS };
  applyStateToUI();
  syncOpUI(); fillPresets(); syncParticles();
  dirty = true;
});

function applyStateToUI() {
  els.amp.value = state.amp; els.ampVal.textContent = state.amp.toFixed(1);
  els.freq.value = state.freq; els.freqVal.textContent = state.freq.toFixed(1);
  els.grid.value = state.grid; els.gridVal.textContent = state.grid;
  els.parts.value = state.parts; els.partsVal.textContent = state.parts;
  els.speed.value = state.speed; els.speedVal.textContent = state.speed.toFixed(1);
  els.showArrows.checked = state.showArrows;
  els.showHeat.checked = state.showHeat;
  els.showFlux.checked = state.showFlux;
  els.showContours.checked = state.showContours;
  els.showProbe.checked = state.showProbe;
}

/* souris */
function updateMouse(e) {
  const r = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - r.left) / r.width) * SIZE;
  mouse.y = ((e.clientY - r.top) / r.height) * SIZE;
  mouse.inside = true;
}
canvas.addEventListener("mousemove", updateMouse);
canvas.addEventListener("mouseleave", () => { mouse.inside = false; });
canvas.addEventListener("touchmove", (e) => {
  if (e.touches[0]) { updateMouse(e.touches[0]); e.preventDefault(); }
}, { passive: false });

/* ========================================================================= */
/*  Démarrage                                                                */
/* ========================================================================= */
syncOpUI();
fillPresets();
applyStateToUI();
syncParticles();
requestAnimationFrame(loop);
