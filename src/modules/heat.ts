import { register } from "../registry";

/* =========================================================================
   Module : Chaleur & rayonnement
   Trois scènes pour les trois modes de transfert thermique :
     • Conduction  — équation de la chaleur  ∂T/∂t = α ∇²T  (loi de Fourier
                     q = −k ∇T), barreau chaud/froid + pinceau interactif.
     • Convection  — Rayleigh-Bénard : fluide de Boussinesq chauffé par le bas
                     (mini-solveur « Stable Fluids » + poussée d'Archimède).
     • Rayonnement — corps noir : loi de Planck B_λ(λ,T), déplacement de Wien
                     λ_max = b/T, exitance de Stefan-Boltzmann M = σT⁴.
   ========================================================================= */

const SIZE = 720;
const N = 80;                       // résolution de la grille (intérieur)
const W1 = N + 2;
const SZ = W1 * W1;
const ITER = 6;                     // itérations de Gauss-Seidel (convection)
const IX = (i, j) => i + W1 * j;

/* champs (alloués une fois) */
const T = new Float32Array(SZ);     // température [0..1]
const T0 = new Float32Array(SZ);
const U = new Float32Array(SZ), V = new Float32Array(SZ);
const U0 = new Float32Array(SZ), V0 = new Float32Array(SZ);

/* ========================================================================= */
/*  Constantes physiques (rayonnement)                                       */
/* ========================================================================= */
const H_PLANCK = 6.62607015e-34;    // J·s
const C_LIGHT = 2.99792458e8;       // m/s
const KB = 1.380649e-23;            // J/K
const B_WIEN = 2.897771955e-3;      // m·K
const SIGMA = 5.670374419e-8;       // W·m⁻²·K⁻⁴

/* ========================================================================= */
/*  État                                                                     */
/* ========================================================================= */
const DEFAULTS = {
  mode: "conduction",
  diffu: 5,        // « vitesse » de diffusion (conduction)
  buoy: 50,        // poussée d'Archimède (convection)
  visc: 6,         // viscosité (convection)
  speed: 1,
  flux: false,     // flèches de flux thermique q = −k∇T
  arrows: false,   // flèches de vitesse (convection)
  tempK: 5778,     // température du corps noir (K) — défaut : le Soleil
};
let state = { ...DEFAULTS };

let canvas = null, ctx = null, off = null, octx = null, img = null, els = null;
let rafId = null, running = false, lastT = 0;
let pointer = { down: false, ci: 0, cj: 0 };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ========================================================================= */
/*  Conduction : équation de la chaleur explicite (toujours stable, r=0.2)   */
/* ========================================================================= */
function applyConductionBC() {
  for (let j = 0; j <= N + 1; j++) {
    T[IX(0, j)] = 1;                 // bord gauche : source chaude (Dirichlet)
    T[IX(N + 1, j)] = 0;            // bord droit : puits froid
  }
  for (let i = 0; i <= N + 1; i++) {
    T[IX(i, 0)] = T[IX(i, 1)];      // haut/bas isolés (Neumann, flux nul)
    T[IX(i, N + 1)] = T[IX(i, N)];
  }
}
function conductionStep() {
  applyConductionBC();
  for (let k = 0; k < SZ; k++) T0[k] = T[k];
  for (let j = 1; j <= N; j++) for (let i = 1; i <= N; i++) {
    T[IX(i, j)] = T0[IX(i, j)] + 0.2 * (
      T0[IX(i - 1, j)] + T0[IX(i + 1, j)] +
      T0[IX(i, j - 1)] + T0[IX(i, j + 1)] - 4 * T0[IX(i, j)]);
  }
}
function paintHeat() {
  if (!pointer.down) return;
  const r = 3;
  for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
    if (di * di + dj * dj > r * r) continue;
    const i = clamp(pointer.ci + di, 1, N), j = clamp(pointer.cj + dj, 1, N);
    T[IX(i, j)] = 1;
  }
}

