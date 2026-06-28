import { register } from "../registry";

/* =========================================================================
   Module : Composants RLC — résistance, condensateur, bobine, circuit RLC
   Schéma animé (circulation des charges), champ E (condensateur), champ B
   (bobine), oscilloscope, équations et mesures en direct.
   Simulation temporelle : l'ODE du circuit est intégrée à chaque image, donc
   déphasages, constantes de temps et résonance émergent du calcul.
   ========================================================================= */

const W = 760, H = 560;

/* géométrie de la boucle (schéma) */
const LOOP = { x0: 90, x1: 680, y0: 70, y1: 300 };
const OSC = { x0: 40, x1: 720, y0: 360, y1: 540 };   // oscilloscope

/* ========================================================================= */
/*  État                                                                     */
/* ========================================================================= */
const DEFAULTS = {
  mode: "R", source: "sin",
  U0: 6, f: 0.6, R: 4, L: 1, C: 0.3, speed: 1,
};
let state = { ...DEFAULTS };

let canvas = null, ctx = null, els = null;
let rafId = null, running = false, lastT = 0, time = 0;

/* état du circuit */
let q = 0, iCur = 0;       // charge sur C, courant
let flowOffset = 0;        // position du flux de charges le long de la boucle
let iMaxSeen = 1;          // pour l'échelle de l'oscilloscope

/* historique oscilloscope (anneaux) */
const HISTN = 480;
let hist = { u: [], i: [], uc: [], ul: [] };

/* ========================================================================= */
/*  Source & simulation                                                      */
/* ========================================================================= */
function omega() { return 2 * Math.PI * state.f; }
function sourceU(t) {
  const ph = omega() * t;
  return state.source === "sin" ? state.U0 * Math.sin(ph)
                                : state.U0 * (Math.sin(ph) >= 0 ? 1 : -1);
}
function stepSim(dtSim) {
  const u = sourceU(time);
  const R = state.R, L = state.L, Cv = state.C;
  const N = 24, h = dtSim / N;
  for (let k = 0; k < N; k++) {
    if (state.mode === "R") {
      iCur = u / R; q = 0;
    } else if (state.mode === "C") {
      // R série + C : dq/dt = (u − q/C)/R
      iCur = (u - q / Cv) / R;
      q += iCur * h;
    } else if (state.mode === "L") {
      // R série + L : di/dt = (u − R·i)/L
      iCur += ((u - R * iCur) / L) * h;
      q = 0;
    } else { // RLC série, Euler semi-implicite (stable pour l'oscillateur)
      iCur += ((u - R * iCur - q / Cv) / L) * h;
      q += iCur * h;
    }
  }
  // flux de charges visuel (sens = signe du courant)
  flowOffset += clamp(iCur * 26 * dtSim * state.speed, -120, 120);
}

/* tensions instantanées */
function uC() { return q / state.C; }
function uL() { return sourceU(time) - state.R * iCur; }  // u_L = u − R·i (mode L)
function compU() {
  if (state.mode === "C") return uC();
  if (state.mode === "L") return uL();
  if (state.mode === "R") return state.R * iCur;
  return uC();
}
function powerR() { return state.R * iCur * iCur; }
function energyC() { return 0.5 * state.C * uC() * uC(); }
function energyL() { return 0.5 * state.L * iCur * iCur; }
function omega0() { return 1 / Math.sqrt(state.L * state.C); }
function qFactor() { return (1 / state.R) * Math.sqrt(state.L / state.C); }

