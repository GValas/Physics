import { register } from "../registry";

/* =========================================================================
   Module : Forces inertielles (référentiel tournant)
   Un palet glisse sans frottement sur un plateau tournant. On bascule entre
   deux points de vue de la MÊME trajectoire :
     • Référentiel galiléen (inertiel) — aucune force réelle : le palet va tout
       droit (mouvement rectiligne uniforme), c'est le plateau qui tourne dessous.
     • Référentiel tournant (non-galiléen) — pour « expliquer » la courbure, on
       invente des forces inertielles :
            centrifuge  F_cf  = m ω² r            (vers l'extérieur)
            Coriolis    F_cor = −2 m ω × v        (perpendiculaire à la vitesse)
            Euler       F_eu  = −m (dω/dt) × r    (si le plateau accélère)
   Trois scènes : Coriolis (lancer du centre), Centrifuge (objet entraîné puis
   libéré), Tir balistique (traversée du plateau).
   ========================================================================= */

const SIZE = 720;
const CX = SIZE / 2, CY = SIZE / 2;
const RDISK = 300;

/* ========================================================================= */
/*  État                                                                     */
/* ========================================================================= */
const DEFAULTS = {
  mode: "coriolis",
  view: "rotating",      // "inertial" | "rotating"
  omega: 0.8,            // vitesse angulaire (rad/s, >0 = sens trigo)
  vmag: 150,             // vitesse de lancement (px/s)
  speed: 1,
  showForces: true,
  showTrace: true,       // trace gravée sur le plateau
};
let state = { ...DEFAULTS };

let canvas = null, ctx = null, els = null;
let rafId = null, running = false, lastT = 0;
let theta = 0;                          // angle courant du plateau
let omegaPrev = 0, alpha = 0;           // pour la force d'Euler
let p = { rx: 0, ry: 0, vx: 0, vy: 0 }; // état du palet en repère INERTIEL (y vers le haut)
let trailIn = [], trailRot = [];        // traces (inertielle / tournante)

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const TWO_PI = Math.PI * 2;

/* repère mathématique (y vers le haut) → écran (y vers le bas) */
const sx = (x) => CX + x;
const sy = (y) => CY - y;
function rot(x, y, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [x * c - y * s, x * s + y * c];
}

/* ========================================================================= */
/*  Lancement d'une scène                                                    */
/* ========================================================================= */
function launch() {
  omegaPrev = state.omega; alpha = 0;          // θ reste continu (le plateau ne « saute » pas)
  trailIn = []; trailRot = [];
  const w = state.omega, v = state.vmag;
  if (state.mode === "coriolis") {
    p = { rx: 0, ry: 0, vx: v, vy: 0 };                  // du centre vers la droite
  } else if (state.mode === "centrifuge") {
    const r0 = 95;
    // objet « entraîné » par le plateau : vitesse tangentielle ω×r (donc immobile
    // dans le repère tournant). Une fois libéré, seule l'inertie agit.
    p = { rx: r0, ry: 0, vx: 0, vy: w * r0 };             // ω×r0 = (−ω·ry, ω·rx) = (0, ω·r0)
  } else { // balistique : traversée depuis le bord gauche
    p = { rx: -RDISK * 0.8, ry: 0, vx: v, vy: 0 };
  }
}

/* ========================================================================= */
/*  Intégration (repère inertiel : ligne droite, sans frottement)            */
/* ========================================================================= */
function step(dt) {
  alpha = (state.omega - omegaPrev) / dt;                 // accélération angulaire (Euler)
  omegaPrev = state.omega;
  theta += state.omega * dt;
  if (theta > TWO_PI) theta -= TWO_PI; else if (theta < -TWO_PI) theta += TWO_PI;

  p.rx += p.vx * dt; p.ry += p.vy * dt;                   // pas de force réelle

  // mémorise les traces dans les deux repères
  trailIn.push([p.rx, p.ry]);
  const pr = rot(p.rx, p.ry, -theta);                     // position en repère tournant
  trailRot.push(pr);
  if (trailIn.length > 600) { trailIn.shift(); trailRot.shift(); }

  // sortie du plateau → on relance la scène
  if (Math.hypot(p.rx, p.ry) > RDISK * 1.04) launch();
}