/* ========================================================================= */
/*  Convection : mini-solveur de Boussinesq (advection + diffusion + proj.)  */
/* ========================================================================= */
function set_bnd(b, x) {
  for (let i = 1; i <= N; i++) {
    x[IX(0, i)]     = b === 1 ? -x[IX(1, i)] : x[IX(1, i)];
    x[IX(N + 1, i)] = b === 1 ? -x[IX(N, i)] : x[IX(N, i)];
    x[IX(i, 0)]     = b === 2 ? -x[IX(i, 1)] : x[IX(i, 1)];
    x[IX(i, N + 1)] = b === 2 ? -x[IX(i, N)] : x[IX(i, N)];
  }
}
function lin_solve(b, x, x0, a, c) {
  const ic = 1 / c;
  for (let k = 0; k < ITER; k++) {
    for (let j = 1; j <= N; j++) for (let i = 1; i <= N; i++)
      x[IX(i, j)] = (x0[IX(i, j)] + a * (x[IX(i - 1, j)] + x[IX(i + 1, j)] +
                     x[IX(i, j - 1)] + x[IX(i, j + 1)])) * ic;
    set_bnd(b, x);
  }
}
function diffuse(b, x, x0, d, dt) { const a = dt * d * N * N; lin_solve(b, x, x0, a, 1 + 4 * a); }
function advect(b, d, d0, u, v, dt) {
  const dt0 = dt * N;
  for (let j = 1; j <= N; j++) for (let i = 1; i <= N; i++) {
    let x = i - dt0 * u[IX(i, j)], y = j - dt0 * v[IX(i, j)];
    x = clamp(x, 0.5, N + 0.5); y = clamp(y, 0.5, N + 0.5);
    const i0 = Math.floor(x), i1 = i0 + 1, j0 = Math.floor(y), j1 = j0 + 1;
    const s1 = x - i0, s0 = 1 - s1, t1 = y - j0, t0 = 1 - t1;
    d[IX(i, j)] = s0 * (t0 * d0[IX(i0, j0)] + t1 * d0[IX(i0, j1)]) +
                  s1 * (t0 * d0[IX(i1, j0)] + t1 * d0[IX(i1, j1)]);
  }
  set_bnd(b, d);
}
function project(u, v, p, div) {
  const h = 1 / N;
  for (let j = 1; j <= N; j++) for (let i = 1; i <= N; i++) {
    div[IX(i, j)] = -0.5 * h * (u[IX(i + 1, j)] - u[IX(i - 1, j)] +
                                v[IX(i, j + 1)] - v[IX(i, j - 1)]);
    p[IX(i, j)] = 0;
  }
  set_bnd(0, div); set_bnd(0, p);
  lin_solve(0, p, div, 1, 4);
  for (let j = 1; j <= N; j++) for (let i = 1; i <= N; i++) {
    u[IX(i, j)] -= 0.5 * (p[IX(i + 1, j)] - p[IX(i - 1, j)]) / h;
    v[IX(i, j)] -= 0.5 * (p[IX(i, j + 1)] - p[IX(i, j - 1)]) / h;
  }
  set_bnd(1, u); set_bnd(2, v);
}
function convectionStep(dt) {
  // 1) conditions de température : bas chaud, haut froid (j croît vers le bas)
  for (let i = 0; i <= N + 1; i++) {
    T[IX(i, N + 1)] = 1; T[IX(i, N)] = 1;     // plaque chaude en bas
    T[IX(i, 0)] = 0;     T[IX(i, 1)] = 0;     // plaque froide en haut
  }
  for (let j = 1; j <= N; j++) { T[IX(0, j)] = T[IX(1, j)]; T[IX(N + 1, j)] = T[IX(N, j)]; }

  // 2) poussée d'Archimède : le chaud monte (v négatif = vers le haut)
  const g = state.buoy * 0.0006;
  for (let j = 1; j <= N; j++) for (let i = 1; i <= N; i++)
    V[IX(i, j)] -= g * (T[IX(i, j)] - 0.5) * dt * N;

  // 3) pas de vitesse (Navier-Stokes incompressible)
  const visc = state.visc * 1e-5;
  copy(U, U0); diffuse(1, U, U0, visc, dt);
  copy(V, V0); diffuse(2, V, V0, visc, dt);
  project(U, V, U0, V0);
  copy(U, U0); copy(V, V0);
  advect(1, U, U0, U0, V0, dt);
  advect(2, V, V0, U0, V0, dt);
  project(U, V, U0, V0);

  // 4) transport de la chaleur : advection + diffusion thermique
  copy(T, T0); diffuse(0, T, T0, 6e-5, dt);
  copy(T, T0); advect(0, T, T0, U, V, dt);
}
function copy(dst, src) { for (let k = 0; k < SZ; k++) dst[k] = src[k]; }

