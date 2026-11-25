// Boot: load Dockview, build the shell, start the engine.
import * as core from './core.js';
import { createShell } from './ui/shell.js';
import { showToast, dialog, h } from './ui/dom.js';

const loadScript = (src) => new Promise((res, rej) => {
  const s = Object.assign(document.createElement('script'), { src, onload: res, onerror: () => rej(new Error(`Could not load ${src}`)) });
  document.head.append(s);
});

core.on('toast', ({ msg, ms }) => showToast(msg, ms));

/** If the last session ended without saving, offer to bring it back. */
async function offerRecovery() {
  try {
    const rec = await core.checkRecovery(); if (!rec) return;
    const when = new Date(rec.savedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    dialog({ title: 'Restore your last session?',
      body: [h('p', `EasyMV found unsaved work from ${when}: ${rec.layers} layer${rec.layers === 1 ? '' : 's'}${rec.name ? `, song ${rec.name}` : ''}.`),
        h('p.muted', rec.hasFiles ? 'Your media was kept too, so it comes back as it was.' : 'The media was too large to keep, so you will re-select the song and files by name.')],
      actions: [{ label: 'Start fresh', run: () => { core.discardRecovery(); } },
        { label: 'Restore', variant: 'filled', run: async () => { try { await core.restoreRecovery(); core.toast('Session restored.'); } catch (e) { core.toast(`Could not restore: ${e.message ?? e}`, 5000); } } }] });
  } catch { /* no recovery available */ }
}

async function main() {
  try {
    await loadScript('vendor/dockview-core.min.js');
    const dv = window['dockview-core'];
    if (!dv?.createDockview) throw new Error('Dockview failed to load');
    const root = document.getElementById('app');
    const shell = createShell(root, dv);
    window.easymv = { core, shell };             // handy for debugging and tests
    await core.boot();
    shell.start();
    document.getElementById('boot')?.remove();
    offerRecovery();
    // drop files anywhere
    addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
    addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      const files = [...e.dataTransfer.files];
      const audio = files.filter((f) => f.type.startsWith('audio/') || /\.flac$/i.test(f.name));
      if (audio.length && !core.state.masterFile) { core.setMaster(audio[0]); shell.analyze(); audio.shift(); }
      if (audio.length) core.addStems(audio);
      const rest = files.filter((f) => !audio.includes(f) && !f.type.startsWith('audio/'));
      const proj = rest.find((f) => /\.(json|easymv)$/i.test(f.name) || (/\.zip$/i.test(f.name) && rest.length === 1));
      if (proj && rest.length === 1) core.openFile(proj); else if (rest.length) core.addFiles(rest);
    });
  } catch (e) {
    console.error(e);
    const b = document.getElementById('boot');
    if (b) b.textContent = `EasyMV could not start: ${e.message ?? e}`;
  }
}
main();
