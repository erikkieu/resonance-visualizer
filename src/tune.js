/**
 * tune.js: a small slider panel for tuning a scene live, toggled with T.
 *
 * A scene creates one in init() with its own parameters and removes it in
 * dispose(), so the panel only exists while that scene is active:
 *
 *   this.tune = createTunePanel({ title: 'Liquid Paint', storageKey: 'resonance.tune.fluid', params: [
 *     { key: 'bloomSize', label: 'bloom size', min: 0, max: 3, step: 0.05, value: 1 },
 *   ]});
 *   ... this.tune.values.bloomSize ...
 *   this.tune.dispose();
 *
 * Values are remembered in localStorage (per browser), "copy" puts them on
 * the clipboard as JSON so they can be baked into the scene's defaults, and
 * "reset" restores the defaults. The panel stays visible when the rest of
 * the UI hides, like the debug overlay.
 *
 * A scene profile (scenes/profiles/*.js) can expose numbers deep inside its
 * config object instead: configParams(config, [['SPEED.MAX', 'max speed', 0, 4, 0.05], ...])
 * builds the params, and bindConfig(config) as `onChange` writes every change
 * straight back into the config, which the scene reads every frame.
 */

const STYLE = `
.tune {
  position: fixed;
  top: max(16px, env(safe-area-inset-top));
  left: max(16px, env(safe-area-inset-left));
  width: 280px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
  padding: 10px 12px 12px;
  border-radius: 12px;
  background: rgba(6, 10, 20, 0.72);
  border: 1px solid var(--line, rgba(255, 255, 255, 0.13));
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: var(--fg, rgba(240, 246, 255, 0.92));
  font: 11px/1.5 ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  z-index: 50;
}
.tune[hidden] { display: none; }
.tune-title { display: flex; justify-content: space-between; margin-bottom: 6px; font-weight: 600; }
.tune-title span { color: var(--fg-faint, rgba(225, 235, 250, 0.34)); font-weight: 400; }
.tune-group { margin: 8px 0 2px; color: var(--fg-dim, rgba(225, 235, 250, 0.58)); text-transform: uppercase; letter-spacing: 0.08em; font-size: 10px; }
.tune-row { display: grid; grid-template-columns: 1fr 44px; align-items: center; column-gap: 8px; }
.tune-row label { grid-column: 1 / -1; color: var(--fg-dim, rgba(225, 235, 250, 0.58)); }
.tune-row input { width: 100%; margin: 0; accent-color: var(--accent, #9fe8ff); }
.tune-row output { text-align: right; font-variant-numeric: tabular-nums; }
.tune-row.changed output { color: var(--accent, #9fe8ff); }
.tune-actions { display: flex; gap: 6px; margin-top: 10px; }
.tune-actions button {
  flex: 1;
  padding: 4px 0;
  border-radius: 6px;
  border: 1px solid var(--line, rgba(255, 255, 255, 0.13));
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.tune-actions button:hover { background: rgba(255, 255, 255, 0.14); }
`;

let styleAdded = false;

function load(storageKey) {
  try {
    return JSON.parse(localStorage.getItem(storageKey) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function save(storageKey, values) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(values));
  } catch {
    // private mode or blocked storage: values still work for this visit
  }
}

const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o?.[k], obj);
  if (target && typeof target[last] === 'number') target[last] = value;
}

// the config's own values, before any tuning was written into it (defaults for "reset")
const originals = new WeakMap();

/** Tune-panel params for numbers in a nested config: entries are { group } or [path, label, min, max, step, hint]. */
export function configParams(config, entries) {
  if (!originals.has(config)) originals.set(config, {});
  const orig = originals.get(config);
  return entries.map((e) => {
    if (!Array.isArray(e)) return e;
    orig[e[0]] ??= getPath(config, e[0]);
    return { key: e[0], label: e[1], min: e[2], max: e[3], step: e[4], hint: e[5], value: orig[e[0]] };
  });
}

/** onChange handler that writes tuned values back into `config` by their dotted paths. */
export const bindConfig = (config) => (values) => {
  for (const [path, v] of Object.entries(values)) setPath(config, path, v);
};

export function createTunePanel({ title, params, storageKey, key = 't', onChange = () => {} }) {
  if (!styleAdded) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);
    styleAdded = true;
  }

  const defaults = Object.fromEntries(params.filter((p) => p.key).map((p) => [p.key, p.value]));
  const stored = load(storageKey);
  const values = { ...defaults };
  for (const k of Object.keys(defaults)) if (typeof stored[k] === 'number') values[k] = stored[k];

  onChange(values);

  const el = document.createElement('div');
  el.className = 'tune';
  el.hidden = true;
  el.innerHTML = `<div class="tune-title">${title}<span>${key.toUpperCase()} to close</span></div>`;

  const rows = new Map();
  const decimals = (step) => Math.max(0, -Math.floor(Math.log10(step)));
  for (const p of params) {
    if (p.group) {
      const g = document.createElement('div');
      g.className = 'tune-group';
      g.textContent = p.group;
      el.appendChild(g);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'tune-row';
    row.title = p.hint ?? '';
    row.innerHTML = `<label>${p.label}</label><input type="range" min="${p.min}" max="${p.max}" step="${p.step}"><output></output>`;
    const input = row.querySelector('input');
    const out = row.querySelector('output');
    const show = () => {
      out.textContent = values[p.key].toFixed(decimals(p.step));
      row.classList.toggle('changed', values[p.key] !== defaults[p.key]);
    };
    input.value = values[p.key];
    input.addEventListener('input', () => {
      values[p.key] = Number(input.value);
      show();
      save(storageKey, values);
      onChange(values);
    });
    // double-click a slider to reset just that one
    input.addEventListener('dblclick', () => {
      values[p.key] = defaults[p.key];
      input.value = values[p.key];
      show();
      save(storageKey, values);
      onChange(values);
    });
    show();
    rows.set(p.key, { input, show });
    el.appendChild(row);
  }

  const actions = document.createElement('div');
  actions.className = 'tune-actions';
  actions.innerHTML = '<button data-a="copy">copy values</button><button data-a="reset">reset all</button>';
  actions.addEventListener('click', (e) => {
    const a = e.target.dataset?.a;
    if (a === 'reset') {
      Object.assign(values, defaults);
      for (const [k, r] of rows) {
        r.input.value = values[k];
        r.show();
      }
      save(storageKey, values);
      onChange(values);
    } else if (a === 'copy') {
      const text = JSON.stringify(values, null, 2);
      navigator.clipboard?.writeText(text).then(
        () => (e.target.textContent = 'copied!'),
        () => (e.target.textContent = 'copy failed'),
      );
      setTimeout(() => (e.target.textContent = 'copy values'), 1500);
    }
  });
  el.appendChild(actions);

  // keep slider drags and clicks from reaching the canvas (which pours paint)
  for (const type of ['pointerdown', 'pointermove', 'pointerup']) el.addEventListener(type, (e) => e.stopPropagation());

  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== key) return;
    if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
    el.hidden = !el.hidden;
  };
  window.addEventListener('keydown', onKey);
  document.body.appendChild(el);

  return {
    values,
    dispose() {
      window.removeEventListener('keydown', onKey);
      el.remove();
    },
  };
}
