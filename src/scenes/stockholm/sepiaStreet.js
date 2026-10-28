/**
 * "Stockholm i sepia": the user's Canvas 2D drawing of a Stockholm street
 * opening onto Riddarfjärden and Stadshuset (2026-10-27), ported from their
 * standalone page with the drawing code kept as it was. A dark projection
 * room around a 2:1 sepia film frame: static layers (sky, Stadshuset, the
 * quay, the street walls) are drawn once per size into offscreen canvases;
 * walkers, the No. 7 tram, a steamboat, gulls, the water's reflection and
 * the film artefacts (flicker, jitter, scratches, dust, grain) move on top.
 *
 * Scene4Stockholm.js owns the clock and the music. It calls
 *   build(width, height)       on resize: lays the frame out and redraws the static layers
 *   step(simDt, peopleDt, crossDt)  moves the tram, the walkers and the street-crossers (each on its own music-driven clock)
 *   filmTick(mod)              once per film frame: new flicker / jitter / dust / scratches
 *   draw(simDt, realDt, mod)   renders a frame into the canvas
 *   addCrosser() / crossing()  sends someone across the street (left -> right) / how many are crossing
 *   addDogWalker(z) / dogWalking()  sends a person with a dog across, close to the viewer / whether one is out
 * where `mod` carries the music's influence on the film treatment:
 *   { flicker, shake, dust, grain, flash } (1 / 1 / 1 / 1 / 0 = the page's own look).
 */
const W = 1600, H = 800, VX = 800, VY = 440, F = 700, EYE = 1.7;
const TAU = Math.PI * 2;

// sepia ramp: 0 = deep brown-black, 1 = pale paper
const DK = [26, 22, 18], LT = [236, 226, 204];
function S(l, a = 1) {
  l = Math.max(0, Math.min(1, l));
  return `rgba(${DK[0] + (LT[0] - DK[0]) * l | 0},${DK[1] + (LT[1] - DK[1]) * l | 0},${DK[2] + (LT[2] - DK[2]) * l | 0},${a})`;
}
// 3D -> screen. Y = metres above ground, Z = metres ahead of camera
function P(X, Y, Z) { return [VX + F * X / Z, VY + F * (EYE - Y) / Z]; }
function path(c, pts) { c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]); c.closePath(); }
function quad(c, pts, fill) { path(c, pts); c.fillStyle = fill; c.fill(); }
function line(c, a, b) { c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }
let seed = 7;
function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }

/* ---------- shared drawing pieces ---------- */
function cobbles(c, z0, z1, x0, x1, tone, rowD, stone, y = 0, gap = .03) {
  quad(c, [P(x0, y, z0), P(x1, y, z0), P(x1, y, z1), P(x0, y, z1)], S(tone - .2));
  let row = 0;
  for (let z = z0; z < z1 - .001; z += rowD, row++) {
    const za = z + gap, zb = Math.min(z + rowD, z1) - gap;
    const off = (row % 2) * stone / 2;
    for (let X = x0 - off; X < x1; X += stone) {
      const xa = Math.max(X, x0) + gap, xb = Math.min(X + stone, x1) - gap;
      if (xb <= xa) continue;
      quad(c, [P(xa, y, za), P(xb, y, za), P(xb, y, zb), P(xa, y, zb)], S(tone + (rnd() - .5) * .13));
    }
  }
}

function lamp(c, X, Z, y0 = 0) {
  const sc = F / Z, [x, yb] = P(X, y0, Z), u = v => v * sc;
  c.fillStyle = S(.13);
  c.fillRect(x - u(.13), yb - u(.5), u(.26), u(.5));
  c.fillRect(x - u(.06), yb - u(3.9), u(.12), u(3.9));
  c.fillRect(x - u(.11), yb - u(4.0), u(.22), u(.1));
  const g = [[x - u(.17), yb - u(4.0)], [x + u(.17), yb - u(4.0)], [x + u(.23), yb - u(4.7)], [x - u(.23), yb - u(4.7)]];
  quad(c, g, S(.8));
  c.strokeStyle = S(.13); c.lineWidth = Math.max(1, u(.04)); path(c, g); c.stroke();
  line(c, [x, yb - u(4.0)], [x, yb - u(4.7)]);
  quad(c, [[x - u(.33), yb - u(4.7)], [x + u(.33), yb - u(4.7)], [x, yb - u(5.05)]], S(.13));
  c.fillStyle = S(.13); c.fillRect(x - u(.025), yb - u(5.25), u(.05), u(.22));
}

function tree(c, X, Z, h) {
  const sc = F / Z, [x, y] = P(X, 0, Z);
  c.strokeStyle = S(.34, .85); c.lineCap = 'round';
  (function br(x, y, a, len, w, d) {
    const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
    c.lineWidth = Math.max(.5, w); line(c, [x, y], [x2, y2]);
    if (!d) return;
    const n = 2 + (rnd() * 2 | 0);
    for (let i = 0; i < n; i++) br(x2, y2, a + (rnd() - .5) * 1.15, len * (.6 + rnd() * .16), w * .64, d - 1);
  })(x, y, -Math.PI / 2, .36 * h * sc, .3 * sc, 6);
  c.fillStyle = S(.36, .2);
  const cx = x, cy = y - .66 * h * sc, rx = .34 * h * sc, ry = .3 * h * sc;
  for (let i = 0; i < 900; i++) {
    const a = rnd() * TAU, r = Math.sqrt(rnd());
    c.fillRect(cx + Math.cos(a) * r * rx, cy + Math.sin(a) * r * ry, 1.4, 1.4);
  }
}

