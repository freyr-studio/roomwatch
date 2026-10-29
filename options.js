import { getSettings, saveSettings, syncFollowing, diagnoseFollowing, GENDERS } from "./lib.js";
import { fillSoundSelect, previewSound } from "./sounds.js";
import { syncNow, buildBackup, applyBackup, syncErrorText } from "./sync.js";
import { tr, setLang, resolveLang, captureI18n, applyI18n } from "./i18n.js";
import { CONFIG } from "./config.js";
import { checkUpdate, applyUpdate, pickExtensionDir, loadDirHandle, currentVersion, updateErrorText, updateBase } from "./update.js";

const $ = (id) => document.getElementById(id);
captureI18n();
const LOGIN_URL = "https://chaturbate.com/auth/login/";

const st = {
  following: [], rooms: [], watch: [], settings: {}, customSounds: [], syncCfg: null, syncMeta: null, updateInfo: null, updateCfg: null,
  error: null, info: null, at: 0, updatedAt: 0,
  g: null, filter: "all", q: "",
};
let counts = { total: 0, shown: 0 };
let lastReport = null;

/* ---------- données ---------- */
async function load() {
  const s = await chrome.storage.local.get(["following", "followingAt", "followingInfo", "rooms", "watch", "error", "updatedAt", "customSounds", "syncCfg", "syncMeta", "updateInfo", "updateCfg"]);
  st.following = s.following || [];
  st.at = s.followingAt || 0;
  st.info = s.followingInfo || null;
  st.rooms = s.rooms || [];
  st.watch = s.watch || [];
  st.customSounds = s.customSounds || [];
  st.syncCfg = s.syncCfg || null;
  st.syncMeta = s.syncMeta || null;
  st.updateInfo = s.updateInfo || null;
  st.updateCfg = s.updateCfg || null;
  st.error = s.error || null;
  st.updatedAt = s.updatedAt || 0;
  st.settings = await getSettings();
}

// Toutes les rooms connues : abonnements synchronisés + rooms en live + favoris déjà choisis
function universe() {
  const map = new Map();
  for (const f of st.following) map.set(f.username.toLowerCase(), { name: f.username, gender: f.gender });
  for (const r of st.rooms) {
    const k = r.username.toLowerCase();
    if (!map.has(k)) map.set(k, { name: r.username, gender: r.gender });
    else if (!map.get(k).gender && r.gender) map.get(k).gender = r.gender;
  }
  for (const n of st.watch) if (!map.has(n)) map.set(n, { name: n, gender: null });
  return [...map.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => a.key.localeCompare(b.key));
}

function visible(uni) {
  const live = new Set(st.rooms.map((r) => r.username.toLowerCase()));
  const sel = new Set(st.watch);
  const q = st.q.trim().toLowerCase();
  const anyGender = uni.some((u) => u.gender);
  const codes = st.g ? (GENDERS.find((g) => g.id === st.g)?.codes ?? [st.g]) : null;
  return uni.filter((u) =>
    (!q || u.key.includes(q)) &&
    (!codes || !anyGender || codes.includes(String(u.gender || "").toLowerCase())) &&
    (st.filter === "all" || (st.filter === "live" && live.has(u.key)) || (st.filter === "sel" && sel.has(u.key)))
  );
}

/* ---------- rendu ---------- */
function updateCount() {
  $("sel-count").textContent = tr("{n} sélectionnée(s) · {a} affichée(s) sur {t}", { n: st.watch.length, a: counts.shown, t: counts.total });
}

