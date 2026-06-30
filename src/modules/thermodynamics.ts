import { register } from "../registry";

/* =========================================================================
   Module : Thermodynamique — les trois principes
   Un gaz parfait simulé par la théorie cinétique : des particules rebondissent
   dans un cylindre à piston. Pression, température et énergie interne émergent
   des chocs. Trois scènes :
     • 1er principe — conservation : ΔU = Q − W (chaleur, travail, diagramme P-V).
     • 2e principe  — entropie : détente libre irréversible, S croît, flèche du temps.
     • 3e principe  — zéro absolu : S → 0 quand T → 0, et T = 0 est inatteignable.
   ========================================================================= */

const SIZE = 720;
const NP = 300;                       // nombre de particules
const BOXH = 1.0;                      // hauteur du cylindre (unités sim)
const VMAX = 1.6, VMIN = 0.45;         // course du piston (= volume)
const SUB = 4;                         // sous-pas d'intégration par frame

/* particules (allouées une fois) */
const px = new Float32Array(NP), py = new Float32Array(NP);
const vx = new Float32Array(NP), vy = new Float32Array(NP);
const sp = new Uint8Array(NP);         // espèce (0/1) — pour la coloration

/* ========================================================================= */
/*  État                                                                     */
/* ========================================================================= */
const DEFAULTS = { mode: "first", speed: 1 };
let state = { ...DEFAULTS };

let pistonX = 1.2;                     // position du piston = volume
let pistonV = 0;                       // vitesse du piston (course en cours)
let partition = false;                 // cloison (2e principe)
let partX = VMAX / 2;
let kFactor = 1;                       // échelle d'affichage de T (≈300 au départ)

/* bilans énergétiques (1er principe) — mesurés sur les chocs réels */
let U0 = 1, Qtot = 0, Wgas = 0;        // Wgas = travail fourni PAR le gaz
/* entropie (2e principe) */
let sHist = [];                        // historique S(t)
/* refroidissement (3e principe) */
let coolSteps = [];                    // T après chaque palier (asymptote)

let canvas = null, ctx = null, els = null;
let rafId = null, running = false, lastT = 0;
let held = null;                       // bouton maintenu : "comp" | "det" | "hot" | "cold"

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rnd = (a, b) => a + Math.random() * (b - a);

/* ========================================================================= */
/*  Mesures dérivées                                                         */
/* ========================================================================= */
function meanKE() {                    // énergie cinétique moyenne ∝ température
  let s = 0;
  for (let i = 0; i < NP; i++) s += 0.5 * (vx[i] * vx[i] + vy[i] * vy[i]);
  return s / NP;
}
function internalU() {                 // énergie interne = Σ ½mv²  (m = 1)
  return meanKE() * NP;
}
function tempK() { return meanKE() * kFactor; }
function volume() { return pistonX; }
function pressure() { return (NP * meanKE()) / pistonX; }   // P·V = N k T (2D)

/* ========================================================================= */
/*  Mise en place des scènes                                                 */
/* ========================================================================= */
function seedScene() {
  pistonV = 0; Qtot = 0; Wgas = 0; sHist = []; coolSteps = [];
  held = null;

  if (state.mode === "second") {
    partition = true; partX = VMAX * 0.34; pistonX = VMAX;     // gaz confiné à gauche
    placeParticles(0, partX, true);
  } else {
    partition = false; pistonX = 1.2;
    placeParticles(0, pistonX, false);
  }
  // calibre l'échelle de température (≈ 300 K au départ)
  const ke = meanKE();
  kFactor = ke > 0 ? 300 / ke : 1;
  U0 = internalU();
}
function placeParticles(x0, x1, twoSpecies) {
  for (let i = 0; i < NP; i++) {
    px[i] = rnd(x0 + 0.02, x1 - 0.02);
    py[i] = rnd(0.02, BOXH - 0.02);
    const a = rnd(0, Math.PI * 2), s = rnd(0.6, 1.0);
    vx[i] = Math.cos(a) * s; vy[i] = Math.sin(a) * s;
    sp[i] = twoSpecies ? (px[i] < (x0 + x1) / 2 ? 0 : 1) : (i & 1);
  }
}