/* grandeurs dans le repère tournant (pour les vecteurs-forces) */
function rotatingState() {
  const w = state.omega;
  const pr = rot(p.rx, p.ry, -theta);                                   // position
  const vWorld = [p.vx + w * p.ry, p.vy - w * p.rx];                    // v_in − ω×r
  const vr = rot(vWorld[0], vWorld[1], -theta);                        // vitesse (repère tournant)
  const aCf = [w * w * pr[0], w * w * pr[1]];                          // centrifuge  ω²r
  const aCor = [2 * w * vr[1], -2 * w * vr[0]];                        // −2 ω×v
  const aEu = [alpha * pr[1], -alpha * pr[0]];                         // −α×r
  return { pr, vr, aCf, aCor, aEu };
}

/* ========================================================================= */
/*  Rendu                                                                    */
/* ========================================================================= */
function arrow(x0, y0, x1, y1, color, width) {
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = width || 2.5;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  const a = Math.atan2(y1 - y0, x1 - x0), h = 8 + (width || 2.5);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - h * Math.cos(a - 0.42), y1 - h * Math.sin(a - 0.42));
  ctx.lineTo(x1 - h * Math.cos(a + 0.42), y1 - h * Math.sin(a + 0.42));
  ctx.closePath(); ctx.fill();
}
function drawDisk(spokeAngle) {
  // plateau
  ctx.fillStyle = "#101826";
  ctx.beginPath(); ctx.arc(CX, CY, RDISK, 0, TWO_PI); ctx.fill();
  ctx.strokeStyle = "#2b3548"; ctx.lineWidth = 2;
  // anneaux concentriques
  for (let r = RDISK / 4; r < RDISK; r += RDISK / 4) {
    ctx.beginPath(); ctx.arc(CX, CY, r, 0, TWO_PI); ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(CX, CY, RDISK, 0, TWO_PI); ctx.stroke();
  // rayons (montrent la rotation)
  ctx.strokeStyle = "#3a4a63"; ctx.lineWidth = 1.5;
  for (let k = 0; k < 8; k++) {
    const ang = spokeAngle + (k / 8) * TWO_PI;
    const [ex, ey] = rot(RDISK, 0, ang);
    ctx.beginPath(); ctx.moveTo(CX, CY); ctx.lineTo(sx(ex), sy(ey)); ctx.stroke();
  }
  // repère « rouge » du plateau (rayon de référence)
  const [rx, ry] = rot(RDISK, 0, spokeAngle);
  ctx.strokeStyle = "#ff7a6b"; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(CX, CY); ctx.lineTo(sx(rx), sy(ry)); ctx.stroke();
  // moyeu
  ctx.fillStyle = "#46566f"; ctx.beginPath(); ctx.arc(CX, CY, 7, 0, TWO_PI); ctx.fill();
}
function drawTrail(pts, color, transformAng) {
  if (pts.length < 2) return;
  ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    let x = pts[i][0], y = pts[i][1];
    if (transformAng !== undefined) { const r = rot(x, y, transformAng); x = r[0]; y = r[1]; }
    const a = sx(x), b = sy(y);
    i ? ctx.lineTo(a, b) : ctx.moveTo(a, b);
  }
  ctx.stroke();
}

