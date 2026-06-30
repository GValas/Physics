import { register } from "../registry";

/* =========================================================================
   Module : Équations de Maxwell — rendu 3D avec caméra orbitale
   Cinq scènes — une par équation, plus l'onde EM de synthèse.
     1. ∇·E = ρ/ε₀          Gauss (électrique)
     2. ∇·B = 0             flux magnétique (pas de monopôle)
     3. ∇×E = −∂B/∂t        induction de Faraday
     4. ∇×B = μ₀J + μ₀ε₀∂ₜE Ampère–Maxwell
     5. onde électromagnétique (E⊥B se propageant à c)
   Moteur 3D maison : projection perspective + orbite à la souris (glisser).
   ========================================================================= */


const SIZE = 720;
const R = 2.5;                     // demi-étendue du domaine (coords monde)
const FOCAL = 820;                 // distance focale (perspective)
const A_REGION = 1.3;             // rayon de la zone de B variable (Faraday)
const POLE_N = 0.95;              // position du pôle N de l'aimant (sur +x)
const C = SIZE / 2;               // centre écran

/* ========================================================================= */
/*  État                                                                     */
/* ========================================================================= */
const DEFAULTS = {
  mode: "gauss-e",
  amp: 1.4, freq: 0.8, grid: 5, parts: 700, speed: 1,
  showArrows: true, showFlux: true, showFrame: true, showHelpers: true,
};
let state = { ...DEFAULTS };

let canvas = null, ctx = null, els = null, readout = null;
let rafId = null, running = false, lastT = 0, time = 0;

let particles = [];
let maxMag = 1;

/* caméra orbitale */
let cam = { yaw: -0.6, pitch: 0.5, dist: 7 };
let drag = { on: false, x: 0, y: 0, moved: 0 };

/* écouteurs window (orbite) — gardés pour pouvoir les retirer au démontage */
let onWinMove = null, onWinUp = null;

/* charges (mode Gauss électrique), dans le plan z = 0 */
let charges = [];
function defaultCharges() { return [{ x: -1, y: 0, z: 0, q: 1 }, { x: 1, y: 0, z: 0, q: -1 }]; }

/* ========================================================================= */
/*  Projection 3D -> écran                                                   */
/* ========================================================================= */
function project(x, y, z) {
  const cyA = Math.cos(cam.yaw), syA = Math.sin(cam.yaw);
  const cpA = Math.cos(cam.pitch), spA = Math.sin(cam.pitch);
  // rotation : yaw (autour de Y) puis pitch (autour de X)
  const vx = cyA * x + syA * z;
  const ry = y, rz = -syA * x + cyA * z;
  const vy = cpA * ry - spA * rz;
  const vz = spA * ry + cpA * rz;
  const depth = cam.dist - vz;            // > 0 devant la caméra
  const f = FOCAL / Math.max(depth, 0.05);
  return { x: C + vx * f, y: C - vy * f, depth, scale: f };
}
const NEAR = () => cam.dist - R - 0.5;
const FAR  = () => cam.dist + R + 0.5;
function depthAlpha(d) {
  const t = clamp((d - NEAR()) / (FAR() - NEAR()), 0, 1);
  return clamp(1.05 - 0.8 * t, 0.18, 1);
}

/* inversion : pixel -> point du plan z = 0 (pour ajouter une charge) */
function unprojectToZ0(sx, sy) {
  const cyA = Math.cos(cam.yaw), syA = Math.sin(cam.yaw);
  const cpA = Math.cos(cam.pitch), spA = Math.sin(cam.pitch);
  const a = (sx - C) / FOCAL, b = -(sy - C) / FOCAL;
  // v.x = cyA*wx ; v.y = cpA*wy + spA*syA*wx ; v.z = spA*wy - cpA*syA*wx
  const R00 = cyA, R01 = 0, R10 = spA * syA, R11 = cpA, R20 = -cpA * syA, R21 = spA;
  const A11 = R00 + a * R20, A12 = R01 + a * R21, c1 = a * cam.dist;
  const A21 = R10 + b * R20, A22 = R11 + b * R21, c2 = b * cam.dist;
  const det = A11 * A22 - A12 * A21;
  if (Math.abs(det) < 1e-6) return null;
  const wx = (c1 * A22 - A12 * c2) / det;
  const wy = (A11 * c2 - c1 * A21) / det;
  return [clamp(wx, -R, R), clamp(wy, -R, R)];
}

