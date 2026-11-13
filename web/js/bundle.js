// Self-contained project bundle: one .zip holding the project JSON and every
// referenced file, so a project reloads without re-selecting anything.

import { zipSync, unzipSync } from '../vendor/fflate.js';

export const BUNDLE_JSON = 'project.easymv.json';
const enc = new TextEncoder();
const dec = new TextDecoder();

/** All file paths a project refers to (master, stems, element files). */
export function referencedPaths(project) {
  const paths = [project.masterMix.path, ...project.stems.map((s) => s.path)];
  for (const e of project.elements) {
    if (e.path) paths.push(e.path);
    if (e.zipPath) paths.push(e.zipPath);
  }
  return [...new Set(paths)];
}

/**
 * @param files Map<string, File|Blob> by project path
 * @returns {Promise<{blob: Blob, missing: string[]}>}
 */
export async function packBundle(project, files) {
  const entries = {};
  const missing = [];
  for (const path of referencedPaths(project)) {
    const f = files.get(path);
    if (!f) { missing.push(path); continue; }
    entries[`assets/${path}`] = [new Uint8Array(await f.arrayBuffer()), { level: 0 }]; // media is already compressed
  }
  entries[BUNDLE_JSON] = [enc.encode(JSON.stringify(project, null, 2)), { level: 6 }];
  return { blob: new Blob([zipSync(entries)], { type: 'application/zip' }), missing };
}

/** @returns {Promise<{project: object, files: Map<string, File>}>} */
export async function unpackBundle(blob) {
  const raw = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const json = raw[BUNDLE_JSON];
  if (!json) throw new Error(`not an EasyMV bundle (missing ${BUNDLE_JSON})`);
  const project = JSON.parse(dec.decode(json));
  const files = new Map();
  for (const [name, data] of Object.entries(raw)) {
    if (!name.startsWith('assets/') || name.endsWith('/')) continue;
    const path = name.slice('assets/'.length);
    files.set(path, new File([data], path));
  }
  return { project, files };
}