/* ---------- static layers ---------- */
function drawBack(c) {
  const base = 448;
  const g = c.createLinearGradient(0, 0, 0, base);
  g.addColorStop(0, S(.76)); g.addColorStop(1, S(.88));
  c.fillStyle = g; c.fillRect(0, 0, W, base + 2);
  for (let i = 0; i < 16; i++) {
    c.fillStyle = S(.97, .1);
    c.beginPath(); c.ellipse(rnd() * W, 40 + rnd() * 230, 80 + rnd() * 160, 8 + rnd() * 16, 0, 0, TAU); c.fill();
  }
  // distant Kungsholmen / Norr Mälarstrand blocks
  for (const [a, b] of [[300, 482], [1118, 1320]]) {
    for (let x = a; x < b;) {
      const w = 18 + rnd() * 30, h = 26 + rnd() * 46, tone = .7 + rnd() * .08;
      c.fillStyle = S(tone); c.fillRect(x, base - h, w + 1, h);
      c.fillStyle = S(tone - .1);
      for (let wy = base - h + 6; wy < base - 6; wy += 8) for (let wx = x + 3; wx < x + w - 3; wx += 6) c.fillRect(wx, wy, 2, 3);
      x += w;
    }
  }
  // distant church spire on the left bank
  c.fillStyle = S(.68);
  c.fillRect(448, base - 112, 14, 70);
  quad(c, [[446, base - 112], [464, base - 112], [455, base - 200]], S(.66));
  c.fillRect(454, base - 214, 2, 16);

  /* --- Stadshuset --- */
  // main body + raised centre block
  c.fillStyle = S(.5); c.fillRect(480, 330, 640, base - 330);
  c.fillRect(690, 316, 200, 16);
  quad(c, [[474, 331], [492, 313], [1108, 313], [1126, 331]], S(.6));
  quad(c, [[684, 317], [700, 300], [880, 300], [896, 317]], S(.62));
  // dormers
  c.fillStyle = S(.54);
  for (let x = 520; x < 1090; x += 46) { if (x > 670 && x < 900) continue; c.fillRect(x, 318, 8, 9); }
  // brick coursing
  c.fillStyle = S(.3, .11);
  for (let y = 333; y < base; y += 3) c.fillRect(480, y, 640, 1);
  // window rows
  c.fillStyle = S(.24);
  for (const wy of [340, 362]) for (let x = 494; x < 1110; x += 20) c.fillRect(x, wy, 6, 12);
  for (let x = 700; x < 885; x += 24) c.fillRect(x, 320, 5, 8);
  // tall arched windows
  for (let x = 498; x < 1110; x += 34) {
    if (x > 600 && x < 950) continue;
    c.fillRect(x, 384, 8, 18); c.beginPath(); c.arc(x + 4, 384, 4, Math.PI, 0); c.fill();
  }
  // the waterside arcade
  c.fillStyle = S(.26); c.fillRect(620, 404, 320, base - 404);
  c.fillStyle = S(.62); c.fillRect(616, 397, 328, 6);
  c.strokeStyle = S(.66); c.lineWidth = 2.4;
  for (let x = 620; x < 940; x += 20) { c.beginPath(); c.arc(x + 10, 414, 9, Math.PI, 0); c.stroke(); }
  c.fillStyle = S(.66);
  for (let x = 620; x <= 940; x += 20) c.fillRect(x - 2, 412, 4, base - 412);
  // small west tower with cupola
  c.fillStyle = S(.5); c.fillRect(505, 262, 36, 70);
  c.fillStyle = S(.3, .12); for (let y = 264; y < 330; y += 3) c.fillRect(505, y, 36, 1);
  c.fillStyle = S(.24); c.fillRect(514, 280, 4, 14); c.fillRect(528, 280, 4, 14);
  c.fillStyle = S(.62); c.fillRect(501, 258, 44, 5);
  c.fillStyle = S(.66); c.beginPath(); c.arc(523, 258, 16, Math.PI, 0); c.fill();
  c.fillRect(519, 234, 8, 10); c.fillRect(522, 222, 2, 12);

  // main tower
  quad(c, [[990, base], [1070, base], [1067, 125], [993, 125]], S(.52));
  c.fillStyle = S(.3, .12); for (let y = 128; y < base; y += 3) c.fillRect(990, y, 80, 1);
  quad(c, [[1052, base], [1070, base], [1067, 125], [1050, 125]], S(.2, .14));
  c.fillStyle = S(.22);
  for (const wy of [168, 232, 296, 352]) for (const wx of [1009, 1023, 1037, 1051]) c.fillRect(wx - 2, wy, 4, 22);
  // cornice, belfry, lantern
  c.fillStyle = S(.64); c.fillRect(985, 116, 90, 9);
  c.fillStyle = S(.55); for (let x = 989; x < 1072; x += 7) c.fillRect(x, 125, 3, 4);
  c.fillStyle = S(.52); c.fillRect(998, 72, 64, 45);
  c.fillStyle = S(.22);
  for (const x of [1006, 1024, 1042]) { c.fillRect(x, 84, 12, 28); c.beginPath(); c.arc(x + 6, 84, 6, Math.PI, 0); c.fill(); }
  c.fillStyle = S(.64); c.fillRect(994, 66, 72, 7);
  const lan = [[1002, 66], [1058, 66], [1052, 54], [1044, 45], [1036, 38], [1024, 38], [1016, 45], [1008, 54]];
  quad(c, lan, S(.68));
  c.strokeStyle = S(.48); c.lineWidth = 1;
  for (const x of [1016, 1030, 1044]) line(c, [x, 64], [1030 + (x - 1030) * .4, 40]);
  c.fillStyle = S(.72); c.fillRect(1028, 22, 4, 17);
  // Tre Kronor
  c.fillStyle = S(.93); c.strokeStyle = S(.35); c.lineWidth = .8;
  c.fillRect(1013, 22, 34, 2);
  for (const [cx, cy] of [[1018, 21], [1030, 17], [1042, 21]]) {
    const cr = [[cx - 5, cy], [cx - 5, cy - 5], [cx - 2.5, cy - 2], [cx, cy - 6.5], [cx + 2.5, cy - 2], [cx + 5, cy - 5], [cx + 5, cy]];
    path(c, cr); c.fill(); c.stroke();
  }
  // terrace wall and garden at the water
  c.fillStyle = S(.62); c.fillRect(470, 441, 660, 7);
  c.fillStyle = S(.34);
  for (const x of [490, 520, 556, 590, 960, 996, 1040, 1088]) { c.beginPath(); c.ellipse(x, 438, 13, 8, 0, 0, TAU); c.fill(); }

  // atmospheric haze over everything far away
  c.fillStyle = S(.86, .16); c.fillRect(0, 0, W, base);
  c.fillStyle = S(.38); c.fillRect(0, base - 1, W, 2);
}

