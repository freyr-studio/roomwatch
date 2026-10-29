// Synchronisation des réglages entre plusieurs PC grâce à un fichier JSON hébergé sur un serveur
// WebDAV / HTTP (NAS, Nextcloud…), plus import/export de fichier.
import { tr } from "./i18n.js";
import { DEFAULT_SETTINGS, SEED_AFK, getSettings, saveSettings } from "./lib.js";

export const SYNC_KEYS = ["watch", "afk", "others", "settings"];

// Réglages synchronisés entre les PC. Tout le reste (notifications, sons, volumes, heures silencieuses, intervalle,
// compteur, flou…) est propre à chaque PC : désactiver les notifications sur un PC ne les coupe pas sur les autres.
export const SYNC_SETTING_KEYS = ["lang", "theme", "autoArchive", "archiveDays", "autoReturn", "afkNotify", "filterByRoom"];
const pickShared = (o = {}) => Object.fromEntries(SYNC_SETTING_KEYS.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
export const canon = (p) => JSON.stringify({
  watch: [...(p.watch || [])].sort(),
  afk: [...(p.afk || [])].sort(),
  others: [...(p.others || [])].sort(),
  settings: sortKeys(p.settings || {}),
});

export async function localPayload() {
  const s = await chrome.storage.local.get(["watch", "afk", "others"]);
  const settings = pickShared(await getSettings());
  return { watch: s.watch || [], afk: s.afk || [], others: s.others || [], settings };
}

function normalizeDoc(doc) {
  return {
    watch: Array.isArray(doc.watch) ? doc.watch : [],
    afk: Array.isArray(doc.afk) ? doc.afk : [],
    others: Array.isArray(doc.others) ? doc.others : [],
    settings: { ...pickShared(DEFAULT_SETTINGS), ...pickShared(doc.settings) },
  };
}

// Machine « neuve » : rien de personnalisé, on accepte directement les données du serveur
function isPristine(p) {
  return !p.watch.length && !p.others.length
    && canon({ afk: p.afk }) === canon({ afk: SEED_AFK })
    && JSON.stringify(sortKeys(p.settings)) === JSON.stringify(sortKeys(pickShared(DEFAULT_SETTINGS)));
}

export function authHeaders(cfg, json = false) {
  const h = {};
  if (json) h["Content-Type"] = "application/json";
  if (cfg.user) h.Authorization = "Basic " + btoa(String.fromCharCode(...new TextEncoder().encode(`${cfg.user}:${cfg.pass || ""}`)));
  return h;
}

async function getRemote(cfg) {
  let res;
  try { res = await fetch(cfg.url, { headers: authHeaders(cfg), cache: "no-store" }); } catch { throw new Error("NETWORK"); }
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) throw new Error(`Identifiants refusés (HTTP ${res.status})`);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const text = await res.text();
  if (!text.trim()) return null;
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error("Fichier distant illisible (JSON invalide)"); }
  if (!doc || doc.app !== "roomwatch") throw new Error("Ce fichier n'est pas un fichier Roomwatch");
  return doc;
}

async function putRemote(cfg, payload) {
  const doc = { app: "roomwatch", version: 3, updatedAt: Date.now(), ...payload };
  let res;
  try { res = await fetch(cfg.url, { method: "PUT", headers: authHeaders(cfg, true), body: JSON.stringify(doc) }); } catch { throw new Error("NETWORK"); }
  if (![200, 201, 204].includes(res.status)) throw new Error(`Écriture refusée (HTTP ${res.status})`);
}

async function applyPayload(p) {
  const { settings: cur = {} } = await chrome.storage.local.get("settings"); // on garde les réglages propres à ce PC
  await chrome.storage.local.set({ watch: p.watch, afk: p.afk, others: p.others, settings: { ...cur, ...p.settings } });
}

const union = (a, b) => [...new Set([...(a || []), ...(b || [])])];

// Texte lisible pour les erreurs de synchronisation
export function syncErrorText(msg) {
  return msg === "NETWORK" ? tr("Serveur injoignable : vérifie l'adresse (Synchronisation > Options avancées) et ta connexion.") : msg;
}

export async function syncNow() {
  const { syncCfg } = await chrome.storage.local.get("syncCfg");
  if (!syncCfg || !syncCfg.enabled || !syncCfg.url) return { skipped: true };
  const { syncMeta = {} } = await chrome.storage.local.get("syncMeta");
  try {
    const local = await localPayload();
    const localJson = canon(local);
    const last = syncMeta.lastJson || "";
    let localChanged = localJson !== last;
    if (!last && isPristine(local)) localChanged = false;

    const remoteDoc = await getRemote(syncCfg);
    let finalPayload = local, action;
    if (!remoteDoc) {
      await putRemote(syncCfg, local);
      action = "push";
    } else {
      const remote = normalizeDoc(remoteDoc);
      const remoteJson = canon(remote);
      const remoteChanged = remoteJson !== last;
      if (remoteJson === localJson) action = "same";
      else if (localChanged && !remoteChanged) { await putRemote(syncCfg, local); action = "push"; }
      else if (!localChanged && remoteChanged) { await applyPayload(remote); finalPayload = await localPayload(); action = "pull"; }
      else { // modifié des deux côtés (ou première synchro) : on fusionne les listes, sans rien perdre
        await applyPayload({ watch: union(local.watch, remote.watch), afk: union(local.afk, remote.afk), others: union(local.others, remote.others), settings: local.settings });
        finalPayload = await localPayload();
        await putRemote(syncCfg, finalPayload);
        action = "merge";
      }
    }
    await chrome.storage.local.set({ syncMeta: { lastJson: canon(finalPayload), at: Date.now(), error: null, action } });
    return { action };
  } catch (e) {
    await chrome.storage.local.set({ syncMeta: { ...syncMeta, at: Date.now(), error: e.message } });
    return { error: e.message };
  }
}

// ---------- Import / export de fichier ----------
export async function buildBackup() {
  return { app: "roomwatch", version: 3, ...(await localPayload()) };
}

export async function applyBackup(data, { replace = false } = {}) {
  if (!data || data.app !== "roomwatch" || !Array.isArray(data.watch)) throw new Error("INVALID");
  const cur = await chrome.storage.local.get(["watch", "afk", "others"]);
  const names = (arr) => arr.map((n) => String(n).trim().toLowerCase().replace(/^https?:\/\/[^/]+\//, "").split(/[/?#]/)[0]).filter(Boolean);
  const merge = (a, b) => (replace ? [...new Set(b)] : [...new Set([...(a || []), ...b])]);
  const patch = { watch: merge(cur.watch, names(data.watch)) };
  if (Array.isArray(data.afk)) patch.afk = merge(cur.afk, names(data.afk));
  if (Array.isArray(data.others)) patch.others = merge(cur.others, names(data.others));
  await chrome.storage.local.set(patch);
  const incoming = { ...(data.settings || {}) };
  if (typeof data.notify === "boolean" && incoming.notify === undefined) incoming.notify = data.notify;
  const clean = {};
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) if (typeof incoming[k] === typeof def) clean[k] = incoming[k];
  if (Object.keys(clean).length) await saveSettings(clean);
  return { watch: patch.watch.length, afk: (patch.afk || cur.afk || []).length };
}
