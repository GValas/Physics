import { register } from "../registry";

/* =========================================================================
   Module : Relativité générale
   3 scènes :
     1. Courbure de l'espace-temps  — nappe déformée par la masse (3D orbitable)
     2. Précession des orbites       — géodésiques (avance du périhélie vs Newton)
     3. Trou noir & lumière          — horizon, sphère photon, ISCO, lentille
   Unités géométriques G = c = 1 ; rayon de Schwarzschild r_s = 2M.
   Équation des géodésiques de Schwarzschild :
     d²u/dφ² + u = M/L² + 3M·u²   (u = 1/r ; terme 3M·u² = correction GR)
   ========================================================================= */

const SIZE = 720;
const CX = SIZE / 2, CY = SIZE / 2;
const R_DOM = 8;                 // demi-domaine (unités géométriques)
const SCALE = SIZE / (2 * R_DOM);

/* ========================================================================= */
/*  État                                                                     */
/* ========================================================================= */
const DEFAULTS = {
  mode: "curvature",
  M: 0.3, e: 0.45, a: 4.2, rays: 17, speed: 1, showNewton: true,
};
let state = { ...DEFAULTS };

let canvas = null, ctx = null, els = null, readout = null;
let rafId = null, running = false, lastT = 0, time = 0;
let dirty = true;

/* caméra (scène nappe) */
let cam = { yaw: -0.6, pitch: 0.95, dist: 9 };
let drag = { on: false, x: 0, y: 0, moved: 0 };
let onWinMove = null, onWinUp = null;

/* orbite intégrée en direct (scène précession) */
let orb = { u: 0, up: 0, phi: 0, Lsq: 1, trail: [], lastLog: -1 };

/* rayons lumineux pré-calculés (scène trou noir) */
let rayPaths = [];

const FOCAL_S = 900;

/* ========================================================================= */
/*  Utilitaires                                                              */
/* ========================================================================= */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function fmt(v, d = 2) {
  if (!isFinite(v)) return "∞";
  const a = Math.abs(v);
  if (a !== 0 && (a < 0.01 || a >= 1000)) return v.toExponential(2);
  return v.toFixed(d);
}
const rs = () => 2 * state.M;
const w2s = (x, y) => [CX + x * SCALE, CY - y * SCALE];

/* projection 3D pour la nappe : (gx, gy, h) ; h = hauteur (creux négatif) */
function proj(gx, gy, h) {
  const x = gx, y = h, z = gy;          // h = axe vertical
  const cyA = Math.cos(cam.yaw), syA = Math.sin(cam.yaw);
  const cpA = Math.cos(cam.pitch), spA = Math.sin(cam.pitch);
  const vx = cyA * x + syA * z;
  const ry = y, rz = -syA * x + cyA * z;
  const vy = cpA * ry - spA * rz;
  const vz = spA * ry + cpA * rz;
  const depth = cam.dist - vz;
  const f = FOCAL_S / Math.max(depth, 0.05);
  return { x: CX + vx * f, y: CY - vy * f, depth };
}

/* profondeur du puits (embedding lissé) */
function wellH(gx, gy) {
  const r = Math.sqrt(gx * gx + gy * gy);
  return -3.2 * state.M / (r * 0.18 + 0.5);   // creux ∝ M, borné au centre
}