/* ========================================================================= */
/*  Champs 3D (vecteur à visualiser)                                         */
/* ========================================================================= */
function eFieldCharges(x, y, z) {
  let ex = 0, ey = 0, ez = 0;
  for (const c of charges) {
    const dx = x - c.x, dy = y - c.y, dz = z - c.z;
    const r2 = dx * dx + dy * dy + dz * dz + 0.04;
    const inv = (state.amp * c.q) / (r2 * Math.sqrt(r2));
    ex += dx * inv; ey += dy * inv; ez += dz * inv;
  }
  return [ex, ey, ez];
}
function bDipole(x, y, z) {                 // moment m le long de +x
  const r2 = x * x + y * y + z * z + 0.05, r = Math.sqrt(r2), r3 = r2 * r;
  const m = state.amp;
  const mdotr = (m * x) / r;
  return [(3 * mdotr * (x / r) - m) / r3,
          (3 * mdotr * (y / r)) / r3,
          (3 * mdotr * (z / r)) / r3];
}
function omega() { return 2 * Math.PI * state.freq * 0.45; }
function bUniform() { return state.amp * Math.sin(omega() * time); }
function dBdt()     { return state.amp * omega() * Math.cos(omega() * time); }
function eFaraday(x, y) {                    // E induit azimutal dans le plan xy
  const rho = Math.hypot(x, y) + 1e-6;
  const db = dBdt();
  const Ephi = rho < A_REGION ? -0.5 * rho * db : -0.5 * (A_REGION * A_REGION) / rho * db;
  return [Ephi * (-y / rho), Ephi * (x / rho), 0];
}
function bWire(x, y) {                       // B autour d'un fil le long de z
  const rho2 = x * x + y * y + 0.03, rho = Math.sqrt(rho2);
  const mag = state.amp / rho;
  return [mag * (-y / rho), mag * (x / rho), 0];
}
function field(x, y, z) {
  switch (state.mode) {
    case "gauss-e": return eFieldCharges(x, y, z);
    case "gauss-b": return bDipole(x, y, z);
    case "faraday": return eFaraday(x, y);
    case "ampere":  return bWire(x, y);
    default:        return [0, 0, 0];
  }
}
/* zones singulières à éviter pour l'échantillonnage */
function nearSingularity(x, y, z) {
  if (state.mode === "gauss-e")
    return charges.some((c) => Math.hypot(x - c.x, y - c.y, z - c.z) < 0.4);
  if (state.mode === "gauss-b") return Math.hypot(x, y, z) < 0.45;
  if (state.mode === "ampere" || state.mode === "faraday") return Math.hypot(x, y) < 0.35;
  return false;
}

/* ========================================================================= */
/*  Utilitaires                                                              */
/* ========================================================================= */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function fmt(v) {
  if (!isFinite(v)) return "∞";
  const a = Math.abs(v);
  if (a !== 0 && (a < 0.01 || a >= 1000)) return v.toExponential(2);
  return v.toFixed(2).replace("-0.00", "0.00");
}
function line3(a, b, rgb, w, alphaMul) {
  const pa = project(a[0], a[1], a[2]), pb = project(b[0], b[1], b[2]);
  const al = depthAlpha((pa.depth + pb.depth) / 2) * (alphaMul == null ? 1 : alphaMul);
  ctx.strokeStyle = `rgba(${rgb},${al})`;
  ctx.lineWidth = w || 1;
  ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
}
function arrow3(a, b, rgb, norm) {
  const pa = project(a[0], a[1], a[2]), pb = project(b[0], b[1], b[2]);
  const near = depthAlpha((pa.depth + pb.depth) / 2);
  const al = near * (0.3 + 0.7 * (norm == null ? 1 : norm));
  const w = (0.8 + 1.6 * (norm == null ? 1 : norm)) * (0.6 + 0.5 * near);
  ctx.strokeStyle = `rgba(${rgb},${al})`;
  ctx.fillStyle = `rgba(${rgb},${al})`;
  ctx.lineWidth = w;
  ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
  const ang = Math.atan2(pb.y - pa.y, pb.x - pa.x);
  const hs = 4 + w * 1.6;
  ctx.beginPath();
  ctx.moveTo(pb.x, pb.y);
  ctx.lineTo(pb.x - hs * Math.cos(ang - 0.42), pb.y - hs * Math.sin(ang - 0.42));
  ctx.lineTo(pb.x - hs * Math.cos(ang + 0.42), pb.y - hs * Math.sin(ang + 0.42));
  ctx.closePath(); ctx.fill();
}
function sphere(cx, cy, cz, rWorld, rgb, alpha) {
  const p = project(cx, cy, cz);
  const rad = rWorld * p.scale;
  const g = ctx.createRadialGradient(p.x - rad * 0.3, p.y - rad * 0.3, rad * 0.1, p.x, p.y, rad);
  g.addColorStop(0, `rgba(${rgb},${alpha})`);
  g.addColorStop(1, `rgba(${rgb},${alpha * 0.35})`);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 7); ctx.fill();
  return p;
}
/* cercle 3D paramétré dans un plan donné par deux vecteurs u, v */
function circle3(center, u, v, rad, rgb, w, alphaMul) {
  ctx.strokeStyle = `rgba(${rgb},${(alphaMul == null ? 1 : alphaMul)})`;
  ctx.lineWidth = w || 1.5;
  ctx.beginPath();
  const N = 60;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const x = center[0] + rad * (Math.cos(a) * u[0] + Math.sin(a) * v[0]);
    const y = center[1] + rad * (Math.cos(a) * u[1] + Math.sin(a) * v[1]);
    const z = center[2] + rad * (Math.cos(a) * u[2] + Math.sin(a) * v[2]);
    const p = project(x, y, z);
    i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
  }
  ctx.stroke();
}