function drawMid(c) {
  const ZQ = 21;
  cobbles(c, 13, ZQ, -27, 27, .5, .2, .26);
  // tram rails
  c.strokeStyle = S(.25, .7); c.lineWidth = 1;
  for (const z of [17.9, 19.1]) line(c, P(-40, 0, z), P(40, 0, z));
  // quay edge stones
  const [, ye] = P(0, 0, ZQ), [, yt] = P(0, .3, ZQ);
  c.fillStyle = S(.64); c.fillRect(0, yt, W, ye - yt + 1);
  // railing
  c.strokeStyle = S(.18); c.lineWidth = 2;
  for (let X = -30; X <= 30; X += 1.6) line(c, P(X, .3, ZQ - .2), P(X, 1.05, ZQ - .2));
  c.lineWidth = 1.6; line(c, P(-40, 1.05, ZQ - .2), P(40, 1.05, ZQ - .2));
  c.lineWidth = 1; line(c, P(-40, .62, ZQ - .2), P(40, .62, ZQ - .2));
  // bare trees and plaza lamps
  tree(c, -10.5, 19.6, 9);
  tree(c, 10.8, 19.4, 9.4);
  tree(c, -17, 20, 8.5);
  lamp(c, -4.6, 20.2); lamp(c, 4.6, 20.2);
  // tram wire and stays
  c.strokeStyle = S(.15, .8); c.lineWidth = 1.1;
  line(c, P(-40, 6, 18.5), P(40, 6, 18.5));
  c.lineWidth = .9;
  line(c, P(-7, 7, 13), P(-1.8, 6, 18.5)); line(c, P(7, 7, 13), P(1.8, 6, 18.5));
}

function wallSeg(c, X, z0, z1, tone, variant) {
  const q = (y0, y1, za, zb, col) => quad(c, [P(X, y0, za), P(X, y0, zb), P(X, y1, zb), P(X, y1, za)], col);
  q(0, 26, z0, z1, S(tone));
  c.lineWidth = 1;
  c.strokeStyle = S(tone - .28, .35);
  for (let y = .45; y < 4.2; y += .45) line(c, P(X, y, z0), P(X, y, z1));
  c.strokeStyle = S(tone - .2, .1);
  for (let y = 4.9; y < 26; y += .55) line(c, P(X, y, z0), P(X, y, z1));
  const bay = 1.7;
  for (let z = z0 + .35; z + 1.2 < z1; z += bay) {
    q(.25, 3.5, z, z + 1.15, S(.13));
    q(3.5, 3.68, z - .06, z + 1.21, S(tone + .12));
  }
  q(4.2, 4.65, z0, z1, S(tone + .17));
  q(4.02, 4.2, z0, z1, S(tone - .3, .6));
  [5.3, 8.7, 12.1, 15.5, 18.9].forEach((f, i) => {
    q(f - .52, f - .36, z0, z1, S(tone + .1, .8));
    for (let z = z0 + .5; z + .9 < z1; z += bay) {
      q(f - .12, f + 2.12, z - .1, z + .9, S(tone + .14));
      q(f, f + 2, z, z + .8, S(.22));
      q(f, f + 2, z + .38, z + .42, S(tone + .1));
      q(f + 1.3, f + 1.36, z, z + .8, S(tone + .1));
      if (i === 0 && variant !== 1) {
        quad(c, [P(X, f + 2.25, z - .16), P(X, f + 2.25, z + .96), P(X, f + 2.75, z + .4)], S(tone + .16));
        q(f + 2.12, f + 2.25, z - .16, z + .96, S(tone - .25, .5));
      }
      if (variant === 1 && i === 1) {
        q(f - .2, f - .05, z - .25, z + 1.05, S(tone - .3));
        c.strokeStyle = S(.15, .85);
        line(c, P(X, f + .95, z - .25), P(X, f + .95, z + 1.05));
        for (let zz = z - .25; zz <= z + 1.05; zz += .13) line(c, P(X, f - .05, zz), P(X, f + .95, zz));
      }
    }
  });
  c.strokeStyle = S(tone - .35, .6); c.lineWidth = 1.5;
  line(c, P(X, 0, z1), P(X, 26, z1));
}