/* ========================================================================= */
/*  Utilitaires de dessin                                                    */
/* ========================================================================= */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function fmt(v, d = 2) {
  if (!isFinite(v)) return "∞";
  const a = Math.abs(v);
  if (a !== 0 && (a < 0.01 || a >= 1000)) return v.toExponential(2);
  return v.toFixed(d);
}
function arrow(c, x0, y0, x1, y1, head) {
  c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
  const ang = Math.atan2(y1 - y0, x1 - x0), hs = head || 6;
  c.beginPath(); c.moveTo(x1, y1);
  c.lineTo(x1 - hs * Math.cos(ang - 0.4), y1 - hs * Math.sin(ang - 0.4));
  c.lineTo(x1 - hs * Math.cos(ang + 0.4), y1 - hs * Math.sin(ang + 0.4));
  c.closePath(); c.fill();
}

/* ----- chemin de la boucle (rectangle) pour le flux de charges ----- */
function loopPath() {
  const { x0, x1, y0, y1 } = LOOP;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
}
function pathLengths(P) {
  const seg = [], acc = [0];
  let tot = 0;
  for (let i = 0; i < P.length - 1; i++) {
    const d = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]);
    seg.push(d); tot += d; acc.push(tot);
  }
  return { seg, acc, tot };
}
function ptAt(P, L, s) {
  s = ((s % L.tot) + L.tot) % L.tot;
  for (let i = 0; i < L.seg.length; i++) {
    if (s <= L.acc[i + 1]) {
      const t = (s - L.acc[i]) / (L.seg[i] || 1);
      return [P[i][0] + (P[i + 1][0] - P[i][0]) * t,
              P[i][1] + (P[i + 1][1] - P[i][1]) * t];
    }
  }
  return P[0];
}

/* ========================================================================= */
/*  Schéma                                                                   */
/* ========================================================================= */
/* positions des composants sur l'arête haute selon le mode */
function layout() {
  const { x0, x1, y0 } = LOOP;
  if (state.mode === "R") return { R: 0.5 };
  if (state.mode === "C") return { R: 0.34, C: 0.66 };
  if (state.mode === "L") return { R: 0.34, L: 0.66 };
  return { R: 0.27, L: 0.5, C: 0.73 };          // RLC
}
function topX(frac) { return LOOP.x0 + (LOOP.x1 - LOOP.x0) * frac; }

function drawWires() {
  const { x0, x1, y0, y1 } = LOOP;
  ctx.strokeStyle = "rgba(159,176,200,0.8)"; ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(x0, y0); ctx.lineTo(x1, y0);
  ctx.lineTo(x1, y1); ctx.lineTo(x0, y1); ctx.lineTo(x0, y0);
  ctx.stroke();
}
function drawSource() {
  const { x0, y0, y1 } = LOOP;
  const cy = (y0 + y1) / 2;
  // coupure du fil pour insérer la source
  ctx.fillStyle = "#060912"; ctx.fillRect(x0 - 3, cy - 24, 6, 48);
  ctx.strokeStyle = "#e8edf5"; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(x0, cy, 22, 0, 7); ctx.stroke();
  // symbole : sinus ou créneau
  ctx.strokeStyle = "#9fb0c8"; ctx.lineWidth = 2; ctx.beginPath();
  if (state.source === "sin") {
    for (let a = -12; a <= 12; a++) {
      const yy = cy - Math.sin((a / 12) * Math.PI * 2) * 7;
      a === -12 ? ctx.moveTo(x0 + a, yy) : ctx.lineTo(x0 + a, yy);
    }
  } else {
    ctx.moveTo(x0 - 12, cy + 7); ctx.lineTo(x0 - 4, cy + 7);
    ctx.lineTo(x0 - 4, cy - 7); ctx.lineTo(x0 + 4, cy - 7);
    ctx.lineTo(x0 + 4, cy + 7); ctx.lineTo(x0 + 12, cy + 7);
  }
  ctx.stroke();
  ctx.fillStyle = "#9fb0c8"; ctx.font = "12px Consolas, monospace";
  ctx.fillText("u(t) = " + fmt(sourceU(time)) + " V", x0 - 26, y1 + 22);
}

