import { NOTE_NAMES } from './audio.js';
import { createTimeline } from './timeline.js';

/**
 * debug.js: live tuning overlay, toggled with D.
 *
 * Shows the melody pitch estimate (pitchHeight, its frequency, how much the
 * peak is trusted over the centroid, the adaptive range), loudness, the
 * dominant pitch class with the 12-bin chroma, and whatever the active scene
 * exposes through a `debug` getter. A scene value given as
 * { swatch: '#rrggbb', text } is drawn with a colour swatch (Scene 1: the
 * ramp colour new paint is currently getting). The overlay stays visible
 * when the rest of the UI hides (H / inactivity).
 * With a piece's analysis loaded it also shows the score timeline
 * (timeline.js) and the score follower's values.
 */
export function createDebugOverlay({ audio, manager }) {
  const el = document.createElement('div');
  el.className = 'debug';
  el.hidden = true;
  el.innerHTML = `
    <div class="debug-title">debug <span>D to close</span></div>
    <div class="debug-row"><b>pitch</b><span class="debug-bar"><i data-k="height"></i></span><span data-k="heightText"></span></div>
    <div class="debug-sub" data-k="pitchInfo"></div>
    <div class="debug-row"><b>loudness</b><span class="debug-bar"><i data-k="loud"></i></span><span data-k="loudText"></span></div>
    <div class="debug-row"><b>note</b><span class="debug-note" data-k="note"></span><span data-k="strength"></span></div>
    <div class="debug-chroma" data-k="chroma"></div>
    <div class="debug-scene" data-k="perf"></div>
    <div class="debug-scene" data-k="scene"></div>
    <div class="debug-sub" data-k="bands"></div>
  `;
  document.body.appendChild(el);
  const timeline = createTimeline({ audio });
  const q = (k) => el.querySelector(`[data-k="${k}"]`);
  const nodes = Object.fromEntries(['height', 'heightText', 'pitchInfo', 'loud', 'loudText', 'note', 'strength', 'chroma', 'perf', 'scene', 'bands'].map((k) => [k, q(k)]));
  const bars = NOTE_NAMES.map((name) => {
    const col = document.createElement('span');
    col.innerHTML = `<i></i><em>${name}</em>`;
    nodes.chroma.appendChild(col);
    return col;
  });

  let last = 0;
  const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');

  const row = ([k, v]) => {
    // { swatch, text } draws a colour swatch; { html } is the scene's own markup (swatch rows, a curve)
    const value = v && typeof v === 'object' ? v.html ?? `<span class="debug-swatch" style="background:${v.swatch}"></span>${v.text}` : v;
    return `<div class="debug-row"><b>${k}</b><span>${value}</span></div>`;
  };

  function update(now = performance.now()) {
    if (el.hidden) return;
    timeline.update();
    if (now - last < 66) return; // ~15 Hz is plenty to read
    last = now;
    const a = audio;
    const p = a.perf;
    if (p) {
      const sum = p.summary;
      nodes.perf.innerHTML = [
        ['source', `${sum.source}${p.source === 'score' ? ` · t ${fmt(p.t, 2)} s · drift ${fmt(p.follower.drift * 1000, 0)} ms` : ''}`],
        ['section', sum.section],
        ['stage', `${sum.stage} · mood ${fmt(p.mood)}`],
        ['next', sum.next],
        ['level', `${fmt(p.level)} · drive ${fmt(p.drive)} · rise ${fmt(p.rise)} · climax ${fmt(p.climax)}`],
        ['melody', `height ${fmt(p.height)} (conf ${fmt(p.heightConf)}) · ${p.pitchHz > 0 ? fmt(p.pitchHz, 0) + ' Hz' : '-'}`],
        ['key', p.key.name || '-'],
      ]
        .map(row)
        .join('');
    }
    nodes.height.style.transform = `scaleX(${fmt(a.pitchHeight, 3)})`;
    nodes.heightText.textContent = fmt(a.pitchHeight);
    nodes.pitchInfo.textContent =
      a.pitchHz > 0
        ? `${fmt(a.pitchHz, 0)} Hz · peak ${fmt(a.pitchConfidence * 100, 0)} % / centroid · raw ${fmt(a.pitchHeightRaw)} in ${fmt(a.pitchLo)}…${fmt(a.pitchHi)}`
        : 'no live input (demo or idle signal)';
    nodes.loud.style.transform = `scaleX(${fmt(a.energy, 3)})`;
    nodes.loudText.textContent = fmt(a.energy);
    nodes.note.textContent = a.dominantNoteName;
    nodes.strength.textContent = `strength ${fmt(a.noteStrength)}`;

    let max = 0;
    for (let i = 0; i < 12; i++) max = Math.max(max, a.chroma[i]);
    bars.forEach((b, i) => {
      b.firstChild.style.transform = `scaleY(${max > 0 ? fmt(a.chroma[i] / max, 3) : 0})`;
      b.classList.toggle('on', i === a.dominantNote);
    });

    const scene = manager.current?.scene;
    const extra = scene?.debug ?? { 'speed ×': fmt(scene?.speed ?? 0) };
    nodes.scene.innerHTML = Object.entries(extra).map(row).join('');
    nodes.bands.textContent = `presence ${fmt(a.presence)} · bass ${fmt(a.bass)} · mid ${fmt(a.mid)} · treble ${fmt(a.treble)}`;
  }

  return {
    toggle() {
      el.hidden = !el.hidden;
      timeline.setVisible(!el.hidden);
      last = 0;
      update();
    },
    get visible() {
      return !el.hidden;
    },
    update,
  };
}