function sign(c, X0, X1, Z, text) {
  const sc = F / Z, u = v => v * sc;
  const a = P(X0, 5.4, Z), b = P(X1, 4.75, Z);
  c.strokeStyle = S(.13); c.lineWidth = Math.max(1, u(.05));
  line(c, P(X0, 5.55, Z), P(X1, 5.55, Z));
  line(c, P(X0, 5.2, Z), P(X0 + (X1 - X0) * .4, 5.55, Z));
  const x = Math.min(a[0], b[0]), w = Math.abs(b[0] - a[0]);
  c.fillStyle = S(.16); c.fillRect(x, a[1], w, b[1] - a[1]);
  c.strokeStyle = S(.72); c.lineWidth = Math.max(.8, u(.025));
  c.strokeRect(x + u(.05), a[1] + u(.05), w - u(.1), b[1] - a[1] - u(.1));
  c.fillStyle = S(.82); c.textAlign = 'center'; c.textBaseline = 'middle';
  let fs = u(.22); c.font = `600 ${fs}px Georgia, "Times New Roman", serif`;
  const tw = c.measureText(text).width, mw = w - u(.3);
  if (tw > mw) { fs *= mw / tw; c.font = `600 ${fs}px Georgia, "Times New Roman", serif`; }
  c.fillText(text, x + w / 2, (a[1] + b[1]) / 2 + u(.01));
}

function drawNear(c) {
  cobbles(c, 3.2, 13, -5.2, 5.2, .46, .2, .26);
  cobbles(c, 3.2, 13, -7, -5.2, .62, .9, .9, .15, .02);
  cobbles(c, 3.2, 13, 5.2, 7, .62, .9, .9, .15, .02);
  for (const X of [-5.2, 5.2]) quad(c, [P(X, 0, 3.2), P(X, 0, 13), P(X, .15, 13), P(X, .15, 3.2)], S(.72));
  wallSeg(c, -7, 2.4, 6.4, .64, 0);
  wallSeg(c, -7, 6.4, 9.8, .57, 1);
  wallSeg(c, -7, 9.8, 13, .66, 2);
  wallSeg(c, 7, 2.4, 5.8, .66, 2);
  wallSeg(c, 7, 5.8, 9.6, .6, 0);
  wallSeg(c, 7, 9.6, 13, .63, 1);
  sign(c, -7, -5.4, 9.5, 'KONDITORI');
  sign(c, 7, 5.4, 9.3, 'BOKHANDEL');
  for (const Z of [7.5, 11.5]) { lamp(c, -5.75, Z, .15); lamp(c, 5.75, Z, .15); }
  c.strokeStyle = S(.13, .85); c.lineWidth = 1.2;
  for (const Z of [11, 13]) {
    c.beginPath();
    for (let X = -7; X <= 7.01; X += .5) {
      const p = P(X, 7.5 - .55 * (1 - (X / 7) ** 2), Z);
      X === -7 ? c.moveTo(p[0], p[1]) : c.lineTo(p[0], p[1]);
    }
    c.stroke();
  }
}

function drawVignette(c) {
  c.save(); c.translate(W / 2, H / 2); c.scale(1, .56);
  const g = c.createRadialGradient(0, 0, 250, 0, 0, 980);
  g.addColorStop(0, 'rgba(26,22,18,0)'); g.addColorStop(.7, 'rgba(26,22,18,.22)'); g.addColorStop(1, 'rgba(14,11,8,.82)');
  c.fillStyle = g; c.fillRect(-W, -H * 1.5, W * 2, H * 3); c.restore();
}

/* ---------- people ---------- */
const KINDS = ['top', 'bowler', 'cap', 'woman', 'umbrella', 'bowler'];
function walker(near, i) {
  const p = { near, kind: KINDS[(Math.random() * KINDS.length) | 0], tone: .1 + Math.random() * .2, ph: Math.random() * TAU, age: 0, out: 1 };
  if (near) {
    const side = i % 2 ? 1 : -1;
    p.X = side * (5.7 + Math.random() * .9); p.Y = .15;
    p.vx = 0; p.vz = (Math.random() < .5 ? -1 : 1) * (1 + Math.random() * .4);
    p.Z = p.vz > 0 ? 6 + Math.random() * 3 : 13 + Math.random() * 2.5;
    p.exitZ = 5 + Math.random() * 2.5;
  } else {
    p.Z = 14 + Math.random() * 6.3; p.Y = 0; p.vz = 0;
    p.vx = (Math.random() < .5 ? -1 : 1) * (.9 + Math.random() * .5);
    p.X = (Math.random() - .5) * 50;
  }
  return p;
}

function updatePeople(list, dt) {
  list.forEach((p, i) => {
    p.X += p.vx * dt; p.Z += p.vz * dt; p.age += dt;
    p.ph += (Math.abs(p.vx) + Math.abs(p.vz)) * dt * 5.2;
    let gone = false;
    if (p.near) {
      if (p.vz < 0 && p.Z < p.exitZ + .8) p.out = Math.max(0, (p.Z - p.exitZ) / .8);
      if (p.vz > 0 && p.Z > 15) p.out = Math.max(0, (16 - p.Z));
      gone = p.out <= 0;
    } else gone = Math.abs(p.X) > 28;
    if (gone) {
      const n = walker(p.near, i);
      if (!p.near) n.X = -Math.sign(n.vx) * 27.5;
      list[i] = n;
    }
    list[i].a = Math.min(1, list[i].age / .9) * list[i].out;
  });
}

