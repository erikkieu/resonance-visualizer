/**
 * timeline.js: the score timeline of the debug overlay (D).
 *
 * Two strips over the analysis of the playing piece:
 *   overview  the whole piece: sections (coloured by role), loudness (level and
 *             the slow structural level), the climax envelope, climax markers
 *   zoom      ZOOM seconds around the playhead: onsets (melody notes brighter,
 *             height = strength), the melody contour, and the look-ahead window
 * plus the playhead, and a row of section buttons. Clicking a strip or a
 * button seeks there, so every moment can be checked quickly.
 */
import { SCORE_CONFIG } from './scoreMap.js';

const ZOOM = 20; // s shown in the zoom strip
const ROLE_COLORS = {
  hush: '#2c4a6e',
  build: '#2f8f6a',
  swell: '#3b7fc4',
  climax: '#e08a3a',
  release: '#8a5fb8',
  fade: '#4b5466',
};

const STYLE = `
.timeline {
  position: fixed;
  left: max(16px, env(safe-area-inset-left));
  right: max(16px, env(safe-area-inset-right));
  bottom: 96px;
  padding: 8px 10px 10px;
  border-radius: 12px;
  background: rgba(6, 10, 20, 0.78);
  border: 1px solid var(--line, rgba(255, 255, 255, 0.13));
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: var(--fg, rgba(240, 246, 255, 0.92));
  font: 10.5px/1.4 ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  z-index: 26;
}
.timeline[hidden] { display: none; }
.timeline canvas { display: block; width: 100%; cursor: pointer; border-radius: 6px; }
.timeline .tl-zoom { margin-top: 6px; }
.timeline .tl-sections { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.timeline .tl-sections button {
  padding: 2px 7px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.05);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.timeline .tl-sections button.on { border-color: rgba(255, 255, 255, 0.7); background: rgba(255, 255, 255, 0.16); }
.timeline .tl-sections i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
.timeline .tl-empty { color: var(--fg-faint, rgba(225, 235, 250, 0.34)); }
/* the debug panel shrinks above the timeline and scrolls */
.timeline-on .debug { max-height: calc(100vh - 360px); overflow-y: auto; pointer-events: auto; }
`;

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function createTimeline({ audio }) {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const el = document.createElement('div');
  el.className = 'timeline';
  el.hidden = true;
  el.innerHTML = `<div class="tl-empty">Score timeline: play a scene's piece (P) to see its analysis. Live input has no timeline.</div>
    <canvas class="tl-overview" height="70"></canvas><canvas class="tl-zoom" height="54"></canvas><div class="tl-sections"></div>`;
  document.body.appendChild(el);
  const empty = el.querySelector('.tl-empty');
  const overview = el.querySelector('.tl-overview');
  const zoom = el.querySelector('.tl-zoom');
  const sectionRow = el.querySelector('.tl-sections');
  // keep clicks away from the canvas below (Scene 1 pours paint on pointerdown)
  for (const type of ['pointerdown', 'pointermove', 'pointerup']) el.addEventListener(type, (e) => e.stopPropagation());

  let visible = false;
  let map = null;
  let background = null; // cached overview without the playhead
  let buttons = [];
  let lastSection = -1;

  function seekFromEvent(e, canvas, t0, span) {
    const r = canvas.getBoundingClientRect();
    audio.seekTo(t0 + ((e.clientX - r.left) / r.width) * span);
  }
  overview.addEventListener('click', (e) => map && seekFromEvent(e, overview, 0, map.duration));
  zoom.addEventListener('click', (e) => map && seekFromEvent(e, zoom, audio.perf.t - ZOOM / 2, ZOOM));

  function sizeCanvas(c) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(c.clientWidth * dpr);
    const h = Math.round(Number(c.getAttribute('height')) * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
      c.style.height = `${c.getAttribute('height')}px`;
      return true;
    }
    return false;
  }

  function build() {
    map = audio.perf?.map ?? null;
    background = null;
    lastSection = -1;
    sectionRow.innerHTML = '';
    buttons = [];
    empty.hidden = !!map;
    overview.hidden = zoom.hidden = !map;
    document.body.classList.toggle('timeline-on', visible && !!map);
    if (!map) return;
    buttons = map.sections.map((s) => {
      const b = document.createElement('button');
      b.innerHTML = `<i style="background:${ROLE_COLORS[s.role]}"></i>${s.index} ${s.role} ${fmtTime(s.start)}`;
      b.title = `${s.label} · mood ${s.mood}${s.manual ? ' · manual' : ''}`;
      b.addEventListener('click', () => audio.seekTo(s.start + 0.01));
      sectionRow.appendChild(b);
      return b;
    });
  }

  function drawBackground() {
    sizeCanvas(overview);
    const c = document.createElement('canvas');
    c.width = overview.width;
    c.height = overview.height;
    const g = c.getContext('2d');
    const W = c.width;
    const H = c.height;
    const x = (t) => (t / map.duration) * W;
    g.fillStyle = '#0b1220';
    g.fillRect(0, 0, W, H);
    for (const s of map.sections) {
      g.fillStyle = ROLE_COLORS[s.role];
      g.globalAlpha = 0.25 + 0.5 * s.mood;
      g.fillRect(x(s.start), 0, x(s.end) - x(s.start), H);
      g.globalAlpha = 1;
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(x(s.start), 0, 1, H);
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.font = `${Math.round(H * 0.15)}px ui-monospace, Menlo, monospace`;
      g.fillText(`${s.index} ${s.role}`, x(s.start) + 4, H * 0.18);
    }
    const curve = (arr, color, width, fill) => {
      g.beginPath();
      for (let i = 0; i < arr.length; i += 2) {
        const px = (i / arr.length) * W;
        const py = H - 2 - arr[i] * (H * 0.72);
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      if (fill) {
        g.lineTo(W, H);
        g.lineTo(0, H);
        g.fillStyle = fill;
        g.fill();
      } else {
        g.strokeStyle = color;
        g.lineWidth = width;
        g.stroke();
      }
    };
    curve(map.climaxCurve, null, 0, 'rgba(255,190,90,0.18)');
    curve(map.level, 'rgba(255,255,255,0.55)', 1);
    curve(map.slowLevel, 'rgba(159,232,255,0.95)', 1.5);
    g.fillStyle = '#ffd27a';
    for (const cl of map.data.climaxes.sustained) {
      const px = x(cl.t);
      g.beginPath();
      g.moveTo(px - 5, H);
      g.lineTo(px + 5, H);
      g.lineTo(px, H - 9);
      g.fill();
    }
    background = c;
  }

  function drawOverview(p) {
    if (sizeCanvas(overview) || !background) drawBackground();
    const g = overview.getContext('2d');
    const W = overview.width;
    const H = overview.height;
    g.drawImage(background, 0, 0);
    const x = (t) => (t / map.duration) * W;
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(x(p.t), 0, Math.max(2, x(p.t + SCORE_CONFIG.LOOKAHEAD) - x(p.t)), H);
    g.fillStyle = '#fff';
    g.fillRect(x(p.t) - 1, 0, 2, H);
  }

  function drawZoom(p) {
    sizeCanvas(zoom);
    const g = zoom.getContext('2d');
    const W = zoom.width;
    const H = zoom.height;
    const t0 = p.t - ZOOM / 2;
    const x = (t) => ((t - t0) / ZOOM) * W;
    g.fillStyle = '#0b1220';
    g.fillRect(0, 0, W, H);
    // sections under the zoom
    for (const s of map.sections) {
      if (s.end < t0 || s.start > t0 + ZOOM) continue;
      g.fillStyle = ROLE_COLORS[s.role];
      g.globalAlpha = 0.35;
      g.fillRect(x(s.start), 0, x(s.end) - x(s.start), H);
      g.globalAlpha = 1;
    }
    // look-ahead window
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fillRect(x(p.t), 0, x(p.t + SCORE_CONFIG.LOOKAHEAD) - x(p.t), H);
    // melody contour (confident frames only)
    g.strokeStyle = 'rgba(255,230,150,0.9)';
    g.lineWidth = 1.5;
    g.beginPath();
    let pen = false;
    const r = map.rate;
    for (let i = Math.max(0, Math.floor(t0 * r)); i < Math.min(map.height.length, Math.ceil((t0 + ZOOM) * r)); i++) {
      const ok = map.heightConf[i] > 0.3 && map.hz[i] > 0;
      const px = x(i / r);
      const py = H - 4 - map.height[i] * (H * 0.55);
      if (ok && pen) g.lineTo(px, py);
      else if (ok) g.moveTo(px, py);
      pen = ok;
    }
    g.stroke();
    // onsets
    for (const o of map.onsets) {
      if (o.t < t0) continue;
      if (o.t > t0 + ZOOM) break;
      g.fillStyle = o.melody ? 'rgba(159,232,255,0.95)' : 'rgba(255,255,255,0.35)';
      const h = 6 + o.strength * (H * 0.4);
      g.fillRect(x(o.t) - 1, 0, o.accent ? 3 : 2, h);
    }
    // beats
    g.fillStyle = 'rgba(255,140,120,0.7)';
    for (const b of map.beats) {
      if (b < t0) continue;
      if (b > t0 + ZOOM) break;
      g.fillRect(x(b) - 1, H - 4, 2, 4);
    }
    g.fillStyle = '#fff';
    g.fillRect(x(p.t) - 1, 0, 2, H);
    g.fillStyle = 'rgba(255,255,255,0.7)';
    g.font = `${Math.round(H * 0.2)}px ui-monospace, Menlo, monospace`;
    g.fillText(`${fmtTime(Math.max(0, t0))}`, 4, H - 6);
    g.fillText(`${fmtTime(t0 + ZOOM)}`, W - g.measureText(fmtTime(t0 + ZOOM)).width - 4, H - 6);
  }

  function update() {
    if (!visible) return;
    const p = audio.perf;
    if ((p?.map ?? null) !== map) build();
    if (!map || p.source !== 'score') return;
    drawOverview(p);
    drawZoom(p);
    const si = p.section?.index ?? -1;
    if (si !== lastSection) {
      buttons.forEach((b, i) => b.classList.toggle('on', i === si));
      lastSection = si;
    }
  }

  window.addEventListener('resize', () => (background = null));

  return {
    update,
    setVisible(v) {
      visible = v;
      el.hidden = !v;
      if (v) build();
      else document.body.classList.remove('timeline-on');
    },
  };
}