function renderRooms() {
  const uni = universe();
  const vis = visible(uni);
  counts = { total: uni.length, shown: vis.length };
  const live = new Set(st.rooms.map((r) => r.username.toLowerCase()));
  const sel = new Set(st.watch);
  const frag = document.createDocumentFragment();
  for (const u of vis) {
    const label = document.createElement("label");
    label.className = "room" + (live.has(u.key) ? " live" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = sel.has(u.key);
    cb.dataset.k = u.key;
    const name = document.createElement("span");
    name.textContent = u.name;
    label.append(cb, name);
    frag.append(label);
  }
  $("rooms").replaceChildren(frag);
  updateCount();

  const note = $("rooms-note");
  if (st.error === "AUTH") {
    note.hidden = false;
    note.textContent = tr("Tu n'es pas connecté à Chaturbate : connecte-toi (onglet Compte) pour voir tes abonnements.");
  } else if (st.info && st.info.strategy === "online-only") {
    note.hidden = false;
    note.textContent = tr("Seuls tes abonnements actuellement en live sont listés (la liste complète n'a pas pu être récupérée). Voir l'onglet Compte > Diagnostic.");
  } else {
    note.hidden = true;
  }
}

function refreshChecks() {
  const sel = new Set(st.watch);
  document.querySelectorAll("#rooms input").forEach((cb) => (cb.checked = sel.has(cb.dataset.k)));
  updateCount();
}

function refreshLive() {
  const live = new Set(st.rooms.map((r) => r.username.toLowerCase()));
  document.querySelectorAll("#rooms .room").forEach((l) => l.classList.toggle("live", live.has(l.querySelector("input").dataset.k)));
}

function renderAccount() {
  const authErr = st.error === "AUTH";
  const connected = !authErr && (st.at || st.updatedAt);
  $("acc-badge").className = "dot " + (authErr ? "bad" : connected ? "ok" : "");
  $("acc-text").textContent = authErr ? tr("Non connecté à Chaturbate") : connected ? tr("Connecté à Chaturbate") : tr("Vérification…");
  $("acc-login").hidden = !authErr;
  const live = st.rooms.length;
  $("acc-info").textContent = st.info
    ? tr("{n} abonnement(s) détecté(s) dont {o} en live · synchro le {d}", { n: st.info.total, o: st.info.online, d: new Date(st.at).toLocaleString() })
    : connected ? tr("{n} abonnement(s) en live en ce moment.", { n: live }) : "";
  const warn = $("acc-warn");
  warn.hidden = !(st.info && st.info.strategy === "online-only");
  warn.textContent = tr("Liste complète indisponible : seuls les abonnements en live sont visibles. Lance le diagnostic ci-dessous.");
}

function renderSettings() {
  fillSoundSelect($("o-sound"), st.customSounds);
  fillSoundSelect($("o-sound-return"), st.customSounds);
  document.querySelectorAll("[data-s]").forEach((el) => {
    const v = st.settings[el.dataset.s];
    if (el.type === "checkbox") el.checked = !!v;
    else if (el.type === "range") el.value = Math.round(v * 100);
    else el.value = v;
  });
  $("rooms-wrap").style.opacity = st.settings.filterByRoom ? "1" : ".45";
}

function renderPills() {
  $("rg").replaceChildren(...GENDERS.map((g) => {
    const b = document.createElement("button");
    b.className = "pill" + (st.g === g.id ? " active" : "");
    b.textContent = g.label;
    b.onclick = () => { st.g = st.g === g.id ? null : g.id; renderPills(); renderRooms(); };
    return b;
  }));
}

// thème et langue (réglages communs à toute l'extension)
function applyChrome() {
  document.body.dataset.theme = st.settings.theme || "default";
  setLang(resolveLang(st.settings.lang));
  applyI18n();
  document.title = tr("Roomwatch – Paramètres");
}

function renderAll() {
  applyChrome();
  renderUpdate();
  renderSound();
  renderSync();
  renderAccount();
  renderSettings();
  renderRooms();
}

/* ---------- actions ---------- */
async function setWatchKeys(keys, on) {
  const s = new Set(st.watch);
  for (const k of keys) on ? s.add(k) : s.delete(k);
  st.watch = [...s];
  await chrome.storage.local.set({ watch: st.watch });
  refreshChecks();
}

$("rooms").addEventListener("change", (e) => {
  const cb = e.target;
  if (cb.type === "checkbox") setWatchKeys([cb.dataset.k], cb.checked);
});
$("sel-all").onclick = () => setWatchKeys(visible(universe()).map((u) => u.key), true);
$("sel-none").onclick = () => setWatchKeys(visible(universe()).map((u) => u.key), false);
$("rq").addEventListener("input", () => { st.q = $("rq").value; renderRooms(); });
$("rf").addEventListener("change", () => { st.filter = $("rf").value; renderRooms(); });

document.querySelectorAll("[data-s]").forEach((el) => {
  el.addEventListener("change", async () => {
    const v = el.type === "checkbox" ? el.checked : el.type === "range" ? Number(el.value) / 100 : el.value;
    await saveSettings({ [el.dataset.s]: v });
    if (el.dataset.s === "sound" || el.dataset.s === "volume") previewSound($("o-sound").value, Number($("o-vol").value) / 100, st.customSounds);
    if (el.dataset.s === "returnSound" || el.dataset.s === "returnVolume") previewSound($("o-sound-return").value, Number($("o-vol-return").value) / 100, st.customSounds);
  });
});

function showSection(name) {
  if (!document.getElementById("sec-" + name)) name = "notifs";
  document.querySelectorAll("nav a").forEach((x) => x.classList.toggle("active", x.dataset.sec === name));
  document.querySelectorAll("main > section").forEach((sec) => (sec.hidden = sec.id !== "sec-" + name));
}
document.querySelectorAll("nav a").forEach((a) => {
  a.onclick = (e) => { e.preventDefault(); showSection(a.dataset.sec); };
});

$("acc-login").onclick = () => chrome.tabs.create({ url: LOGIN_URL });

async function runSync() {
  $("sync-status").textContent = tr("Synchronisation…");
  try {
    await syncFollowing();
    $("sync-status").textContent = tr("Terminé.");
  } catch (e) {
    $("sync-status").textContent = e.message === "AUTH" ? tr("Connecte-toi d'abord à Chaturbate.") : tr("Erreur : {e}", { e: e.message });
  }
  await load();
  renderAll();
}
$("sync").onclick = runSync;

$("diag").onclick = async () => {
  $("diag").disabled = true;
  $("diag-out").hidden = false;
  $("diag-out").textContent = tr("Analyse en cours…");
  lastReport = await diagnoseFollowing();
  $("diag-out").textContent = JSON.stringify(lastReport, null, 2);
  $("diag-copy").hidden = false;
  $("diag").disabled = false;
};
$("diag-copy").onclick = async () => {
  try { await navigator.clipboard.writeText(JSON.stringify(lastReport, null, 2)); $("diag-copy").textContent = tr("Copié !"); } catch {}
  setTimeout(() => ($("diag-copy").textContent = tr("Copier le rapport")), 1500);
};

/* ---------- synchronisation avec le stockage ---------- */
chrome.storage.onChanged.addListener(async (ch, area) => {
  if (area !== "local") return;
  if (ch.following || ch.error) { await load(); renderAll(); return; }
  if (ch.rooms) { st.rooms = ch.rooms.newValue || []; refreshLive(); renderAccount(); }
  if (ch.watch) { st.watch = ch.watch.newValue || []; refreshChecks(); }
  if (ch.settings) { st.settings = await getSettings(); renderAll(); }
  if (ch.updateInfo || ch.updateCfg) { await load(); renderUpdate(); }
  if (ch.customSounds || ch.syncMeta || ch.syncCfg) { await load(); renderSettings(); renderSound(); renderSync(); }
});

/* ---------- init ---------- */
(async () => {
  renderPills();
  await load();
  renderAll();
  showSection(location.hash.slice(1) || "notifs");
  $("sync-advanced").open = !!st.syncCfg || location.hash === "#sync";
  if (!st.at && st.error !== "AUTH") runSync(); // première ouverture : récupère les abonnements
})();


/* ---------- sons personnels ---------- */
const MAX_SOUNDS = 5, MAX_BYTES = 1024 * 1024;
const soundMsg = (t) => { $("o-sound-status").textContent = t; };

function renderSound() {
  const box = $("o-sounds");
  if (!st.customSounds.length) { box.replaceChildren(Object.assign(document.createElement("p"), { className: "muted", textContent: tr("Aucun son personnel pour l'instant.") })); return; }
  box.replaceChildren(...st.customSounds.map((c) => {
    const row = document.createElement("div");
    row.className = "snd";
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = "♪ " + c.name;
    const play = document.createElement("button");
    play.textContent = "▶";
    play.title = tr("Écouter");
    play.onclick = () => previewSound("custom:" + c.id, st.settings.volume, st.customSounds);
    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = tr("Supprimer");
    del.onclick = async () => {
      st.customSounds = st.customSounds.filter((x) => x.id !== c.id);
      await chrome.storage.local.set({ customSounds: st.customSounds });
      if (st.settings.sound === "custom:" + c.id) await saveSettings({ sound: "ding" });
    };
    row.append(nm, play, del);
    return row;
  }));
}

const readData = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = reject;
  r.readAsDataURL(file);
});

