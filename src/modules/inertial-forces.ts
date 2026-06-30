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
/*  Scène « Planète » : petit moteur 3D + sphère orientable                  */
/* ========================================================================= */
const PA = [0, 1, 0];                       // axe de rotation de la planète (pôles N/S)
const FOCAL = 820;
let cam = { yaw: 0.6, pitch: 0.5, dist: 3.2 };
let drag = { on: false, x: 0, y: 0 };

/* mobile sur la sphère (repère INERTIEL, vecteurs unitaires) */
let sphStart = [0, 0, 1], gcAxis = [-1, 0, 0];
let gcArc = 0, gcSpeed = 0.8, spin = 0;
let trail3 = [];                            // trace au sol (planète-fixe)

const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vscale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
function vnorm(a) { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
/* rotation de Rodrigues autour d'un axe unitaire k */
function rotAxis(v, k, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const kv = vcross(k, v), kd = vdot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd,
          v[1] * c + kv[1] * s + k[1] * kd,
          v[2] * c + kv[2] * s + k[2] * kd];
}
function project3(v) {
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  const x1 = v[0] * cy + v[2] * sy, z1 = -v[0] * sy + v[2] * cy, y1 = v[1];
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const y2 = y1 * cp - z1 * sp, z2 = y1 * sp + z1 * cp;
  const depth = cam.dist - z2;
  const f = FOCAL / Math.max(depth, 0.05);
  return { x: CX + x1 * f, y: CY - y2 * f, vz: z2, behind: depth <= 0.05 };
}
/* grille (parallèles + méridiens) en coordonnées planète-fixe */
function buildGrid() {
  const par = [], mer = [];
  for (let lat = -60; lat <= 60; lat += 30) {
    const pts = [], cl = Math.cos(lat * Math.PI / 180), sl = Math.sin(lat * Math.PI / 180);
    for (let lo = 0; lo <= 360; lo += 12) { const a = lo * Math.PI / 180; pts.push([cl * Math.sin(a), sl, cl * Math.cos(a)]); }
    par.push({ pts, lat });
  }
  for (let lo = 0; lo < 360; lo += 30) {
    const pts = [], a = lo * Math.PI / 180;
    for (let lat = -90; lat <= 90; lat += 9) {
      const cl = Math.cos(lat * Math.PI / 180), sl = Math.sin(lat * Math.PI / 180);
      pts.push([cl * Math.sin(a), sl, cl * Math.cos(a)]);
    }
    mer.push({ pts, lon: lo });
  }
  return { par, mer };
}
let GRID = null;
/* point planète-fixe → monde, selon le référentiel choisi (cf. trace gravée 2D) */
function worldPF(v) { return state.view === "inertial" ? rotAxis(v, PA, spin) : v; }
function spherePos() { return rotAxis(sphStart, gcAxis, gcArc); }   // position inertielle

