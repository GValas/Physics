import { register } from "../registry";

/* =========================================================================
   Module : Courant électrique — modèle microscopique (Drude simplifié)
   Illustre intensité I, tension U, résistance R, vitesse de dérive v_d,
   électrons libres, ions du réseau, champ E et sens conventionnel.
   ========================================================================= */


const W = 760, H = 440;            // résolution interne du canvas (px)

/* Géométrie du conducteur (px écran) */
const BAND = { x0: 110, x1: 650, y0: 120, y1: 360 };
const MIDX = (BAND.x0 + BAND.x1) / 2;     // section de mesure

/* Constantes physiques (pour les mesures « réelles ») */
const E_CH = 1.602e-19;            // charge élémentaire (C)
const M_E  = 9.109e-31;            // masse de l'électron (kg)
const K_B  = 1.381e-23;            // constante de Boltzmann (J/K)
const N0   = 8.5e28;               // densité de porteurs du cuivre (m⁻³)
const AREA = 1e-6;                 // section du fil : 1 mm² (m²)
const L_WIRE = 0.1;                // longueur du conducteur : 10 cm (m)

/* Échelles d'animation (px/frame) */
const DRIFT_K = 0.6;               // dérive visuelle ∝ I / densité
const THERMAL_K = 0.115;           // agitation thermique visuelle ∝ √T
const BASE_N = 160;                // nb d'électrons dessinés à densité = 1

/* ========================================================================= */
/*  État                                                                     */
/* ========================================================================= */
const DEFAULTS = {
  U: 6, R: 3, dens: 1, temp: 300, speed: 1,
  showField: true, showCurrent: true, showDrift: true,
  showThermal: true, showIons: true, showPotential: true,
};
let state = { ...DEFAULTS };

let canvas = null, ctx = null, els = null, readout = null;
let rafId = null, running = false, lastT = 0;

let electrons = [];
let ions = [];

/* mesure du débit à la section */
let crossAccum = 0, timeAccum = 0, crossRate = 0;

/* ========================================================================= */
/*  Physique dérivée de l'état                                               */
/* ========================================================================= */
function current()    { return state.U / state.R; }                 // I = U/R (A)
function power()       { return state.U * current(); }              // P = U·I (W)
function eField()      { return state.U / L_WIRE; }                 // E = U/L (V/m)
function carrierN()    { return N0 * state.dens; }                  // densité porteurs
function driftReal()   {                                            // v_d réelle (m/s)
  return current() / (carrierN() * E_CH * AREA);
}
function thermalReal() {                                            // v_th réelle (m/s)
  return Math.sqrt(3 * K_B * state.temp / M_E);
}
function electronFlux(){ return current() / E_CH; }                 // e⁻/s à la section

/* vitesses d'animation (px/frame) */
function driftPx()   { return DRIFT_K * (current() / state.dens) * state.speed; }
function thermalPx() {
  return state.showThermal ? THERMAL_K * Math.sqrt(state.temp) * state.speed : 0;
}
/* probabilité de collision par frame (croît avec R et T) — surtout cosmétique */
function collisionProb() {
  return clamp(0.02 + 0.004 * state.R + 0.00004 * state.temp, 0, 0.5);
}

/* ========================================================================= */
/*  Utilitaires                                                              */
/* ========================================================================= */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);

function fmt(v, d = 2) {
  if (!isFinite(v)) return "∞";
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e4)) return v.toExponential(2);
  return v.toFixed(d);
}
function sci(v) {                       // notation 1.25×10¹⁹
  if (v === 0) return "0";
  const e = Math.floor(Math.log10(Math.abs(v)));
  const m = v / Math.pow(10, e);
  const sup = String(e).replace(/-/g, "⁻").replace(/[0-9]/g,
    (d) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[d]);
  return `${m.toFixed(2)}×10${sup}`;
}

function drawArrow(c, x0, y0, x1, y1, head) {
  c.beginPath();
  c.moveTo(x0, y0);
  c.lineTo(x1, y1);
  c.stroke();
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const hs = head || (5 + c.lineWidth * 1.4);
  c.beginPath();
  c.moveTo(x1, y1);
  c.lineTo(x1 - hs * Math.cos(ang - 0.42), y1 - hs * Math.sin(ang - 0.42));
  c.lineTo(x1 - hs * Math.cos(ang + 0.42), y1 - hs * Math.sin(ang + 0.42));
  c.closePath();
  c.fill();
}