function person(c, p) {
  const sc = F / p.Z, [x, y] = P(p.X, p.Y, p.Z), u = v => v * sc;
  const side = Math.abs(p.vx) > Math.abs(p.vz), fd = Math.sign(p.vx) || 1, away = p.vz > 0;
  const sw = Math.sin(p.ph), col = S(p.tone), skirt = p.kind === 'woman' || p.kind === 'umbrella';
  c.save(); c.globalAlpha = p.a;
  c.fillStyle = S(0, .16); c.beginPath(); c.ellipse(x, y, u(.32), u(.05), 0, 0, TAU); c.fill();
  c.strokeStyle = col; c.fillStyle = col; c.lineCap = 'round';
  const hipY = y - u(skirt ? .35 : .86);
  c.lineWidth = u(.12);
  for (const k of [1, -1]) {
    if (side) line(c, [x, hipY], [x + k * sw * u(skirt ? .1 : .27), y - u(.03)]);
    else line(c, [x + k * u(.07), hipY], [x + k * u(.09), y - Math.max(0, k * sw) * u(.09) - u(.02)]);
  }
  const sh = y - u(1.45);
  if (skirt) {
    const tw = side ? .12 : .17, bw = side ? .24 : .3, sx = side ? sw * u(.03) : 0;
    quad(c, [[x - u(tw), sh], [x + u(tw), sh], [x + u(bw) + sx, y - u(.1)], [x - u(bw) + sx, y - u(.1)]], col);
  } else {
    const tw = side ? .13 : .21, bw = side ? .16 : .2;
    quad(c, [[x - u(tw), sh], [x + u(tw), sh], [x + u(bw), y - u(.62)], [x - u(bw), y - u(.62)]], col);
  }
  c.lineWidth = u(.085);
  let hand;
  if (side) { hand = [x - sw * u(.24) * fd + fd * u(.03), sh + u(.64)]; line(c, [x, sh + u(.06)], hand); }
  else { for (const k of [1, -1]) line(c, [x + k * u(.2), sh + u(.06)], [x + k * u(.23), sh + u(.62)]); hand = [x + u(.23), sh + u(.62)]; }
  c.fillStyle = away ? S(p.tone + .06) : S(.72);
  c.beginPath(); c.arc(x, y - u(1.6), u(.105), 0, TAU); c.fill();
  c.fillStyle = col;
  if (p.kind === 'top') {
    c.fillRect(x - u(.1), y - u(1.93), u(.2), u(.25)); c.fillRect(x - u(.17), y - u(1.7), u(.34), u(.04));
    c.lineWidth = u(.035); line(c, hand, [hand[0] + (side ? fd * u(.12) : u(.04)), y]);
  } else if (p.kind === 'bowler') {
    c.beginPath(); c.arc(x, y - u(1.68), u(.12), Math.PI, 0); c.fill(); c.fillRect(x - u(.17), y - u(1.69), u(.34), u(.035));
  } else if (p.kind === 'cap') {
    c.beginPath(); c.ellipse(x + (side ? fd * u(.03) : 0), y - u(1.69), u(.14), u(.05), 0, 0, TAU); c.fill();
  } else if (p.kind === 'woman') {
    c.beginPath(); c.ellipse(x, y - u(1.68), u(.22), u(.04), 0, 0, TAU); c.fill();
    c.beginPath(); c.arc(x, y - u(1.69), u(.1), Math.PI, 0); c.fill();
  } else if (p.kind === 'umbrella') {
    const top = [x + u(.06), y - u(2.08)];
    c.lineWidth = u(.03); line(c, [x + u(.12), sh + u(.35)], top);
    c.fillStyle = S(.1); c.beginPath(); c.ellipse(top[0], top[1] + u(.05), u(.58), u(.24), 0, Math.PI, 0); c.fill();
  }
  c.restore();
}