/* ========================================================================= */
/*  Lancement d'une scène                                                    */
/* ========================================================================= */
function launch() {
  omegaPrev = state.omega; alpha = 0;          // θ reste continu (le plateau ne « saute » pas)
  trailIn = []; trailRot = [];
  if (state.mode === "sphere") { launchSphere(); return; }
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
function launchSphere() {
  if (!GRID) GRID = buildGrid();
  sphStart = [0, 0, 1];                        // départ à l'équateur, face à la caméra
  gcAxis = vnorm(vcross(sphStart, [0, 1, 0])); // grand cercle = méridien (cap plein nord)
  gcArc = 0; trail3 = [];
  gcSpeed = state.vmag / 220;                  // vitesse angulaire sur la sphère
}

/* ========================================================================= */
/*  Intégration (repère inertiel : ligne droite, sans frottement)            */
/* ========================================================================= */
function stepSphere(dt) {
  alpha = (state.omega - omegaPrev) / dt; omegaPrev = state.omega;
  spin += state.omega * dt;
  if (spin > TWO_PI) spin -= TWO_PI; else if (spin < -TWO_PI) spin += TWO_PI;
  gcArc += gcSpeed * dt;
  const pf = rotAxis(spherePos(), PA, -spin);  // trace au sol (planète-fixe)
  trail3.push(pf);
  if (trail3.length > 900) trail3.shift();
  if (gcArc > TWO_PI) launchSphere();          // tour complet → on relance
}
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
/*  Rendu — scène « Planète » (sphère 3D)                                    */
/* ========================================================================= */
function drawPath3(wpts, rgb, width) {
  ctx.lineWidth = width;
  for (let i = 1; i < wpts.length; i++) {
    const a = project3(wpts[i - 1]), b = project3(wpts[i]);
    if (a.behind || b.behind) continue;
    const al = (a.vz + b.vz) * 0.5 > 0 ? 0.95 : 0.14;   // face avant nette, face arrière estompée
    ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${al})`;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
}
function arrow3(base, vec, len, color) {
  const d = vnorm(vec); if (vlen(vec) < 1e-6) return;
  const a = project3(base), b = project3(vadd(base, vscale(d, len)));
  if (a.behind || b.behind || a.vz < 0) return;          // masqué si derrière la sphère
  arrow(a.x, a.y, b.x, b.y, color, 3);
}
function renderSphere() {
  ctx.fillStyle = "#060912"; ctx.fillRect(0, 0, SIZE, SIZE);
  if (!GRID) GRID = buildGrid();

  // corps de la planète (disque ombré)
  const c = project3([0, 0, 0]);
  const R = FOCAL / Math.sqrt(Math.max(cam.dist * cam.dist - 1, 0.04));   // rayon de la silhouette
  const g = ctx.createRadialGradient(c.x - R * 0.35, c.y - R * 0.35, R * 0.15, c.x, c.y, R);
  g.addColorStop(0, "#16263e"); g.addColorStop(1, "#091018");
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c.x, c.y, R, 0, TWO_PI); ctx.fill();

  // grille : parallèles (équateur en bleu) + méridiens (méridien d'origine en rouge)
  for (const par of GRID.par) drawPath3(par.pts.map(worldPF), par.lat === 0 ? [90, 200, 255] : [74, 92, 122], par.lat === 0 ? 2 : 1);
  for (const mer of GRID.mer) drawPath3(mer.pts.map(worldPF), mer.lon === 0 ? [255, 140, 110] : [74, 92, 122], mer.lon === 0 ? 2.4 : 1);

  // axe de rotation + pôles (invariants par la rotation)
  drawPath3([[0, -1.18, 0], [0, 1.18, 0]], [150, 170, 200], 1.5);
  for (const [pole, lbl] of [[[0, 1.13, 0], "N"], [[0, -1.13, 0], "S"]]) {
    const s = project3(pole);
    ctx.fillStyle = "#cfe0f5"; ctx.font = "13px Segoe UI, sans-serif"; ctx.textAlign = "center";
    ctx.fillText(lbl, s.x, s.y + 4);
  }

  // trajectoire : grand cercle (vue inertielle) ou trace au sol qui dévie (vue tournante)
  if (state.showTrace) drawPath3(trail3.map(worldPF), [255, 190, 90], 2.6);

  // mobile + vecteurs
  const posIn = spherePos();
  const pf = rotAxis(posIn, PA, -spin);
  const world = state.view === "inertial" ? posIn : pf;
  const sp = project3(world);
  if (!sp.behind) {
    const front = sp.vz > 0;
    ctx.fillStyle = front ? "#5dd0ff" : "rgba(93,208,255,0.4)";
    ctx.beginPath(); ctx.arc(sp.x, sp.y, front ? 7 : 5, 0, TWO_PI); ctx.fill();
  }

  // vitesse (apparente) + force de Coriolis
  const velIn = vscale(vnorm(vcross(gcAxis, posIn)), gcSpeed);
  if (state.view === "inertial") {
    arrow3(world, velIn, 0.33, "#cfe8ff");
  } else {
    const vRot = vsub(rotAxis(velIn, PA, -spin), vscale(vcross(PA, pf), state.omega));
    arrow3(world, vRot, 0.33, "#cfe8ff");
    if (state.showForces && Math.abs(state.omega) > 0.02) {
      const aCor = vscale(vcross(PA, vRot), -2 * state.omega);   // −2 Ω×v
      arrow3(world, aCor, 0.30, "#7CFFB2");
    }
  }

  banner(state.view === "inertial"
    ? "Galiléen : le mobile suit une géodésique (grand cercle) ; la planète tourne dessous."
    : "Tournant : vu du sol, la trajectoire dévie (Coriolis) — d'autant plus que la latitude est élevée.");
  ctx.fillStyle = "rgba(159,176,200,0.7)"; ctx.font = "12px Segoe UI, sans-serif"; ctx.textAlign = "center";
  ctx.fillText("Glisse pour réorienter le globe · molette pour zoomer · vois-le depuis le pôle N", CX, SIZE - 14);
}

/* ========================================================================= */
/*  Boucle                                                                   */
/* ========================================================================= */
function loop(t) {
  if (!running) return;
  let dt = (t - lastT) / 1000; lastT = t;
  if (!isFinite(dt) || dt <= 0) dt = 0.016;
  dt = clamp(dt, 0.008, 0.033) * state.speed;
  if (state.mode === "sphere") {
    stepSphere(dt); renderSphere();
  } else {
    step(dt);
    if (state.view === "inertial") renderInertial(); else renderRotating();
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
  if (state.mode === "sphere") {
    const lat = Math.asin(clamp(spherePos()[1], -1, 1)) * 180 / Math.PI;
    const f = 2 * state.omega * Math.sin(lat * Math.PI / 180);
    els.meas.innerHTML =
      row("Vitesse angulaire ω", state.omega.toFixed(2) + " rad/s") +
      row("Période T", state.omega !== 0 ? (TWO_PI / Math.abs(state.omega)).toFixed(1) + " s" : "∞") +
      row("Latitude φ", lat.toFixed(0) + "°") +
      row("Coriolis f = 2Ω·sinφ", f.toFixed(2)) +
      row("Référentiel", state.view === "inertial" ? "galiléen" : "tournant");
    return;
  }
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
  { id: "sphere", label: "Planète (sphère 3D)",
    formula: "f = 2 Ω · sin φ   (paramètre de Coriolis)",
    desc: "Une planète en rotation, orientable à la souris. On lance un mobile à l'équateur, plein nord : dans le labo il suit un grand cercle (géodésique), mais vu du sol sa trajectoire dévie vers la droite (hémisphère nord) — d'autant plus fort qu'on approche du pôle. Coriolis est donc nul à l'équateur et maximal aux pôles (f = 2Ω·sinφ). Regarde le globe par le pôle Nord : on retrouve exactement le plateau tournant !" },
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
  cam = { yaw: 0.6, pitch: 0.5, dist: 3.2 }; drag = { on: false, x: 0, y: 0 }; spin = 0;

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
    cam = { yaw: 0.6, pitch: 0.5, dist: 3.2 };
    applyStateToUI(); launch(); syncUI();
  });

  // caméra orbitale (scène sphère uniquement)
  const orbitStart = (cx, cy) => { drag.on = true; drag.x = cx; drag.y = cy; };
  const orbitMove = (cx, cy) => {
    if (!drag.on || state.mode !== "sphere") return;
    cam.yaw += (cx - drag.x) * 0.01;
    cam.pitch = clamp(cam.pitch + (cy - drag.y) * 0.01, -1.45, 1.45);
    drag.x = cx; drag.y = cy;
  };
  canvas.addEventListener("mousedown", (e) => orbitStart(e.clientX, e.clientY));
  canvas.addEventListener("mousemove", (e) => orbitMove(e.clientX, e.clientY));
  window.addEventListener("mouseup", onWinUp);
  canvas.addEventListener("wheel", (e) => {
    if (state.mode !== "sphere") return;
    cam.dist = clamp(cam.dist + (e.deltaY > 0 ? 0.3 : -0.3), 2.2, 6);
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener("touchstart", (e) => { orbitStart(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); }, { passive: false });
  canvas.addEventListener("touchmove", (e) => { orbitMove(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); }, { passive: false });
  canvas.addEventListener("touchend", () => { drag.on = false; });

  applyStateToUI(); launch(); syncUI();
  running = true;
  rafId = requestAnimationFrame(loop);
  return { unmount };
}
function onWinUp() { drag.on = false; }
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
  window.removeEventListener("mouseup", onWinUp);
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
        "les deux référentiels pour voir la même trajectoire changer d'allure. La scène " +
        "<b>Planète (sphère 3D)</b>, orientable à la souris, montre pourquoi Coriolis est " +
        "nul à l'équateur et maximal aux pôles (f = 2Ω·sinφ) — c'est elle qui dévie " +
        "vents et courants sur la Terre en rotation.",
  mount,
});