/* ========================================================================= */
/*  Population                                                               */
/* ========================================================================= */
function makeElectron() {
  return {
    x: rand(BAND.x0, BAND.x1),
    y: rand(BAND.y0, BAND.y1),
    tvx: 0, tvy: 0,        // composante thermique persistante
    flash: 0,              // éclat de collision
  };
}
function syncElectrons() {
  const n = Math.round(BASE_N * state.dens);
  if (electrons.length < n) {
    while (electrons.length < n) electrons.push(makeElectron());
  } else {
    electrons.length = n;
  }
}
function buildIons() {
  ions = [];
  const dx = 46, dy = 46;
  for (let x = BAND.x0 + 24; x <= BAND.x1 - 10; x += dx) {
    for (let y = BAND.y0 + 24; y <= BAND.y1 - 10; y += dy) {
      ions.push({ x, y });
    }
  }
}

/* ========================================================================= */
/*  Mise à jour                                                              */
/* ========================================================================= */
function step(dt) {
  const drift = driftPx();        // dérive vers la droite (vers la borne +)
  const th = thermalPx();
  const pColl = collisionProb();

  for (const e of electrons) {
    // collision : ré-randomise la composante thermique
    if (Math.random() < pColl || (e.tvx === 0 && e.tvy === 0)) {
      const a = rand(0, Math.PI * 2);
      e.tvx = Math.cos(a) * th;
      e.tvy = Math.sin(a) * th;
      e.flash = 1;
    }
    if (th === 0) { e.tvx = 0; e.tvy = 0; }

    const prevX = e.x;
    e.x += e.tvx + drift;          // dérive = +x (vers la droite, vers la borne +)
    e.y += e.tvy;
    e.flash *= 0.88;

    // confinement vertical (rebond)
    if (e.y < BAND.y0) { e.y = BAND.y0; e.tvy = Math.abs(e.tvy); }
    if (e.y > BAND.y1) { e.y = BAND.y1; e.tvy = -Math.abs(e.tvy); }

    // comptage à la section (passage vers la droite)
    if (prevX < MIDX && e.x >= MIDX) crossAccum++;

    // recirculation : sorti par la borne + (droite) → réinjecté par la borne − (gauche)
    if (e.x > BAND.x1) { e.x = BAND.x0; e.y = rand(BAND.y0, BAND.y1); }
    if (e.x < BAND.x0) { e.x = BAND.x1; }
  }

  // taux de passage moyenné sur ~0.5 s
  timeAccum += dt;
  if (timeAccum >= 0.5) {
    crossRate = crossAccum / timeAccum;
    crossAccum = 0;
    timeAccum = 0;
  }
}

/* ========================================================================= */
/*  Rendu                                                                    */
/* ========================================================================= */
function draw() {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#060912";
  ctx.fillRect(0, 0, W, H);

  drawConductor();
  drawTerminals();
  if (state.showIons) drawIons();
  if (state.showField) drawField();
  drawElectrons();
  drawSection();
  if (state.showCurrent) drawConventional();
  if (state.showDrift) drawDrift();
}

function drawConductor() {
  const { x0, x1, y0, y1 } = BAND;
  if (state.showPotential) {
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, "rgba(88,166,255,0.32)");    // potentiel bas (−)
    g.addColorStop(0.5, "rgba(40,52,73,0.30)");
    g.addColorStop(1, "rgba(255,77,77,0.32)");     // potentiel haut (+)
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = "rgba(40,52,73,0.35)";
  }
  roundRect(x0, y0, x1 - x0, y1 - y0, 10);
  ctx.fill();
  ctx.strokeStyle = "rgba(159,176,200,0.4)";
  ctx.lineWidth = 1.5;
  roundRect(x0, y0, x1 - x0, y1 - y0, 10);
  ctx.stroke();
}

