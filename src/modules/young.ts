import { register } from "../registry";

/* =========================================================================
   Module : Fentes de Young — dualité onde-corpuscule
   Trois scènes pour confronter les deux visages de la lumière :
     • Onde       — cuve à ondes : deux fronts d'onde cohérents issus des
                    fentes se superposent ; la figure d'interférence
                    I(θ) = sinc²(πa sinθ/λ) · cos²(πd sinθ/λ) s'inscrit sur l'écran.
     • Photons    — la lumière arrive « grain par grain » : chaque photon est
                    un impact ponctuel et aléatoire, mais l'accumulation
                    redessine peu à peu les franges (statistique ondulatoire).
     • Balles     — si la lumière était de simples corpuscules sans onde, on
                    n'obtiendrait que deux taches (somme des deux fentes),
                    SANS interférence.
   ========================================================================= */

const SIZE = 720;
const SRC_X = 56;                      // source ponctuelle
const BAR_X = 180;                     // plan des fentes
const SCR_X = SIZE - 150;              // écran de détection
const YC = SIZE / 2;                   // axe optique
const L = SCR_X - BAR_X;               // « distance » fentes → écran (px)
const FW = 170, FH = 170;              // résolution du champ d'onde (cuve)

/* ========================================================================= */
/*  État                                                                     */
/* ========================================================================= */
const DEFAULTS = {
  mode: "wave",
  lambdaNm: 540,    // longueur d'onde (couleur)
  d: 46,            // écartement des fentes (px)
  a: 9,             // largeur d'une fente (px)
  rate: 8,          // photons émis par frame
  speed: 1,
  theory: true,     // superposer la courbe théorique I(y)
};
let state = { ...DEFAULTS };

let canvas = null, ctx = null, els = null;
let field = null, fctx = null, fimg = null;      // cuve à ondes (offscreen)
let acc = null, actx = null;                      // accumulation des impacts
let rafId = null, running = false, lastT = 0, phase = 0;

/* figure d'interférence (échantillonnée) + table de tirage (CDF) */
const Y0 = 24, Y1 = SIZE - 24;
let Iy = null, cdf = null, Itot = 0, dirty = true;
let counts = null, nHits = 0;
let flying = [];                                  // photons en vol

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lambdaPx = () => state.lambdaNm * 0.03;     // échelle nm → px (cuve & franges)

/* ========================================================================= */
/*  Couleur de la lumière (λ visible → RGB)                                  */
/* ========================================================================= */
function wavelengthRGB(nm) {
  let r = 0, g = 0, b = 0;
  if (nm >= 380 && nm < 440) { r = (440 - nm) / 60; b = 1; }
  else if (nm < 490) { g = (nm - 440) / 50; b = 1; }
  else if (nm < 510) { g = 1; b = (510 - nm) / 20; }
  else if (nm < 580) { r = (nm - 510) / 70; g = 1; }
  else if (nm < 645) { r = 1; g = (645 - nm) / 65; }
  else { r = 1; }
  // atténuation aux extrémités du spectre
  let f = 1;
  if (nm < 420) f = 0.3 + 0.7 * (nm - 380) / 40;
  else if (nm > 700) f = 0.3 + 0.7 * (780 - nm) / 80;
  return [(r * 255 * f) | 0, (g * 255 * f) | 0, (b * 255 * f) | 0];
}
function lightCSS() { const c = wavelengthRGB(state.lambdaNm); return `rgb(${c[0]},${c[1]},${c[2]})`; }

/* ========================================================================= */
/*  Position des fentes                                                      */
/* ========================================================================= */
function slitY() { return [YC - state.d / 2, YC + state.d / 2]; }