function renderInertial() {
  ctx.fillStyle = "#060912"; ctx.fillRect(0, 0, SIZE, SIZE);
  drawDisk(theta);                                          // le plateau tourne
  // trace gravée sur le plateau (tourne solidairement avec lui)
  if (state.showTrace) drawTrail(trailRot, "rgba(255,180,90,0.55)", theta);
  // trajectoire réelle (rectiligne !) du palet dans le labo
  drawTrail(trailIn, "rgba(120,210,255,0.95)");
  // palet
  const ax = sx(p.rx), ay = sy(p.ry);
  ctx.fillStyle = "#5dd0ff"; ctx.beginPath(); ctx.arc(ax, ay, 8, 0, TWO_PI); ctx.fill();
  // vecteur vitesse (constant, rectiligne)
  arrow(ax, ay, sx(p.rx + p.vx * 0.35), sy(p.ry + p.vy * 0.35), "#cfe8ff", 2.5);
  banner("Référentiel galiléen : aucune force — le palet va tout droit, le plateau tourne dessous.");
}

function renderRotating() {
  ctx.fillStyle = "#060912"; ctx.fillRect(0, 0, SIZE, SIZE);
  drawDisk(0);                                              // plateau fixe (on tourne avec lui)
  // trace dans le repère tournant (courbe !)
  if (state.showTrace) drawTrail(trailRot, "rgba(255,180,90,0.7)");
  const { pr, vr, aCf, aCor, aEu } = rotatingState();
  const ax = sx(pr[0]), ay = sy(pr[1]);
  // palet
  ctx.fillStyle = "#5dd0ff"; ctx.beginPath(); ctx.arc(ax, ay, 8, 0, TWO_PI); ctx.fill();
  // vecteur vitesse apparente
  arrow(ax, ay, sx(pr[0] + vr[0] * 0.35), sy(pr[1] + vr[1] * 0.35), "#cfe8ff", 2);
  // forces inertielles
  if (state.showForces) {
    const G = 0.16;                                         // gain d'affichage des forces
    drawForce(ax, ay, aCf, G, "#ff9d57", "centrifuge");
    drawForce(ax, ay, aCor, G, "#7CFFB2", "Coriolis");
    if (Math.abs(alpha) > 0.05) drawForce(ax, ay, aEu, G, "#c89bff", "Euler");
  }
  banner("Référentiel tournant : pour expliquer la courbure, on ajoute des forces inertielles (fictives).");
}
function drawForce(ax, ay, a, gain, color, label) {
  const len = Math.hypot(a[0], a[1]) * gain;
  if (len < 4) return;
  const ux = a[0] / Math.hypot(a[0], a[1]), uy = a[1] / Math.hypot(a[0], a[1]);
  const L = clamp(len, 0, 150);
  const ex = ax + ux * L, ey = ay - uy * L;
  arrow(ax, ay, ex, ey, color, 3);
  ctx.fillStyle = color; ctx.font = "12px Segoe UI, sans-serif";
  ctx.textAlign = "left"; ctx.fillText(label, ex + 4, ey);
}
function banner(text) {
  ctx.fillStyle = "rgba(8,12,20,0.7)"; ctx.fillRect(0, 0, SIZE, 30);
  ctx.fillStyle = "#cfe0f5"; ctx.font = "13px Segoe UI, sans-serif"; ctx.textAlign = "center";
  ctx.fillText(text, CX, 20);
}

/* ========================================================================= */
/*  Boucle                                                                   */
/* ========================================================================= */
function loop(t) {
  if (!running) return;
  let dt = (t - lastT) / 1000; lastT = t;
  if (!isFinite(dt) || dt <= 0) dt = 0.016;
  dt = clamp(dt, 0.008, 0.033) * state.speed;
  step(dt);
  if (state.view === "inertial") renderInertial(); else renderRotating();
  updateMeasures();
  rafId = requestAnimationFrame(loop);
}