function drawTerminals() {
  const { x0, x1, y0, y1 } = BAND;
  // borne − (gauche, bleue)
  ctx.fillStyle = "#58a6ff";
  roundRect(x0 - 26, y0, 16, y1 - y0, 5); ctx.fill();
  // borne + (droite, rouge)
  ctx.fillStyle = "#ff4d4d";
  roundRect(x1 + 10, y0, 16, y1 - y0, 5); ctx.fill();

  ctx.fillStyle = "#e8edf5";
  ctx.font = "bold 22px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText("−", x0 - 18, y0 - 16);
  ctx.fillText("+", x1 + 18, y0 - 16);

  ctx.font = "13px Consolas, monospace";
  ctx.fillStyle = "#9fb0c8";
  ctx.textAlign = "left";
  ctx.fillText("0 V", x0 - 26, y1 + 24);
  ctx.textAlign = "right";
  ctx.fillText(`U = ${state.U.toFixed(1)} V`, x1 + 26, y1 + 24);
  ctx.textAlign = "left";
}

function drawIons() {
  ctx.lineWidth = 1.4;
  for (const ion of ions) {
    ctx.beginPath();
    ctx.arc(ion.x, ion.y, 6.5, 0, 7);
    ctx.fillStyle = "rgba(255,157,87,0.22)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,157,87,0.7)";
    ctx.stroke();
    // signe +
    ctx.strokeStyle = "rgba(255,200,160,0.9)";
    ctx.beginPath();
    ctx.moveTo(ion.x - 3, ion.y); ctx.lineTo(ion.x + 3, ion.y);
    ctx.moveTo(ion.x, ion.y - 3); ctx.lineTo(ion.x, ion.y + 3);
    ctx.stroke();
  }
}

function drawField() {
  const { x0, x1, y0, y1 } = BAND;
  ctx.strokeStyle = "rgba(93,208,255,0.45)";
  ctx.fillStyle = "rgba(93,208,255,0.45)";
  ctx.lineWidth = 1.6;
  const rows = 3;
  const len = 34;
  for (let r = 0; r < rows; r++) {
    const y = y0 + ((r + 0.5) / rows) * (y1 - y0);
    for (let x = x0 + 60; x < x1 - 20; x += 120) {
      drawArrow(ctx, x + len, y, x, y, 7);      // E pointe vers la gauche (+ → −)
    }
  }
  ctx.fillStyle = "#5dd0ff";
  ctx.font = "italic 14px Consolas, monospace";
  ctx.fillText("E", x1 - 30, y0 + (y1 - y0) / 2 - 8);
}

function drawElectrons() {
  for (const e of electrons) {
    const glow = 0.5 + 0.5 * e.flash;
    ctx.beginPath();
    ctx.arc(e.x, e.y, 3.1, 0, 7);
    ctx.fillStyle = e.flash > 0.15
      ? `rgba(220,245,255,${glow})`
      : "rgba(120,200,255,0.95)";
    ctx.fill();
    // petit signe −
    ctx.strokeStyle = "rgba(10,20,35,0.8)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(e.x - 1.6, e.y); ctx.lineTo(e.x + 1.6, e.y);
    ctx.stroke();
  }
}

function drawSection() {
  const { y0, y1 } = BAND;
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(MIDX, y0 - 6); ctx.lineTo(MIDX, y1 + 6);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#9fb0c8";
  ctx.font = "11px Consolas, monospace";
  ctx.textAlign = "center";
  ctx.fillText("section", MIDX, y1 + 20);
  ctx.textAlign = "left";
}

function drawConventional() {
  const { x0, x1, y0 } = BAND;
  const y = y0 - 44;
  ctx.strokeStyle = "#ff9d57";
  ctx.fillStyle = "#ff9d57";
  ctx.lineWidth = 3;
  drawArrow(ctx, x1 - 20, y, x0 + 20, y, 12);   // I : + → − (droite → gauche)
  ctx.font = "13px Consolas, monospace";
  ctx.fillText(`I = ${fmt(current())} A  (sens conventionnel)`, x0 + 24, y - 10);
}