$("o-preview").onclick = () => previewSound($("o-sound").value, Number($("o-vol").value) / 100, st.customSounds);
$("o-preview-return").onclick = () => previewSound($("o-sound-return").value, Number($("o-vol-return").value) / 100, st.customSounds);
$("o-file").addEventListener("change", async (e) => {
  const list = [...e.target.files];
  const cur = [...st.customSounds];
  const notes = [];
  for (const f of list) {
    if (cur.length >= MAX_SOUNDS) { notes.push(tr("{n} sons maximum.", { n: MAX_SOUNDS })); break; }
    if (f.size > MAX_BYTES) { notes.push(tr("« {f} » dépasse 1 Mo.", { f: f.name })); continue; }
    cur.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: f.name.replace(/\.[^.]+$/, "").slice(0, 30), data: await readData(f) });
  }
  if (cur.length !== st.customSounds.length) await chrome.storage.local.set({ customSounds: cur });
  soundMsg(notes.length ? notes.join(" ") : cur.length > st.customSounds.length ? tr("Son ajouté.") : "");
  e.target.value = "";
});

/* ---------- synchronisation ---------- */
const syncMsg = (t) => { $("s-status").textContent = t; };
const fileMsg = (t) => { $("f-status").textContent = t; };
const ACTIONS = { push: "Données envoyées au serveur.", pull: "Données récupérées depuis le serveur.", merge: "Fusion effectuée (rien n'a été perdu).", same: "Déjà à jour." };
const actionText = (a) => (ACTIONS[a] ? tr(ACTIONS[a]) : a);