/* ========================================================================= */
/*  Scène 1 : courbure (nappe 3D)                                            */
/* ========================================================================= */
function drawCurvature(dt) {
  const G = 6, N = 26, step = (2 * G) / N;
  ctx.lineWidth = 1;
  // lignes selon gx (colonnes) puis gy (lignes), triées grossièrement par profondeur
  for (let i = 0; i <= N; i++) {
    ctx.beginPath();
    for (let j = 0; j <= N; j++) {
      const gx = -G + i * step, gy = -G + j * step;
      const p = proj(gx, gy, wellH(gx, gy));
      j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    }
    ctx.strokeStyle = "rgba(93,160,255,0.35)"; ctx.stroke();
  }
  for (let j = 0; j <= N; j++) {
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const gx = -G + i * step, gy = -G + j * step;
      const p = proj(gx, gy, wellH(gx, gy));
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    }
    ctx.strokeStyle = "rgba(93,160,255,0.22)"; ctx.stroke();
  }
  // masse centrale (sphère) au fond du puits
  const c = proj(0, 0, wellH(0, 0));
  const rad = (8 + 60 * state.M) * (FOCAL_S / (cam.dist * SCALE)) * 0.12;
  const g = ctx.createRadialGradient(c.x - rad * 0.3, c.y - rad * 0.3, rad * 0.1, c.x, c.y, rad);
  g.addColorStop(0, "#ffe39a"); g.addColorStop(1, "#b06a10");
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(c.x, c.y, Math.max(rad, 8), 0, 7); ctx.fill();

  // bille en orbite dans le puits (illustratif)
  const rp = 3.4;
  const ang = time * 0.6;
  const bx = rp * Math.cos(ang), by = rp * Math.sin(ang);
  const pb = proj(bx, by, wellH(bx, by) + 0.15);
  ctx.fillStyle = "#7CFFB2";
  ctx.beginPath(); ctx.arc(pb.x, pb.y, 5, 0, 7); ctx.fill();

  readout.textContent =
    `Courbure de l'espace-temps\nr_s = 2M = ${fmt(rs())}\nla masse « creuse » la géométrie ;\nles corps suivent les géodésiques.`;

  // indice d'interaction
  ctx.fillStyle = "rgba(159,176,200,0.55)"; ctx.font = "12px system-ui, sans-serif";
  ctx.fillText("glisser pour orbiter · molette = zoom", 14, SIZE - 14);
}

/* ========================================================================= */
/*  Scène 2 : précession des orbites                                         */
/* ========================================================================= */
function resetOrbit() {
  const p = state.a * (1 - state.e * state.e);     // paramètre (demi-latus rectum)
  orb.Lsq = state.M * p;                            // L² ≈ M·p
  orb.u = (1 + state.e) / p;                        // au périhélie (φ = 0)
  orb.up = 0; orb.phi = 0; orb.trail = []; orb.lastLog = -1;
}
function stepOrbit(dt) {
  const M = state.M, Lsq = orb.Lsq;
  const sub = 60, h = (dt * state.speed * 3.2) / sub;
  for (let k = 0; k < sub; k++) {
    const L = Math.sqrt(Lsq);
    const dphi = L * orb.u * orb.u * h;             // dφ/dt = L·u² (vitesse aréolaire)
    const acc = M / Lsq + 3 * M * orb.u * orb.u - orb.u;
    orb.up += acc * dphi;                           // intégrateur d'Euler-Cromer (symplectique)
    orb.u += orb.up * dphi;
    orb.phi += dphi;
    orb.u = clamp(orb.u, 1e-4, 1 / (rs() * 1.05));  // garde-fou
    // échantillonnage à pas d'angle ~constant : la rosette reste lisible
    // quelle que soit la vitesse et s'accumule sur de nombreuses orbites
    if (orb.phi - orb.lastLog >= 0.015) {
      orb.lastLog = orb.phi;
      const r = 1 / orb.u;
      orb.trail.push([r * Math.cos(orb.phi), r * Math.sin(orb.phi)]);
    }
  }
  if (orb.trail.length > 5000) orb.trail.splice(0, orb.trail.length - 5000);
}
function drawPrecession(dt) {
  stepOrbit(dt);
  // masse + horizon
  drawCentralMass();

  // orbite newtonienne fermée (référence)
  if (state.showNewton) {
    const p = state.a * (1 - state.e * state.e);
    ctx.strokeStyle = "rgba(159,176,200,0.5)"; ctx.lineWidth = 1.4;
    ctx.setLineDash([5, 5]); ctx.beginPath();
    for (let t = 0; t <= 360; t++) {
      const th = (t / 360) * Math.PI * 2;
      const r = p / (1 + state.e * Math.cos(th));
      const [sx, sy] = w2s(r * Math.cos(th), r * Math.sin(th));
      t ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
    }
    ctx.stroke(); ctx.setLineDash([]);
  }

  // trajectoire GR (rosette)
  ctx.strokeStyle = "rgba(124,255,178,0.85)"; ctx.lineWidth = 1.8;
  ctx.beginPath();
  for (let k = 0; k < orb.trail.length; k++) {
    const [sx, sy] = w2s(orb.trail[k][0], orb.trail[k][1]);
    k ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
  }
  ctx.stroke();
  // planète (tête)
  if (orb.trail.length) {
    const last = orb.trail[orb.trail.length - 1];
    const [sx, sy] = w2s(last[0], last[1]);
    ctx.fillStyle = "#7CFFB2"; ctx.beginPath(); ctx.arc(sx, sy, 5, 0, 7); ctx.fill();
  }

  const p = state.a * (1 - state.e * state.e);
  const dPhi = (6 * Math.PI * state.M) / p;          // avance du périhélie / orbite (rad)
  readout.textContent =
    `Avance du périhélie\nΔφ = 6πM / [a(1−e²)]\n   = ${fmt(dPhi * 180 / Math.PI)}° par orbite\nr_s = ${fmt(rs())}` +
    (state.showNewton ? "\n(pointillé = orbite newtonienne)" : "");
}