/* ========================================================================= */
/*  Repère 3D (boîte + axes)                                                 */
/* ========================================================================= */
function drawFrame() {
  if (!state.showFrame) return;
  const s = R;
  const corners = [
    [-s, -s, -s], [s, -s, -s], [s, s, -s], [-s, s, -s],
    [-s, -s, s], [s, -s, s], [s, s, s], [-s, s, s],
  ];
  const edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
  for (const [i, j] of edges) line3(corners[i], corners[j], "120,140,170", 1, 0.35);
  // axes colorés
  arrow3([0,0,0], [s*1.05,0,0], "255,120,120", 1);
  arrow3([0,0,0], [0,s*1.05,0], "120,255,150", 1);
  arrow3([0,0,0], [0,0,s*1.05], "120,170,255", 1);
  label3(s*1.12,0,0,"x","#ff9090"); label3(0,s*1.12,0,"y","#90ffb0"); label3(0,0,s*1.12,"z","#90b0ff");
}
function label3(x, y, z, txt, color) {
  const p = project(x, y, z);
  ctx.fillStyle = color; ctx.font = "13px Consolas, monospace";
  ctx.fillText(txt, p.x + 3, p.y - 3);
}

/* ========================================================================= */
/*  Normalisation                                                            */
/* ========================================================================= */
function computeMaxMag() {
  let m = 1e-6; const N = 7;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) for (let k = 0; k <= N; k++) {
    const x = -R + (i / N) * 2 * R, y = -R + (j / N) * 2 * R, z = -R + (k / N) * 2 * R;
    if (nearSingularity(x, y, z)) continue;
    const v = field(x, y, z);
    const mag = Math.hypot(v[0], v[1], v[2]);
    if (mag > m && isFinite(mag)) m = mag;
  }
  maxMag = m;
}

/* ========================================================================= */
/*  Flèches du champ (échantillonnage 3D, trié en profondeur)                */
/* ========================================================================= */
function drawArrows() {
  if (!state.showArrows || state.mode === "wave") return;
  const n = state.grid, step = (2 * R) / (n - 1);
  const list = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
    const x = -R + i * step, y = -R + j * step, z = -R + k * step;
    if (nearSingularity(x, y, z)) continue;
    const v = field(x, y, z);
    const mag = Math.hypot(v[0], v[1], v[2]);
    if (mag < 1e-9 || !isFinite(mag)) continue;
    const norm = clamp(mag / maxMag, 0, 1);
    const len = step * 0.5 * (0.35 + 0.65 * Math.sqrt(norm));
    const ux = v[0] / mag, uy = v[1] / mag, uz = v[2] / mag;
    const a = [x - ux * len / 2, y - uy * len / 2, z - uz * len / 2];
    const b = [x + ux * len / 2, y + uy * len / 2, z + uz * len / 2];
    list.push({ depth: project(x, y, z).depth, a, b, norm });
  }
  list.sort((p, q) => q.depth - p.depth);     // loin -> près
  for (const it of list) arrow3(it.a, it.b, "228,236,248", it.norm);
}