/* ========================================================================= */
/*  Mesures                                                                  */
/* ========================================================================= */
function row(k, v) { return `<div class="m-row"><span>${k}</span><b>${v}</b></div>`; }
function updateMeasures() {
  if (!els.meas) return;
  const w = state.omega, r = Math.hypot(p.rx, p.ry);
  const { vr } = rotatingState();
  const vrm = Math.hypot(vr[0], vr[1]);
  els.meas.innerHTML =
    row("Vitesse angulaire ω", w.toFixed(2) + " rad/s") +
    row("Période T", w !== 0 ? (TWO_PI / Math.abs(w)).toFixed(1) + " s" : "∞") +
    row("Rayon r", r.toFixed(0) + " px") +
    row("F centrifuge ω²r", (w * w * r).toFixed(0)) +
    row("F Coriolis 2ω·v", (2 * Math.abs(w) * vrm).toFixed(0)) +
    row("Référentiel", state.view === "inertial" ? "galiléen" : "tournant");
}

/* ========================================================================= */
/*  Textes                                                                   */
/* ========================================================================= */
const MODES = [
  { id: "coriolis", label: "Coriolis (lancer du centre)",
    formula: "F_Coriolis = −2 m ω × v",
    desc: "On lance le palet depuis le centre, droit devant. Dans le labo il file en ligne droite ; mais vu du plateau tournant, il dévie sur le côté : c'est la force de Coriolis, perpendiculaire à la vitesse. Bascule le référentiel pour voir la même trajectoire « droite » devenir « courbe »." },
  { id: "centrifuge", label: "Centrifuge (objet libéré)",
    formula: "F_centrifuge = m ω² r   (vers l'extérieur)",
    desc: "Le palet est d'abord entraîné par le plateau (immobile dans le repère tournant). Libéré, il n'a plus rien pour le retenir : dans le labo il part en ligne droite (tangentielle), mais vu du plateau il s'éloigne du centre — la fameuse force centrifuge, qui n'est que de l'inertie." },
  { id: "balistique", label: "Tir balistique",
    formula: "déviation ∝ ω × (portée)",
    desc: "Un projectile traverse le plateau de part en part. Sur une Terre en rotation, c'est ce qui dévie les vents, les courants marins et les missiles longue portée (vers la droite dans l'hémisphère nord, ω > 0)." },
];
function modeCfg() { return MODES.find((m) => m.id === state.mode); }

