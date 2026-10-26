import { SCENES } from './SceneManager.js';

/**
 * ui.js: all DOM chrome. Scene buttons, audio source controls, transport,
 * level meter, start overlay, drag & drop, toasts, the hint line, and the
 * show/hide logic (H toggle plus auto-hide after 3 s of inactivity).
 */

const IDLE_HIDE_MS = 3000;
const HINT_MS = 5500;

const $ = (id) => document.getElementById(id);

function formatTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export function createUI({ manager, audio, toggleFullscreen }) {
  const ui = $('ui');
  const start = $('start');
  const fileInput = $('file-input');
  const transport = $('transport');
  const seek = $('seek');
  const sceneLabel = $('scene-label');
  const hint = $('hint');
  const toastEl = $('toast');
  const drop = $('drop');

  let started = false;
  let forcedHidden = false; // H key
  let idleHidden = false;
  let lastActivity = performance.now();
  let hoveringUI = false;
  let seeking = false;
  let toastTimer = 0;
  let hintTimer = 0;

  // ---------------------------------------------------------- scene buttons

  const nav = $('scene-buttons');
  const sceneButtons = SCENES.map((s, i) => {
    const b = document.createElement('button');
    b.className = 'btn';
    b.title = `${s.name} (${i + 1})`;
    b.innerHTML = `<span class="k">${i + 1}</span><span class="n">${s.name}</span>`;
    b.addEventListener('click', () => {
      begin();
      manager.switchTo(i);
    });
    nav.appendChild(b);
    return b;
  });

  function setLabel(index) {
    const s = SCENES[index];
    if (!s) return;
    sceneLabel.classList.add('swap');
    setTimeout(() => {
      $('scene-num').textContent = String(index + 1).padStart(2, '0');
      $('scene-name').textContent = s.name;
      $('scene-sub').textContent = s.sub;
      sceneLabel.classList.remove('swap');
    }, 260);
  }

  manager.on((type, index) => {
    if (type === 'loading') sceneButtons[index]?.classList.add('loading');
    if (type === 'switch' || type === 'error') sceneButtons.forEach((b) => b.classList.remove('loading'));
    if (type === 'switch') {
      sceneButtons.forEach((b, i) => b.classList.toggle('active', i === index));
      setLabel(index);
    }
    if (type === 'error') toast(`Scene ${index + 1} could not start on this device`);
  });

  // ------------------------------------------------------------ audio UI

  async function useMic() {
    begin();
    try {
      await audio.useMic();
      toast('Listening to the microphone');
    } catch (err) {
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      toast(denied ? 'Microphone permission was denied' : err.message || 'Microphone unavailable');
    }
  }

  function pickFile() {
    begin();
    fileInput.click();
  }

  async function loadFile(file) {
    begin();
    try {
      await audio.useFile(file);
    } catch (err) {
      if (err?.name === 'NotAllowedError') toast('Press play to start the track');
      else toast(err?.message || 'Could not play that file');
    }
  }

  async function useDemo() {
    begin();
    await audio.useDemo();
    toast('Demo mode · synthetic signal');
  }

  $('btn-mic').addEventListener('click', useMic);
  $('btn-file').addEventListener('click', pickFile);
  $('btn-demo').addEventListener('click', useDemo);
  $('start-mic').addEventListener('click', (e) => {
    e.stopPropagation();
    useMic();
  });
  $('start-file').addEventListener('click', (e) => {
    e.stopPropagation();
    pickFile();
  });
  $('start-demo').addEventListener('click', (e) => {
    e.stopPropagation();
    useDemo();
  });
  start.addEventListener('click', () => begin());

  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) loadFile(f);
    fileInput.value = '';
  });

  $('btn-play').addEventListener('click', () => audio.togglePlay().catch(() => {}));
  $('btn-fullscreen').addEventListener('click', () => toggleFullscreen());

  seek.addEventListener('input', () => {
    seeking = true;
    seek.style.setProperty('--p', `${seek.value / 10}%`);
  });
  seek.addEventListener('change', () => {
    audio.seek(seek.value / 1000);
    seeking = false;
  });

  function refreshSource() {
    const m = audio.mode;
    $('btn-mic').classList.toggle('active', m === 'mic');
    $('btn-file').classList.toggle('active', m === 'file');
    $('btn-demo').classList.toggle('active', m === 'demo');
    transport.hidden = m !== 'file';
    transport.classList.toggle('playing', audio.isPlaying);
    $('track-name').textContent = audio.fileName || '—';
    const status = {
      idle: 'Idle signal · choose a source',
      demo: 'Demo · synthetic groove',
      mic: 'Microphone · live',
      file: audio.isPlaying ? 'Playing' : 'Paused',
    }[m];
    $('source-status').textContent = status;
  }
  audio.onChange(refreshSource);
  refreshSource();
  applyVisibility();

  // ------------------------------------------------------- drag and drop

  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    drop.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) drop.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    drop.hidden = true;
    const f = e.dataTransfer.files?.[0];
    if (f) loadFile(f);
  });

  // --------------------------------------------------------- start / hint

  function begin() {
    if (started) return;
    started = true;
    start.classList.add('gone');
    audio.ensureContext().catch(() => {});
    hint.classList.remove('gone');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hint.classList.add('gone'), HINT_MS);
    activity();
  }

  // ------------------------------------------------- visibility handling

  function applyVisibility() {
    const hidden = !started || forcedHidden || idleHidden;
    ui.classList.toggle('hidden', hidden);
    document.body.classList.toggle('cursor-hidden', started && hidden);
  }

  function activity() {
    lastActivity = performance.now();
    idleHidden = false;
    applyVisibility();
  }

  function toggleHidden() {
    forcedHidden = !forcedHidden;
    if (!forcedHidden) idleHidden = false;
    lastActivity = performance.now();
    applyVisibility();
  }

  ui.addEventListener('pointerover', (e) => {
    if (e.target.closest('.glass, .btn')) hoveringUI = true;
  });
  ui.addEventListener('pointerout', (e) => {
    if (!e.relatedTarget || !e.relatedTarget.closest?.('.glass, .btn')) hoveringUI = false;
  });

  function toast(msg, ms = 2600) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  // ---------------------------------------------------------- per frame

  const bars = {};
  for (const el of document.querySelectorAll('#meter .bar')) bars[el.dataset.k] = el.firstElementChild;
  const beatDot = $('beat-dot');

  function update(now = performance.now()) {
    if (started && !idleHidden && !forcedHidden && !hoveringUI && !seeking && now - lastActivity > IDLE_HIDE_MS) {
      idleHidden = true;
      applyVisibility();
    }
    if (ui.classList.contains('hidden')) return; // skip DOM writes nobody sees

    for (const k of ['bass', 'mid', 'treble', 'energy']) {
      bars[k].style.transform = `scaleY(${Math.max(0.05, audio[k]).toFixed(3)})`;
    }
    beatDot.style.opacity = (0.15 + 0.85 * audio.beat).toFixed(3);

    if (audio.mode === 'file') {
      const d = audio.duration;
      if (!seeking && d > 0) {
        const p = audio.currentTime / d;
        seek.value = String(Math.round(p * 1000));
        seek.style.setProperty('--p', `${(p * 100).toFixed(2)}%`);
      }
      $('time').textContent = formatTime(seeking ? (seek.value / 1000) * d : audio.currentTime);
    }
  }

  return {
    update,
    activity,
    toggleHidden,
    toast,
    begin,
    get started() {
      return started;
    },
    togglePlay: () => audio.togglePlay().catch(() => {}),
  };
}