/* ========================================================================= */
/*  Particules de flux (3D)                                                  */
/* ========================================================================= */
function rnd() { return (Math.random() * 2 - 1) * R; }
function sphereDir(r) {            // point aléatoire à distance r de l'origine
  const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return [r * s * Math.cos(th), r * s * Math.sin(th), r * u];
}
function spawnPos() {
  // Ré-émettre une partie des particules tout près des « sources » du champ,
  // sinon elles fuient si vite que les sources paraissent vides.
  if (state.mode === "gauss-e") {
    const pos = charges.filter((c) => c.q > 0);
    if (pos.length && Math.random() < 0.6) {
      const c = pos[(Math.random() * pos.length) | 0];
      const d = sphereDir(0.45 + Math.random() * 0.3);
      return [c.x + d[0], c.y + d[1], c.z + d[2]];
    }
  } else if (state.mode === "gauss-b") {
    // émettre autour du pôle N (+x) : les lignes en sortent et bouclent vers S
    if (Math.random() < 0.65) {
      const d = sphereDir(0.3 + Math.random() * 0.45);
      return [POLE_N + d[0], d[1], d[2]];
    }
  }
  return [rnd(), rnd(), rnd()];
}
function makeParticle() {
  const [x, y, z] = spawnPos();
  return { x, y, z, px: 0, py: 0, pz: 0,
           age: 0, maxAge: 50 + Math.random() * 120, init: false };
}
function syncParticles() {
  const n = state.mode === "wave" ? 0 : state.parts;
  if (particles.length < n) while (particles.length < n) particles.push(makeParticle());
  else particles.length = n;
}
function resetParticle(p) {
  const [x, y, z] = spawnPos();
  p.x = x; p.y = y; p.z = z; p.age = 0;
  p.maxAge = 50 + Math.random() * 120; p.init = false;
}
function stepParticles(dt) {
  if (!state.showFlux || state.mode === "wave") return;
  const k = (R * 0.9) / maxMag * state.speed * dt;
  const cap = R * 4 * dt * Math.max(state.speed, 0.2);   // déplacement max / image
  for (const p of particles) {
    const v = field(p.x, p.y, p.z);
    const mag = Math.hypot(v[0], v[1], v[2]);
    let dx = v[0] * k, dy = v[1] * k, dz = v[2] * k;
    const sl = Math.hypot(dx, dy, dz);
    if (sl > cap) { const s = cap / sl; dx *= s; dy *= s; dz *= s; }   // anti-téléport
    p.px = p.x; p.py = p.y; p.pz = p.z;
    p.x += dx; p.y += dy; p.z += dz;
    p.age++; p.lastMag = mag;
    if (!p.init) { p.px = p.x; p.py = p.y; p.pz = p.z; p.init = true; }
    if (p.age > p.maxAge || Math.abs(p.x) > R || Math.abs(p.y) > R ||
        Math.abs(p.z) > R || mag < 1e-7) resetParticle(p);
  }
}
function drawParticles() {
  if (!state.showFlux || state.mode === "wave") return;
  ctx.lineCap = "round";
  const col = (state.mode === "gauss-b" || state.mode === "ampere") ? "120,235,255" : "150,225,255";
  const list = [];
  for (const p of particles) {
    if (!p.init) continue;
    list.push({ depth: project(p.x, p.y, p.z).depth, p });
  }
  list.sort((a, b) => b.depth - a.depth);
  for (const { p } of list) {
    const a = project(p.px, p.py, p.pz), b = project(p.x, p.y, p.z);
    const norm = clamp((p.lastMag || 0) / maxMag, 0, 1);
    const fade = Math.sin((p.age / p.maxAge) * Math.PI);
    const alpha = clamp(0.15 + 0.7 * norm, 0, 0.85) * fade * depthAlpha(b.depth);
    ctx.strokeStyle = `rgba(${col},${alpha})`;
    ctx.lineWidth = (0.8 + 1.6 * norm) * (0.6 + 0.5 * depthAlpha(b.depth));
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
}

/* ========================================================================= */
/*  Repères propres à chaque scène (3D)                                      */
/* ========================================================================= */
function drawHelpers() {
  if (!state.showHelpers) return;
  if (state.mode === "gauss-e") helpGaussE();
  else if (state.mode === "gauss-b") helpGaussB();
  else if (state.mode === "faraday") helpFaraday();
  else if (state.mode === "ampere") helpAmpere();
}

function helpGaussE() {
  // surface de Gauss (sphère fil de fer) autour de l'origine
  const rg = 1.6;
  circle3([0,0,0], [1,0,0], [0,1,0], rg, "255,209,102", 1.2, 0.5);
  circle3([0,0,0], [1,0,0], [0,0,1], rg, "255,209,102", 1.2, 0.5);
  circle3([0,0,0], [0,1,0], [0,0,1], rg, "255,209,102", 1.2, 0.5);
  // charges, triées en profondeur
  const list = charges.map((c) => ({ c, depth: project(c.x, c.y, c.z).depth }));
  list.sort((a, b) => b.depth - a.depth);
  for (const { c } of list) {
    sphere(c.x, c.y, c.z, 0.22, c.q > 0 ? "255,77,77" : "88,166,255", 0.95);
    const p = project(c.x, c.y, c.z);
    ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.x - 5, p.y); ctx.lineTo(p.x + 5, p.y);
    if (c.q > 0) { ctx.moveTo(p.x, p.y - 5); ctx.lineTo(p.x, p.y + 5); }
    ctx.stroke();
  }
}
function helpGaussB() {
  // barreau aimanté le long de x : deux moitiés jointives S (−x) / N (+x)
  box3(-0.45, 0, 0, 0.9, 0.5, 0.5, "88,166,255");   // S côté −x
  box3(0.45, 0, 0, 0.9, 0.5, 0.5, "255,77,77");     // N côté +x
  label3(1.1, 0, 0, "N", "#ffb0b0"); label3(-1.1, 0, 0, "S", "#b0d0ff");
  // surface de Gauss : flux net nul
  circle3([0,0,0], [1,0,0], [0,1,0], 1.7, "255,209,102", 1.2, 0.45);
  circle3([0,0,0], [0,1,0], [0,0,1], 1.7, "255,209,102", 1.2, 0.45);
}
function box3(cx, cy, cz, w, h, d, rgb) {
  const hx = w/2, hy = h/2, hz = d/2;
  const c = [
    [cx-hx,cy-hy,cz-hz],[cx+hx,cy-hy,cz-hz],[cx+hx,cy+hy,cz-hz],[cx-hx,cy+hy,cz-hz],
    [cx-hx,cy-hy,cz+hz],[cx+hx,cy-hy,cz+hz],[cx+hx,cy+hy,cz+hz],[cx-hx,cy+hy,cz+hz],
  ];
  const e = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
  for (const [i,j] of e) line3(c[i], c[j], rgb, 2, 0.9);
}
function helpFaraday() {
  const B = bUniform(), sgn = B >= 0 ? 1 : -1, mB = Math.abs(B / state.amp);
  // disque de la zone de champ (dans le plan xy, z = 0)
  circle3([0,0,0], [1,0,0], [0,1,0], A_REGION, "255,255,255", 1.5, 0.5);
  // B le long de z, sur une grille dans le disque, longueur ∝ B(t)
  const len = sgn * (0.3 + 1.0 * mB);
  for (let gx = -1; gx <= 1; gx++) for (let gy = -1; gy <= 1; gy++) {
    const x = gx * 0.7, y = gy * 0.7;
    if (Math.hypot(x, y) > A_REGION) continue;
    arrow3([x, y, 0], [x, y, len], B >= 0 ? "255,138,93" : "88,166,255", 0.4 + 0.6 * mB);
  }
  // E induit : anneau circulant dans le plan xy, sens selon −dB/dt
  const ccw = -dBdt() >= 0;
  const rE = A_REGION * 0.8;
  circle3([0,0,0], [1,0,0], [0,1,0], rE, "124,255,178", 2, 0.9);
  for (let a = 0; a < 8; a++) {
    const ang = (a / 8) * Math.PI * 2;
    const x = rE * Math.cos(ang), y = rE * Math.sin(ang);
    const tx = -Math.sin(ang) * (ccw ? 1 : -1), ty = Math.cos(ang) * (ccw ? 1 : -1);
    arrow3([x, y, 0], [x + tx * 0.35, y + ty * 0.35, 0], "124,255,178", 0.9);
  }
}
function helpAmpere() {
  // fil le long de z + sens du courant
  line3([0,0,-R], [0,0,R], "255,209,102", 3, 1);
  arrow3([0,0,R*0.5], [0,0,R*0.95], "255,209,102", 1);
  label3(0, 0, R*1.0, "I", "#ffd166");
  // boucles d'Ampère à quelques niveaux z
  for (const z of [-1.2, 0, 1.2]) {
    circle3([0,0,z], [1,0,0], [0,1,0], 1.4, "255,209,102", 1.3, 0.55);
    for (let a = 0; a < 6; a++) {
      const ang = (a / 6) * Math.PI * 2 + 0.2;
      const x = 1.4 * Math.cos(ang), y = 1.4 * Math.sin(ang);
      const tx = -Math.sin(ang), ty = Math.cos(ang);
      arrow3([x, y, z], [x + tx * 0.3, y + ty * 0.3, z], "255,209,102", 0.7);
    }
  }
}