/* ========================================================================= */
/*  Intégration                                                              */
/* ========================================================================= */
function step(dt) {
  // mouvement du piston (1er principe)
  pistonV = 0;
  if (state.mode === "first") {
    if (held === "comp" && pistonX > VMIN) pistonV = -0.6;
    else if (held === "det" && pistonX < VMAX) pistonV = 0.6;
  }
  const Ubefore = state.mode === "first" ? meanKE() * NP : 0;
  const Vbefore = pistonX;

  const h = dt / SUB;
  for (let s = 0; s < SUB; s++) {
    pistonX = clamp(pistonX + pistonV * h, VMIN, VMAX);
    for (let i = 0; i < NP; i++) {
      px[i] += vx[i] * h; py[i] += vy[i] * h;
      // parois haute/basse
      if (py[i] < 0) { py[i] = -py[i]; vy[i] = -vy[i]; }
      else if (py[i] > BOXH) { py[i] = 2 * BOXH - py[i]; vy[i] = -vy[i]; }
      // paroi gauche (fixe)
      if (px[i] < 0) { px[i] = -px[i]; vx[i] = -vx[i]; }
      // piston mobile à droite : réflexion sur paroi en mouvement (fait un travail)
      if (px[i] > pistonX) {
        px[i] = 2 * pistonX - px[i];
        vx[i] = 2 * pistonV - vx[i];      // v' = 2·v_piston − v
      }
    }
    // cloison (2e principe) : tant qu'elle est là, le gaz reste à gauche
    if (partition) reflectPartition();
  }

  // bilan du 1er principe : l'énergie reçue du piston (chocs) AVANT tout apport
  // de chaleur est le travail reçu par le gaz = −W_gaz. On le mesure ici pour
  // ne pas le mélanger avec Q (appliqué juste après).
  if (state.mode === "first") {
    const dU_piston = meanKE() * NP - Ubefore;  // variation due aux seuls chocs piston
    Wgas -= dU_piston;                          // W fourni par le gaz = −(énergie reçue du piston)
    if (Math.abs(pistonX - Vbefore) > 1e-6) sampledPV();
  }

  // thermostat manuel (chaleur Q) — compté séparément dans Qtot
  if (held === "hot") applyHeat(1 + 0.012 * state.speed);
  else if (held === "cold") applyHeat(1 - 0.012 * state.speed);
}
function reflectPartition() {
  for (let i = 0; i < NP; i++) {
    if (px[i] > partX) { px[i] = 2 * partX - px[i]; vx[i] = -vx[i]; }
  }
}
function applyHeat(scale) {
  const before = meanKE() * NP;
  for (let i = 0; i < NP; i++) { vx[i] *= scale; vy[i] *= scale; }
  Qtot += meanKE() * NP - before;
}

/* échantillonne le diagramme P-V */
let pvPath = [];
function sampledPV() {
  pvPath.push([volume(), pressure()]);
  if (pvPath.length > 1200) pvPath.shift();
}

/* ========================================================================= */
/*  Entropie (2e principe) — entropie coarse-grainée sur une grille          */
/* ========================================================================= */
const GX = 24, GY = 12;
function entropy() {
  const cells = new Float32Array(GX * GY);
  // ne compter que la zone accessible (gauche de la cloison si présente)
  const xmax = partition ? partX : pistonX;
  for (let i = 0; i < NP; i++) {
    const cx = Math.min(GX - 1, (px[i] / xmax * GX) | 0);
    const cy = Math.min(GY - 1, (py[i] / BOXH * GY) | 0);
    cells[cx + GX * cy]++;
  }
  let S = 0;
  for (let k = 0; k < cells.length; k++) {
    if (cells[k] > 0) { const p = cells[k] / NP; S -= p * Math.log(p); }
  }
  return S;
}