/* ========================================================================= */
/*  Initialisation des champs selon la scène                                 */
/* ========================================================================= */
function clearFields() {
  T.fill(0); T0.fill(0);
  U.fill(0); V.fill(0); U0.fill(0); V0.fill(0);
}
function seedScene() {
  clearFields();
  if (state.mode === "conduction") {
    // dégradé initial nul ; les bords imposeront le gradient
    applyConductionBC();
  } else if (state.mode === "convection") {
    // léger bruit pour amorcer l'instabilité de Rayleigh-Bénard
    // (j croît vers le bas : chaud en bas → T augmente avec j)
    for (let j = 1; j <= N; j++) for (let i = 1; i <= N; i++)
      T[IX(i, j)] = j / (N + 1) + (Math.random() - 0.5) * 0.05;
  }
}

/* ========================================================================= */
/*  Rendu — carte thermique (palette « inferno »)                            */
/* ========================================================================= */
const INFERNO = [
  [0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99],
  [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164],
];
function thermal(t) {
  t = clamp(t, 0, 1) * (INFERNO.length - 1);
  const i = Math.min(INFERNO.length - 2, Math.floor(t));
  const f = t - i, a = INFERNO[i], b = INFERNO[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
function renderField() {
  const data = img.data;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const col = thermal(T[IX(i + 1, j + 1)]);
    const p = (i + N * j) * 4;
    data[p] = col[0]; data[p + 1] = col[1]; data[p + 2] = col[2]; data[p + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, SIZE, SIZE);

  if (state.mode === "conduction" && state.flux) drawFlux();
  if (state.mode === "convection" && state.arrows) drawVel();
}
function drawFlux() {
  // q = −k ∇T : la chaleur descend le gradient (du chaud vers le froid)
  const stepc = 6, cell = SIZE / N;
  ctx.strokeStyle = "rgba(120,200,255,0.7)"; ctx.lineWidth = 1.4;
  for (let j = stepc; j <= N; j += stepc) for (let i = stepc; i <= N; i += stepc) {
    const gx = -(T[IX(i + 1, j)] - T[IX(i - 1, j)]) * 0.5;
    const gy = -(T[IX(i, j + 1)] - T[IX(i, j - 1)]) * 0.5;
    const m = Math.hypot(gx, gy);
    if (m < 0.004) continue;
    const sx = (i - 0.5) * cell, sy = (j - 0.5) * cell;
    const len = Math.min(stepc * cell * 0.55, m * 900);
    const a = Math.atan2(gy, gx);
    arrow(sx, sy, sx + Math.cos(a) * len, sy + Math.sin(a) * len);
  }
}
function drawVel() {
  const stepc = 5, cell = SIZE / N;
  ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 1;
  let m = 1e-4;
  for (let k = 0; k < SZ; k++) { const s = Math.hypot(U[k], V[k]); if (s > m) m = s; }
  for (let j = 1; j <= N; j += stepc) for (let i = 1; i <= N; i += stepc) {
    const u = U[IX(i, j)], v = V[IX(i, j)];
    const len = (Math.hypot(u, v) / m) * cell * stepc * 0.5;
    if (len < 0.6) continue;
    const sx = (i - 0.5) * cell, sy = (j - 0.5) * cell, a = Math.atan2(v, u);
    arrow(sx, sy, sx + Math.cos(a) * len, sy + Math.sin(a) * len);
  }
}
function arrow(x0, y0, x1, y1) {
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
  const a = Math.atan2(y1 - y0, x1 - x0), hl = 4;
  ctx.lineTo(x1 - hl * Math.cos(a - 0.5), y1 - hl * Math.sin(a - 0.5));
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - hl * Math.cos(a + 0.5), y1 - hl * Math.sin(a + 0.5));
  ctx.stroke();
}

/* ========================================================================= */
/*  Rendu — corps noir : courbe de Planck                                    */
/* ========================================================================= */
function planck(lambda, tK) {
  // B_λ(λ,T) en W·sr⁻¹·m⁻³  (par unité de longueur d'onde)
  const a = (2 * H_PLANCK * C_LIGHT * C_LIGHT) / Math.pow(lambda, 5);
  const x = (H_PLANCK * C_LIGHT) / (lambda * KB * tK);
  return a / (Math.exp(x) - 1);
}
function blackbodyRGB(tK) {
  // approximation de Tanner Helland (1000–40000 K)
  const t = clamp(tK, 1000, 40000) / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; }
  else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [clamp(r, 0, 255) | 0, clamp(g, 0, 255) | 0, clamp(b, 0, 255) | 0];
}
function wavelengthRGB(nm) {
  // longueur d'onde visible -> RGB (spectre)
  let r = 0, g = 0, b = 0;
  if (nm >= 380 && nm < 440) { r = (440 - nm) / 60; b = 1; }
  else if (nm < 490) { g = (nm - 440) / 50; b = 1; }
  else if (nm < 510) { g = 1; b = (510 - nm) / 20; }
  else if (nm < 580) { r = (nm - 510) / 70; g = 1; }
  else if (nm < 645) { r = 1; g = (645 - nm) / 65; }
  else if (nm <= 780) { r = 1; }
  return [(r * 255) | 0, (g * 255) | 0, (b * 255) | 0];
}
function renderRadiation() {
  const w = SIZE, h = SIZE;
  ctx.fillStyle = "#060912"; ctx.fillRect(0, 0, w, h);
  const L = 60, R = w - 30, Tp = 40, B = h - 60;           // cadre du graphe
  const lamMax = 2200e-9;                                   // axe x : 0 → 2200 nm
  const x = (lam) => L + (lam / lamMax) * (R - L);
  const tK = state.tempK;

  // échelle y : pic de Planck à la température courante (auto-cadrage)
  const peakLam = B_WIEN / tK;
  const ymax = planck(peakLam, tK) * 1.08;
  const y = (val) => B - (val / ymax) * (B - Tp);

  // bande du spectre visible (380–780 nm)
  for (let nm = 380; nm <= 780; nm += 2) {
    const c = wavelengthRGB(nm);
    ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.30)`;
    ctx.fillRect(x(nm * 1e-9), Tp, Math.max(1, x(2e-9) - x(0)), B - Tp);
  }

  // grille + axes
  ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.lineWidth = 1;
  ctx.fillStyle = "#9fb0c8"; ctx.font = "12px Consolas, monospace";
  ctx.textAlign = "center";
  for (let nm = 0; nm <= 2200; nm += 200) {
    const px = x(nm * 1e-9);
    ctx.beginPath(); ctx.moveTo(px, Tp); ctx.lineTo(px, B); ctx.stroke();
    ctx.fillText(String(nm), px, B + 18);
  }
  ctx.textAlign = "left";
  ctx.fillText("longueur d'onde λ (nm)", L, B + 38);
  ctx.save(); ctx.translate(18, (Tp + B) / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center"; ctx.fillText("luminance spectrale B(λ,T)", 0, 0); ctx.restore();
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.beginPath(); ctx.moveTo(L, Tp); ctx.lineTo(L, B); ctx.lineTo(R, B); ctx.stroke();

  // courbes de référence (faibles) à quelques températures
  const refs = [3000, 4000, 5778, 7000, 9000];
  ctx.lineWidth = 1.2;
  for (const tr of refs) {
    if (Math.abs(tr - tK) < 60) continue;
    ctx.strokeStyle = "rgba(150,170,200,0.22)";
    ctx.beginPath();
    for (let px = L; px <= R; px += 3) {
      const lam = ((px - L) / (R - L)) * lamMax;
      if (lam <= 0) continue;
      const yy = y(planck(lam, tr));
      px === L ? ctx.moveTo(px, clamp(yy, Tp, B)) : ctx.lineTo(px, clamp(yy, Tp, B));
    }
    ctx.stroke();
  }

  // courbe principale (couleur du corps noir)
  const rgb = blackbodyRGB(tK);
  ctx.strokeStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`; ctx.lineWidth = 2.6;
  ctx.beginPath();
  for (let px = L; px <= R; px += 1.5) {
    const lam = ((px - L) / (R - L)) * lamMax;
    if (lam <= 0) continue;
    const yy = clamp(y(planck(lam, tK)), Tp, B);
    px === L ? ctx.moveTo(px, yy) : ctx.lineTo(px, yy);
  }
  ctx.stroke();

  // marqueur du maximum (loi de Wien)
  const pxMax = x(peakLam);
  if (pxMax <= R) {
    ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(pxMax, Tp); ctx.lineTo(pxMax, B); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#e8edf5"; ctx.textAlign = "center";
    ctx.fillText(`λmax = ${(peakLam * 1e9).toFixed(0)} nm`, pxMax, Tp - 8);
  }

  // pastille de couleur perçue
  ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  ctx.fillRect(R - 86, Tp + 8, 56, 56);
  ctx.strokeStyle = "rgba(255,255,255,0.4)"; ctx.lineWidth = 1;
  ctx.strokeRect(R - 86, Tp + 8, 56, 56);
  ctx.fillStyle = "#9fb0c8"; ctx.textAlign = "center"; ctx.font = "11px Consolas, monospace";
  ctx.fillText("couleur", R - 58, Tp + 78);
}

