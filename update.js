// Mise à jour de l'extension depuis le NAS (serveur WebDAV déjà utilisé pour la synchronisation).
// - checkUpdate()  : compare la version publiée sur le NAS avec la version installée
// - applyUpdate()  : télécharge les fichiers, les écrit dans le dossier de l'extension (choisi une fois) puis recharge
import { authHeaders } from "./sync.js";
import { CONFIG } from "./config.js";
import { tr } from "./i18n.js";

const UPD_DB = "roomwatch", UPD_STORE = "handles", UPD_KEY = "ext-dir";

const idb = () => new Promise((resolve, reject) => {
  const r = indexedDB.open(UPD_DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(UPD_STORE);
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

export async function saveDirHandle(handle) {
  const db = await idb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(UPD_STORE, "readwrite");
    tx.objectStore(UPD_STORE).put(handle, UPD_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadDirHandle() {
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(UPD_STORE).objectStore(UPD_STORE).get(UPD_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export const currentVersion = () => chrome.runtime.getManifest().version;

// Ajoute un paramètre unique : évite qu'un cache (navigateur, Cloudflare…) renvoie d'anciens fichiers
const bust = (u) => u + (u.includes("?") ? "&" : "?") + "cb=" + Date.now();

// Texte lisible pour les erreurs de mise à jour
export function updateErrorText(msg) {
  if (msg === "NETWORK") return tr("Serveur de mise à jour injoignable");
  if (msg === "NOTFOUND") return tr("Aucune version publiée à cette adresse : vérifie l'adresse du dossier.");
  if (msg === "ZIP_INVALID") return tr("Le fichier zip publié est illisible ou ne contient pas l'extension.");
  if (msg === "STALE") return tr("Les fichiers reçus ne correspondent pas à la version annoncée. Réessaie dans quelques minutes.");
  if (String(msg).startsWith("RELOAD_FAILED:")) return tr("Fichiers mis à jour (v{v}) mais l'extension ne s'est pas rechargée : clique sur ⟳ dans chrome://extensions.", { v: msg.split(":")[1] });
  return msg;
}

// Une mise à jour est-elle disponible ? Recalculé avec la version INSTALLÉE maintenant
// (l'information enregistrée peut dater d'avant une mise à jour faite à la main)
export const updateAvailable = (u) => !!(u && u.latest && cmpVersion(u.latest, currentVersion()) > 0);

export function cmpVersion(a, b) {
  const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Adresse du dossier de l'application sur le NAS : réglage manuel, sinon déduite de l'adresse de synchronisation
export async function updateBase() {
  const { syncCfg, updateCfg } = await chrome.storage.local.get(["syncCfg", "updateCfg"]);
  let base = updateCfg && updateCfg.url ? updateCfg.url.trim() : CONFIG.UPDATE_URL;
  if (!base) throw new Error("Adresse de mise à jour non configurée");
  const zip = /\.zip\s*$/i.test(base); // adresse d'un fichier zip : mise à jour depuis ce seul fichier
  if (!zip) {
    base = base.replace(/files\.json\s*$/i, ""); // on tolère l'adresse complète du fichier files.json
    if (!base.endsWith("/")) base += "/";
  }
  let auth = {}; // identifiants envoyés seulement si le dossier est sur le même serveur que la synchronisation
  try { if (syncCfg && syncCfg.url && new URL(syncCfg.url).origin === new URL(base).origin) auth = authHeaders(syncCfg); } catch { /* adresse invalide */ }
  return { base, auth, zip };
}

async function inflateRaw(raw) {
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).arrayBuffer();
}

// Extrait un zip en mémoire : { "chemin/relatif": ArrayBuffer }. Le dossier racine éventuel du zip est retiré.
export async function unzip(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let e = buf.byteLength - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("ZIP_INVALID");
  const n = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const raw = {};
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("ZIP_INVALID");
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;
    const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    const data = u8.subarray(start, start + csize);
    raw[name] = method === 0 ? data.slice().buffer : await inflateRaw(data);
  }
  const mani = Object.keys(raw).filter((k) => k === "manifest.json" || k.endsWith("/manifest.json")).sort((a, b) => a.length - b.length)[0];
  if (!mani) throw new Error("ZIP_INVALID");
  const prefix = mani.slice(0, mani.length - "manifest.json".length);
  const files = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith(prefix)) continue;
    const rel = k.slice(prefix.length);
    if (!rel || rel.split("/").includes("..")) continue;
    files[rel] = v;
  }
  return files;
}

// Récupère le zip publié : { version, files }
async function fetchZip(base, auth) {
  let res;
  try { res = await fetch(bust(base), { headers: auth, cache: "no-store" }); } catch { throw new Error("NETWORK"); }
  if (res.status === 404) throw new Error("NOTFOUND");
  if (res.status === 401 || res.status === 403) throw new Error(`Identifiants refusés (HTTP ${res.status})`);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const files = await unzip(await res.arrayBuffer());
  let version = null;
  try { version = JSON.parse(new TextDecoder().decode(files["manifest.json"])).version; } catch { /* illisible */ }
  if (!version) throw new Error("ZIP_INVALID");
  return { version, files };
}

export async function checkUpdate() {
  const prev = (await chrome.storage.local.get("updateInfo")).updateInfo || {};
  try {
    const { base, auth, zip } = await updateBase();
    let info;
    if (zip) info = { version: (await fetchZip(base, auth)).version, files: [] };
    else {
      let res;
      try { res = await fetch(bust(base + "files.json"), { headers: auth, cache: "no-store" }); } catch { throw new Error("NETWORK"); }
      if (res.status === 404) throw new Error("NOTFOUND");
      if (res.status === 401 || res.status === 403) throw new Error(`Identifiants refusés (HTTP ${res.status})`);
      if (!res.ok) throw new Error("HTTP " + res.status);
      info = await res.json();
      if (!info || !info.version || !Array.isArray(info.files)) throw new Error("Fichier files.json invalide sur le serveur");
    }
    const out = { latest: info.version, current: currentVersion(), available: cmpVersion(info.version, currentVersion()) > 0, at: Date.now(), error: null };
    await chrome.storage.local.set({ updateInfo: out });
    return out;
  } catch (e) {
    await chrome.storage.local.set({ updateInfo: { ...prev, current: currentVersion(), at: Date.now(), error: e.message } });
    throw e;
  }
}

// Télécharge tous les fichiers en mémoire AVANT d'écrire quoi que ce soit : en cas d'échec, rien n'est modifié
async function downloadAll() {
  const { base, auth, zip } = await updateBase();
  if (zip) return fetchZip(base, auth); // un seul fichier à télécharger
  let res;
  try { res = await fetch(bust(base + "files.json"), { headers: auth, cache: "no-store" }); } catch { throw new Error("NETWORK"); }
  if (!res.ok) throw new Error("files.json introuvable sur le serveur (HTTP " + res.status + ")");
  const meta = await res.json();
  const files = {};
  const queue = [...meta.files];
  const worker = async () => { // 8 téléchargements en parallèle (au lieu d'un par un)
    while (queue.length) {
      const path = queue.shift();
      let r;
      try { r = await fetch(bust(base + path), { headers: auth, cache: "no-store" }); } catch { throw new Error("NETWORK"); }
      if (!r.ok) throw new Error(`Téléchargement impossible : ${path} (HTTP ${r.status})`);
      files[path] = await r.arrayBuffer();
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { version: meta.version, files };
}

async function assertExtensionDir(dir) {
  let manifest;
  try {
    const fh = await dir.getFileHandle("manifest.json");
    manifest = JSON.parse(await (await fh.getFile()).text());
  } catch {
    throw new Error("Ce dossier ne contient pas l'extension (manifest.json introuvable)");
  }
  if (manifest.name !== chrome.runtime.getManifest().name) throw new Error("Ce dossier n'est pas celui de Roomwatch");
}

export async function pickExtensionDir() {
  if (typeof showDirectoryPicker !== "function") throw new Error("NO_PICKER");
  const handle = await showDirectoryPicker({ id: "roomwatch", mode: "readwrite" });
  await assertExtensionDir(handle);
  await saveDirHandle(handle);
  return handle.name;
}

async function writeFile(root, path, data) {
  const parts = path.split("/");
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

export async function applyUpdate({ reload = true } = {}) {
  const dir = await loadDirHandle();
  if (!dir) throw new Error("NO_DIR");
  if ((await dir.requestPermission({ mode: "readwrite" })) !== "granted") throw new Error("Accès au dossier refusé");
  await assertExtensionDir(dir);
  const t0 = Date.now();
  const { version, files } = await downloadAll();
  const downloadMs = Date.now() - t0;
  // le manifest reçu doit bien annoncer la version publiée (sinon : anciens fichiers renvoyés par un cache) : on n'écrit rien
  let received = null;
  try { received = JSON.parse(new TextDecoder().decode(files["manifest.json"])).version; } catch { /* illisible */ }
  if (received !== version) throw new Error("STALE");
  const order = Object.keys(files).sort((a, b) => (a === "manifest.json") - (b === "manifest.json")); // manifest en dernier
  const t1 = Date.now();
  for (const path of order) await writeFile(dir, path, files[path]);
  const writeMs = Date.now() - t1;
  // relecture : le manifest écrit sur le disque doit être celui de la nouvelle version
  const onDisk = JSON.parse(await (await (await dir.getFileHandle("manifest.json")).getFile()).text());
  if (onDisk.version !== version) throw new Error("STALE");
  await chrome.storage.local.set({
    updateInfo: { latest: version, current: version, available: false, at: Date.now(), error: null },
    updatePending: { to: version, from: currentVersion(), at: Date.now() }, // vérifié au redémarrage de l'extension
    updateTimings: { version, downloadMs, writeMs, files: Object.keys(files).length, at: Date.now() },
  });
  if (reload) {
    chrome.runtime.reload();
    await new Promise((r) => setTimeout(r, 3000)); // si on est encore là, le rechargement n'a pas eu lieu
    throw new Error("RELOAD_FAILED:" + version);
  }
  return version;
}