function drawResistor(frac) {
  const x = topX(frac), y = LOOP.y0, w = 56;
  ctx.fillStyle = "#060912"; ctx.fillRect(x - w / 2, y - 12, w, 24);
  // lueur de dissipation (Joule) ∝ P
  const pn = clamp(powerR() / (state.U0 * state.U0 / state.R + 1e-6), 0, 1);
  if (pn > 0.02) {
    ctx.fillStyle = `rgba(255,90,60,${0.15 + 0.55 * pn})`;
    ctx.beginPath(); ctx.arc(x, y, 16 + 10 * pn, 0, 7); ctx.fill();
  }
  ctx.strokeStyle = "#ff9d57"; ctx.lineWidth = 2.4; ctx.beginPath();
  ctx.moveTo(x - w / 2, y);
  const n = 6;
  for (let k = 0; k <= n; k++) {
    const xx = x - w / 2 + (w * k) / n;
    const yy = y + (k === 0 || k === n ? 0 : (k % 2 ? -9 : 9));
    ctx.lineTo(xx, yy);
  }
  ctx.lineTo(x + w / 2, y); ctx.stroke();
  ctx.fillStyle = "#ff9d57"; ctx.font = "13px Consolas, monospace";
  ctx.fillText("R", x - 4, y - 18);
}
function drawCapacitor(frac) {
  const x = topX(frac), y = LOOP.y0, gap = 12;
  ctx.fillStyle = "#060912"; ctx.fillRect(x - 22, y - 30, 44, 60);
  // fils jusqu'aux armatures
  ctx.strokeStyle = "rgba(159,176,200,0.8)"; ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(x - 22, y); ctx.lineTo(x - gap, y);
  ctx.moveTo(x + gap, y); ctx.lineTo(x + 22, y); ctx.stroke();
  // armatures + champ E + charges
  const uc = uC(), un = clamp(uc / state.U0, -1.4, 1.4);
  ctx.strokeStyle = "#5dd0ff"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(x - gap, y - 22); ctx.lineTo(x - gap, y + 22);
  ctx.moveTo(x + gap, y - 22); ctx.lineTo(x + gap, y + 22); ctx.stroke();
  // champ E entre armatures (∝ u_C), de + vers −
  const leftPos = un >= 0;
  const na = 4;
  ctx.strokeStyle = `rgba(93,208,255,${0.25 + 0.6 * Math.min(Math.abs(un), 1)})`;
  ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = 1.5;
  for (let kk = 0; kk < na; kk++) {
    const yy = y - 16 + (kk / (na - 1)) * 32;
    if (Math.abs(un) > 0.03) {
      if (leftPos) arrow(ctx, x - gap + 2, yy, x + gap - 2, yy, 5);
      else arrow(ctx, x + gap - 2, yy, x - gap + 2, yy, 5);
    }
  }
  // charges sur les armatures (+ / −)
  drawPlateCharges(x - gap - 4, y, un >= 0 ? +1 : -1, Math.abs(un));
  drawPlateCharges(x + gap + 4, y, un >= 0 ? -1 : +1, Math.abs(un));
  ctx.fillStyle = "#5dd0ff"; ctx.font = "13px Consolas, monospace";
  ctx.fillText("C", x - 4, y - 30);
}
function drawPlateCharges(px, y, sign, mag) {
  const n = Math.round(clamp(mag, 0, 1) * 4);
  ctx.fillStyle = sign > 0 ? "#ff6a6a" : "#6ab8ff";
  ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1.2;
  for (let k = 0; k < n; k++) {
    const yy = y - 15 + (k / Math.max(n - 1, 1)) * 30;
    ctx.beginPath(); ctx.arc(px, yy, 3, 0, 7); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(px - 2, yy); ctx.lineTo(px + 2, yy);
    if (sign > 0) { ctx.moveTo(px, yy - 2); ctx.lineTo(px, yy + 2); }
    ctx.stroke();
  }
}
function drawInductor(frac) {
  const x = topX(frac), y = LOOP.y0, w = 64, loops = 4;
  ctx.fillStyle = "#060912"; ctx.fillRect(x - w / 2 - 2, y - 26, w + 4, 40);
  ctx.strokeStyle = "#7CFFB2"; ctx.lineWidth = 2.4; ctx.beginPath();
  ctx.moveTo(x - w / 2, y);
  for (let k = 0; k < loops; k++) {
    const xx = x - w / 2 + (w * (k + 0.5)) / loops;
    ctx.arc(xx, y - 6, w / (2 * loops), Math.PI, 0, false);
  }
  ctx.lineTo(x + w / 2, y); ctx.stroke();
  // champ B dans la bobine (∝ i), • / × selon le signe
  const inMag = clamp(Math.abs(iCur) / (iMaxSeen + 1e-6), 0, 1);
  const into = iCur < 0;
  ctx.strokeStyle = into ? "#58a6ff" : "#ff8a5d";
  ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = 1.6;
  const sz = 2 + inMag * 4;
  for (let k = 0; k < loops; k++) {
    const xx = x - w / 2 + (w * (k + 0.5)) / loops, yy = y - 6;
    if (inMag < 0.04) continue;
    if (into) {
      ctx.beginPath();
      ctx.moveTo(xx - sz, yy - sz); ctx.lineTo(xx + sz, yy + sz);
      ctx.moveTo(xx + sz, yy - sz); ctx.lineTo(xx - sz, yy + sz); ctx.stroke();
    } else { ctx.beginPath(); ctx.arc(xx, yy, sz * 0.6, 0, 7); ctx.fill(); }
  }
  ctx.fillStyle = "#7CFFB2"; ctx.font = "13px Consolas, monospace";
  ctx.fillText("L", x - 4, y - 26);
}