export function createSepiaStreet(cv) {
  const ctx = cv.getContext('2d');
  let s = 1, ox = 0, oy = 0;
  const L = {};

  function layer(draw) {
    const c = document.createElement('canvas');
    c.width = Math.ceil(W * s); c.height = Math.ceil(H * s);
    const g = c.getContext('2d'); g.scale(s, s); seed = 7; draw(g); return c;
  }

  /* ---------- grain ---------- */
  const grains = [0, 1, 2].map(() => {
    const g = document.createElement('canvas'); g.width = g.height = 256;
    const gc = g.getContext('2d'), im = gc.createImageData(256, 256);
    for (let i = 0; i < im.data.length; i += 4) {
      const v = Math.random() > .5 ? 238 : 18;
      im.data[i] = v; im.data[i + 1] = v * .95; im.data[i + 2] = v * .85; im.data[i + 3] = Math.random() * 95;
    }
    gc.putImageData(im, 0, 0); return ctx.createPattern(g, 'repeat');
  });

  /* ---------- moving things ---------- */
  const nearP = [0, 1, 2, 3, 4].map(i => walker(true, i));
  const plazaP = [0, 1, 2, 3, 4, 5].map(i => walker(false, i));
  nearP.forEach(p => p.age = 2); plazaP.forEach(p => p.age = 2);

  // people crossing the street toward Stadshuset, left to right (the scene
  // sends them when the music is at its strongest): they fade in on the left
  // pavement, step down onto the cobbles, up the far kerb, and fade out
  const crossers = [];
  const CROSS_X = 6.4; // from -CROSS_X (left pavement) to +CROSS_X (right pavement)
  function addCrosser() {
    const p = walker(true, 0);
    p.Z = 5.5 + Math.random() * 7; p.vz = 0; p.vx = .9 + Math.random() * .5;
    p.X = -CROSS_X; p.age = 0;
    crossers.push(p);
  }
  // a person walking a dog across the street close to the viewer (the scene
  // sends them only when the music is very strong); the dog trots ahead on a
  // slack leash
  let dogWalk = null;
  function addDogWalker(z = 4.8) {
    if (dogWalk) return false;
    const p = walker(true, 0);
    p.kind = ['bowler', 'top', 'woman'][(Math.random() * 3) | 0];
    p.Z = z; p.vz = 0; p.vx = .95 + Math.random() * .25; p.X = -CROSS_X - 1.2; p.age = 0;
    dogWalk = { p, lead: 1.05 + Math.random() * .25, tone: .1 + Math.random() * .08 };
    return true;
  }
  function updateDogWalker(dt) {
    if (!dogWalk) return;
    const p = dogWalk.p;
    p.X += p.vx * dt; p.age += dt; p.ph += p.vx * dt * 5.2;
    p.Y = Math.abs(p.X) > 5.2 ? .15 : 0;
    // close to the camera the pavements are off frame anyway; fade just in case
    p.a = Math.min(1, p.age / .6) * Math.min(1, Math.max(0, (CROSS_X + 1.6 - p.X) / .8));
    if (p.X >= CROSS_X + 1.6) dogWalk = null;
  }
  function dog(c, X, Y, Z, ph, tone, alpha) {
    const sc = F / Z, [x, y] = P(X, Y, Z), u = v => v * sc;
    c.save(); c.globalAlpha = alpha;
    c.fillStyle = S(0, .16); c.beginPath(); c.ellipse(x, y, u(.42), u(.05), 0, 0, TAU); c.fill();
    const col = S(tone); c.strokeStyle = col; c.fillStyle = col; c.lineCap = 'round';
    // legs: a trot, diagonal pairs together
    c.lineWidth = u(.055);
    const legs = [[.22, 0], [.14, Math.PI], [-.2, Math.PI], [-.28, 0]];
    for (const [lx, off] of legs) {
      const sw = Math.sin(ph + off);
      line(c, [x + u(lx), y - u(.32)], [x + u(lx) + sw * u(.1), y - u(.02) - Math.max(0, -sw) * u(.05)]);
    }
    // body, chest, neck and head
    c.beginPath(); c.ellipse(x - u(.03), y - u(.4), u(.32), u(.115), 0, 0, TAU); c.fill();
    c.beginPath(); c.ellipse(x + u(.22), y - u(.43), u(.12), u(.12), 0, 0, TAU); c.fill();
    c.lineWidth = u(.1); line(c, [x + u(.26), y - u(.45)], [x + u(.36), y - u(.6)]);
    c.beginPath(); c.arc(x + u(.38), y - u(.63), u(.085), 0, TAU); c.fill();
    c.beginPath(); c.ellipse(x + u(.48), y - u(.6), u(.075), u(.04), .15, 0, TAU); c.fill();
    quad(c, [[x + u(.33), y - u(.68)], [x + u(.38), y - u(.7)], [x + u(.3), y - u(.58)]], col); // ear
    // tail, wagging
    const wag = Math.sin(ph * 1.7) * u(.05);
    c.lineWidth = u(.045); c.beginPath(); c.moveTo(x - u(.33), y - u(.45));
    c.quadraticCurveTo(x - u(.45), y - u(.55), x - u(.43) + wag, y - u(.66)); c.stroke();
    c.restore();
    return [x + u(.33), y - u(.56)]; // the collar, for the leash
  }
  function drawDogWalker(c) {
    const { p, lead, tone } = dogWalk;
    const sc = F / p.Z, u = v => v * sc;
    const collar = dog(c, p.X + lead, p.Y, p.Z, p.ph * 1.55, tone, p.a);
    person(c, p);
    // leash from the leading hand to the collar, sagging a little
    const [x, y] = P(p.X, p.Y, p.Z);
    const hand = [x + u(.2), y - u(.84)];
    c.save(); c.globalAlpha = p.a; c.strokeStyle = S(.12, .9); c.lineWidth = Math.max(1, u(.018));
    c.beginPath(); c.moveTo(hand[0], hand[1]);
    c.quadraticCurveTo((hand[0] + collar[0]) / 2, Math.max(hand[1], collar[1]) + u(.18), collar[0], collar[1]); c.stroke();
    c.restore();
  }

  function updateCrossers(dt) {
    for (let i = crossers.length - 1; i >= 0; i--) {
      const p = crossers[i];
      p.X += p.vx * dt; p.age += dt; p.ph += p.vx * dt * 5.2;
      p.Y = Math.abs(p.X) > 5.2 ? .15 : 0; // pavement or street
      p.a = Math.min(1, p.age / .9) * Math.min(1, Math.max(0, (CROSS_X - p.X) / .8));
      if (p.X >= CROSS_X) crossers.splice(i, 1);
    }
  }

  const tramS = { X: -36, dir: 1, wait: 0 };
  function updateTram(dt) {
    if (tramS.wait > 0) { tramS.wait -= dt; return; }
    tramS.X += tramS.dir * 3.4 * dt;
    if (tramS.X > 34 || tramS.X < -46) { tramS.dir *= -1; tramS.wait = 5 + Math.random() * 8; tramS.X = tramS.dir > 0 ? -46 : 34; }
  }
  function tram(c) {
    const Z = 18.5, sc = F / Z, len = 10, u = v => v * sc;
    const xa = P(tramS.X, 0, Z)[0], yy = h => P(0, h, Z)[1];
    c.fillStyle = S(0, .2); c.fillRect(xa, yy(.05), u(len), u(.12));
    c.fillStyle = S(.12);
    for (const w of [1.6, 2.6, len - 2.6, len - 1.6]) { c.beginPath(); c.arc(xa + u(w), yy(.4), u(.38), 0, TAU); c.fill(); }
    c.fillStyle = S(.16); c.fillRect(xa + u(.4), yy(.8), u(len - .8), yy(.45) - yy(.8));
    c.fillStyle = S(.34); c.fillRect(xa, yy(1.55), u(len), yy(.78) - yy(1.55));
    c.fillStyle = S(.24); c.fillRect(xa, yy(1.0), u(len), u(.05));
    c.fillStyle = S(.74); c.fillRect(xa, yy(2.78), u(len), yy(1.55) - yy(2.78));
    c.fillStyle = S(.28);
    for (let i = 0; i < 9; i++) c.fillRect(xa + u(.55 + i * 1.0), yy(2.62), u(.74), yy(1.72) - yy(2.62));
    c.fillStyle = S(.5); c.fillRect(xa - u(.12), yy(3.02), u(len + .24), yy(2.78) - yy(3.02));
    c.fillStyle = S(.42); c.fillRect(xa + u(1.5), yy(3.36), u(len - 3), yy(3.02) - yy(3.36));
    const front = tramS.dir > 0 ? xa + u(len - .9) : xa + u(.15);
    c.fillStyle = S(.9); c.fillRect(front, yy(3.3), u(.75), yy(3.04) - yy(3.3));
    c.fillStyle = S(.15); c.font = `700 ${u(.26)}px Georgia, serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('7', front + u(.375), yy(3.17));
    const px = xa + u(tramS.dir > 0 ? 3 : len - 3);
    c.strokeStyle = S(.13); c.lineWidth = 1.3;
    line(c, [px, yy(3.36)], [px - tramS.dir * u(4.2), yy(6)]);
  }

  const boatS = { x: 520 }, smoke = [];
  function boat(c, dt) {
    boatS.x += dt * 9; if (boatS.x > 1260) boatS.x = 380;
    const x = boatS.x, y = 460;
    if (Math.random() < dt * 3) smoke.push({ x: x + 6, y: y - 22, r: 3, a: .35 });
    for (const p of smoke) { p.x -= dt * 7; p.y -= dt * 5; p.r += dt * 3; p.a -= dt * .05; }
    while (smoke.length && smoke[0].a <= 0) smoke.shift();
    for (const p of smoke) { c.fillStyle = S(.5, Math.max(0, p.a)); c.beginPath(); c.arc(p.x, p.y, p.r, 0, TAU); c.fill(); }
    quad(c, [[x - 34, y - 6], [x + 38, y - 6], [x + 30, y + 2], [x - 30, y + 2]], S(.22));
    c.fillStyle = S(.86); c.fillRect(x - 22, y - 13, 44, 7);
    c.fillStyle = S(.3); for (let i = -18; i < 20; i += 6) c.fillRect(i + x, y - 11, 3, 3);
    c.fillStyle = S(.7); c.fillRect(x - 14, y - 16, 26, 3);
    c.fillStyle = S(.18); c.fillRect(x + 3, y - 26, 6, 13);
    c.fillStyle = S(.85); c.fillRect(x + 3, y - 22, 6, 2);
    c.fillStyle = S(.2, .25); c.fillRect(x - 30, y + 3, 60, 2);
  }

  const gulls = [0, 1, 2, 3].map(() => ({ x: Math.random() * W, y: 90 + Math.random() * 160, v: 12 + Math.random() * 16, ph: Math.random() * TAU, sz: 5 + Math.random() * 4 }));
  function drawGulls(c, dt, t) {
    c.strokeStyle = S(.3, .75); c.lineWidth = 1.3; c.lineCap = 'round';
    for (const g of gulls) {
      g.x += g.v * dt; g.y += Math.sin(t * .6 + g.ph) * dt * 4; if (g.x > W + 20) g.x = -20;
      const f = Math.sin(t * 5 + g.ph) * g.sz * .45;
      c.beginPath(); c.moveTo(g.x - g.sz, g.y - f); c.quadraticCurveTo(g.x - g.sz * .4, g.y - g.sz * .5, g.x, g.y);
      c.quadraticCurveTo(g.x + g.sz * .4, g.y - g.sz * .5, g.x + g.sz, g.y - f); c.stroke();
    }
  }

  function water(c, t) {
    const y0 = 448, y1 = P(0, 0, 21)[1];
    const g = c.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, S(.66)); g.addColorStop(1, S(.5));
    c.fillStyle = g; c.fillRect(0, y0, W, y1 - y0);
    c.save(); c.globalAlpha = .34;
    for (let y = y0; y < y1; y += 2) {
      const d = y - y0, sy = y0 - d - 2;
      const off = Math.sin(t * 1.3 + y * .45) * (1.2 + d * .07);
      c.drawImage(L.back, 0, sy * s, W * s, 2 * s, off, y, W, 2.2);
    }
    c.restore();
    for (let i = 0; i < 46; i++) {
      const x = ((i * 137.5 + t * 6 * (i % 3 + 1)) % (W + 40)) - 20;
      const y = y0 + 3 + ((i * 53) % (y1 - y0 - 4)), w = 5 + (i % 5) * 4;
      c.fillStyle = S(.95, .22 * (.5 + .5 * Math.sin(t * 2.4 + i)));
      c.fillRect(x, y, w, 1);
    }
  }

  /* ---------- film artefacts (scaled by the music through `mod`) ---------- */
  const scratches = [];
  const fx = { fl: 0, gr: 0, gx: 0, gy: 0, jit: 0, dust: [] };
  function filmTick(mod) {
    fx.fl = (Math.random() - .5) * .07 * mod.flicker;
    fx.gr = Math.random() * 3 | 0; fx.gx = Math.random() * 256; fx.gy = Math.random() * 256;
    fx.jit = (Math.random() < .08 ? (Math.random() - .5) * 2.4 : (Math.random() - .5) * .6) + (Math.random() - .5) * mod.shake;
    if (Math.random() < .035 * mod.dust) scratches.push({ x: 200 + Math.random() * 1200, life: 1 + Math.random() * 4, light: Math.random() < .7 });
    fx.dust = [];
    const n = Math.random() * 4 * mod.dust | 0;
    for (let i = 0; i < n; i++) fx.dust.push({ x: Math.random() * W, y: Math.random() * H, r: .6 + Math.random() * 1.8, light: Math.random() < .35, hair: Math.random() < .12 });
  }
  function artefacts(c, dt) {
    for (let i = scratches.length - 1; i >= 0; i--) {
      const sc = scratches[i]; sc.life -= dt; sc.x += (Math.random() - .5) * 1.4;
      if (sc.life <= 0) { scratches.splice(i, 1); continue; }
      c.fillStyle = sc.light ? S(1, .45) : S(0, .4); c.fillRect(sc.x, 0, 1.1, H);
    }
    for (const d of fx.dust) {
      c.fillStyle = d.light ? S(1, .8) : S(0, .75); c.strokeStyle = c.fillStyle;
      if (d.hair) { c.lineWidth = .8; c.beginPath(); c.moveTo(d.x, d.y); c.quadraticCurveTo(d.x + 8, d.y - 10, d.x + 3, d.y - 20); c.stroke(); }
      else { c.beginPath(); c.arc(d.x, d.y, d.r, 0, TAU); c.fill(); }
    }
  }

  /* ---------- frame ---------- */
  let t = 0;
  function build(width, height) {
    cv.width = Math.max(1, Math.round(width)); cv.height = Math.max(1, Math.round(height));
    s = Math.min(cv.width / W, cv.height / H, 3200 / W);
    ox = (cv.width - W * s) / 2; oy = (cv.height - H * s) / 2;
    L.back = layer(drawBack); L.mid = layer(drawMid); L.near = layer(drawNear); L.vig = layer(drawVignette);
  }

  // the walkers and the street-crossers keep their own paces (they follow the music's loudness)
  function step(dt, peopleDt = dt, crossDt = peopleDt) {
    t += dt;
    updatePeople(nearP, peopleDt); updatePeople(plazaP, peopleDt); updateCrossers(crossDt); updateDogWalker(crossDt); updateTram(dt);
  }

  function draw(dt, realDt, mod) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0d0b09'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.setTransform(s, 0, 0, s, ox, oy + fx.jit * s);
    ctx.save();
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(0, 0, W, H, 26) : ctx.rect(0, 0, W, H); ctx.clip();
    ctx.drawImage(L.back, 0, 0, W, H);
    water(ctx, t);
    drawGulls(ctx, dt, t);
    boat(ctx, dt);
    ctx.drawImage(L.mid, 0, 0, W, H);
    const mids = plazaP.map(p => ({ z: p.Z, d: () => person(ctx, p) }));
    mids.push({ z: 18.5, d: () => tram(ctx) });
    mids.sort((a, b) => b.z - a.z).forEach(m => m.d());
    ctx.drawImage(L.near, 0, 0, W, H);
    const near = [...nearP, ...crossers].map(p => ({ z: p.Z, d: () => person(ctx, p) }));
    if (dogWalk) near.push({ z: dogWalk.p.Z, d: () => drawDogWalker(ctx) });
    near.sort((a, b) => b.z - a.z).forEach(m => m.d());
    ctx.fillStyle = fx.fl > 0 ? S(1, fx.fl) : S(0, -fx.fl); ctx.fillRect(0, 0, W, H);
    if (mod.flash > 0) { ctx.fillStyle = S(1, mod.flash); ctx.fillRect(0, 0, W, H); }
    ctx.drawImage(L.vig, 0, 0, W, H);
    artefacts(ctx, realDt);
    ctx.setTransform(1, 0, 0, 1, ox - fx.gx, oy - fx.gy + fx.jit * s);
    ctx.globalAlpha = Math.min(1, .24 * mod.grain); ctx.fillStyle = grains[fx.gr];
    ctx.fillRect(fx.gx, fx.gy, W * s, H * s); ctx.globalAlpha = 1;
    ctx.restore();
  }

  return { build, step, filmTick, draw, addCrosser, crossing: () => crossers.length, addDogWalker, dogWalking: () => !!dogWalk };
}