/* ========================================================================= */
/*  Figure d'interférence I(y) sur l'écran                                   */
/* ========================================================================= */
function intensityWave(y) {
  const lam = lambdaPx();
  const dy = y - YC;
  const sinT = dy / Math.sqrt(dy * dy + L * L);
  const beta = (Math.PI * state.a / lam) * sinT;     // diffraction (1 fente)
  const alpha = (Math.PI * state.d / lam) * sinT;    // interférence (2 fentes)
  const env = beta === 0 ? 1 : (Math.sin(beta) / beta) ** 2;
  return env * Math.cos(alpha) ** 2;
}
function intensityBalls(y) {
  // deux taches gaussiennes (projection géométrique des fentes), aucune frange
  const [y1, y2] = slitY();
  const proj = (BAR_X - SRC_X + L) / (BAR_X - SRC_X);  // grandissement géométrique
  const c1 = YC + (y1 - YC) * proj, c2 = YC + (y2 - YC) * proj;
  const sig = clamp((lambdaPx() * L) / state.a * 0.18, 26, 150);
  const g = (c) => Math.exp(-((y - c) ** 2) / (2 * sig * sig));
  return g(c1) + g(c2);
}
function intensityAt(y) {
  return state.mode === "balls" ? intensityBalls(y) : intensityWave(y);
}
function rebuildPattern() {
  const n = Y1 - Y0;
  if (!Iy) { Iy = new Float32Array(n); cdf = new Float32Array(n); }
  let cum = 0, max = 1e-9;
  for (let k = 0; k < n; k++) { const v = intensityAt(Y0 + k); Iy[k] = v; if (v > max) max = v; }
  for (let k = 0; k < n; k++) { cum += Iy[k]; cdf[k] = cum; }
  Itot = cum;
  for (let k = 0; k < n; k++) Iy[k] /= max;          // normalisé pour l'affichage
  dirty = false;
}
function sampleY() {
  const r = Math.random() * Itot;
  // recherche dichotomique dans la CDF
  let lo = 0, hi = cdf.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < r) lo = m + 1; else hi = m; }
  return Y0 + lo;
}

