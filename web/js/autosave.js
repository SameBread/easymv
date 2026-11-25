// Crash recovery: the project (and, when it is not huge, its media files) is copied into the browser's IndexedDB a moment
// after every change. After a crash or an accidental tab close, the next visit offers to restore it. An explicit save clears it.

const DB = 'easymv-recovery'; const STORE = 'slots';
export const FILE_LIMIT = 400 * 1024 * 1024;     // above this the files are not kept, only the project (media is re-selected by name)

const open = () => new Promise((res, rej) => {
  if (typeof indexedDB === 'undefined') { rej(new Error('no indexedDB')); return; }
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE);
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const tx = async (mode, fn) => {
  const db = await open();
  try {
    return await new Promise((res, rej) => {
      const t = db.transaction(STORE, mode); const s = t.objectStore(STORE);
      const out = fn(s);
      t.oncomplete = () => res(out?.result ?? out);
      t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  } finally { db.close(); }
};
const get = async (key) => { const db = await open(); try { return await new Promise((res, rej) => { const r = db.transaction(STORE).objectStore(STORE).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); } finally { db.close(); } };

/** Write a snapshot. `files` is a Map name -> File. The previous latest becomes "previous" when it is at least 5 minutes old. */
export async function writeSnapshot({ project, files }) {
  let total = 0; for (const f of files.values()) total += f.size ?? 0;
  const rec = { savedAt: Date.now(), project, files: total <= FILE_LIMIT ? [...files.entries()] : null, fileNames: [...files.keys()], bytes: total };
  try {
    const prev = await get('latest');
    if (prev && rec.savedAt - prev.savedAt > 5 * 60 * 1000) await tx('readwrite', (s) => s.put(prev, 'previous'));
  } catch { /* keep going: the new snapshot matters more */ }
  await tx('readwrite', (s) => s.put(rec, 'latest'));
  return rec;
}
export async function readSnapshot(slot = 'latest') { try { return (await get(slot)) ?? null; } catch { return null; } }
export async function clearSnapshot(slot = 'latest') { try { await tx('readwrite', (s) => s.delete(slot)); } catch { /* nothing to clear */ } }

/** Does a snapshot hold anything worth restoring? */
export const hasContent = (rec) => !!rec && (rec.project?.elements?.length > 0 || !!rec.project?.masterMix?.path);

/** Debounce helper: run `fn` once things have been quiet for `ms` (and at most every `max` ms during constant editing). */
export function quiet(fn, ms = 2500, max = 15000) {
  let t = 0; let first = 0;
  return () => {
    const now = Date.now(); if (!first) first = now;
    clearTimeout(t);
    t = setTimeout(() => { first = 0; fn(); }, Math.max(0, Math.min(ms, first + max - now)));
  };
}