/* ========================================================================= */
/*  Scène 3 : trou noir & lumière                                            */
/* ========================================================================= */
function traceRay(b) {                               // géodésique nulle, param. impact b
  const M = state.M, pts = [];
  let phi = 1e-3, u = Math.sin(phi) / b, up = Math.cos(phi) / b;
  const dphi = 0.012, horizon = 1 / (rs());
  let captured = false;
  for (let n = 0; n < 2600; n++) {
    const acc = 3 * M * u * u - u;
    up += acc * dphi; u += up * dphi; phi += dphi;
    if (u >= horizon) { captured = true; pts.push([Math.cos(phi) / horizon, Math.sin(phi) / horizon]); break; }
    if (u <= 1e-4) { u = 1e-4; }
    const r = 1 / u;
    if (r > R_DOM * 1.5 && phi > 0.5) break;         // échappé
    pts.push([r * Math.cos(phi), r * Math.sin(phi)]);
  }
  return { pts, captured };
}
function buildRays() {
  rayPaths = [];
  const n = state.rays;
  const bmax = R_DOM * 0.95;
  for (let i = 0; i < n; i++) {
    const frac = -1 + (2 * i) / (n - 1);     // −1 … +1
    const b = Math.abs(frac) * bmax;
    if (b < 0.08) continue;                  // évite le rayon axial
    const sign = frac >= 0 ? 1 : -1;         // rayon au-dessus / au-dessous de l'axe
    const ray = traceRay(b);
    rayPaths.push({ pts: ray.pts.map(([x, y]) => [x, sign * y]), captured: ray.captured });
  }
  dirty = false;
}
function drawBlackHole() {
  if (dirty) buildRays();
  const M = state.M, rsv = rs();
  // ISCO (3 r_s), sphère photon (1.5 r_s), horizon (r_s)
  drawCircleWorld(3 * rsv, "rgba(124,255,178,0.5)", [4, 4], "ISCO 3r_s");
  drawCircleWorld(1.5 * rsv, "rgba(255,209,102,0.7)", [2, 3], "sphère photon");
  // disque d'horizon (noir)
  const [hx, hy] = w2s(0, 0);
  ctx.fillStyle = "#000";
  ctx.beginPath(); ctx.arc(hx, hy, rsv * SCALE, 0, 7); ctx.fill();
  ctx.strokeStyle = "#5dd0ff"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(hx, hy, rsv * SCALE, 0, 7); ctx.stroke();

  // rayons lumineux (depuis la droite), pointillés animés
  const off = -(time * 60 * state.speed) % 16;
  for (const ray of rayPaths) {
    ctx.strokeStyle = ray.captured ? "rgba(255,120,90,0.85)" : "rgba(255,245,210,0.8)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([7, 9]); ctx.lineDashOffset = off;
    ctx.beginPath();
    for (let k = 0; k < ray.pts.length; k++) {
      const [sx, sy] = w2s(ray.pts[k][0], ray.pts[k][1]);
      k ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);

  const bcrit = Math.sqrt(27) * M;                   // paramètre d'impact critique
  readout.textContent =
    `Trou noir de Schwarzschild\nr_s (horizon)   = ${fmt(rsv)}\nsphère photon  = ${fmt(1.5 * rsv)}\nISCO              = ${fmt(3 * rsv)}\nb_crit = √27·M = ${fmt(bcrit)}\n(rouge = lumière capturée)`;
}
function drawCircleWorld(r, color, dash, label) {
  const [cx, cy] = w2s(0, 0);
  ctx.strokeStyle = color; ctx.lineWidth = 1.4;
  ctx.setLineDash(dash); ctx.beginPath();
  ctx.arc(cx, cy, r * SCALE, 0, 7); ctx.stroke(); ctx.setLineDash([]);
  if (label) {
    ctx.fillStyle = color; ctx.font = "11px Consolas, monospace";
    ctx.fillText(label, cx + r * SCALE * 0.7, cy - r * SCALE * 0.7);
  }
}
function drawCentralMass() {
  const [cx, cy] = w2s(0, 0);
  ctx.strokeStyle = "rgba(255,209,102,0.4)"; ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  ctx.beginPath(); ctx.arc(cx, cy, rs() * SCALE, 0, 7); ctx.stroke();
  ctx.setLineDash([]);
  const rad = Math.max(rs() * SCALE, 7);
  const g = ctx.createRadialGradient(cx - rad * 0.3, cy - rad * 0.3, rad * 0.1, cx, cy, rad);
  g.addColorStop(0, "#ffe39a"); g.addColorStop(1, "#a85f0e");
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, rad, 0, 7); ctx.fill();
}