/* ========================================================================= */
/*  Boucle                                                                   */
/* ========================================================================= */
function loop(t) {
  if (!running) return;
  let dt = (t - lastT) / 1000; lastT = t;
  if (!isFinite(dt) || dt <= 0) dt = 0.016;

  if (state.mode === "radiation") {
    renderRadiation();
    updateMeasures();
    rafId = requestAnimationFrame(loop);
    return;
  }

  const steps = state.mode === "conduction" ? Math.round(state.diffu * state.speed) : 1;
  if (state.mode === "conduction") {
    for (let s = 0; s < Math.max(1, steps); s++) { paintHeat(); conductionStep(); }
  } else {
    const dtSim = clamp(dt, 0.008, 0.033) * state.speed * 6;
    paintHeat();
    convectionStep(dtSim);
  }
  ctx.clearRect(0, 0, SIZE, SIZE);
  renderField();
  updateMeasures();
  rafId = requestAnimationFrame(loop);
}

/* ========================================================================= */
/*  Mesures live                                                             */
/* ========================================================================= */
function updateMeasures() {
  if (!els.meas) return;
  if (state.mode === "radiation") {
    const tK = state.tempK;
    const lamMax = B_WIEN / tK;
    const M = SIGMA * Math.pow(tK, 4);            // W/m²
    els.meas.innerHTML =
      row("Température", tK.toLocaleString("fr-FR") + " K") +
      row("λ max (Wien)", (lamMax * 1e9).toFixed(0) + " nm") +
      row("Exitance σT⁴", fmtSci(M) + " W/m²") +
      row("≈ corps", bodyName(tK));
  } else {
    // température moyenne du champ
    let sum = 0, n = 0;
    for (let j = 1; j <= N; j++) for (let i = 1; i <= N; i++) { sum += T[IX(i, j)]; n++; }
    els.meas.innerHTML =
      row("T moyenne", (sum / n).toFixed(3)) +
      row("Mode", state.mode === "conduction" ? "Conduction (Fourier)" : "Convection (Rayleigh-Bénard)");
  }
}
function row(k, v) { return `<div class="m-row"><span>${k}</span><b>${v}</b></div>`; }
function fmtSci(x) {
  const e = Math.floor(Math.log10(x));
  return (x / Math.pow(10, e)).toFixed(2) + "·10" + sup(e);
}
function sup(e) {
  const m = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
  return String(e).split("").map((c) => m[c] || c).join("");
}
function bodyName(tK) {
  if (tK < 1500) return "braise / fer rouge";
  if (tK < 3500) return "ampoule à filament";
  if (tK < 5200) return "étoile orange";
  if (tK < 6200) return "Soleil";
  if (tK < 8000) return "étoile blanche";
  return "étoile bleue";
}