/* ========================================================================= */
/*  Rendu                                                                    */
/* ========================================================================= */
const CYL = { x: 60, y: 56, w: SIZE - 110, h: 360 };
const sx = (x) => CYL.x + (x / VMAX) * CYL.w;
const sy = (y) => CYL.y + (y / BOXH) * CYL.h;

function speciesColor(i, speedRel) {
  if (state.mode === "second") return sp[i] === 0 ? "#ff7a6b" : "#5dd0ff";
  // sinon : couleur selon la vitesse (froid bleu → chaud rouge)
  const t = clamp(speedRel, 0, 1);
  const r = (90 + t * 165) | 0, g = (140 - t * 60) | 0, b = (245 - t * 175) | 0;
  return `rgb(${r},${g},${b})`;
}
function drawCylinder() {
  const pX = sx(pistonX);
  // intérieur
  ctx.fillStyle = "#0a1019";
  ctx.fillRect(CYL.x, CYL.y, CYL.w, CYL.h);
  // parois
  ctx.strokeStyle = "#3a4a63"; ctx.lineWidth = 3;
  ctx.strokeRect(CYL.x, CYL.y, CYL.w, CYL.h);

  // cloison (2e principe)
  if (partition) {
    ctx.strokeStyle = "#9fb0c8"; ctx.lineWidth = 4; ctx.setLineDash([8, 6]);
    ctx.beginPath(); ctx.moveTo(sx(partX), CYL.y); ctx.lineTo(sx(partX), CYL.y + CYL.h); ctx.stroke();
    ctx.setLineDash([]);
  }

  // particules
  const vmax = 1.6;
  for (let i = 0; i < NP; i++) {
    const s = Math.hypot(vx[i], vy[i]);
    ctx.fillStyle = speciesColor(i, s / vmax);
    ctx.beginPath(); ctx.arc(sx(px[i]), sy(py[i]), 3, 0, Math.PI * 2); ctx.fill();
  }

  // piston
  ctx.fillStyle = "#46566f";
  ctx.fillRect(pX, CYL.y - 6, 14, CYL.h + 12);
  ctx.fillStyle = "#5dd0ff";
  ctx.fillRect(pX, CYL.y - 6, 3, CYL.h + 12);
  // tige
  ctx.fillStyle = "#46566f";
  ctx.fillRect(pX + 14, CYL.y + CYL.h / 2 - 4, SIZE - 30 - (pX + 14), 8);

  // flamme / glace sous le cylindre
  if (held === "hot") drawFlame();
  else if (held === "cold") drawIce();

  // légende du mode
  ctx.fillStyle = "#9fb0c8"; ctx.font = "13px Segoe UI, sans-serif"; ctx.textAlign = "left";
  if (state.mode === "first")
    ctx.fillText("Cylindre à piston — comprime/détends (W) et chauffe/refroidis (Q)", CYL.x, CYL.y - 14);
  else if (state.mode === "second")
    ctx.fillText(partition ? "Gaz confiné à gauche par la cloison" : "Détente libre — le gaz a envahi tout le volume", CYL.x, CYL.y - 14);
  else
    ctx.fillText("Refroidissement vers le zéro absolu", CYL.x, CYL.y - 14);
}
function drawFlame() {
  const y = CYL.y + CYL.h + 6;
  for (let k = 0; k < 14; k++) {
    const fx = CYL.x + (k + 0.5) / 14 * CYL.w;
    const hgt = 18 + Math.random() * 16;
    const grad = ctx.createLinearGradient(0, y, 0, y + hgt);
    grad.addColorStop(0, "#ffd24a"); grad.addColorStop(1, "rgba(255,90,40,0)");
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.moveTo(fx - 7, y); ctx.quadraticCurveTo(fx, y + hgt, fx + 7, y); ctx.fill();
  }
}
function drawIce() {
  const y = CYL.y + CYL.h + 10;
  ctx.fillStyle = "#9fe0ff"; ctx.font = "16px serif"; ctx.textAlign = "center";
  for (let k = 0; k < 12; k++) ctx.fillText("❄", CYL.x + (k + 0.5) / 12 * CYL.w, y + 8 + (k % 2) * 6);
}

