// Keyboard shortcuts: a pure table of actions with default key combos, plus helpers to read a keyboard event,
// merge the person's overrides (stored in prefs.keys) and detect conflicts. The shell runs the actions.

/** id, label, default combo (or ''), group. `scope: 'timeline-skip'` = ignored while the timeline has focus (it has its own arrows/Delete). */
export const ACTIONS = [
  { id: 'play', label: 'Play / pause', key: 'Space', group: 'Playback' },
  { id: 'prev', label: 'Previous frame', key: 'ArrowLeft', group: 'Playback', skipIn: '.tl-scroll' },
  { id: 'next', label: 'Next frame', key: 'ArrowRight', group: 'Playback', skipIn: '.tl-scroll' },
  { id: 'prev10', label: 'Back 10 frames', key: 'Shift+ArrowLeft', group: 'Playback', skipIn: '.tl-scroll' },
  { id: 'next10', label: 'Forward 10 frames', key: 'Shift+ArrowRight', group: 'Playback', skipIn: '.tl-scroll' },
  { id: 'start', label: 'Go to start', key: 'Home', group: 'Playback' },
  { id: 'end', label: 'Go to end', key: 'End', group: 'Playback' },
  { id: 'back10', label: 'Back 10 seconds', key: 'J', group: 'Playback' },
  { id: 'fwd10', label: 'Forward 10 seconds', key: 'L', group: 'Playback' },
  { id: 'loop', label: 'Toggle loop', key: 'Shift+L', group: 'Playback' },
  { id: 'tap', label: 'Tap the next lyric / script line', key: 'T', group: 'Lyrics' },
  { id: 'toolSelect', label: 'Select tool', key: 'V', group: 'Preview tools' },
  { id: 'toolMove', label: 'Move tool', key: 'W', group: 'Preview tools' },
  { id: 'toolRotate', label: 'Rotate tool', key: 'E', group: 'Preview tools' },
  { id: 'toolScale', label: 'Scale tool', key: 'R', group: 'Preview tools' },
  { id: 'toggleEdit', label: 'Editing in the preview on / off', key: 'Q', group: 'Preview tools' },
  { id: 'resetXform', label: 'Reset position, scale and rotation of the selected layer', key: 'Shift+R', group: 'Preview tools' },
  { id: 'undo', label: 'Undo', key: 'Ctrl+Z', group: 'Project' },
  { id: 'redo', label: 'Redo', key: 'Ctrl+Shift+Z', group: 'Project' },
  { id: 'redo2', label: 'Redo (alternative)', key: 'Ctrl+Y', group: 'Project' },
  { id: 'save', label: 'Save project', key: 'Ctrl+S', group: 'Project' },
  { id: 'open', label: 'Open project', key: 'Ctrl+O', group: 'Project' },
  { id: 'export', label: 'Export video', key: 'Ctrl+E', group: 'Project' },
  { id: 'dup', label: 'Duplicate layer', key: 'Ctrl+D', group: 'Layers' },
  { id: 'del', label: 'Delete layer', key: 'Delete', group: 'Layers', skipIn: '.tl-scroll' },
];
export const ACTION_BY_ID = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));

const MOD_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);
const NAMES = { ' ': 'Space', Spacebar: 'Space', Esc: 'Escape', Del: 'Delete', Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown' };

/** "ctrl+shift+z" / "Cmd+Z" -> "Ctrl+Shift+Z" (modifier order Ctrl, Alt, Shift; letters upper-case). */
export function normalizeCombo(str) {
  if (!str) return '';
  const parts = String(str).split('+').map((s) => s.trim()).filter(Boolean);
  const mods = new Set(); let key = '';
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'ctrl' || l === 'control' || l === 'cmd' || l === 'meta' || l === 'command') mods.add('Ctrl');
    else if (l === 'alt' || l === 'option') mods.add('Alt');
    else if (l === 'shift') mods.add('Shift');
    else { const cap = p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1).toLowerCase(); key = NAMES[p] ?? NAMES[cap] ?? (p.length > 1 && /^arrow/i.test(p) ? `Arrow${cap.slice(5)}` : cap); }
  }
  if (!key) return '';
  return [...['Ctrl', 'Alt', 'Shift'].filter((m) => mods.has(m)), key].join('+');
}

/** The combo for a keyboard event, or '' for a bare modifier press. */
export function eventCombo(e) {
  if (MOD_KEYS.has(e.key)) return '';
  const key = e.code === 'Space' ? 'Space' : (NAMES[e.key] ?? e.key);
  return normalizeCombo([e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', key].filter(Boolean).join('+'));
}

/** combo -> action id for the defaults with the person's overrides applied (an override of '' disables the action). */
export function buildMap(overrides = {}) {
  const map = new Map();
  for (const a of ACTIONS) {
    const combo = normalizeCombo(Object.hasOwn(overrides, a.id) ? overrides[a.id] : a.key);
    if (combo && !map.has(combo)) map.set(combo, a.id);
  }
  return map;
}

export const comboOf = (id, overrides = {}) => normalizeCombo(Object.hasOwn(overrides, id) ? overrides[id] : ACTION_BY_ID[id]?.key ?? '');

/** The action that already uses `combo` (other than `id`), if any. */
export function conflictFor(id, combo, overrides = {}) {
  const c = normalizeCombo(combo); if (!c) return null;
  return ACTIONS.find((a) => a.id !== id && comboOf(a.id, overrides) === c) ?? null;
}

/** Friendly text for display ("ArrowLeft" -> "←"). */
export const prettyCombo = (c) => (c || 'None').replace('ArrowLeft', '←').replace('ArrowRight', '→').replace('ArrowUp', '↑').replace('ArrowDown', '↓');