/* ========================================================================= */
/*  Boucle                                                                   */
/* ========================================================================= */
function loop(t) {
  if (!running) return;
  let dt = (t - lastT) / 1000; lastT = t;
  if (!isFinite(dt) || dt <= 0) dt = 0.016;
  dt = Math.min(dt, 0.05);
  time += dt;

  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = "#04060c"; ctx.fillRect(0, 0, SIZE, SIZE);

  if (state.mode === "curvature") drawCurvature(dt);
  else if (state.mode === "precession") drawPrecession(dt);
  else drawBlackHole();

  rafId = requestAnimationFrame(loop);
}

/* ========================================================================= */
/*  Textes                                                                   */
/* ========================================================================= */
const MODES = [
  { id: "curvature", label: "Courbure de l'espace-temps",
    formula: "Gμν = (8πG/c⁴) Tμν        r_s = 2GM/c²",
    desc: "La masse-énergie courbe l'espace-temps (équation d'Einstein). La nappe est une image de cette courbure : la masse y creuse un puits. Glisse pour faire tourner le point de vue." },
  { id: "precession", label: "Précession des orbites",
    formula: "d²u/dφ² + u = M/L² + 3M·u²     (u = 1/r)",
    desc: "Le terme relativiste 3M·u² fait tourner l'orbite : le périhélie avance à chaque tour (rosette), contrairement à l'ellipse fermée de Newton. C'est l'anomalie de Mercure." },
  { id: "blackhole", label: "Trou noir & lumière",
    formula: "horizon r_s · sphère photon 1.5 r_s · ISCO 3 r_s",
    desc: "La lumière (venant de la droite) est déviée par la masse (lentille gravitationnelle) ; si son paramètre d'impact est inférieur à b_crit = √27·M, elle est capturée sous l'horizon." },
];
function modeCfg() { return MODES.find((m) => m.id === state.mode); }