function drawDrift() {
  const { x0, x1, y1 } = BAND;
  const y = y1 + 44;
  ctx.strokeStyle = "#7CFFB2";
  ctx.fillStyle = "#7CFFB2";
  ctx.lineWidth = 2.4;
  drawArrow(ctx, x0 + 20, y, x1 - 20, y, 11);   // dérive e⁻ : gauche → droite
  ctx.font = "13px Consolas, monospace";
  ctx.textAlign = "left";
  ctx.fillText(`dérive des e⁻  (v_d ≈ ${fmt(driftReal() * 1e3)} mm/s)`, x0 + 24, y + 18);
  ctx.textAlign = "left";
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ========================================================================= */
/*  Mesures (panneau)                                                        */
/* ========================================================================= */
function updateMeasures() {
  els.mI.textContent   = fmt(current()) + " A";
  els.mU.textContent   = state.U.toFixed(1) + " V";
  els.mE.textContent   = fmt(eField()) + " V/m";
  els.mR.textContent   = state.R.toFixed(1) + " Ω";
  els.mP.textContent   = fmt(power()) + " W";
  els.mVd.textContent  = fmt(driftReal() * 1e3) + " mm/s";
  els.mVth.textContent = fmt(thermalReal() / 1e3, 0) + " km/s";
  els.mFlux.textContent = sci(electronFlux()) + " e⁻/s";
}

/* ========================================================================= */
/*  Boucle                                                                   */
/* ========================================================================= */
function loop(t) {
  if (!running) return;
  let dt = (t - lastT) / 1000;
  lastT = t;
  if (!isFinite(dt) || dt <= 0) dt = 0.016;
  dt = Math.min(dt, 0.05);

  step(dt);
  draw();
  updateMeasures();
  rafId = requestAnimationFrame(loop);
}

/* ========================================================================= */
/*  Gabarit HTML                                                             */
/* ========================================================================= */
const TEMPLATE = `
<div class="sim-layout">
  <section class="stage">
    <canvas id="ec-canvas" width="${W}" height="${H}" aria-label="Courant électrique"></canvas>
  </section>

  <aside class="panel">
    <div class="group">
      <h2>Mesures</h2>
      <div class="measures">
        <div class="m-row"><span>Intensité I</span><b id="m-I">—</b></div>
        <div class="m-row"><span>Tension U</span><b id="m-U">—</b></div>
        <div class="m-row"><span>Champ E = U/L</span><b id="m-E">—</b></div>
        <div class="m-row"><span>Résistance R</span><b id="m-R">—</b></div>
        <div class="m-row"><span>Puissance P</span><b id="m-P">—</b></div>
        <div class="m-row"><span>Vitesse de dérive</span><b id="m-vd">—</b></div>
        <div class="m-row"><span>Vitesse thermique</span><b id="m-vth">—</b></div>
        <div class="m-row"><span>Débit (section)</span><b id="m-flux">—</b></div>
      </div>
      <div class="formula">I = U / R&#10;I = n·e·A·v_d</div>
    </div>

    <div class="group">
      <h2>Source &amp; circuit</h2>
      <label class="slider">
        <span>Tension U <em id="U-val">6.0 V</em></span>
        <input type="range" id="U" min="0" max="12" step="0.5" value="6" />
      </label>
      <label class="slider">
        <span>Résistance R <em id="R-val">3.0 Ω</em></span>
        <input type="range" id="R" min="0.5" max="20" step="0.5" value="3" />
      </label>
    </div>

    <div class="group">
      <h2>Matériau &amp; porteurs</h2>
      <label class="slider">
        <span>Densité de porteurs <em id="dens-val">1.0×</em></span>
        <input type="range" id="dens" min="0.3" max="2" step="0.1" value="1" />
      </label>
      <label class="slider">
        <span>Température <em id="temp-val">300 K</em></span>
        <input type="range" id="temp" min="100" max="600" step="10" value="300" />
      </label>
    </div>

    <div class="group">
      <h2>Animation</h2>
      <label class="slider">
        <span>Vitesse <em id="speed-val">1.0</em></span>
        <input type="range" id="speed" min="0.2" max="3" step="0.1" value="1" />
      </label>
    </div>

    <div class="group">
      <h2>Affichage</h2>
      <label class="check"><input type="checkbox" id="show-field" checked /> Champ électrique E</label>
      <label class="check"><input type="checkbox" id="show-current" checked /> Sens conventionnel I</label>
      <label class="check"><input type="checkbox" id="show-drift" checked /> Dérive moyenne des e⁻</label>
      <label class="check"><input type="checkbox" id="show-thermal" checked /> Agitation thermique</label>
      <label class="check"><input type="checkbox" id="show-ions" checked /> Ions du réseau</label>
      <label class="check"><input type="checkbox" id="show-potential" checked /> Potentiel coloré</label>
    </div>

    <div class="group">
      <button id="ec-reset" class="reset">Réinitialiser</button>
    </div>
  </aside>
</div>`;

/* ========================================================================= */
/*  Cycle de vie                                                             */
/* ========================================================================= */
function mount(root: HTMLElement) {
  root.innerHTML = TEMPLATE;

  state = { ...DEFAULTS };
  electrons = [];
  crossAccum = timeAccum = crossRate = 0;
  lastT = 0;

  canvas = root.querySelector("#ec-canvas");
  ctx = canvas.getContext("2d");

  const $ = (id) => root.querySelector("#" + id);
  els = {
    mI: $("m-I"), mU: $("m-U"), mE: $("m-E"), mR: $("m-R"), mP: $("m-P"),
    mVd: $("m-vd"), mVth: $("m-vth"), mFlux: $("m-flux"),
    U: $("U"), UVal: $("U-val"),
    R: $("R"), RVal: $("R-val"),
    dens: $("dens"), densVal: $("dens-val"),
    temp: $("temp"), tempVal: $("temp-val"),
    speed: $("speed"), speedVal: $("speed-val"),
    showField: $("show-field"), showCurrent: $("show-current"),
    showDrift: $("show-drift"), showThermal: $("show-thermal"),
    showIons: $("show-ions"), showPotential: $("show-potential"),
    reset: $("ec-reset"),
  };

  bindSlider(els.U, els.UVal, "U", (v) => v.toFixed(1) + " V");
  bindSlider(els.R, els.RVal, "R", (v) => v.toFixed(1) + " Ω");
  bindSlider(els.dens, els.densVal, "dens", (v) => v.toFixed(1) + "×", syncElectrons);
  bindSlider(els.temp, els.tempVal, "temp", (v) => Math.round(v) + " K", null, true);
  bindSlider(els.speed, els.speedVal, "speed", (v) => v.toFixed(1));

  bindCheck(els.showField, "showField");
  bindCheck(els.showCurrent, "showCurrent");
  bindCheck(els.showDrift, "showDrift");
  bindCheck(els.showThermal, "showThermal");
  bindCheck(els.showIons, "showIons");
  bindCheck(els.showPotential, "showPotential");

  els.reset.addEventListener("click", () => {
    state = { ...DEFAULTS };
    applyStateToUI();
    syncElectrons();
  });

  buildIons();
  syncElectrons();
  applyStateToUI();

  running = true;
  rafId = requestAnimationFrame(loop);

  return { unmount };
}

function bindSlider(el, valEl, key, label, after, isInt) {
  el.addEventListener("input", () => {
    state[key] = isInt ? parseInt(el.value, 10) : parseFloat(el.value);
    valEl.textContent = label(state[key]);
    if (after) after();
  });
}
function bindCheck(el, key) {
  el.addEventListener("change", () => { state[key] = el.checked; });
}
function applyStateToUI() {
  els.U.value = state.U;       els.UVal.textContent = state.U.toFixed(1) + " V";
  els.R.value = state.R;       els.RVal.textContent = state.R.toFixed(1) + " Ω";
  els.dens.value = state.dens; els.densVal.textContent = state.dens.toFixed(1) + "×";
  els.temp.value = state.temp; els.tempVal.textContent = Math.round(state.temp) + " K";
  els.speed.value = state.speed; els.speedVal.textContent = state.speed.toFixed(1);
  els.showField.checked = state.showField;
  els.showCurrent.checked = state.showCurrent;
  els.showDrift.checked = state.showDrift;
  els.showThermal.checked = state.showThermal;
  els.showIons.checked = state.showIons;
  els.showPotential.checked = state.showPotential;
}

function unmount() {
  running = false;
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  canvas = ctx = els = readout = null;
}

/* ========================================================================= */
/*  Enregistrement                                                           */
/* ========================================================================= */
register({
  id: "electric-current",
  title: "Courant électrique",
  subtitle: "Modèle microscopique : électrons, dérive, intensité, résistance et tension.",
  help: "Les <b>électrons</b> (bleus, −) dérivent vers la borne + tandis que le " +
        "<b>courant conventionnel</b> I va de + vers −. Augmente <b>U</b> pour " +
        "renforcer le champ et la dérive ; augmente <b>R</b> ou la température " +
        "pour multiplier les collisions sur les <b>ions</b> du réseau et réduire I " +
        "(loi d'Ohm I = U/R). Noter le contraste : la vitesse de dérive est de " +
        "l'ordre du mm/s, l'agitation thermique de l'ordre de 100 km/s.",
  mount,
});