/* ========================================================================= */
/*  Gabarit                                                                  */
/* ========================================================================= */
const TEMPLATE = `
<div class="sim-layout">
  <section class="stage">
    <canvas id="if-canvas" width="${SIZE}" height="${SIZE}" aria-label="Forces inertielles"></canvas>
  </section>

  <aside class="panel">
    <div class="group">
      <h2>Scène</h2>
      <div class="seg" id="if-seg" role="tablist">
        ${MODES.map((m) => `<button class="seg-btn" data-mode="${m.id}">${m.label}</button>`).join("")}
      </div>
      <div class="formula" id="if-formula"></div>
      <p class="hint" id="if-desc"></p>
    </div>

    <div class="group">
      <h2>Référentiel</h2>
      <div class="seg" id="if-view">
        <button class="seg-btn" data-view="inertial">Galiléen (labo fixe)</button>
        <button class="seg-btn" data-view="rotating">Tournant (lié au plateau)</button>
      </div>
    </div>

    <div class="group">
      <h2>Paramètres</h2>
      <label class="slider">
        <span>Vitesse de rotation ω <em id="om-val">0.80</em></span>
        <input type="range" id="om" min="-1.4" max="1.4" step="0.05" value="0.8" />
      </label>
      <label class="slider">
        <span>Vitesse de lancement <em id="vm-val">150</em></span>
        <input type="range" id="vm" min="40" max="280" step="10" value="150" />
      </label>
      <label class="slider">
        <span>Vitesse d'animation <em id="speed-val">1.0</em></span>
        <input type="range" id="speed" min="0.2" max="2.5" step="0.1" value="1" />
      </label>
    </div>

    <div class="group">
      <h2>Affichage</h2>
      <label class="check"><input type="checkbox" id="if-forces" checked /> Vecteurs forces inertielles</label>
      <label class="check"><input type="checkbox" id="if-trace" checked /> Trace gravée sur le plateau</label>
    </div>

    <div class="group">
      <h2>Mesures</h2>
      <div class="measures" id="if-meas"></div>
    </div>

    <div class="group">
      <button id="if-launch" class="reset" style="margin-bottom:8px">Relancer le palet</button>
      <button id="if-reset" class="reset">Réinitialiser</button>
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

  canvas = root.querySelector("#if-canvas");
  ctx = canvas.getContext("2d");

  const $ = (id) => root.querySelector("#" + id);
  els = {
    seg: $("if-seg"), view: $("if-view"), formula: $("if-formula"), desc: $("if-desc"), meas: $("if-meas"),
    om: $("om"), omVal: $("om-val"), vm: $("vm"), vmVal: $("vm-val"),
    speed: $("speed"), speedVal: $("speed-val"),
    forces: $("if-forces"), trace: $("if-trace"),
    launch: $("if-launch"), reset: $("if-reset"),
  };

  els.seg.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn"); if (!btn) return;
    state.mode = btn.dataset.mode; launch(); syncUI();
  });
  els.view.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn"); if (!btn) return;
    state.view = btn.dataset.view; syncUI();
  });
  els.om.addEventListener("input", () => {
    state.omega = parseFloat(els.om.value); els.omVal.textContent = state.omega.toFixed(2);
  });
  els.vm.addEventListener("input", () => {
    state.vmag = parseFloat(els.vm.value); els.vmVal.textContent = state.vmag;
  });
  els.speed.addEventListener("input", () => {
    state.speed = parseFloat(els.speed.value); els.speedVal.textContent = state.speed.toFixed(1);
  });
  els.forces.addEventListener("change", () => { state.showForces = els.forces.checked; });
  els.trace.addEventListener("change", () => { state.showTrace = els.trace.checked; });
  els.launch.addEventListener("click", launch);
  els.reset.addEventListener("click", () => {
    const mode = state.mode;
    state = { ...DEFAULTS, mode };
    applyStateToUI(); launch(); syncUI();
  });

  applyStateToUI(); launch(); syncUI();
  running = true;
  rafId = requestAnimationFrame(loop);
  return { unmount };
}
function syncUI() {
  els.seg.querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === state.mode));
  els.view.querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === state.view));
  els.formula.textContent = modeCfg().formula;
  els.desc.textContent = modeCfg().desc;
}
function applyStateToUI() {
  els.om.value = state.omega; els.omVal.textContent = state.omega.toFixed(2);
  els.vm.value = state.vmag; els.vmVal.textContent = state.vmag;
  els.speed.value = state.speed; els.speedVal.textContent = state.speed.toFixed(1);
  els.forces.checked = state.showForces; els.trace.checked = state.showTrace;
}
function unmount() {
  running = false;
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  canvas = ctx = els = null;
}

/* ========================================================================= */
/*  Enregistrement                                                           */
/* ========================================================================= */
register({
  id: "inertial-forces",
  title: "Forces inertielles",
  subtitle: "Centrifuge, Coriolis, Euler : les forces « fictives » d'un référentiel tournant.",
  help: "Un palet glisse sans frottement sur un <b>plateau tournant</b>. Dans le " +
        "<b>référentiel galiléen</b> (labo) il n'y a aucune force : le palet va tout " +
        "droit. Dans le <b>référentiel tournant</b> (lié au plateau) on doit ajouter " +
        "des <b>forces inertielles</b> pour expliquer sa trajectoire courbe : " +
        "<b>centrifuge</b> (mω²r, vers l'extérieur), <b>Coriolis</b> (−2mω×v, " +
        "perpendiculaire à la vitesse) et <b>Euler</b> (quand ω varie). Bascule entre " +
        "les deux référentiels pour voir la même trajectoire changer d'allure — c'est " +
        "Coriolis qui dévie vents et courants sur la Terre en rotation.",
  mount,
});