/* ========================================================================= */
/*  Onde électromagnétique (3D)                                              */
/* ========================================================================= */
function drawWave() {
  const k = 2 * Math.PI * state.freq * 0.9;
  const w = k * 1.0;
  const amp = state.amp * 0.85;
  const phase = (x) => k * x - w * time * state.speed;

  // axes
  arrow3([-R,0,0], [R*1.05,0,0], "159,176,200", 1);  label3(R*1.1,0,0,"x  (c)","#9fb0c8");
  arrow3([0,0,0], [0,R*0.9,0], "255,93,93", 1);       label3(0,R*0.95,0,"E","#ff5d5d");
  arrow3([0,0,0], [0,0,R*0.9], "88,166,255", 1);      label3(0,0,R*0.95,"B","#58a6ff");

  const N = 120;
  // courbe E (plan xy)
  ctx.strokeStyle = "#ff5d5d"; ctx.lineWidth = 2; ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const x = -R + (i / N) * 2 * R; const p = project(x, Math.sin(phase(x)) * amp, 0);
    i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
  }
  ctx.stroke();
  // courbe B (plan xz)
  ctx.strokeStyle = "#58a6ff"; ctx.lineWidth = 2; ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const x = -R + (i / N) * 2 * R; const p = project(x, 0, Math.sin(phase(x)) * amp);
    i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
  }
  ctx.stroke();
  // vecteurs échantillonnés E, B et S (Poynting)
  for (let i = 0; i <= 22; i++) {
    const x = -R + (i / 22) * 2 * R; const s = Math.sin(phase(x));
    arrow3([x,0,0], [x, s * amp, 0], "255,93,93", 0.35 + 0.5 * Math.abs(s));
    arrow3([x,0,0], [x, 0, s * amp], "88,166,255", 0.35 + 0.5 * Math.abs(s));
    // S = (1/μ₀) E×B  ∝ sin²(phase) : toujours selon +x (flux d'énergie), pulse
    const sp = s * s;
    arrow3([x,0,0], [x + amp * 0.6 * sp, 0, 0], "124,255,178", 0.3 + 0.6 * sp);
  }
  label3(amp * 0.6 + 0.1, 0, 0, "S", "#7cffb2");

  // équation de propagation (superposition fixe, indépendante de la rotation)
  ctx.fillStyle = "#cdd6e4"; ctx.font = "15px Consolas, monospace";
  ctx.fillText("∂²E/∂t² = c²·∂²E/∂x²", 16, 30);
  ctx.font = "12px Consolas, monospace"; ctx.fillStyle = "#9fb0c8";
  ctx.fillText("(idem pour B — équation d'onde de d'Alembert)", 16, 50);
  ctx.fillStyle = "#7cffb2";
  ctx.fillText("S = (1/μ₀) E×B   → flux d'énergie selon +x", 16, 68);
}

