import { register } from "../registry";

/* =========================================================================
   Module : Fluides (Navier-Stokes)
   Solveur « Stable Fluids » de Jos Stam : advection semi-lagrangienne +
   diffusion (Gauss-Seidel) + projection de pression (champ à divergence nulle).
   Résout les équations de Navier-Stokes incompressibles :
       ∂u/∂t + (u·∇)u = −∇p/ρ + ν∇²u + f      ∇·u = 0
   3 scènes : tourbillon interactif, cheminée (convection), obstacle (Kármán).
   ========================================================================= */

const SIZE = 720;
const N = 72;                       // résolution de la grille (intérieur)
const W1 = N + 2;
const SZ = W1 * W1;
const ITER = 6;                     // itérations de Gauss-Seidel
const IX = (i, j) => i + W1 * j;

/* champs (alloués une fois) */
const F = {
  u: new Float32Array(SZ), v: new Float32Array(SZ),
  u0: new Float32Array(SZ), v0: new Float32Array(SZ),
  dens: new Float32Array(SZ), dens0: new Float32Array(SZ),
};
const curl = new Float32Array(SZ);
const obstacle = new Uint8Array(SZ);

/* ========================================================================= */
/*  État                                                                     */
/* ========================================================================= */
const DEFAULTS = {
  mode: "stir", display: "dye",
  visc: 8, diff: 4, force: 50, vort: 30, speed: 1, arrows: false,
};
let state = { ...DEFAULTS };

let canvas = null, ctx = null, off = null, octx = null, img = null, els = null;
let rafId = null, running = false, lastT = 0;
let pointer = { down: false, ci: 0, cj: 0, pci: 0, pcj: 0 };

/* ========================================================================= */
/*  Solveur                                                                  */
/* ========================================================================= */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function swap(a, b) { const t = F[a]; F[a] = F[b]; F[b] = t; }