/* ========================================================================= */
/*  Textes                                                                   */
/* ========================================================================= */
const MODES = [
  { id: "conduction", label: "Conduction",
    formula: "∂T/∂t = α ∇²T        (équation de la chaleur)\nq = −k ∇T          (loi de Fourier)",
    desc: "Le bord gauche est chaud, le droit froid : la chaleur diffuse de proche en proche dans le solide, sans transport de matière. À l'équilibre le profil devient linéaire. Peins de la chaleur à la souris et affiche le flux q = −k∇T (du chaud vers le froid)." },
  { id: "convection", label: "Convection",
    formula: "ρ c (∂T/∂t + u·∇T) = k ∇²T\npoussée d'Archimède  f = ρ β g (T−T₀)",
    desc: "Fluide chauffé par le bas (Rayleigh-Bénard). Le fluide chaud se dilate, monte, se refroidit en haut puis redescend : des rouleaux de convection s'installent et transportent la chaleur bien plus vite que la conduction seule." },
  { id: "radiation", label: "Rayonnement / corps noir",
    formula: "B_λ(λ,T) = (2hc²/λ⁵) · 1/(e^{hc/λk_BT} − 1)\nλmax = b/T (Wien)   M = σT⁴ (Stefan-Boltzmann)",
    desc: "Tout corps chaud rayonne un spectre continu : c'est la loi de Planck. Plus il est chaud, plus le maximum se déplace vers le bleu (Wien) et plus la puissance émise explose (σT⁴). Aucun milieu n'est nécessaire : le rayonnement traverse le vide." },
];
function modeCfg() { return MODES.find((m) => m.id === state.mode); }