/* ========================================================================= */
/*  Bandeau de lecture (forme intégrale + valeurs en direct)                 */
/* ========================================================================= */
function updateReadout() {
  let txt = "";
  if (state.mode === "gauss-e") {
    let q = 0; for (const c of charges)
      if (Math.hypot(c.x, c.y, c.z) < 1.6) q += state.amp * c.q;
    txt = `∮ E·dA = Q_int/ε₀\nQ_int (sphère) = ${fmt(q)}\nΦ_E = ${fmt(q)}`;
  } else if (state.mode === "gauss-b") {
    txt = `∮ B·dA = 0\nautant de lignes sortent du N\nqu'il n'en rentre dans le S\n→ pas de monopôle`;
  } else if (state.mode === "faraday") {
    const emf = -Math.PI * A_REGION * A_REGION * dBdt();
    txt = `∮ E·dl = −dΦ_B/dt\nB(t) = ${fmt(bUniform())}\ndB/dt = ${fmt(dBdt())}\nf.é.m. = ${fmt(emf)}`;
  } else if (state.mode === "ampere") {
    txt = `∮ B·dl = μ₀ I_int\nI_int = ${fmt(state.amp)}\n∮ B·dl = ${fmt(state.amp)}`;
  } else {
    txt = `∂²E/∂t² = c²·∂²E/∂x²\nE ⊥ B ⊥ c,  |E| = c·|B|\nc = 1/√(μ₀ε₀)\nS = (1/μ₀) E×B  (→ +x)`;
  }
  readout.textContent = txt;
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
  ctx.fillStyle = "#060912"; ctx.fillRect(0, 0, SIZE, SIZE);

  drawFrame();
  if (state.mode === "wave") {
    drawWave();
  } else {
    computeMaxMag();
    drawArrows();
    stepParticles(dt);
    drawParticles();
    drawHelpers();
  }
  updateReadout();

  // indice d'interaction
  ctx.fillStyle = "rgba(159,176,200,0.55)"; ctx.font = "12px system-ui, sans-serif";
  ctx.fillText("glisser pour orbiter" + (state.mode === "gauss-e" ? "  ·  clic = charge (Maj = −)" : ""), 14, SIZE - 14);

  rafId = requestAnimationFrame(loop);
}

/* ========================================================================= */
/*  Textes                                                                   */
/* ========================================================================= */
const MODES = [
  { id: "gauss-e", label: "∇·E = ρ/ε₀",
    formula: "∮ E·dA = Q_int / ε₀        (∇·E = ρ/ε₀)",
    desc: "Théorème de Gauss : les charges sont les sources de E. Les lignes partent des + et se terminent sur les −. Clic = ajouter une charge (Maj+clic = négative)." },
  { id: "gauss-b", label: "∇·B = 0",
    formula: "∮ B·dA = 0                  (∇·B = 0)",
    desc: "Aucun monopôle : les lignes de B sont fermées. Le flux à travers toute surface fermée est nul." },
  { id: "faraday", label: "∇×E = −∂ₜB",
    formula: "∮ E·dl = − dΦ_B/dt          (∇×E = −∂B/∂t)",
    desc: "Induction de Faraday : un B variable (le long de z) engendre un E tourbillonnaire dans le plan xy. Le sens s'inverse avec dB/dt (loi de Lenz)." },
  { id: "ampere", label: "∇×B = μ₀J + μ₀ε₀∂ₜE",
    formula: "∮ B·dl = μ₀ I_int + μ₀ε₀ dΦ_E/dt",
    desc: "Théorème d'Ampère–Maxwell : un courant le long de z engendre un B tourbillonnaire qui circule autour du fil, à tous les niveaux." },
  { id: "wave", label: "Onde EM",
    formula: "∂²E/∂t² = c²·∂²E/∂x²   (équation d'onde)\nE ⊥ B ⊥ c,  |E| = c|B|,  c = 1/√(μ₀ε₀)\nS = (1/μ₀) E×B   (vecteur de Poynting)",
    desc: "Synthèse : E (selon y) et B (selon z) en phase se propagent selon x à la vitesse c. Le vecteur de Poynting S = E×B/μ₀ (vert) donne le flux d'énergie, toujours vers +x et pulsant en sin²." },
];
function modeCfg() { return MODES.find((m) => m.id === state.mode); }