/* ========================================================================= */
/*  Gabarit                                                                  */
/* ========================================================================= */
const TEMPLATE = `
<div class="sim-layout">
  <section class="stage">
    <canvas id="gr-canvas" width="${SIZE}" height="${SIZE}" aria-label="Relativité générale"></canvas>
    <div id="gr-readout" class="probe-readout" aria-live="polite"></div>
  </section>

  <aside class="panel">
    <div class="group">
      <h2>Scène</h2>
      <div class="seg" id="gr-seg" role="tablist">
        ${MODES.map((m) => `<button class="seg-btn" data-mode="${m.id}">${m.label}</button>`).join("")}
      </div>
      <div class="formula" id="gr-formula"></div>
      <p class="hint" id="gr-desc"></p>
    </div>

    <div class="group">
      <h2>Masse</h2>
      <label class="slider">
        <span>Masse M <em id="M-val">0.30</em></span>
        <input type="range" id="M" min="0.05" max="0.6" step="0.05" value="0.3" />
      </label>
    </div>

    <div class="group" id="grp-orbit">
      <h2>Orbite</h2>
      <label class="slider">
        <span>Excentricité e <em id="e-val">0.45</em></span>
        <input type="range" id="e" min="0" max="0.8" step="0.05" value="0.45" />
      </label>
      <label class="slider">
        <span>Demi-grand axe a <em id="a-val">4.2</em></span>
        <input type="range" id="a" min="2.5" max="6" step="0.1" value="4.2" />
      </label>
      <label class="check"><input type="checkbox" id="show-newton" checked /> Orbite newtonienne (réf.)</label>
    </div>

    <div class="group" id="grp-ray">
      <h2>Lumière</h2>
      <label class="slider">
        <span>Nombre de rayons <em id="rays-val">17</em></span>
        <input type="range" id="rays" min="5" max="31" step="2" value="17" />
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
      <button id="gr-view" class="reset" style="margin-bottom:8px">Vue par défaut</button>
      <button id="gr-reset" class="reset">Réinitialiser</button>
    </div>
  </aside>
</div>`;