const PRESETS = [
  { k: 2400, label: "Ampoule" },
  { k: 5778, label: "Soleil" },
  { k: 9940, label: "Rigel" },
];

/* ========================================================================= */
/*  Gabarit                                                                  */
/* ========================================================================= */
const TEMPLATE = `
<div class="sim-layout">
  <section class="stage">
    <canvas id="ht-canvas" width="${SIZE}" height="${SIZE}" aria-label="Transfert thermique"></canvas>
  </section>

  <aside class="panel">
    <div class="group">
      <h2>Mode de transfert</h2>
      <div class="seg" id="ht-seg" role="tablist">
        ${MODES.map((m) => `<button class="seg-btn" data-mode="${m.id}">${m.label}</button>`).join("")}
      </div>
      <div class="formula" id="ht-formula"></div>
      <p class="hint" id="ht-desc"></p>
    </div>

    <div class="group" id="ht-grp-cond">
      <h2>Conduction</h2>
      <label class="slider">
        <span>Vitesse de diffusion <em id="diffu-val">5</em></span>
        <input type="range" id="diffu" min="1" max="10" step="1" value="5" />
      </label>
      <label class="check"><input type="checkbox" id="ht-flux" /> Flèches de flux q = −k∇T</label>
    </div>

    <div class="group" id="ht-grp-conv">
      <h2>Convection</h2>
      <label class="slider">
        <span>Poussée (Rayleigh) <em id="buoy-val">50</em></span>
        <input type="range" id="buoy" min="10" max="100" step="5" value="50" />
      </label>
      <label class="slider">
        <span>Viscosité <em id="visc-val">6</em></span>
        <input type="range" id="visc" min="1" max="30" step="1" value="6" />
      </label>
      <label class="check"><input type="checkbox" id="ht-arrows" /> Vecteurs vitesse</label>
    </div>

    <div class="group" id="ht-grp-rad">
      <h2>Corps noir</h2>
      <label class="slider">
        <span>Température <em id="temp-val">5778 K</em></span>
        <input type="range" id="temp" min="1000" max="12000" step="50" value="5778" />
      </label>
      <div class="seg" id="ht-presets" style="margin-top:4px">
        ${PRESETS.map((p) => `<button class="seg-btn" data-k="${p.k}">${p.label} — ${p.k} K</button>`).join("")}
      </div>
    </div>

    <div class="group" id="ht-grp-speed">
      <h2>Simulation</h2>
      <label class="slider">
        <span>Vitesse <em id="speed-val">1.0</em></span>
        <input type="range" id="speed" min="0.2" max="3" step="0.1" value="1" />
      </label>
    </div>

    <div class="group">
      <h2>Mesures</h2>
      <div class="measures" id="ht-meas"></div>
    </div>

    <div class="group">
      <button id="ht-reset" class="reset">Réinitialiser</button>
    </div>
  </aside>
</div>`;