/* ========================================================================= */
/*  Gabarit HTML                                                             */
/* ========================================================================= */
const TEMPLATE = `
<div class="sim-layout">
  <section class="stage">
    <canvas id="mx-canvas" width="${SIZE}" height="${SIZE}" aria-label="Équations de Maxwell (3D)"></canvas>
    <div id="mx-readout" class="probe-readout" aria-live="polite"></div>
  </section>

  <aside class="panel">
    <div class="group">
      <h2>Équation</h2>
      <div class="seg" id="mx-seg" role="tablist">
        ${MODES.map((m) => `<button class="seg-btn" data-mode="${m.id}">${m.label}</button>`).join("")}
      </div>
      <div class="formula" id="mx-formula"></div>
      <p class="hint" id="mx-desc"></p>
    </div>

    <div class="group">
      <h2>Paramètres</h2>
      <label class="slider">
        <span>Intensité <em id="amp-val">1.4</em></span>
        <input type="range" id="amp" min="0.2" max="3" step="0.1" value="1.4" />
      </label>
      <label class="slider">
        <span>Fréquence (temps) <em id="freq-val">0.8</em></span>
        <input type="range" id="freq" min="0.1" max="2" step="0.1" value="0.8" />
      </label>
      <label class="slider">
        <span>Densité des flèches <em id="grid-val">5</em></span>
        <input type="range" id="grid" min="3" max="8" step="1" value="5" />
      </label>
      <label class="slider">
        <span>Particules de flux <em id="parts-val">700</em></span>
        <input type="range" id="parts" min="0" max="2000" step="100" value="700" />
      </label>
      <label class="slider">
        <span>Vitesse <em id="speed-val">1.0</em></span>
        <input type="range" id="speed" min="0.2" max="3" step="0.1" value="1" />
      </label>
    </div>

    <div class="group">
      <h2>Affichage</h2>
      <label class="check"><input type="checkbox" id="show-arrows" checked /> Flèches du champ</label>
      <label class="check"><input type="checkbox" id="show-flux" checked /> Flux de particules</label>
      <label class="check"><input type="checkbox" id="show-frame" checked /> Boîte &amp; axes 3D</label>
      <label class="check"><input type="checkbox" id="show-helpers" checked /> Repères (charges, aimant, fil…)</label>
    </div>

    <div class="group">
      <button id="mx-view" class="reset" style="margin-bottom:8px">Vue par défaut</button>
      <button id="mx-reset" class="reset">Réinitialiser</button>
    </div>
  </aside>
</div>`;