function renderSync() {
  const c = st.syncCfg, m = st.syncMeta || {};
  if (c) { $("s-url").value = c.url || ""; $("s-user").value = c.user || ""; $("s-pass").placeholder = c.pass ? tr("(enregistré)") : ""; }
  if (!c || !c.enabled) syncMsg(tr("Synchronisation automatique désactivée."));
  else if (m.error) syncMsg(tr("Erreur : {e}", { e: syncErrorText(m.error) }));
  else syncMsg(m.at ? tr("Active · dernière synchro à {t}", { t: new Date(m.at).toLocaleTimeString() }) + (m.action ? " (" + actionText(m.action) + ")" : "") : tr("Active · en attente de la première synchro"));
}

$("s-save").onclick = async () => {
  const url = $("s-url").value.trim();
  let origin;
  try { origin = new URL(url).origin + "/*"; } catch { return syncMsg(tr("Adresse invalide.")); }
  if (!/^https?:/i.test(url)) return syncMsg(tr("L'adresse doit commencer par http:// ou https://"));
  let granted = false;
  try { granted = await chrome.permissions.request({ origins: [origin] }); } catch { /* refusé */ }
  if (!granted) return syncMsg(tr("Autorisation refusée : l'extension doit pouvoir joindre {o}", { o: origin }));
  const old = st.syncCfg || {};
  await chrome.storage.local.set({ syncCfg: { enabled: true, url, user: $("s-user").value.trim(), pass: $("s-pass").value || old.pass || "" }, syncMeta: {} });
  $("s-pass").value = "";
  syncMsg(tr("Synchronisation…"));
  const r = await syncNow();
  syncMsg(r.error ? tr("Erreur : {e}", { e: syncErrorText(r.error) }) : actionText(r.action) || tr("Terminé."));
};
$("s-now").onclick = async () => {
  syncMsg(tr("Synchronisation…"));
  const r = await syncNow();
  syncMsg(r.skipped ? tr("Enregistre d'abord les paramètres du serveur.") : r.error ? tr("Erreur : {e}", { e: syncErrorText(r.error) }) : actionText(r.action) || tr("Terminé."));
};
$("s-off").onclick = async () => {
  await chrome.storage.local.set({ syncCfg: { ...(st.syncCfg || {}), enabled: false } });
  syncMsg(tr("Synchronisation automatique désactivée."));
};