/* ========================================================================= */
/*  Cycle de vie                                                             */
/* ========================================================================= */
function mount(root: HTMLElement) {
  root.innerHTML = TEMPLATE;
  state = { ...DEFAULTS };
  time = 0; lastT = 0; dirty = true;
  cam = { yaw: -0.6, pitch: 0.95, dist: 9 };
  drag = { on: false, x: 0, y: 0, moved: 0 };

  canvas = root.querySelector("#gr-canvas");
  ctx = canvas.getContext("2d");
  readout = root.querySelector("#gr-readout");
  const $ = (id) => root.querySelector("#" + id);
  els = {
    seg: $("gr-seg"), formula: $("gr-formula"), desc: $("gr-desc"),
    grpOrbit: $("grp-orbit"), grpRay: $("grp-ray"),
    M: $("M"), MVal: $("M-val"),
    e: $("e"), eVal: $("e-val"),
    a: $("a"), aVal: $("a-val"),
    rays: $("rays"), raysVal: $("rays-val"),
    speed: $("speed"), speedVal: $("speed-val"),
    showNewton: $("show-newton"),
    view: $("gr-view"), reset: $("gr-reset"),
  };

  els.seg.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    state.mode = btn.dataset.mode;
    dirty = true;
    if (state.mode === "precession") resetOrbit();
    syncModeUI();
  });
  bindSlider(els.M, els.MVal, "M", (v) => v.toFixed(2), () => { dirty = true; if (state.mode === "precession") resetOrbit(); });
  bindSlider(els.e, els.eVal, "e", (v) => v.toFixed(2), () => resetOrbit());
  bindSlider(els.a, els.aVal, "a", (v) => v.toFixed(1), () => resetOrbit());
  bindSlider(els.rays, els.raysVal, "rays", (v) => v, () => { dirty = true; }, true);
  bindSlider(els.speed, els.speedVal, "speed", (v) => v.toFixed(1));
  els.showNewton.addEventListener("change", () => { state.showNewton = els.showNewton.checked; });

  els.view.addEventListener("click", () => { cam = { yaw: -0.6, pitch: 0.95, dist: 9 }; });
  els.reset.addEventListener("click", () => {
    const mode = state.mode;
    state = { ...DEFAULTS, mode };
    cam = { yaw: -0.6, pitch: 0.95, dist: 9 };
    dirty = true; resetOrbit();
    applyStateToUI(); syncModeUI();
  });

  /* orbite caméra (scène nappe) : glisser */
  canvas.addEventListener("mousedown", (e) => {
    drag.on = true; drag.x = e.clientX; drag.y = e.clientY; drag.moved = 0; e.preventDefault();
  });
  onWinMove = (e) => {
    if (!drag.on || state.mode !== "curvature") return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    cam.yaw += dx * 0.01;
    cam.pitch = clamp(cam.pitch + dy * 0.01, 0.15, 1.45);
  };
  onWinUp = () => { drag.on = false; };
  window.addEventListener("mousemove", onWinMove);
  window.addEventListener("mouseup", onWinUp);
  canvas.addEventListener("wheel", (e) => {
    cam.dist = clamp(cam.dist + Math.sign(e.deltaY) * 0.5, 5, 18);
    e.preventDefault();
  }, { passive: false });
  // tactile (nappe)
  let pinch = 0;
  const tDist = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                                  e.touches[0].clientY - e.touches[1].clientY);
  canvas.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) { drag.on = true; drag.x = e.touches[0].clientX; drag.y = e.touches[0].clientY; }
    else if (e.touches.length === 2) { drag.on = false; pinch = tDist(e); }
  }, { passive: false });
  canvas.addEventListener("touchmove", (e) => {
    if (state.mode !== "curvature") return;
    if (e.touches.length === 1 && drag.on) {
      const dx = e.touches[0].clientX - drag.x, dy = e.touches[0].clientY - drag.y;
      drag.x = e.touches[0].clientX; drag.y = e.touches[0].clientY;
      cam.yaw += dx * 0.01; cam.pitch = clamp(cam.pitch + dy * 0.01, 0.15, 1.45);
      e.preventDefault();
    } else if (e.touches.length === 2) {
      const d = tDist(e); if (pinch) cam.dist = clamp(cam.dist * (pinch / d), 5, 18); pinch = d;
      e.preventDefault();
    }
  }, { passive: false });
  canvas.addEventListener("touchend", (e) => { if (e.touches.length === 0) drag.on = false; });

  resetOrbit();
  applyStateToUI(); syncModeUI();
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
function syncModeUI() {
  els.seg.querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === state.mode));
  const cfg = modeCfg();
  els.formula.textContent = cfg.formula;
  els.desc.textContent = cfg.desc;
  els.grpOrbit.style.display = state.mode === "precession" ? "" : "none";
  els.grpRay.style.display = state.mode === "blackhole" ? "" : "none";
  els.view.style.display = state.mode === "curvature" ? "" : "none";
}
function applyStateToUI() {
  els.M.value = state.M; els.MVal.textContent = state.M.toFixed(2);
  els.e.value = state.e; els.eVal.textContent = state.e.toFixed(2);
  els.a.value = state.a; els.aVal.textContent = state.a.toFixed(1);
  els.rays.value = state.rays; els.raysVal.textContent = state.rays;
  els.speed.value = state.speed; els.speedVal.textContent = state.speed.toFixed(1);
  els.showNewton.checked = state.showNewton;
}
function unmount() {
  running = false;
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  if (onWinMove) window.removeEventListener("mousemove", onWinMove);
  if (onWinUp) window.removeEventListener("mouseup", onWinUp);
  onWinMove = onWinUp = null;
  canvas = ctx = els = readout = null;
}

/* ========================================================================= */
/*  Enregistrement                                                           */
/* ========================================================================= */
register({
  id: "general-relativity",
  title: "Relativité générale",
  subtitle: "Courbure de l'espace-temps, précession des orbites, trous noirs et déviation de la lumière.",
  help: "Trois scènes : la <b>courbure</b> (nappe déformée par la masse, glisse pour " +
        "orbiter), la <b>précession</b> des orbites (avance du périhélie due au terme " +
        "relativiste, comparée à l'ellipse de Newton), et le <b>trou noir</b> de " +
        "Schwarzschild (horizon, sphère photon, ISCO, et capture/déviation de la " +
        "lumière). Unités géométriques G = c = 1, r_s = 2M.",
  mount,
});