/* ========================================================================= */
/*  Cycle de vie                                                             */
/* ========================================================================= */
function mount(root: HTMLElement) {
  root.innerHTML = TEMPLATE;
  state = { ...DEFAULTS };
  charges = defaultCharges();
  particles = []; time = 0; lastT = 0;
  cam = { yaw: -0.6, pitch: 0.5, dist: 7 };
  drag = { on: false, x: 0, y: 0, moved: 0 };

  canvas = root.querySelector("#mx-canvas");
  ctx = canvas.getContext("2d");
  readout = root.querySelector("#mx-readout");

  const $ = (id) => root.querySelector("#" + id);
  els = {
    seg: $("mx-seg"), formula: $("mx-formula"), desc: $("mx-desc"),
    amp: $("amp"), ampVal: $("amp-val"),
    freq: $("freq"), freqVal: $("freq-val"),
    grid: $("grid"), gridVal: $("grid-val"),
    parts: $("parts"), partsVal: $("parts-val"),
    speed: $("speed"), speedVal: $("speed-val"),
    showArrows: $("show-arrows"), showFlux: $("show-flux"),
    showFrame: $("show-frame"), showHelpers: $("show-helpers"),
    view: $("mx-view"), reset: $("mx-reset"),
  };

  els.seg.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    state.mode = btn.dataset.mode;
    if (state.mode === "gauss-e") charges = defaultCharges();
    syncModeUI(); syncParticles();
  });
  bindSlider(els.amp, els.ampVal, "amp", (v) => v.toFixed(1));
  bindSlider(els.freq, els.freqVal, "freq", (v) => v.toFixed(1));
  bindSlider(els.grid, els.gridVal, "grid", (v) => v, null, true);
  bindSlider(els.parts, els.partsVal, "parts", (v) => v, syncParticles, true);
  bindSlider(els.speed, els.speedVal, "speed", (v) => v.toFixed(1));
  bindCheck(els.showArrows, "showArrows");
  bindCheck(els.showFlux, "showFlux");
  bindCheck(els.showFrame, "showFrame");
  bindCheck(els.showHelpers, "showHelpers");

  els.view.addEventListener("click", () => { cam = { yaw: -0.6, pitch: 0.5, dist: 7 }; });
  els.reset.addEventListener("click", () => {
    const mode = state.mode;
    state = { ...DEFAULTS, mode };
    charges = defaultCharges();
    cam = { yaw: -0.6, pitch: 0.5, dist: 7 };
    applyStateToUI(); syncModeUI(); syncParticles();
  });

  /* ---- orbite à la souris (glisser) + clic pour ajouter une charge ---- */
  canvas.addEventListener("mousedown", (e) => {
    drag.on = true; drag.x = e.clientX; drag.y = e.clientY; drag.moved = 0;
    e.preventDefault();
  });
  onWinMove = (e) => {
    if (!drag.on) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    cam.yaw += dx * 0.01;
    cam.pitch = clamp(cam.pitch + dy * 0.01, -1.45, 1.45);
  };
  onWinUp = (e) => {
    if (!drag.on) return;
    drag.on = false;
    if (drag.moved < 5 && state.mode === "gauss-e") {     // clic franc -> charge
      const r = canvas.getBoundingClientRect();
      const sx = ((e.clientX - r.left) / r.width) * SIZE;
      const sy = ((e.clientY - r.top) / r.height) * SIZE;
      if (sx >= 0 && sx <= SIZE && sy >= 0 && sy <= SIZE) {
        const w = unprojectToZ0(sx, sy);
        if (w) charges.push({ x: w[0], y: w[1], z: 0, q: e.shiftKey ? -1 : 1 });
      }
    }
  };
  window.addEventListener("mousemove", onWinMove);
  window.addEventListener("mouseup", onWinUp);
  // molette : zoom
  canvas.addEventListener("wheel", (e) => {
    // min ≥ demi-diagonale de la boîte (R√3 ≈ 4.33) : sinon des coins passent
    // derrière la caméra (depth < 0) et la projection « explose » à l'écran
    cam.dist = clamp(cam.dist + Math.sign(e.deltaY) * 0.4, 5, 14);
    e.preventDefault();
  }, { passive: false });

  /* ---- tactile : 1 doigt = orbite, 2 doigts = zoom (pincement) ---- */
  let pinchDist = 0;
  const touchDist = (e) => {
    const a = e.touches[0], b = e.touches[1];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  };
  canvas.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) {
      drag.on = true; drag.x = e.touches[0].clientX; drag.y = e.touches[0].clientY; drag.moved = 0;
    } else if (e.touches.length === 2) {
      drag.on = false; pinchDist = touchDist(e);
    }
  }, { passive: false });
  canvas.addEventListener("touchmove", (e) => {
    if (e.touches.length === 1 && drag.on) {
      const t = e.touches[0];
      const dx = t.clientX - drag.x, dy = t.clientY - drag.y;
      drag.x = t.clientX; drag.y = t.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      cam.yaw += dx * 0.01;
      cam.pitch = clamp(cam.pitch + dy * 0.01, -1.45, 1.45);
      e.preventDefault();
    } else if (e.touches.length === 2) {
      const d = touchDist(e);
      if (pinchDist) cam.dist = clamp(cam.dist * (pinchDist / d), 5, 14);
      pinchDist = d;
      e.preventDefault();
    }
  }, { passive: false });
  canvas.addEventListener("touchend", (e) => {
    if (drag.on && drag.moved < 8 && state.mode === "gauss-e" && e.changedTouches[0]) {
      const r = canvas.getBoundingClientRect();
      const sx = ((e.changedTouches[0].clientX - r.left) / r.width) * SIZE;
      const sy = ((e.changedTouches[0].clientY - r.top) / r.height) * SIZE;
      const w = unprojectToZ0(sx, sy);
      if (w) charges.push({ x: w[0], y: w[1], z: 0, q: 1 });
    }
    if (e.touches.length === 0) { drag.on = false; pinchDist = 0; }
  });

  applyStateToUI(); syncModeUI(); syncParticles();
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
function syncModeUI() {
  els.seg.querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === state.mode));
  const cfg = modeCfg();
  els.formula.textContent = cfg.formula;
  els.desc.textContent = cfg.desc;
}
function applyStateToUI() {
  els.amp.value = state.amp; els.ampVal.textContent = state.amp.toFixed(1);
  els.freq.value = state.freq; els.freqVal.textContent = state.freq.toFixed(1);
  els.grid.value = state.grid; els.gridVal.textContent = state.grid;
  els.parts.value = state.parts; els.partsVal.textContent = state.parts;
  els.speed.value = state.speed; els.speedVal.textContent = state.speed.toFixed(1);
  els.showArrows.checked = state.showArrows;
  els.showFlux.checked = state.showFlux;
  els.showFrame.checked = state.showFrame;
  els.showHelpers.checked = state.showHelpers;
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
  id: "maxwell",
  title: "Équations de Maxwell",
  subtitle: "Les quatre équations de Maxwell en 3D (caméra orbitale) + l'onde EM de synthèse.",
  help: "Choisis une équation puis <b>glisse à la souris pour orbiter</b> autour de la scène " +
        "(molette = zoom). Gauss électrique (charges sources de E), flux magnétique nul " +
        "(lignes de B fermées), Faraday (B variable → E tourbillonnaire), Ampère–Maxwell " +
        "(courant → B tourbillonnaire), puis l'onde EM (E⊥B se propageant à c). En mode " +
        "Gauss, un <b>clic franc ajoute une charge</b> (Maj+clic = négative).",
  mount,
});