/* ========================================================================= */
/*  Rendu — cuve à ondes (champ instantané)                                  */
/* ========================================================================= */
function renderWaveField() {
  const [y1, y2] = slitY();
  const k = (2 * Math.PI) / lambdaPx();
  const col = wavelengthRGB(state.lambdaNm);
  const data = fimg.data;
  for (let fy = 0; fy < FH; fy++) {
    const y = (fy / FH) * SIZE;
    for (let fx = 0; fx < FW; fx++) {
      const x = BAR_X + (fx / FW) * L;
      const r1 = Math.hypot(x - BAR_X, y - y1);
      const r2 = Math.hypot(x - BAR_X, y - y2);
      let amp = 4 * (Math.cos(k * r1 - phase) / Math.sqrt(r1 + 8) +
                     Math.cos(k * r2 - phase) / Math.sqrt(r2 + 8));
      amp = clamp(amp, -1, 1);
      const b = amp * 0.5 + 0.5;                      // crête claire / creux sombre
      const p = (fx + FW * fy) * 4;
      data[p] = col[0] * b; data[p + 1] = col[1] * b; data[p + 2] = col[2] * b; data[p + 3] = 255;
    }
  }
  fctx.putImageData(fimg, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(field, BAR_X, 0, L, SIZE);
}

/* ========================================================================= */
/*  Rendu — décor commun (source, barrière, fentes, écran)                   */
/* ========================================================================= */
function drawScene() {
  const [y1, y2] = slitY(), a = state.a;
  // faisceau source (mode onde uniquement, à gauche de la barrière)
  if (state.mode === "wave") {
    const g = ctx.createRadialGradient(SRC_X, YC, 2, SRC_X, YC, BAR_X - SRC_X + 40);
    g.addColorStop(0, lightCSS()); g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = 0.16; ctx.fillStyle = g;
    ctx.fillRect(0, 0, BAR_X, SIZE); ctx.globalAlpha = 1;
  }
  // source ponctuelle
  ctx.fillStyle = lightCSS();
  ctx.beginPath(); ctx.arc(SRC_X, YC, 6, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.beginPath(); ctx.moveTo(SRC_X, YC); ctx.lineTo(BAR_X, y1); ctx.moveTo(SRC_X, YC); ctx.lineTo(BAR_X, y2); ctx.stroke();

  // barrière opaque avec deux fentes
  ctx.fillStyle = "#2b3548";
  ctx.fillRect(BAR_X - 5, 0, 10, y1 - a / 2);
  ctx.fillRect(BAR_X - 5, y1 + a / 2, 10, (y2 - a / 2) - (y1 + a / 2));
  ctx.fillRect(BAR_X - 5, y2 + a / 2, 10, SIZE - (y2 + a / 2));

  // écran de détection
  ctx.fillStyle = "#0a0f18"; ctx.fillRect(SCR_X, 0, SIZE - SCR_X, SIZE);
  ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(SCR_X, 0); ctx.lineTo(SCR_X, SIZE); ctx.stroke();
}

/* ========================================================================= */
/*  Rendu — figure sur l'écran (franges en mode onde)                        */
/* ========================================================================= */
function drawWaveScreen() {
  const col = wavelengthRGB(state.lambdaNm);
  const w = SIZE - SCR_X;
  for (let k = 0; k < Iy.length; k++) {
    const b = Iy[k];
    ctx.fillStyle = `rgb(${(col[0] * b) | 0},${(col[1] * b) | 0},${(col[2] * b) | 0})`;
    ctx.fillRect(SCR_X + 1, Y0 + k, w - 1, 1);
  }
  if (state.theory) drawTheoryCurve();
}
function drawTheoryCurve() {
  ctx.strokeStyle = "rgba(255,255,255,0.8)"; ctx.lineWidth = 1.5;
  ctx.beginPath();
  const xL = SCR_X - 4, span = 120;            // la courbe « déborde » vers la gauche
  for (let k = 0; k < Iy.length; k++) {
    const px = xL - Iy[k] * span, py = Y0 + k;
    k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.stroke();
}

/* ========================================================================= */
/*  Rendu — photons / balles                                                 */
/* ========================================================================= */
function spawnPhotons() {
  if (dirty) rebuildPattern();
  const [y1, y2] = slitY();
  const n = Math.round(state.rate * state.speed);
  for (let i = 0; i < n; i++) {
    const ty = sampleY();
    // choix « indéterminé » de la fente (décor : la trajectoire n'est pas mesurée)
    const sy = Math.random() < 0.5 ? y1 : y2;
    const tx = SCR_X + 3 + Math.random() * (SIZE - SCR_X - 6);
    flying.push({ t: 0, sy, ty, tx });
    if (flying.length > 400) flying.shift();
  }
}
function stepPhotons() {
  const col = wavelengthRGB(state.lambdaNm);
  const sp = 0.05 * state.speed;
  for (let i = flying.length - 1; i >= 0; i--) {
    const f = flying[i];
    f.t += sp;
    if (f.t >= 1) {
      // impact : marque permanente + comptage
      actx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},0.85)`;
      actx.beginPath(); actx.arc(f.tx, f.ty, 1.4, 0, Math.PI * 2); actx.fill();
      const bin = clamp((f.ty - Y0) | 0, 0, counts.length - 1);
      counts[bin]++; nHits++;
      flying.splice(i, 1);
    }
  }
}
function drawPhotons() {
  // accumulation des impacts
  ctx.drawImage(acc, 0, 0);
  // photons en vol : source → fente → cible
  const col = wavelengthRGB(state.lambdaNm);
  ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
  for (const f of flying) {
    let x, y;
    if (f.t < 0.45) { const u = f.t / 0.45; x = SRC_X + (BAR_X - SRC_X) * u; y = YC + (f.sy - YC) * u; }
    else { const u = (f.t - 0.45) / 0.55; x = BAR_X + (f.tx - BAR_X) * u; y = f.sy + (f.ty - f.sy) * u; }
    ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  // histogramme cumulé (courbe construite)
  if (state.theory && nHits > 5) drawHistogram();
}
function drawHistogram() {
  let max = 1; for (const c of counts) if (c > max) max = c;
  ctx.strokeStyle = "rgba(255,255,255,0.75)"; ctx.lineWidth = 1.4;
  ctx.beginPath();
  const xL = SCR_X - 4, span = 120;
  for (let k = 0; k < counts.length; k++) {
    const px = xL - (counts[k] / max) * span, py = Y0 + k;
    k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.stroke();
}
function clearAccumulation() {
  if (actx) actx.clearRect(0, 0, SIZE, SIZE);
  if (counts) counts.fill(0);
  nHits = 0; flying = [];
}

/* ========================================================================= */
/*  Boucle                                                                   */
/* ========================================================================= */
function loop(t) {
  if (!running) return;
  let dt = (t - lastT) / 1000; lastT = t;
  if (!isFinite(dt) || dt <= 0) dt = 0.016;
  phase += clamp(dt, 0.008, 0.05) * state.speed * 7;

  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = "#060912"; ctx.fillRect(0, 0, SIZE, SIZE);

  if (state.mode === "wave") {
    if (dirty) rebuildPattern();
    renderWaveField();
    drawScene();
    drawWaveScreen();
  } else {
    drawScene();
    spawnPhotons();
    stepPhotons();
    drawPhotons();
  }
  updateMeasures();
  rafId = requestAnimationFrame(loop);
}

/* ========================================================================= */
/*  Mesures                                                                  */
/* ========================================================================= */
function row(k, v) { return `<div class="m-row"><span>${k}</span><b>${v}</b></div>`; }
function updateMeasures() {
  if (!els.meas) return;
  const i = (lambdaPx() * L) / state.d;       // interfrange i = λL/d
  let html =
    row("λ", state.lambdaNm + " nm") +
    row("Écart fentes d", state.d + " px") +
    row("Largeur fente a", state.a + " px") +
    row("Interfrange i = λL/d", i.toFixed(0) + " px");
  if (state.mode !== "wave") html += row("Photons détectés", nHits.toLocaleString("fr-FR"));
  els.meas.innerHTML = html;
}

/* ========================================================================= */
/*  Textes                                                                   */
/* ========================================================================= */
const MODES = [
  { id: "wave", label: "Onde (cuve à ondes)",
    formula: "I(θ) = sinc²(πa·sinθ/λ) · cos²(πd·sinθ/λ)\ninterfrange  i = λL/d",
    desc: "Chaque fente devient une source secondaire cohérente (Huygens). Les deux trains d'ondes se superposent : là où ils sont en phase, ils s'ajoutent (frange brillante) ; en opposition de phase, ils s'annulent (frange sombre). La figure de franges apparaît sur l'écran." },
  { id: "photon", label: "Photons (un par un)",
    formula: "P(y) ∝ |ψ₁ + ψ₂|²\nimpacts discrets, probabilité ondulatoire",
    desc: "On baisse l'intensité au point d'envoyer un seul photon à la fois. Chaque photon laisse un impact ponctuel, imprévisible — c'est le côté corpusculaire. Mais au fil des impacts, la figure d'interférence se reconstruit : chaque photon « interfère avec lui-même ». Voilà la dualité onde-corpuscule." },
  { id: "balls", label: "Balles classiques",
    formula: "I = I₁ + I₂   (pas de terme d'interférence)",
    desc: "Et si la lumière n'était QUE des petites billes, sans onde ? Chaque bille passe par une fente ou l'autre et l'on additionne simplement les deux : on obtient deux taches, sans la moindre frange. C'est ce que l'expérience NE montre pas — preuve que la lumière est aussi une onde." },
];
function modeCfg() { return MODES.find((m) => m.id === state.mode); }

/* ========================================================================= */
/*  Gabarit                                                                  */
/* ========================================================================= */
const TEMPLATE = `
<div class="sim-layout">
  <section class="stage">
    <canvas id="yg-canvas" width="${SIZE}" height="${SIZE}" aria-label="Fentes de Young"></canvas>
  </section>

  <aside class="panel">
    <div class="group">
      <h2>Nature de la lumière</h2>
      <div class="seg" id="yg-seg" role="tablist">
        ${MODES.map((m) => `<button class="seg-btn" data-mode="${m.id}">${m.label}</button>`).join("")}
      </div>
      <div class="formula" id="yg-formula"></div>
      <p class="hint" id="yg-desc"></p>
    </div>

    <div class="group">
      <h2>Dispositif</h2>
      <label class="slider">
        <span>Longueur d'onde λ <em id="lam-val">540 nm</em></span>
        <input type="range" id="lam" min="410" max="680" step="10" value="540" />
      </label>
      <label class="slider">
        <span>Écartement des fentes d <em id="d-val">46</em></span>
        <input type="range" id="d" min="18" max="100" step="2" value="46" />
      </label>
      <label class="slider">
        <span>Largeur d'une fente a <em id="a-val">9</em></span>
        <input type="range" id="a" min="3" max="26" step="1" value="9" />
      </label>
    </div>

    <div class="group" id="yg-grp-rate">
      <h2>Flux de photons</h2>
      <label class="slider">
        <span>Débit <em id="rate-val">8</em></span>
        <input type="range" id="rate" min="1" max="40" step="1" value="8" />
      </label>
      <button id="yg-clear" class="reset">Effacer l'écran</button>
    </div>

    <div class="group">
      <h2>Affichage</h2>
      <label class="check"><input type="checkbox" id="yg-theory" checked /> Courbe d'intensité</label>
      <label class="slider">
        <span>Vitesse <em id="speed-val">1.0</em></span>
        <input type="range" id="speed" min="0.2" max="3" step="0.1" value="1" />
      </label>
    </div>

    <div class="group">
      <h2>Mesures</h2>
      <div class="measures" id="yg-meas"></div>
    </div>

    <div class="group">
      <button id="yg-reset" class="reset">Réinitialiser</button>
    </div>
  </aside>
</div>`;

/* ========================================================================= */
/*  Cycle de vie                                                             */
/* ========================================================================= */
function mount(root: HTMLElement) {
  root.innerHTML = TEMPLATE;
  state = { ...DEFAULTS };
  lastT = 0; phase = 0; dirty = true; flying = [];

  canvas = root.querySelector("#yg-canvas");
  ctx = canvas.getContext("2d");
  field = document.createElement("canvas"); field.width = FW; field.height = FH;
  fctx = field.getContext("2d"); fimg = fctx.createImageData(FW, FH);
  acc = document.createElement("canvas"); acc.width = acc.height = SIZE;
  actx = acc.getContext("2d");
  counts = new Float32Array(Y1 - Y0); nHits = 0;

  const $ = (id) => root.querySelector("#" + id);
  els = {
    seg: $("yg-seg"), formula: $("yg-formula"), desc: $("yg-desc"), meas: $("yg-meas"),
    grpRate: $("yg-grp-rate"), clear: $("yg-clear"),
    lam: $("lam"), lamVal: $("lam-val"), d: $("d"), dVal: $("d-val"), a: $("a"), aVal: $("a-val"),
    rate: $("rate"), rateVal: $("rate-val"), theory: $("yg-theory"),
    speed: $("speed"), speedVal: $("speed-val"), reset: $("yg-reset"),
  };

  els.seg.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn"); if (!btn) return;
    state.mode = btn.dataset.mode; dirty = true; clearAccumulation(); syncModeUI();
  });
  bindSlider(els.lam, els.lamVal, "lambdaNm", (v) => v + " nm", true);
  bindSlider(els.d, els.dVal, "d", null, true);
  bindSlider(els.a, els.aVal, "a", null, true);
  bindSlider(els.rate, els.rateVal, "rate");
  bindSlider(els.speed, els.speedVal, "speed", (v) => v.toFixed(1));
  els.theory.addEventListener("change", () => { state.theory = els.theory.checked; });
  els.clear.addEventListener("click", clearAccumulation);
  els.reset.addEventListener("click", () => {
    const mode = state.mode;
    state = { ...DEFAULTS, mode };
    dirty = true; clearAccumulation(); applyStateToUI(); syncModeUI();
  });

  applyStateToUI(); syncModeUI();
  running = true;
  rafId = requestAnimationFrame(loop);
  return { unmount };
}

function bindSlider(el, valEl, key, label, repattern) {
  el.addEventListener("input", () => {
    state[key] = parseFloat(el.value);
    valEl.textContent = label ? label(state[key]) : state[key];
    if (repattern) { dirty = true; if (state.mode !== "wave") clearAccumulation(); }
  });
}
function syncModeUI() {
  els.seg.querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === state.mode));
  els.formula.textContent = modeCfg().formula;
  els.desc.textContent = modeCfg().desc;
  els.grpRate.style.display = state.mode === "wave" ? "none" : "";
  canvas.style.cursor = "default";
}
function applyStateToUI() {
  els.lam.value = state.lambdaNm; els.lamVal.textContent = state.lambdaNm + " nm";
  els.d.value = state.d; els.dVal.textContent = state.d;
  els.a.value = state.a; els.aVal.textContent = state.a;
  els.rate.value = state.rate; els.rateVal.textContent = state.rate;
  els.speed.value = state.speed; els.speedVal.textContent = state.speed.toFixed(1);
  els.theory.checked = state.theory;
}
function unmount() {
  running = false;
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  canvas = ctx = els = field = fctx = fimg = acc = actx = null;
}

/* ========================================================================= */
/*  Enregistrement                                                           */
/* ========================================================================= */
register({
  id: "young",
  title: "Fentes de Young",
  subtitle: "Interférences et dualité onde-corpuscule de la lumière.",
  help: "L'expérience des <b>fentes de Young</b> : une lumière cohérente traverse " +
        "deux fentes voisines. <b>Onde</b> — les deux ondes se superposent et " +
        "dessinent des franges (interfrange i = λL/d). <b>Photons un par un</b> — " +
        "la lumière arrive en grains : chaque impact est ponctuel et aléatoire, mais " +
        "l'accumulation reconstruit les franges (chaque photon « interfère avec " +
        "lui-même »). <b>Balles classiques</b> — sans nature ondulatoire on n'aurait " +
        "que deux taches. Joue sur λ, l'écartement d et la largeur a des fentes.",
  mount,
});