/* --- insets selon la scène --- */
function drawInsetPV() {
  const X = 60, Y = CYL.y + CYL.h + 60, W = SIZE - 110, H = SIZE - Y - 30;
  ctx.fillStyle = "#060912"; ctx.fillRect(X, Y, W, H);
  ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(X + 34, Y + 8); ctx.lineTo(X + 34, Y + H - 22); ctx.lineTo(X + W - 10, Y + H - 22); ctx.stroke();
  ctx.fillStyle = "#9fb0c8"; ctx.font = "11px Consolas, monospace"; ctx.textAlign = "left";
  ctx.fillText("P", X + 20, Y + 16); ctx.fillText("V", X + W - 16, Y + H - 8);
  ctx.fillText("Diagramme P–V (aire = travail)", X + 44, Y + 16);

  if (pvPath.length < 2) return;
  let pmax = 1e-6, vmaxv = VMAX;
  for (const [, p] of pvPath) if (p > pmax) pmax = p;
  const gx = (v) => X + 34 + (v / vmaxv) * (W - 48);
  const gy = (p) => Y + H - 22 - (p / (pmax * 1.1)) * (H - 36);
  ctx.strokeStyle = "#5dd0ff"; ctx.lineWidth = 1.6; ctx.beginPath();
  pvPath.forEach(([v, p], i) => { const a = gx(v), b = gy(p); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
  ctx.stroke();
  // point courant
  const last = pvPath[pvPath.length - 1];
  ctx.fillStyle = "#ff7a6b";
  ctx.beginPath(); ctx.arc(gx(last[0]), gy(last[1]), 4, 0, Math.PI * 2); ctx.fill();
}
function drawInsetEntropy() {
  const X = 60, Y = CYL.y + CYL.h + 60, W = SIZE - 110, H = SIZE - Y - 30;
  ctx.fillStyle = "#060912"; ctx.fillRect(X, Y, W, H);
  ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(X + 34, Y + 8); ctx.lineTo(X + 34, Y + H - 22); ctx.lineTo(X + W - 10, Y + H - 22); ctx.stroke();
  ctx.fillStyle = "#9fb0c8"; ctx.font = "11px Consolas, monospace"; ctx.textAlign = "left";
  ctx.fillText("S", X + 20, Y + 16); ctx.fillText("temps →", X + W - 60, Y + H - 8);
  ctx.fillText("Entropie au cours du temps (ne décroît jamais)", X + 44, Y + 16);

  if (sHist.length < 2) return;
  const Smax = Math.log(GX * GY);
  const gx = (i) => X + 34 + (i / (sHist.length - 1)) * (W - 48);
  const gy = (s) => Y + H - 22 - (s / Smax) * (H - 36);
  ctx.strokeStyle = "#ffd24a"; ctx.lineWidth = 1.8; ctx.beginPath();
  sHist.forEach((s, i) => { const a = gx(i), b = gy(s); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
  ctx.stroke();
}
function drawInsetCooling() {
  const X = 60, Y = CYL.y + CYL.h + 60, W = SIZE - 110, H = SIZE - Y - 30;
  ctx.fillStyle = "#060912"; ctx.fillRect(X, Y, W, H);
  // histogramme des vitesses (Maxwell-Boltzmann) — à gauche
  const HW = W * 0.5;
  const bins = 18, hist = new Float32Array(bins);
  let vM = 0; for (let i = 0; i < NP; i++) { const s = Math.hypot(vx[i], vy[i]); if (s > vM) vM = s; }
  vM = Math.max(vM, 1e-3);
  for (let i = 0; i < NP; i++) { const s = Math.hypot(vx[i], vy[i]); hist[Math.min(bins - 1, (s / vM * bins) | 0)]++; }
  let hM = 1; for (const v of hist) if (v > hM) hM = v;
  const bw = (HW - 44) / bins;
  ctx.fillStyle = "#5dd0ff";
  for (let k = 0; k < bins; k++) {
    const bh = (hist[k] / hM) * (H - 40);
    ctx.fillRect(X + 34 + k * bw, Y + H - 22 - bh, bw - 1, bh);
  }
  ctx.fillStyle = "#9fb0c8"; ctx.font = "11px Consolas, monospace"; ctx.textAlign = "left";
  ctx.fillText("Distribution des vitesses → pic en 0 quand T→0", X + 34, Y + 16);

  // courbe d'inatteignabilité — à droite
  const RX = X + HW + 16;
  ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(RX, Y + 8); ctx.lineTo(RX, Y + H - 22); ctx.lineTo(X + W - 10, Y + H - 22); ctx.stroke();
  ctx.fillStyle = "#9fb0c8"; ctx.fillText("T après chaque palier (jamais 0)", RX + 4, Y + 16);
  if (coolSteps.length) {
    const Tm = coolSteps[0] || 1;
    const gx = (i) => RX + 6 + (i / Math.max(1, coolSteps.length - 1)) * (X + W - 16 - RX);
    const gy = (t) => Y + H - 22 - (t / Tm) * (H - 36);
    ctx.fillStyle = "#ff7a6b";
    coolSteps.forEach((t, i) => { ctx.beginPath(); ctx.arc(gx(i), gy(t), 3.5, 0, Math.PI * 2); ctx.fill(); });
    // ligne T=0
    ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(RX, gy(0)); ctx.lineTo(X + W - 10, gy(0)); ctx.stroke(); ctx.setLineDash([]);
  }
}

/* ========================================================================= */
/*  Boucle                                                                   */
/* ========================================================================= */
function loop(t) {
  if (!running) return;
  let dt = (t - lastT) / 1000; lastT = t;
  if (!isFinite(dt) || dt <= 0) dt = 0.016;
  const dtSim = clamp(dt, 0.008, 0.033) * state.speed * 2.2;

  step(dtSim);
  if (state.mode === "second" && !partition) {
    sHist.push(entropy());
    if (sHist.length > 1400) sHist.shift();
  }

  ctx.clearRect(0, 0, SIZE, SIZE);
  drawCylinder();
  if (state.mode === "first") drawInsetPV();
  else if (state.mode === "second") drawInsetEntropy();
  else drawInsetCooling();

  updateMeasures();
  rafId = requestAnimationFrame(loop);
}

/* ========================================================================= */
/*  Mesures                                                                  */
/* ========================================================================= */
function row(k, v) { return `<div class="m-row"><span>${k}</span><b>${v}</b></div>`; }
function updateMeasures() {
  if (!els.meas) return;
  const T = tempK();
  if (state.mode === "first") {
    const dU = internalU() - U0;
    els.meas.innerHTML =
      row("Température", T.toFixed(0) + " K") +
      row("Pression P", pressure().toFixed(2)) +
      row("Volume V", volume().toFixed(2)) +
      row("Q reçu", Qtot.toFixed(1)) +
      row("W fourni", Wgas.toFixed(1)) +
      row("ΔU = Q − W", dU.toFixed(1) + "  (≈ " + (Qtot - Wgas).toFixed(1) + ")");
  } else if (state.mode === "second") {
    els.meas.innerHTML =
      row("Température", T.toFixed(0) + " K") +
      row("Entropie S", entropy().toFixed(3)) +
      row("S max", Math.log(GX * GY).toFixed(3)) +
      row("État", partition ? "confiné (ordonné)" : "détendu (désordonné)");
  } else {
    els.meas.innerHTML =
      row("Température", T.toFixed(1) + " K") +
      row("Paliers", String(coolSteps.length)) +
      row("Vitesse moyenne", Math.sqrt(2 * meanKE()).toFixed(3)) +
      row("Zéro absolu", "0 K — inatteignable");
  }
}

/* ========================================================================= */
/*  Textes                                                                   */
/* ========================================================================= */
const MODES = [
  { id: "first", label: "1er principe — conservation",
    formula: "ΔU = Q − W\nU = énergie interne · Q = chaleur reçue · W = travail fourni",
    desc: "L'énergie ne se crée ni ne se perd. Apporte de la chaleur (Q) en chauffant, ou un travail en bougeant le piston (W) : la variation d'énergie interne ΔU est toujours la somme des deux. Comprime le gaz isolé : il s'échauffe (compression adiabatique) sans aucune flamme — le travail s'est transformé en énergie interne." },
  { id: "second", label: "2e principe — entropie",
    formula: "ΔS ≥ 0  (système isolé)\nS = −k Σ pᵢ ln pᵢ",
    desc: "Retire la cloison : le gaz envahit spontanément tout le volume. L'entropie (désordre) augmente et n'inverse jamais sa course — c'est la flèche du temps. Tu ne verras jamais les particules se rassembler spontanément d'un seul côté : la détente libre est irréversible." },
  { id: "third", label: "3e principe — zéro absolu",
    formula: "S → 0  quand  T → 0 K\nle zéro absolu est inatteignable",
    desc: "Refroidis le gaz : les particules ralentissent et la distribution des vitesses se resserre vers un pic en zéro (un seul micro-état, entropie nulle). Mais chaque palier de refroidissement n'enlève qu'une fraction de l'énergie : on s'approche de 0 K sans jamais l'atteindre." },
];
function modeCfg() { return MODES.find((m) => m.id === state.mode); }

/* ========================================================================= */
/*  Gabarit                                                                  */
/* ========================================================================= */
const TEMPLATE = `
<div class="sim-layout">
  <section class="stage">
    <canvas id="td-canvas" width="${SIZE}" height="${SIZE}" aria-label="Thermodynamique"></canvas>
  </section>

  <aside class="panel">
    <div class="group">
      <h2>Principe</h2>
      <div class="seg" id="td-seg" role="tablist">
        ${MODES.map((m) => `<button class="seg-btn" data-mode="${m.id}">${m.label}</button>`).join("")}
      </div>
      <div class="formula" id="td-formula"></div>
      <p class="hint" id="td-desc"></p>
    </div>

    <div class="group" id="td-grp-first">
      <h2>Travail (piston)</h2>
      <div class="seg">
        <button class="seg-btn" id="td-comp">⟵ Comprimer (maintenir)</button>
        <button class="seg-btn" id="td-det">Détendre ⟶ (maintenir)</button>
      </div>
      <h2 style="margin-top:8px">Chaleur</h2>
      <div class="seg">
        <button class="seg-btn" id="td-hot">🔥 Chauffer (maintenir)</button>
        <button class="seg-btn" id="td-cold">❄ Refroidir (maintenir)</button>
      </div>
    </div>

    <div class="group" id="td-grp-second">
      <h2>Détente libre</h2>
      <button id="td-release" class="reset" style="margin-bottom:8px">Retirer la cloison</button>
      <button id="td-repart" class="reset">Remettre la cloison (reset)</button>
    </div>

    <div class="group" id="td-grp-third">
      <h2>Refroidissement</h2>
      <div class="seg">
        <button class="seg-btn" id="td-cool">❄ Refroidir (maintenir)</button>
        <button class="seg-btn" id="td-halve">Palier : T × ½</button>
      </div>
    </div>

    <div class="group">
      <h2>Simulation</h2>
      <label class="slider">
        <span>Vitesse <em id="td-speed-val">1.0</em></span>
        <input type="range" id="td-speed" min="0.2" max="3" step="0.1" value="1" />
      </label>
    </div>

    <div class="group">
      <h2>Mesures</h2>
      <div class="measures" id="td-meas"></div>
    </div>

    <div class="group">
      <button id="td-reset" class="reset">Réinitialiser la scène</button>
    </div>
  </aside>
</div>`;

/* ========================================================================= */
/*  Cycle de vie                                                             */
/* ========================================================================= */
function mount(root: HTMLElement) {
  root.innerHTML = TEMPLATE;
  state = { ...DEFAULTS };
  lastT = 0; pvPath = [];

  canvas = root.querySelector("#td-canvas");
  ctx = canvas.getContext("2d");

  const $ = (id) => root.querySelector("#" + id);
  els = {
    seg: $("td-seg"), formula: $("td-formula"), desc: $("td-desc"), meas: $("td-meas"),
    grpFirst: $("td-grp-first"), grpSecond: $("td-grp-second"), grpThird: $("td-grp-third"),
    comp: $("td-comp"), det: $("td-det"), hot: $("td-hot"), cold: $("td-cold"),
    release: $("td-release"), repart: $("td-repart"),
    cool: $("td-cool"), halve: $("td-halve"),
    speed: $("td-speed"), speedVal: $("td-speed-val"), reset: $("td-reset"),
  };

  els.seg.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn"); if (!btn || !btn.dataset.mode) return;
    state.mode = btn.dataset.mode; pvPath = []; seedScene(); syncModeUI();
  });

  // boutons « maintenus »
  bindHold(els.comp, "comp"); bindHold(els.det, "det");
  bindHold(els.hot, "hot"); bindHold(els.cold, "cold");
  bindHold(els.cool, "cold");

  els.release.addEventListener("click", () => { partition = false; sHist = []; });
  els.repart.addEventListener("click", () => { seedScene(); });
  els.halve.addEventListener("click", () => {
    for (let i = 0; i < NP; i++) { vx[i] *= Math.SQRT1_2; vy[i] *= Math.SQRT1_2; } // KE × ½ → T × ½
    coolSteps.push(tempK());
  });
  els.speed.addEventListener("input", () => {
    state.speed = parseFloat(els.speed.value);
    els.speedVal.textContent = state.speed.toFixed(1);
  });
  els.reset.addEventListener("click", () => { pvPath = []; seedScene(); });

  seedScene(); syncModeUI();
  running = true;
  rafId = requestAnimationFrame(loop);
  return { unmount };
}

function bindHold(el, key) {
  const down = (e) => { held = key; e.preventDefault(); };
  const up = () => { if (held === key) held = null; };
  el.addEventListener("mousedown", down);
  el.addEventListener("touchstart", down, { passive: false });
  el.addEventListener("mouseup", up);
  el.addEventListener("mouseleave", up);
  el.addEventListener("touchend", up);
  // mémorise pour pouvoir détacher proprement
  holdCleanup.push(() => {
    el.removeEventListener("mousedown", down); el.removeEventListener("touchstart", down);
    el.removeEventListener("mouseup", up); el.removeEventListener("mouseleave", up);
    el.removeEventListener("touchend", up);
  });
}
let holdCleanup = [];

function syncModeUI() {
  els.seg.querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === state.mode));
  els.formula.textContent = modeCfg().formula;
  els.desc.textContent = modeCfg().desc;
  els.grpFirst.style.display = state.mode === "first" ? "" : "none";
  els.grpSecond.style.display = state.mode === "second" ? "" : "none";
  els.grpThird.style.display = state.mode === "third" ? "" : "none";
}
function unmount() {
  running = false;
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  held = null;
  holdCleanup.forEach((fn) => fn()); holdCleanup = [];
  canvas = ctx = els = null;
}

/* ========================================================================= */
/*  Enregistrement                                                           */
/* ========================================================================= */
register({
  id: "thermodynamics",
  title: "Thermodynamique",
  subtitle: "Les trois principes vus par la théorie cinétique d'un gaz de particules.",
  help: "Un gaz parfait est simulé particule par particule : <b>température</b> (énergie " +
        "cinétique moyenne), <b>pression</b> (chocs sur les parois) et <b>volume</b> " +
        "(position du piston) en émergent. <b>1er principe</b> : ΔU = Q − W (chauffe ou " +
        "travaille le piston, lis le bilan et le diagramme P–V). <b>2e principe</b> : " +
        "retire la cloison, l'entropie croît et la détente est irréversible. " +
        "<b>3e principe</b> : refroidis le gaz — S → 0 mais le zéro absolu reste " +
        "inatteignable.",
  mount,
});