/* ========================================================================= */
/*  Cycle de vie                                                             */
/* ========================================================================= */
function mount(root: HTMLElement) {
  root.innerHTML = TEMPLATE;
  state = { ...DEFAULTS };
  lastT = 0;
  pointer.down = false;

  canvas = root.querySelector("#ht-canvas");
  ctx = canvas.getContext("2d");
  off = document.createElement("canvas"); off.width = off.height = N;
  octx = off.getContext("2d");
  img = octx.createImageData(N, N);

  const $ = (id) => root.querySelector("#" + id);
  els = {
    seg: $("ht-seg"), formula: $("ht-formula"), desc: $("ht-desc"), meas: $("ht-meas"),
    grpCond: $("ht-grp-cond"), grpConv: $("ht-grp-conv"), grpRad: $("ht-grp-rad"), grpSpeed: $("ht-grp-speed"),
    diffu: $("diffu"), diffuVal: $("diffu-val"), flux: $("ht-flux"),
    buoy: $("buoy"), buoyVal: $("buoy-val"), visc: $("visc"), viscVal: $("visc-val"), arrows: $("ht-arrows"),
    temp: $("temp"), tempVal: $("temp-val"), presets: $("ht-presets"),
    speed: $("speed"), speedVal: $("speed-val"), reset: $("ht-reset"),
  };

  els.seg.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn"); if (!btn) return;
    state.mode = btn.dataset.mode; seedScene(); syncModeUI();
  });
  bindSlider(els.diffu, els.diffuVal, "diffu");
  bindSlider(els.buoy, els.buoyVal, "buoy");
  bindSlider(els.visc, els.viscVal, "visc");
  bindSlider(els.speed, els.speedVal, "speed", (v) => v.toFixed(1));
  els.flux.addEventListener("change", () => { state.flux = els.flux.checked; });
  els.arrows.addEventListener("change", () => { state.arrows = els.arrows.checked; });
  els.temp.addEventListener("input", () => {
    state.tempK = parseInt(els.temp.value, 10);
    els.tempVal.textContent = state.tempK + " K";
  });
  els.presets.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn"); if (!btn) return;
    state.tempK = parseInt(btn.dataset.k, 10);
    els.temp.value = state.tempK; els.tempVal.textContent = state.tempK + " K";
  });
  els.reset.addEventListener("click", () => {
    const mode = state.mode;
    state = { ...DEFAULTS, mode };
    seedScene(); applyStateToUI(); syncModeUI();
  });

  // pinceau (conduction & convection)
  const toCell = (cx, cy) => {
    const r = canvas.getBoundingClientRect();
    pointer.ci = clamp(Math.round(((cx - r.left) / r.width) * N), 1, N);
    pointer.cj = clamp(Math.round(((cy - r.top) / r.height) * N), 1, N);
  };
  canvas.addEventListener("mousedown", (e) => { pointer.down = true; toCell(e.clientX, e.clientY); });
  canvas.addEventListener("mousemove", (e) => { if (pointer.down) toCell(e.clientX, e.clientY); });
  window.addEventListener("mouseup", onUp);
  canvas.addEventListener("touchstart", (e) => { pointer.down = true; toCell(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); }, { passive: false });
  canvas.addEventListener("touchmove", (e) => { toCell(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); }, { passive: false });
  canvas.addEventListener("touchend", () => { pointer.down = false; });

  seedScene();
  applyStateToUI(); syncModeUI();
  running = true;
  rafId = requestAnimationFrame(loop);
  return { unmount };
}
function onUp() { pointer.down = false; }