function set_bnd(b, x) {
  for (let i = 1; i <= N; i++) {
    x[IX(0, i)]     = b === 1 ? -x[IX(1, i)] : x[IX(1, i)];
    x[IX(N + 1, i)] = b === 1 ? -x[IX(N, i)] : x[IX(N, i)];
    x[IX(i, 0)]     = b === 2 ? -x[IX(i, 1)] : x[IX(i, 1)];
    x[IX(i, N + 1)] = b === 2 ? -x[IX(i, N)] : x[IX(i, N)];
  }
  x[IX(0, 0)]         = 0.5 * (x[IX(1, 0)] + x[IX(0, 1)]);
  x[IX(0, N + 1)]     = 0.5 * (x[IX(1, N + 1)] + x[IX(0, N)]);
  x[IX(N + 1, 0)]     = 0.5 * (x[IX(N, 0)] + x[IX(N + 1, 1)]);
  x[IX(N + 1, N + 1)] = 0.5 * (x[IX(N, N + 1)] + x[IX(N + 1, N)]);
}
function lin_solve(b, x, x0, a, c) {
  const ic = 1 / c;
  for (let k = 0; k < ITER; k++) {
    for (let j = 1; j <= N; j++)
      for (let i = 1; i <= N; i++)
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
function vorticityConfinement(dt) {
  const eps = state.vort * 0.02;
  if (eps <= 0) return;
  for (let j = 1; j <= N; j++) for (let i = 1; i <= N; i++)
    curl[IX(i, j)] = 0.5 * (F.v[IX(i + 1, j)] - F.v[IX(i - 1, j)] -
                            F.u[IX(i, j + 1)] + F.u[IX(i, j - 1)]);
  for (let j = 2; j < N; j++) for (let i = 2; i < N; i++) {
    const dwdx = 0.5 * (Math.abs(curl[IX(i + 1, j)]) - Math.abs(curl[IX(i - 1, j)]));
    const dwdy = 0.5 * (Math.abs(curl[IX(i, j + 1)]) - Math.abs(curl[IX(i, j - 1)]));
    const len = Math.hypot(dwdx, dwdy) + 1e-5;
    const w = curl[IX(i, j)];
    F.u[IX(i, j)] += dt * eps * (dwdy / len) * w;
    F.v[IX(i, j)] += dt * eps * -(dwdx / len) * w;
  }
}
function velStep(dt) {
  vorticityConfinement(dt);
  const visc = state.visc * 1e-5;
  swap("u0", "u"); diffuse(1, F.u, F.u0, visc, dt);
  swap("v0", "v"); diffuse(2, F.v, F.v0, visc, dt);
  project(F.u, F.v, F.u0, F.v0);
  swap("u0", "u"); swap("v0", "v");
  advect(1, F.u, F.u0, F.u0, F.v0, dt);
  advect(2, F.v, F.v0, F.u0, F.v0, dt);
  project(F.u, F.v, F.u0, F.v0);
}
function densStep(dt) {
  const diff = state.diff * 1e-5;
  swap("dens0", "dens"); diffuse(0, F.dens, F.dens0, diff, dt);
  swap("dens0", "dens"); advect(0, F.dens, F.dens0, F.u, F.v, dt);
  for (let k = 0; k < SZ; k++) F.dens[k] *= 0.992;     // dissipation lente
}

/* ========================================================================= */
/*  Forçage propre à chaque scène                                            */
/* ========================================================================= */
function buildObstacle() {
  obstacle.fill(0);
  const cx = N * 0.3, cy = N * 0.5, rad = N * 0.09;
  for (let j = 1; j <= N; j++) for (let i = 1; i <= N; i++)
    if ((i - cx) ** 2 + (j - cy) ** 2 < rad * rad) obstacle[IX(i, j)] = 1;
}
function applyForcing(dt) {
  if (state.mode === "stir") {
    if (pointer.down) injectBrush();
  } else if (state.mode === "smoke") {
    const cx = (N / 2) | 0;
    for (let i = cx - 3; i <= cx + 3; i++) {
      F.dens[IX(i, N - 3)] += 60 * dt;
      F.v[IX(i, N - 3)] -= state.force * 0.02;          // poussée vers le haut
    }
    if (pointer.down) injectBrush();
  } else { // obstacle : entrée à gauche
    const inflow = state.force * 0.06;
    for (let j = 1; j <= N; j++) {
      F.u[IX(0, j)] = inflow; F.u[IX(1, j)] = inflow; F.v[IX(1, j)] = 0;
      if ((j >> 3) & 1) F.dens[IX(2, j)] = 1;            // bandes de colorant
    }
    for (let j = 1; j <= N; j++) F.u[IX(N + 1, j)] = F.u[IX(N, j)];   // sortie libre
    applyObstacle();
    if (pointer.down) injectBrush();
  }
}
function applyObstacle() {
  for (let k = 0; k < SZ; k++) if (obstacle[k]) { F.u[k] = 0; F.v[k] = 0; }
}
function injectBrush() {
  const du = (pointer.ci - pointer.pci) * state.force * 0.5;
  const dv = (pointer.cj - pointer.pcj) * state.force * 0.5;
  const r = 2;
  for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
    const i = clamp(pointer.ci + di, 1, N), j = clamp(pointer.cj + dj, 1, N);
    F.u[IX(i, j)] += du; F.v[IX(i, j)] += dv;
    F.dens[IX(i, j)] = clamp(F.dens[IX(i, j)] + 1, 0, 3);
  }
  pointer.pci = pointer.ci; pointer.pcj = pointer.cj;
}

/* ========================================================================= */
/*  Rendu                                                                    */
/* ========================================================================= */
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const DARK = [6, 12, 24], TEAL = [40, 180, 205], WHITE = [235, 250, 255];
const BLUE = [60, 130, 245], RED = [255, 80, 70];
function dyeColor(t) {
  t = clamp(t, 0, 1);
  return t < 0.5 ? mix(DARK, TEAL, t / 0.5) : mix(TEAL, WHITE, (t - 0.5) / 0.5);
}
function vortColor(c) {
  c = clamp(c, -1, 1);
  return c >= 0 ? mix(DARK, RED, c) : mix(DARK, BLUE, -c);
}
function render() {
  const data = img.data;
  let vmax = 1e-4;
  if (state.display === "vort") {
    for (let j = 1; j <= N; j++) for (let i = 1; i <= N; i++) {
      const c = 0.5 * (F.v[IX(i + 1, j)] - F.v[IX(i - 1, j)] - F.u[IX(i, j + 1)] + F.u[IX(i, j - 1)]);
      curl[IX(i, j)] = c; if (Math.abs(c) > vmax) vmax = Math.abs(c);
    }
  }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const gi = i + 1, gj = j + 1;
    let col;
    if (obstacle[IX(gi, gj)]) col = [70, 80, 100];
    else if (state.display === "vort") col = vortColor(curl[IX(gi, gj)] / vmax);
    else col = dyeColor(F.dens[IX(gi, gj)]);
    const p = (i + N * j) * 4;
    data[p] = col[0]; data[p + 1] = col[1]; data[p + 2] = col[2]; data[p + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, SIZE, SIZE);

  if (state.arrows) drawArrows();
}
function drawArrows() {
  const stepc = 5, cell = SIZE / N;
  ctx.strokeStyle = "rgba(255,255,255,0.45)"; ctx.lineWidth = 1;
  let m = 1e-4;
  for (let k = 0; k < SZ; k++) { const s = Math.hypot(F.u[k], F.v[k]); if (s > m) m = s; }
  for (let j = 1; j <= N; j += stepc) for (let i = 1; i <= N; i += stepc) {
    const sx = (i - 0.5) * cell, sy = (j - 0.5) * cell;
    const u = F.u[IX(i, j)], v = F.v[IX(i, j)];
    const len = (Math.hypot(u, v) / m) * cell * stepc * 0.5;
    if (len < 0.5) continue;
    const a = Math.atan2(v, u);
    ctx.beginPath(); ctx.moveTo(sx, sy);
    ctx.lineTo(sx + Math.cos(a) * len, sy + Math.sin(a) * len); ctx.stroke();
  }
}

/* ========================================================================= */
/*  Boucle                                                                   */
/* ========================================================================= */
function loop(t) {
  if (!running) return;
  let dt = (t - lastT) / 1000; lastT = t;
  if (!isFinite(dt) || dt <= 0) dt = 0.016;
  const dtSim = clamp(dt, 0.008, 0.033) * state.speed * 6;   // pas de simulation
  applyForcing(dtSim);
  velStep(dtSim);
  if (state.mode === "obstacle") applyObstacle();
  densStep(dtSim);
  ctx.clearRect(0, 0, SIZE, SIZE);
  render();
  rafId = requestAnimationFrame(loop);
}

/* ========================================================================= */
/*  Textes                                                                   */
/* ========================================================================= */
const MODES = [
  { id: "stir", label: "Tourbillon interactif",
    desc: "Remue le fluide à la souris (ou au doigt) : tu injectes de la quantité de mouvement et du colorant. Observe les tourbillons s'étirer et se mélanger — c'est l'advection." },
  { id: "smoke", label: "Cheminée (convection)",
    desc: "Une source de « fumée » en bas est poussée vers le haut (flottabilité). Les instabilités forment des volutes typiques d'un panache convectif." },
  { id: "obstacle", label: "Obstacle (von Kármán)",
    desc: "Un écoulement entre par la gauche et contourne un cylindre. À nombre de Reynolds adéquat, un lâcher alterné de tourbillons apparaît : l'allée de von Kármán. Affiche la vorticité pour bien la voir." },
];
function modeCfg() { return MODES.find((m) => m.id === state.mode); }
const FORMULA = "∂u/∂t + (u·∇)u = −∇p/ρ + ν∇²u + f\n∇·u = 0   (incompressible)";

/* ========================================================================= */
/*  Gabarit                                                                  */
/* ========================================================================= */
const TEMPLATE = `
<div class="sim-layout">
  <section class="stage">
    <canvas id="fl-canvas" width="${SIZE}" height="${SIZE}" aria-label="Simulation de fluides"></canvas>
  </section>

  <aside class="panel">
    <div class="group">
      <h2>Scène</h2>
      <div class="seg" id="fl-seg" role="tablist">
        ${MODES.map((m) => `<button class="seg-btn" data-mode="${m.id}">${m.label}</button>`).join("")}
      </div>
      <div class="formula" id="fl-formula"></div>
      <p class="hint" id="fl-desc"></p>
    </div>

    <div class="group">
      <h2>Affichage</h2>
      <select id="fl-display">
        <option value="dye">Encre (densité)</option>
        <option value="vort">Vorticité (∇×u)</option>
      </select>
      <label class="check"><input type="checkbox" id="fl-arrows" /> Vecteurs vitesse</label>
    </div>

    <div class="group">
      <h2>Paramètres</h2>
      <label class="slider">
        <span>Viscosité ν <em id="visc-val">8</em></span>
        <input type="range" id="visc" min="0" max="60" step="1" value="8" />
      </label>
      <label class="slider">
        <span>Diffusion du colorant <em id="diff-val">4</em></span>
        <input type="range" id="diff" min="0" max="40" step="1" value="4" />
      </label>
      <label class="slider">
        <span>Force / débit <em id="force-val">50</em></span>
        <input type="range" id="force" min="5" max="120" step="5" value="50" />
      </label>
      <label class="slider">
        <span>Tourbillons (confinement) <em id="vort-val">30</em></span>
        <input type="range" id="vort" min="0" max="80" step="5" value="30" />
      </label>
      <label class="slider">
        <span>Vitesse <em id="speed-val">1.0</em></span>
        <input type="range" id="speed" min="0.2" max="3" step="0.1" value="1" />
      </label>
    </div>

    <div class="group">
      <button id="fl-clear" class="reset" style="margin-bottom:8px">Effacer</button>
      <button id="fl-reset" class="reset">Réinitialiser</button>
    </div>
  </aside>
</div>`;

/* ========================================================================= */
/*  Cycle de vie                                                             */
/* ========================================================================= */
function clearFields() {
  F.u.fill(0); F.v.fill(0); F.u0.fill(0); F.v0.fill(0);
  F.dens.fill(0); F.dens0.fill(0);
}
function mount(root: HTMLElement) {
  root.innerHTML = TEMPLATE;
  state = { ...DEFAULTS };
  clearFields(); buildObstacle();
  lastT = 0;

  canvas = root.querySelector("#fl-canvas");
  ctx = canvas.getContext("2d");
  off = document.createElement("canvas"); off.width = off.height = N;
  octx = off.getContext("2d");
  img = octx.createImageData(N, N);

  const $ = (id) => root.querySelector("#" + id);
  els = {
    seg: $("fl-seg"), formula: $("fl-formula"), desc: $("fl-desc"),
    display: $("fl-display"), arrows: $("fl-arrows"),
    visc: $("visc"), viscVal: $("visc-val"),
    diff: $("diff"), diffVal: $("diff-val"),
    force: $("force"), forceVal: $("force-val"),
    vort: $("vort"), vortVal: $("vort-val"),
    speed: $("speed"), speedVal: $("speed-val"),
    clear: $("fl-clear"), reset: $("fl-reset"),
  };

  els.seg.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    state.mode = btn.dataset.mode;
    clearFields(); syncModeUI();
  });
  els.display.addEventListener("change", () => { state.display = els.display.value; });
  els.arrows.addEventListener("change", () => { state.arrows = els.arrows.checked; });
  bindSlider(els.visc, els.viscVal, "visc");
  bindSlider(els.diff, els.diffVal, "diff");
  bindSlider(els.force, els.forceVal, "force");
  bindSlider(els.vort, els.vortVal, "vort");
  bindSlider(els.speed, els.speedVal, "speed", (v) => v.toFixed(1));
  els.clear.addEventListener("click", clearFields);
  els.reset.addEventListener("click", () => {
    const mode = state.mode;
    state = { ...DEFAULTS, mode };
    clearFields(); applyStateToUI(); syncModeUI();
  });

  // interaction pointeur
  const toCell = (clientX, clientY) => {
    const r = canvas.getBoundingClientRect();
    const ci = clamp(Math.round(((clientX - r.left) / r.width) * N), 1, N);
    const cj = clamp(Math.round(((clientY - r.top) / r.height) * N), 1, N);
    return [ci, cj];
  };
  const setPos = (cx, cy, start) => {
    const [ci, cj] = toCell(cx, cy);
    if (start) { pointer.pci = ci; pointer.pcj = cj; }
    pointer.ci = ci; pointer.cj = cj;
  };
  canvas.addEventListener("mousedown", (e) => { pointer.down = true; setPos(e.clientX, e.clientY, true); });
  canvas.addEventListener("mousemove", (e) => { if (pointer.down) setPos(e.clientX, e.clientY, false); });
  window.addEventListener("mouseup", onUp);
  canvas.addEventListener("touchstart", (e) => {
    pointer.down = true; setPos(e.touches[0].clientX, e.touches[0].clientY, true); e.preventDefault();
  }, { passive: false });
  canvas.addEventListener("touchmove", (e) => {
    setPos(e.touches[0].clientX, e.touches[0].clientY, false); e.preventDefault();
  }, { passive: false });
  canvas.addEventListener("touchend", () => { pointer.down = false; });

  els.formula.textContent = FORMULA;
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
  els.desc.textContent = modeCfg().desc;
  // l'obstacle se voit mieux en vorticité
  if (state.mode === "obstacle") { state.display = "vort"; els.display.value = "vort"; }
}
function applyStateToUI() {
  els.display.value = state.display;
  els.arrows.checked = state.arrows;
  els.visc.value = state.visc; els.viscVal.textContent = state.visc;
  els.diff.value = state.diff; els.diffVal.textContent = state.diff;
  els.force.value = state.force; els.forceVal.textContent = state.force;
  els.vort.value = state.vort; els.vortVal.textContent = state.vort;
  els.speed.value = state.speed; els.speedVal.textContent = state.speed.toFixed(1);
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
  id: "fluids",
  title: "Fluides (Navier-Stokes)",
  subtitle: "Simulation temps réel d'un fluide incompressible (méthode Stable Fluids).",
  help: "Le solveur intègre les équations de <b>Navier-Stokes</b> incompressibles " +
        "(advection + diffusion visqueuse + projection de pression). <b>Remue à la " +
        "souris/au doigt</b> pour injecter mouvement et colorant. Essaie la " +
        "<b>cheminée</b> (convection) et l'<b>obstacle</b> (allée de von Kármán, " +
        "vue en vorticité). Joue sur la viscosité, le débit et le confinement de " +
        "vorticité pour changer de régime.",
  mount,
});