function drawCharges() {
  const P = loopPath(), L = pathLengths(P);
  const n = 46;
  for (let j = 0; j < n; j++) {
    const s = (j / n) * L.tot + flowOffset;
    const [px, py] = ptAt(P, L, s);
    ctx.beginPath(); ctx.arc(px, py, 2.6, 0, 7);
    ctx.fillStyle = "rgba(120,200,255,0.9)"; ctx.fill();
  }
}

/* ========================================================================= */
/*  Oscilloscope                                                             */
/* ========================================================================= */
function pushHistory() {
  hist.u.push(sourceU(time));
  hist.i.push(iCur);
  hist.uc.push(uC());
  hist.ul.push(uL());
  for (const key of ["u", "i", "uc", "ul"]) if (hist[key].length > HISTN) hist[key].shift();
  iMaxSeen = Math.max(iMaxSeen * 0.995, Math.abs(iCur), 0.05);
}
function drawOsc() {
  const { x0, x1, y0, y1 } = OSC;
  const cy = (y0 + y1) / 2;
  ctx.strokeStyle = "rgba(159,176,200,0.25)"; ctx.lineWidth = 1;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.beginPath(); ctx.moveTo(x0, cy); ctx.lineTo(x1, cy); ctx.stroke();

  const vMax = Math.max(state.U0, maxAbs(hist.uc), maxAbs(hist.ul), 1e-6);
  const iMax = Math.max(maxAbs(hist.i), 1e-6);
  const amp = (y1 - y0) * 0.42;

  const channels = [];
  channels.push({ data: hist.u, scale: vMax, color: "#e8edf5", name: "u(t)" });
  if (state.mode === "C" || state.mode === "RLC")
    channels.push({ data: hist.uc, scale: vMax, color: "#ff9d57", name: "u_C" });
  if (state.mode === "L")
    channels.push({ data: hist.ul, scale: vMax, color: "#7CFFB2", name: "u_L" });
  channels.push({ data: hist.i, scale: iMax, color: "#5dd0ff", name: "i" });

  const N = hist.u.length;
  for (const ch of channels) {
    ctx.strokeStyle = ch.color; ctx.lineWidth = 1.8; ctx.beginPath();
    for (let k = 0; k < N; k++) {
      const x = x0 + (k / HISTN) * (x1 - x0);
      const y = cy - (ch.data[k] / ch.scale) * amp;
      k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
  // légende
  ctx.font = "12px Consolas, monospace"; let lx = x0 + 8;
  for (const ch of channels) {
    ctx.fillStyle = ch.color; ctx.fillText(ch.name, lx, y0 + 14);
    lx += ctx.measureText(ch.name).width + 16;
  }
  ctx.fillStyle = "#9fb0c8"; ctx.fillText("oscilloscope (amplitudes normalisées)", x0 + 8, y1 - 8);
}
function maxAbs(a) { let m = 0; for (const v of a) if (Math.abs(v) > m) m = Math.abs(v); return m; }

/* ========================================================================= */
/*  Mesures                                                                  */
/* ========================================================================= */
function updateMeasures() {
  els.mI.textContent = fmt(iCur) + " A";
  els.mU.textContent = fmt(compU()) + " V";
  if (state.mode === "C" || state.mode === "RLC") {
    els.mQ.textContent = fmt(q) + " C";
    els.mE.textContent = fmt(energyC()) + " J  (½C·u²)";
  } else if (state.mode === "L") {
    els.mQ.textContent = "—";
    els.mE.textContent = fmt(energyL()) + " J  (½L·i²)";
  } else {
    els.mQ.textContent = "—";
    els.mE.textContent = "—";
  }
  els.mP.textContent = fmt(powerR()) + " W";
  if (state.mode === "RLC") {
    els.mK.textContent = `ω₀=${fmt(omega0())}  Q=${fmt(qFactor())}`;
  } else if (state.mode === "C") {
    els.mK.textContent = `τ = R·C = ${fmt(state.R * state.C)} s`;
  } else if (state.mode === "L") {
    els.mK.textContent = `τ = L/R = ${fmt(state.L / state.R)} s`;
  } else {
    els.mK.textContent = `P = u²/R`;
  }
}

/* ========================================================================= */
/*  Boucle                                                                   */
/* ========================================================================= */
function loop(t) {
  if (!running) return;
  let dt = (t - lastT) / 1000; lastT = t;
  if (!isFinite(dt) || dt <= 0) dt = 0.016;
  dt = Math.min(dt, 0.05);
  const dtSim = dt * state.speed;
  time += dtSim;
  stepSim(dtSim);
  pushHistory();

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#060912"; ctx.fillRect(0, 0, W, H);

  drawWires();
  drawCharges();
  drawSource();
  const lay = layout();
  if (lay.R != null) drawResistor(lay.R);
  if (lay.L != null) drawInductor(lay.L);
  if (lay.C != null) drawCapacitor(lay.C);
  drawOsc();
  updateMeasures();

  rafId = requestAnimationFrame(loop);
}

/* ========================================================================= */
/*  Textes                                                                   */
/* ========================================================================= */
const MODES = [
  { id: "R", label: "Résistance R",
    formula: "u = R·i        P = R·i² = u²/R",
    desc: "La résistance s'oppose au passage du courant : la tension est proportionnelle au courant (loi d'Ohm), en phase. L'énergie électrique y est dissipée en chaleur (effet Joule, lueur rouge). Le champ E interne est uniforme et proportionnel à i." },
  { id: "C", label: "Condensateur C",
    formula: "q = C·u_C     i = C·du_C/dt     E_C = ½C·u_C²     τ = R·C",
    desc: "Le condensateur stocke des charges sur ses armatures (champ E entre elles ∝ u_C). Il s'oppose aux variations de tension : en sinusoïdal, le courant est en avance de 90° sur u_C. Constante de charge τ = R·C." },
  { id: "L", label: "Bobine L",
    formula: "u_L = L·di/dt     E_L = ½L·i²     τ = L/R",
    desc: "La bobine stocke de l'énergie dans son champ magnétique B (∝ i, symboles ⊙/⊗). Elle s'oppose aux variations de courant : en sinusoïdal, le courant est en retard de 90° sur u_L. Constante d'établissement τ = L/R." },
  { id: "RLC", label: "Circuit RLC",
    formula: "L·d²q/dt² + R·dq/dt + q/C = u(t)\nω₀ = 1/√(LC)     Q = (1/R)·√(L/C)",
    desc: "Les trois en série : l'énergie oscille entre le condensateur (champ E) et la bobine (champ B), R amortit. En sinusoïdal, l'amplitude du courant est maximale à la résonance f₀ = ω₀/2π. Essaie un créneau pour voir les oscillations amorties." },
];
function modeCfg() { return MODES.find((m) => m.id === state.mode); }

/* ========================================================================= */
/*  Gabarit                                                                  */
/* ========================================================================= */
const TEMPLATE = `
<div class="sim-layout">
  <section class="stage">
    <canvas id="rlc-canvas" width="${W}" height="${H}" aria-label="Composants RLC"></canvas>
  </section>

  <aside class="panel">
    <div class="group">
      <h2>Composant</h2>
      <div class="seg" id="rlc-seg" role="tablist">
        ${MODES.map((m) => `<button class="seg-btn" data-mode="${m.id}">${m.label}</button>`).join("")}
      </div>
      <div class="formula" id="rlc-formula"></div>
      <p class="hint" id="rlc-desc"></p>
    </div>

    <div class="group">
      <h2>Source</h2>
      <select id="rlc-source">
        <option value="sin">Sinusoïdale</option>
        <option value="square">Créneau</option>
      </select>
      <label class="slider">
        <span>Amplitude U₀ <em id="U0-val">6.0 V</em></span>
        <input type="range" id="U0" min="1" max="10" step="0.5" value="6" />
      </label>
      <label class="slider">
        <span>Fréquence f <em id="f-val">0.60 Hz</em></span>
        <input type="range" id="f" min="0.1" max="3" step="0.1" value="0.6" />
      </label>
    </div>

    <div class="group">
      <h2>Composants</h2>
      <label class="slider">
        <span>Résistance R <em id="R-val">4.0 Ω</em></span>
        <input type="range" id="R" min="0.5" max="20" step="0.5" value="4" />
      </label>
      <label class="slider">
        <span>Inductance L <em id="L-val">1.0 H</em></span>
        <input type="range" id="L" min="0.2" max="5" step="0.1" value="1" />
      </label>
      <label class="slider">
        <span>Capacité C <em id="C-val">0.30 F</em></span>
        <input type="range" id="C" min="0.05" max="1" step="0.05" value="0.3" />
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
      <h2>Mesures</h2>
      <div class="measures">
        <div class="m-row"><span>Courant i</span><b id="m-i">—</b></div>
        <div class="m-row"><span>Tension composant</span><b id="m-u">—</b></div>
        <div class="m-row"><span>Charge q</span><b id="m-q">—</b></div>
        <div class="m-row"><span>Énergie stockée</span><b id="m-e">—</b></div>
        <div class="m-row"><span>Puissance dissipée</span><b id="m-p">—</b></div>
        <div class="m-row"><span>Caractéristique</span><b id="m-k">—</b></div>
      </div>
    </div>

    <div class="group">
      <button id="rlc-reset" class="reset">Réinitialiser</button>
    </div>
  </aside>
</div>`;

/* ========================================================================= */
/*  Cycle de vie                                                             */
/* ========================================================================= */
function mount(root: HTMLElement) {
  root.innerHTML = TEMPLATE;
  state = { ...DEFAULTS };
  q = 0; iCur = 0; flowOffset = 0; time = 0; lastT = 0; iMaxSeen = 1;
  hist = { u: [], i: [], uc: [], ul: [] };

  canvas = root.querySelector("#rlc-canvas");
  ctx = canvas.getContext("2d");
  const $ = (id) => root.querySelector("#" + id);
  els = {
    seg: $("rlc-seg"), formula: $("rlc-formula"), desc: $("rlc-desc"),
    source: $("rlc-source"),
    U0: $("U0"), U0Val: $("U0-val"),
    f: $("f"), fVal: $("f-val"),
    R: $("R"), RVal: $("R-val"),
    L: $("L"), LVal: $("L-val"),
    C: $("C"), CVal: $("C-val"),
    speed: $("speed"), speedVal: $("speed-val"),
    mI: $("m-i"), mU: $("m-u"), mQ: $("m-q"), mE: $("m-e"), mP: $("m-p"), mK: $("m-k"),
    reset: $("rlc-reset"),
  };

  els.seg.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    state.mode = btn.dataset.mode;
    q = 0; iCur = 0; hist = { u: [], i: [], uc: [], ul: [] };
    syncModeUI();
  });
  els.source.addEventListener("change", () => { state.source = els.source.value; });
  bindSlider(els.U0, els.U0Val, "U0", (v) => v.toFixed(1) + " V");
  bindSlider(els.f, els.fVal, "f", (v) => v.toFixed(2) + " Hz");
  bindSlider(els.R, els.RVal, "R", (v) => v.toFixed(1) + " Ω");
  bindSlider(els.L, els.LVal, "L", (v) => v.toFixed(1) + " H");
  bindSlider(els.C, els.CVal, "C", (v) => v.toFixed(2) + " F");
  bindSlider(els.speed, els.speedVal, "speed", (v) => v.toFixed(1));
  els.reset.addEventListener("click", () => {
    const mode = state.mode;
    state = { ...DEFAULTS, mode };
    q = 0; iCur = 0; hist = { u: [], i: [], uc: [], ul: [] };
    applyStateToUI(); syncModeUI();
  });

  applyStateToUI(); syncModeUI();
  running = true;
  rafId = requestAnimationFrame(loop);
  return { unmount };
}
function bindSlider(el, valEl, key, label) {
  el.addEventListener("input", () => {
    state[key] = parseFloat(el.value);
    valEl.textContent = label(state[key]);
  });
}
function syncModeUI() {
  els.seg.querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === state.mode));
  const cfg = modeCfg();
  els.formula.textContent = cfg.formula;
  els.desc.textContent = cfg.desc;
}
function applyStateToUI() {
  els.source.value = state.source;
  els.U0.value = state.U0; els.U0Val.textContent = state.U0.toFixed(1) + " V";
  els.f.value = state.f; els.fVal.textContent = state.f.toFixed(2) + " Hz";
  els.R.value = state.R; els.RVal.textContent = state.R.toFixed(1) + " Ω";
  els.L.value = state.L; els.LVal.textContent = state.L.toFixed(1) + " H";
  els.C.value = state.C; els.CVal.textContent = state.C.toFixed(2) + " F";
  els.speed.value = state.speed; els.speedVal.textContent = state.speed.toFixed(1);
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
  id: "rlc",
  title: "Composants RLC",
  subtitle: "Résistance, condensateur, bobine et circuit RLC : équations, charges, champs E et B.",
  help: "Choisis un composant. Le <b>schéma</b> montre la circulation des charges " +
        "(points bleus), le <b>condensateur</b> accumule des charges et un champ E " +
        "entre ses armatures, la <b>bobine</b> développe un champ B (⊙/⊗) ∝ i. " +
        "L'<b>oscilloscope</b> trace u(t), le courant i et la tension du composant : " +
        "observe les déphasages (i en avance sur C, en retard sur L) et, pour le " +
        "<b>RLC</b>, la résonance (sinus) ou les oscillations amorties (créneau).",
  mount,
});