function bindSlider(el, valEl, key, label) {
  el.addEventListener("input", () => {
    state[key] = parseFloat(el.value);
    valEl.textContent = label ? label(state[key]) : state[key];
  });
}
function syncModeUI() {
  els.seg.querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === state.mode));
  els.formula.textContent = modeCfg().formula;
  els.desc.textContent = modeCfg().desc;
  els.grpCond.style.display = state.mode === "conduction" ? "" : "none";
  els.grpConv.style.display = state.mode === "convection" ? "" : "none";
  els.grpRad.style.display = state.mode === "radiation" ? "" : "none";
  els.grpSpeed.style.display = state.mode === "radiation" ? "none" : "";
  canvas.style.cursor = state.mode === "radiation" ? "default" : "crosshair";
}
function applyStateToUI() {
  els.diffu.value = state.diffu; els.diffuVal.textContent = state.diffu;
  els.buoy.value = state.buoy; els.buoyVal.textContent = state.buoy;
  els.visc.value = state.visc; els.viscVal.textContent = state.visc;
  els.speed.value = state.speed; els.speedVal.textContent = state.speed.toFixed(1);
  els.temp.value = state.tempK; els.tempVal.textContent = state.tempK + " K";
  els.flux.checked = state.flux; els.arrows.checked = state.arrows;
}
function unmount() {
  running = false;
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  window.removeEventListener("mouseup", onUp);
  canvas = ctx = off = octx = img = els = null;
}

/* ========================================================================= */
/*  Enregistrement                                                           */
/* ========================================================================= */
register({
  id: "heat",
  title: "Chaleur & rayonnement",
  subtitle: "Les trois modes de transfert thermique : conduction, convection, rayonnement.",
  help: "<b>Conduction</b> : l'équation de la chaleur ∂T/∂t = α∇²T diffuse l'énergie " +
        "dans la matière immobile (loi de Fourier q = −k∇T). <b>Convection</b> : un " +
        "fluide chauffé par le bas forme des rouleaux de Rayleigh-Bénard qui " +
        "transportent la chaleur. <b>Rayonnement</b> : un corps noir émet le spectre " +
        "de Planck — déplacement de Wien (λmax = b/T) et exitance de Stefan-Boltzmann " +
        "(M = σT⁴). <b>Peins la chaleur</b> à la souris/au doigt sur les deux premières " +
        "scènes.",
  mount,
});