$("f-export").onclick = async () => {
  const json = JSON.stringify(await buildBackup(), null, 2);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  a.download = "roomwatch-settings.json";
  a.click();
  fileMsg(tr("Fichier exporté."));
};
$("f-import").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const r = await applyBackup(JSON.parse(await f.text()), { replace: $("f-replace").checked });
    fileMsg(tr("Import terminé : {n} favoris, {a} rooms AFK.", { n: r.watch, a: r.afk }));
  } catch {
    fileMsg(tr("Import impossible : ce n'est pas un fichier Roomwatch valide."));
  }
  e.target.value = "";
});


/* ---------- mise à jour depuis le NAS ---------- */
const updMsg = (t) => { $("u-status").textContent = t; };

async function renderUpdate() {
  const u = st.updateInfo;
  $("u-ver").textContent = tr("Version installée : v{v}", { v: currentVersion() });
  if (st.updateCfg && st.updateCfg.url) $("u-url").value = st.updateCfg.url;
  $("u-info").textContent = !u ? tr("Pas encore vérifié.")
    : u.error ? tr("Dernière vérification : {e}", { e: updateErrorText(u.error) })
    : u.available ? tr("Version v{v} disponible.", { v: u.latest }) : tr("À jour (dernière version : v{v}).", { v: u.latest });
  try { $("u-effective").textContent = tr("Adresse utilisée : {a}", { a: (await updateBase()).base }); } catch { $("u-effective").textContent = ""; }
  const dir = await loadDirHandle();
  $("u-dir").textContent = dir ? tr("Dossier choisi : {d}", { d: dir.name }) : tr("Aucun dossier choisi.");
}

const updError = (e) => e.message === "NO_DIR" ? tr("Choisis d'abord le dossier de l'extension.")
  : e.message === "NO_PICKER" ? tr("Ton navigateur bloque le choix de dossier. Active chrome://flags/#file-system-access-api (puis redémarre-le), ou télécharge le zip et remplace les fichiers à la main.")
  : updateErrorText(e.message);

$("u-save").onclick = async () => {
  const url = $("u-url").value.trim();
  if (url) {
    let origin;
    try { origin = new URL(url).origin + "/*"; } catch { return updMsg(tr("Adresse invalide.")); }
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: [origin] }); } catch { /* refusé */ }
    if (!granted) return updMsg(tr("Autorisation refusée pour {o}", { o: origin }));
  }
  await chrome.storage.local.set({ updateCfg: { url } });
  updMsg(url ? tr("Adresse enregistrée.") : tr("Adresse par défaut rétablie."));
};
$("u-reset").onclick = async () => { // retour à l'adresse par défaut du serveur de mises à jour
  $("u-url").value = "";
  await chrome.storage.local.set({ updateCfg: { url: "" } });
  updMsg(tr("Adresse par défaut rétablie."));
  renderUpdate();
};
$("u-pick").onclick = async () => {
  try { updMsg(tr("Dossier « {d} » enregistré.", { d: await pickExtensionDir() })); await renderUpdate(); }
  catch (e) { updMsg(e.name === "AbortError" ? "" : updError(e)); }
};
$("u-check").onclick = async () => {
  updMsg(tr("Vérification…"));
  try { const r = await checkUpdate(); updMsg(r.available ? tr("Version v{v} disponible.", { v: r.latest }) : tr("À jour (v{v}).", { v: r.current })); }
  catch (e) { updMsg(tr("Erreur : {e}", { e: updError(e) })); }
};
$("u-apply").onclick = async () => {
  updMsg(tr("Installation…"));
  try {
    const info = st.updateInfo && st.updateInfo.available ? st.updateInfo : await checkUpdate();
    if (!info.available) return updMsg(tr("À jour (v{v}).", { v: info.current }));
    await applyUpdate();
  } catch (e) { updMsg(tr("Erreur : {e}", { e: updError(e) })); }
};
$("u-download").onclick = () => chrome.tabs.create({ url: CONFIG.DOWNLOAD_URL });

if (CONFIG.SUPPORT_URL) { // bouton « Support me » (masqué tant qu'aucune adresse n'est configurée)
  const a = $("support-link");
  a.hidden = false;
  a.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: CONFIG.SUPPORT_URL }); };
}
