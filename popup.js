import { lastLiveEnd, fetchByGender, fetchLastBroadcast, fetchRoomStatuses, mergeStatuses, getSettings, saveSettings, DEFAULT_SETTINGS, GENDERS, genderKind, showKind } from "./lib.js";
import { fillSoundSelect, previewSound } from "./sounds.js";
import { syncNow, syncErrorText } from "./sync.js";
import { checkUpdate, applyUpdate, loadDirHandle, updateErrorText } from "./update.js";
import { tr, setLang, resolveLang, captureI18n, applyI18n, getLang, LANGS } from "./i18n.js";
import { CONFIG } from "./config.js";
import { PATCH_NOTES } from "./patchnotes.js";

const $ = (id) => document.getElementById(id);
captureI18n(); // mémorise les textes français d'origine pour pouvoir changer de langue

const state = {
  rooms: [], error: null, updatedAt: 0,
  watch: [], afk: [], others: [], settings: { ...DEFAULT_SETTINGS },
  view: "watch", gender: "f", allGender: null,
  last: {}, lastApi: {}, afkStatus: {}, follow: {}, autoArchived: {},
  favTab: "fav", setTab: "notif", // onglets : fav (Favoris) | oth (Following) | afk
  sortKey: "uptime", sortDir: "asc",          // le live le plus récent en haut
  offSortKey: "last", offSortDir: "desc",
  customSounds: [], syncCfg: null, syncMeta: null, updateInfo: null,
  remote: { key: null, rooms: [], loading: false, error: null, at: 0 },
};
let i18nReady = false;

/* ---------- icônes ---------- */
const COPY_SVG = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
const CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>';
const PINK = "#ef6b81", BLUE = "#4a9bf0", GREEN = "#34c28b";
const person = (cx, r, color, k = 1) => `<circle cx="${cx}" cy="${8}" r="${r}" fill="${color}"/><path d="M${cx - 6 * k} 21a${6 * k} ${6 * k} 0 0 1 ${12 * k} 0z" fill="${color}"/>`;
const GENDER_SVG = {
  female: `<svg viewBox="0 0 24 24">${person(12, 4, PINK, 1.3)}</svg>`,
  couple: `<svg viewBox="0 0 24 24">${person(8, 3.2, BLUE, 1)}${person(16, 3.2, PINK, 1)}</svg>`,
  trans: `<svg viewBox="0 0 24 24">${person(12, 4, GREEN, 1.3)}</svg>`,
  male: `<svg viewBox="0 0 24 24">${person(12, 4, BLUE, 1.3)}</svg>`,
};
const GENDER_LABEL = { female: "Femme", couple: "Couple", trans: "Trans", male: "Homme" };

function genderIcon(kind) {
  const s = document.createElement("span");
  s.className = "gico";
  s.innerHTML = GENDER_SVG[kind];
  s.title = tr(GENDER_LABEL[kind]);
  return s;
}

const SHOW_LABEL = { public: "PUBLIC", private: "IN PRIVATE", group: "GROUP SHOW", away: "AWAY", hidden: "HIDDEN", password: "PASSWORD", offline: "OFFLINE", other: "OTHER" };
function statusBadge(kind) {
  const b = document.createElement("span");
  b.className = "badge st-" + kind;
  b.textContent = SHOW_LABEL[kind] || SHOW_LABEL.other;
  return b;
}

/* ---------- utilitaires ---------- */
async function copyLink(name, btn) {
  const url = `https://chaturbate.com/${name}/`;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    const t = document.createElement("textarea");
    t.value = url;
    document.body.append(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
  btn.innerHTML = CHECK_SVG;
  btn.classList.add("done");
  btn.title = tr("Lien copié !");
  setTimeout(() => { btn.innerHTML = COPY_SVG; btn.classList.remove("done"); btn.title = tr("Copier le lien de la room"); }, 1200);
}

function copyButton(name) {
  const b = document.createElement("button");
  b.className = "copybtn";
  b.innerHTML = COPY_SVG;
  b.title = tr("Copier le lien de la room");
  b.onclick = (e) => { e.stopPropagation(); copyLink(name, b); };
  return b;
}

const fmtUptime = (t) => {
  if (!t) return "—";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};
const fmtAgo = (ms) => {
  const m = Math.floor(ms / 60000);
  if (m < 1) return tr("à l'instant");
  if (m < 60) return tr("il y a {n} min", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return tr("il y a {n} h", { n: h });
  return tr("il y a {n} j", { n: Math.floor(h / 24) });
};
const parseName = (v) => v.trim().replace(/^https?:\/\/[^/]+\//i, "").split(/[/?#]/)[0].toLowerCase();
const openRoom = (name) => chrome.tabs.create({ url: `https://chaturbate.com/${name}/` });
const status = (t) => { $("io-status").textContent = t; };
const lower = (r) => r.username.toLowerCase();
const displayName = (n) => (state.follow[n] && state.follow[n].username) || (state.afkStatus[n] && state.afkStatus[n].username) || n;

// Miniature : image fournie par le site si on l'a, sinon deux adresses de secours (le pseudo y est sensible aux majuscules)
function loadThumb(img, name, first) {
  const src = [first, `https://thumb.live.mmcdn.com/riw/${name}.jpg`, `https://roomimg.stream.highwebmedia.com/ri/${name}.jpg`].filter(Boolean);
  let i = 0;
  img.onerror = () => { i++; if (i < src.length) img.src = src[i]; else img.onerror = null; };
  img.src = src[0];
}

const saveWatch = (watch) => chrome.storage.local.set({ watch });
const saveAfk = (afk) => chrome.storage.local.set({ afk });
const saveOthers = (others) => chrome.storage.local.set({ others });
const toggleIn = (list, save) => (name) => {
  const n = name.toLowerCase();
  save(list().includes(n) ? list().filter((x) => x !== n) : [...list(), n]);
};
const toggleWatch = toggleIn(() => state.watch, saveWatch);
const toggleAfk = toggleIn(() => state.afk, saveAfk);
const toggleOther = toggleIn(() => state.others, saveOthers);

// Déplace une room entre l'onglet Favoris et l'onglet Follow
function moveRoom(name, to) {
  const n = name.toLowerCase();
  if (to === "others") saveBoth({ watch: state.watch.filter((x) => x !== n), others: [...new Set([...state.others, n])] });
  else saveBoth({ others: state.others.filter((x) => x !== n), watch: [...new Set([...state.watch, n])] });
}
const saveBoth = (patch) => chrome.storage.local.set(patch);
const SWAP_SVG = '<svg viewBox="0 0 24 24"><path d="M7 7h13l-3-3"/><path d="M17 17H4l3 3"/></svg>';
function moveButton(name, to) {
  const b = document.createElement("button");
  b.className = "copybtn";
  b.innerHTML = SWAP_SVG;
  b.title = to === "others" ? tr("Déplacer vers Follow") : tr("Déplacer vers Favoris");
  b.onclick = (e) => { e.stopPropagation(); moveRoom(name, to); };
  return b;
}

const isLocalView = () => state.view === "watch" || state.view === "all";
const remoteKey = () => (state.view === "featured" ? `featured:${state.gender}` : null);
const bioPending = new Set();
const statusOf = (n) => (state.afkStatus[n] ? state.afkStatus[n].status : null);
const isActiveStatus = (st) => !!st && st !== "offline" && st !== "unknown";

// Extrait des pseudos d'un texte libre : un par ligne, séparés par des virgules/espaces, liens ou JSON
function parseNames(text) {
  const t = text.trim();
  let raw = [];
  if (t.startsWith("{") || t.startsWith("[")) {
    try { const d = JSON.parse(t); raw = Array.isArray(d) ? d : Array.isArray(d.afk) ? d.afk : []; } catch { raw = []; }
  } else {
    raw = t.split(/[\s,;]+/);
  }
  return [...new Set(raw.map((n) => parseName(String(n))).filter((n) => /^[a-z0-9_]{2,40}$/.test(n)))];
}

/* ---------- genre / statut d'une room ---------- */
function genderOf(n) {
  const live = state.rooms.find((r) => lower(r) === n);
  return (live && live.gender) || (state.follow[n] && state.follow[n].gender) || (state.afkStatus[n] && state.afkStatus[n].gender) || null;
}

// Favori qui n'apparaît pas dans la liste des suivis en live mais dont le statut vérifié est actif (show privé, absent…)
function synthRoom(n) {
  const s = state.afkStatus[n];
  if (!s || !isActiveStatus(s.status) || Date.now() - s.at > 10 * 60000) return null;
  return { username: displayName(n), viewers: null, subject: s.title || "", show: s.status, img: null, startedAt: null, gender: s.gender, synthetic: true };
}

function favRooms(list = state.watch) {
  const real = state.rooms.filter((r) => list.includes(lower(r)));
  const have = new Set(real.map(lower));
  const extra = list.filter((n) => !have.has(n)).map(synthRoom).filter(Boolean);
  return [...real, ...extra];
}
const realLiveSet = () => new Set(state.rooms.map(lower));
const inFollow = () => state.view === "watch" && state.favTab === "oth";
const currentList = () => (inFollow() ? state.others : state.watch); // liste affichée par Favoris / Follow
const offlineNames = (list = state.watch) => {
  const live = realLiveSet();
  return list.filter((n) => !live.has(n) && !synthRoom(n));
};

/* ---------- données distantes (Featured) ---------- */
async function loadRemote(force = false) {
  const key = remoteKey();
  if (!key) return;
  const r = state.remote;
  if (!force && r.key === key && Date.now() - r.at < 60000) return;
  state.remote = { key, rooms: [], loading: true, error: null, at: 0 };
  render();
  try {
    const rooms = await fetchByGender({ gender: state.gender });
    if (state.remote.key !== key) return;
    state.remote = { key, rooms, loading: false, error: null, at: Date.now() };
  } catch (e) {
    if (state.remote.key !== key) return;
    state.remote = { key, rooms: [], loading: false, error: e.message, at: 0 };
  }
  render();
}

/* ---------- tri / filtre ---------- */
function filterGender(rooms, gid) {
  if (!gid) return rooms;
  if (!rooms.some((r) => r.gender)) return rooms; // le site ne fournit pas le genre : pas de filtrage
  const codes = GENDERS.find((g) => g.id === gid)?.codes ?? [gid];
  return rooms.filter((r) => codes.includes(String(r.gender || "").toLowerCase()));
}

function sourceRooms() {
  if (state.view === "watch") return favRooms();
  if (state.view === "all") return filterGender(state.rooms, state.allGender);
  return state.remote.key === remoteKey() ? state.remote.rooms : [];
}

function sortRooms(rooms) {
  const dir = state.sortDir === "asc" ? 1 : -1;
  const val = (r) =>
    state.sortKey === "viewers" ? (r.viewers == null ? -1 : r.viewers) :
    state.sortKey === "name" ? r.username.toLowerCase() :
    r.startedAt ? Date.now() - r.startedAt : null;
  return [...rooms].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
}

/* ---------- rendu des lignes ---------- */
function setMsg(text, html = false) {
  const m = $("msg");
  m.hidden = false;
  if (html) m.innerHTML = text; else m.textContent = text;
}

function enableMarquee(li) { // titre trop long : défile quand le curseur le survole
  li.addEventListener("mouseenter", () => {
    const sp = li.querySelector(".subject span");
    if (!sp) return;
    const over = sp.scrollWidth - sp.parentElement.clientWidth;
    if (over > 4) {
      sp.style.setProperty("--shift", `-${over + 6}px`);
      sp.style.setProperty("--dur", `${Math.max(2.5, over / 35)}s`);
      sp.classList.add("scroll");
    }
  });
  li.addEventListener("mouseleave", () => {
    const sp = li.querySelector(".subject span");
    if (sp) sp.classList.remove("scroll");
  });
}

function roomRow(r) {
  const li = document.createElement("li");
  li.innerHTML = `<div class="thumb"><img><span></span></div>
    <div class="info"><div class="top"><span class="name"></span><span class="viewers"></span></div>
    <div class="subject"><span></span></div><div class="show"></div></div><button class="star"></button>`;
  loadThumb(li.querySelector("img"), r.username, r.img);
  const up = li.querySelector(".thumb span");
  up.textContent = fmtUptime(r.startedAt);
  if (r.startedAt) up.dataset.start = r.startedAt;
  const nameEl = li.querySelector(".name");
  nameEl.textContent = r.username;
  const gk = genderKind(r.gender);
  if (gk) nameEl.prepend(genderIcon(gk));
  li.querySelector(".viewers").textContent = r.viewers == null ? "" : r.viewers;
  li.querySelector(".subject span").textContent = r.subject;
  li.querySelector(".show").append(statusBadge(showKind(r.show)));
  let star = li.querySelector(".star");
  if (inFollow()) { // Follow : mêmes infos que Favoris, mais pas d'étoile ni d'alerte
    const rm = document.createElement("button");
    rm.className = "rm";
    rm.textContent = "×";
    rm.title = tr("Retirer de la liste");
    rm.onclick = (e) => { e.stopPropagation(); toggleOther(r.username); };
    star.replaceWith(rm);
    li.insertBefore(copyButton(r.username), rm);
    li.insertBefore(moveButton(r.username, "watch"), rm);
    li.onclick = () => openRoom(r.username);
    enableMarquee(li);
    return li;
  }
  const on = state.watch.includes(lower(r));
  star.textContent = on ? "★" : "☆";
  star.classList.toggle("on", on);
  star.title = on ? tr("Retirer des favoris") : tr("Ajouter aux favoris (alertes)");
  star.onclick = (e) => { e.stopPropagation(); toggleWatch(r.username); };
  li.insertBefore(copyButton(r.username), star);
  if (state.view === "watch" && on) li.insertBefore(moveButton(r.username, "others"), star);
  li.onclick = () => openRoom(r.username);
  enableMarquee(li);
  return li;
}

// Rooms affichées dans l'onglet Live (après recherche)
function liveVisible() {
  const q = $("q").value.trim().toLowerCase();
  return sortRooms(favRooms(currentList()).filter((r) => !q || r.username.toLowerCase().includes(q) || (r.subject || "").toLowerCase().includes(q)));
}

function renderList() {
  const list = $("list"), top = list.scrollTop;
  list.replaceChildren();
  $("msg").hidden = true;

  if (isLocalView()) {
    if (state.error === "AUTH") return; // l'écran de connexion est affiché
    if (state.error) return setMsg(tr("Erreur : {e}", { e: state.error }));
  } else {
    if (state.remote.loading) return setMsg(tr("Chargement…"));
    if (state.remote.error) return setMsg(tr("Erreur : {e}", { e: state.remote.error }));
  }

  const q = $("q").value.trim().toLowerCase();
  const rooms = sortRooms(
    sourceRooms().filter((r) => !q || r.username.toLowerCase().includes(q) || (r.subject || "").toLowerCase().includes(q))
  );

  if (!rooms.length) {
    if (state.view === "watch") {
      return setMsg(state.watch.length ? tr("Aucun favori en live.") : tr("Ta liste est vide : ajoute des pseudos avec le champ ci-dessus."));
    }
    return setMsg(state.view === "all" ? tr("Personne en live.") : tr("Aucun résultat."));
  }
  for (const r of rooms) list.append(roomRow(r));
  list.scrollTop = top;
}

// Moment (ms) du dernier live d'une room hors ligne, ou null si inconnu
const offlineEnd = (n) => lastLiveEnd(n, state.last, state.lastApi);

function sortOfflineFavs(names) {
  const dir = state.sortDir === "asc" ? 1 : -1;
  return [...names].sort((a, b) => {
    if (state.sortKey === "name") return a.localeCompare(b) * dir;
    const x = offlineEnd(a), y = offlineEnd(b);
    if (x === null && y === null) return a.localeCompare(b);
    if (x === null) return 1;   // inconnus toujours en bas
    if (y === null) return -1;
    return (y - x) * (state.sortKey === "viewers" ? 1 : dir); // croissant = connexion la plus récente d'abord
  });
}

function sortByLast(names) {
  const dir = state.offSortDir === "asc" ? 1 : -1;
  return [...names].sort((a, b) => {
    if (state.offSortKey === "name") return a.localeCompare(b) * dir;
    const x = offlineEnd(a), y = offlineEnd(b);
    if (x === null && y === null) return a.localeCompare(b);
    if (x === null) return 1;   // inconnus toujours en bas
    if (y === null) return -1;
    return (x - y) * dir;       // desc = connexion la plus récente d'abord
  });
}

function sortManual(names) { // les rooms actives (live, privé…) d'abord
  const rank = (n) => ({ public: 0, group: 1, private: 1, away: 2 }[statusOf(n)] ?? (isActiveStatus(statusOf(n)) ? 2 : 3));
  const dir = state.offSortDir === "asc" ? 1 : -1;
  return [...names].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r) return r;
    if (state.offSortKey === "name") return a.localeCompare(b) * dir;
    const x = offlineEnd(a), y = offlineEnd(b);
    if (x === null && y === null) return a.localeCompare(b);
    if (x === null) return 1;
    if (y === null) return -1;
    return (x - y) * dir;
  });
}

// vrai quand un onglet « liste » (Following ou AFK) remplace la liste des favoris
const inOffline = () => state.view === "watch" && state.favTab === "afk" && state.error !== "AUTH";
const manualList = () => state.afk;

const SORTS_LIVE = [["uptime", "Temps en ligne"], ["viewers", "Spectateurs"], ["name", "Nom"]];
const SORTS_OFFLINE = [["last", "Dernier live"], ["name", "Nom"]];
function syncSortControls() {
  const off = inOffline(), sel = $("sort"), mode = (off ? "off" : "live") + getLang();
  if (sel.dataset.mode !== mode) {
    sel.replaceChildren(...(off ? SORTS_OFFLINE : SORTS_LIVE).map(([v, l]) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = tr(l);
      return o;
    }));
    sel.dataset.mode = mode;
  }
  sel.value = off ? state.offSortKey : state.sortKey;
  $("dir").textContent = (off ? state.offSortDir : state.sortDir) === "asc" ? "↑" : "↓";
}

// Room « en ligne » : statut actif (live, privé, absent…) vérifié il y a moins de 10 minutes
const freshActive = (n) => { const st = state.afkStatus[n]; return !!st && isActiveStatus(st.status) && Date.now() - st.at < 10 * 60000; };
const onlineCount = (list) => list.filter(freshActive).length;

function renderFavTabs() {
  const bar = $("favtabs");
  bar.hidden = state.view !== "watch" || state.error === "AUTH";
  if (bar.hidden) return;
  $("tab-fav-count").textContent = `${favRooms().length}/${state.watch.length}`;
  $("tab-afk-count").textContent = state.afk.length;
  $("tab-oth-count").textContent = `${favRooms(state.others).length}/${state.others.length}`;
  bar.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.t === state.favTab));
}

function lastInfo(n) {
  const end = offlineEnd(n);
  if (end !== null) return { text: tr("Dernier live : {t}", { t: fmtAgo(Date.now() - end) }), known: true };
  const a = state.lastApi[n];
  if (a && a.text) return { text: tr("Dernier live : {t}", { t: a.text }), known: true };
  if (bioPending.has(n)) return { text: tr("Recherche…"), known: false };
  return { text: tr("Dernier live inconnu"), known: false };
}

function nameBlock(n, cls) {
  const name = document.createElement("div");
  name.className = cls;
  name.textContent = displayName(n);
  const gk = genderKind(genderOf(n));
  if (gk) name.prepend(genderIcon(gk));
  return name;
}

function avatar(n) {
  const av = document.createElement("div");
  av.className = "avatar";
  av.textContent = (displayName(n)[0] || "?");
  return av;
}

function offRow(n) {
  const row = document.createElement("li");
  row.className = "off-row";
  const info = document.createElement("div");
  info.className = "off-info";
  const li = lastInfo(n);
  const last = document.createElement("div");
  last.className = "off-last" + (li.known ? "" : " unknown");
  last.textContent = li.text;
  info.append(nameBlock(n, "off-name"), last);
  if (inFollow()) {
    const rm = document.createElement("button");
    rm.className = "rm";
    rm.textContent = "×";
    rm.title = tr("Retirer de la liste");
    rm.onclick = (e) => { e.stopPropagation(); toggleOther(n); };
    row.append(avatar(n), info, copyButton(n), moveButton(n, "watch"), rm);
    row.onclick = () => openRoom(n);
    return row;
  }
  const star = document.createElement("button");
  star.className = "star on";
  star.textContent = "★";
  star.title = tr("Retirer des favoris");
  star.onclick = (e) => { e.stopPropagation(); toggleWatch(n); };
  row.append(avatar(n), info, copyButton(n), moveButton(n, "others"), star);
  row.onclick = () => openRoom(n);
  return row;
}

async function checkArchive() { // déplace tout de suite vers AFK les favoris hors ligne depuis plus de N jours
  footMsg(tr("Vérification…"), 30000);
  let r;
  try { r = await chrome.runtime.sendMessage("archive-now"); } catch { r = null; }
  await load();
  footMsg(r && r.moved ? tr("{n} room(s) déplacée(s) vers AFK ✓", { n: r.moved }) : tr("Aucune room à déplacer"), 6000);
}

// Onglet Favoris : les rooms en live d'abord, puis les rooms hors ligne sous un séparateur
function renderFav() {
  const list = $("list"), top = list.scrollTop;
  list.replaceChildren();
  $("msg").hidden = true;
  if (state.error) return setMsg(tr("Erreur : {e}", { e: state.error }));
  const q = $("q").value.trim().toLowerCase();
  const live = liveVisible();
  const cur = currentList();
  const off = sortOfflineFavs(offlineNames(cur).filter((n) => !q || n.includes(q)));
  if (!live.length && !off.length) {
    if (!cur.length) return setMsg(inFollow() ? tr("La liste Follow est vide : ajoute des rooms avec le champ ci-dessus (pseudos ou liens).") : tr("Ta liste est vide : ajoute des pseudos avec le champ ci-dessus."));
    return setMsg(tr("Aucun résultat."));
  }
  for (const r of live) list.append(roomRow(r));
  if (off.length) {
    const sep = document.createElement("li");
    sep.className = "sep";
    const dot = document.createElement("i");
    dot.className = "dot d-off";
    const label = document.createElement("span");
    label.textContent = `${tr("Offline")} (${off.length})`;
    const btn = document.createElement("button");
    btn.className = "btn ghost";
    btn.textContent = tr("Vérifier maintenant");
    btn.title = tr(inFollow() ? "Rooms Follow hors ligne depuis plus de {n} jours → AFK" : "Favoris hors ligne depuis plus de {n} jours → AFK", { n: state.settings.archiveDays });
    btn.onclick = (e) => { e.stopPropagation(); checkArchive(); };
    sep.append(dot, label, btn);
    list.append(sep);
    for (const n of off) list.append(offRow(n));
  }
  list.scrollTop = top;
}

/* ---------- onglets AFK et Following (listes manuelles) ---------- */
function manualRow(n, kind) {
  const st = statusOf(n);
  const row = document.createElement("div");
  row.className = "off-row";

  let lead;
  if (isActiveStatus(st)) {
    lead = document.createElement("div");
    lead.className = "mini";
    const img = document.createElement("img");
    const liveRoom = state.rooms.find((r) => lower(r) === n);
    loadThumb(img, displayName(n), liveRoom && liveRoom.img);
    lead.append(img);
  } else {
    lead = avatar(n);
  }

  const info = document.createElement("div");
  info.className = "off-info";
  const name = nameBlock(n, "off-name");
  if (kind === "afk" && state.autoArchived[n]) { // archivée automatiquement (hors ligne depuis longtemps)
    const tag = document.createElement("span");
    tag.className = "autotag";
    tag.textContent = "auto";
    tag.title = tr("Déplacée automatiquement {t}", { t: fmtAgo(Date.now() - state.autoArchived[n].at) });
    name.append(" ", tag);
  }
  const line = document.createElement("div");
  line.className = "off-last";
  if (!st) {
    line.textContent = tr("Vérification…");
  } else if (isActiveStatus(st)) {
    line.append(statusBadge(showKind(st)), " " + (state.afkStatus[n].title || ""));
  } else {
    line.append(statusBadge("offline"), " " + lastInfo(n).text);
  }
  info.append(name, line);

  const rm = document.createElement("button");
  rm.className = "rm";
  rm.textContent = "×";
  rm.title = tr("Retirer de la liste");
  rm.onclick = (e) => { e.stopPropagation(); (kind === "others" ? toggleOther : toggleAfk)(n); };

  if (kind === "others") row.append(lead, info, copyButton(n), moveButton(n, "watch"), rm);
  else row.append(lead, info, copyButton(n), rm);
  row.onclick = () => openRoom(n);
  return row;
}

function renderManual() {
  const kind = state.favTab === "oth" ? "others" : "afk", list = manualList();
  const box = $("offline-view"), top = box.scrollTop;
  $("msg").hidden = true;
  const q = $("q").value.trim().toLowerCase();
  const names = sortManual(list.filter((n) => !q || n.includes(q)));
  box.replaceChildren();
  if (!names.length) {
    box.hidden = true;
    return setMsg(!list.length
      ? tr(kind === "others" ? "La liste Follow est vide : ajoute des rooms avec le champ ci-dessus (pseudos ou liens)." : "La liste AFK est vide : ajoute des rooms avec le champ ci-dessus (pseudos ou liens).")
      : tr("Aucun résultat."));
  }
  box.hidden = false;
  box.append(...names.map((n) => manualRow(n, kind)));
  box.scrollTop = top;
}

let statusBusy = false;
async function refreshStatuses(names, force = false) {
  if (statusBusy || !names.length) return;
  const now = Date.now();
  const stale = names.filter((n) => force || !state.afkStatus[n] || now - state.afkStatus[n].at > 60000).slice(0, 40);
  if (!stale.length) return;
  statusBusy = true;
  try {
    state.afkStatus = mergeStatuses(state.afkStatus, await fetchRoomStatuses(stale));
    await chrome.storage.local.set({ afkStatus: state.afkStatus });
  } finally {
    statusBusy = false;
  }
}

// Récupère (au mieux) la date du dernier live des rooms jamais vues en live par l'extension
async function fillLastBroadcasts() {
  const live = realLiveSet();
  const fresh = (a) => a && Date.now() - a.at < 6 * 3600e3;
  const pool = state.favTab === "afk" ? state.afk : state.favTab === "oth" ? state.others : offlineNames();
  const queue = pool
    .filter((n) => !live.has(n) && !isActiveStatus(statusOf(n)) && !state.last[n] && !fresh(state.lastApi[n]) && !bioPending.has(n))
    .slice(0, 20);
  if (!queue.length) return;
  queue.forEach((n) => bioPending.add(n));
  if (inOffline()) renderManual();
  else if (state.view === "watch") renderFav();
  const worker = async () => {
    while (queue.length) {
      const n = queue.shift();
      let text = null;
      try { text = await fetchLastBroadcast(n); } catch {}
      bioPending.delete(n);
      state.lastApi = { ...state.lastApi, [n]: { text, at: Date.now() } };
      await chrome.storage.local.set({ lastApi: state.lastApi });
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

/* ---------- réglages ---------- */
function chip(label, onRemove, live = false) {
  const c = document.createElement("span");
  c.className = "chip" + (live ? " live" : "");
  c.append(label);
  const x = document.createElement("button");
  x.textContent = "×";
  x.onclick = onRemove;
  c.append(x);
  return c;
}

function syncText() {
  const c = state.syncCfg, m = state.syncMeta || {};
  if (!c || !c.enabled) return tr("Non configurée. Ouvre « Configurer… » pour synchroniser tes PC automatiquement (NAS, Nextcloud, WebDAV) ou échanger un fichier.");
  if (m.error) return tr("Erreur : {e}", { e: syncErrorText(m.error) });
  return m.at ? tr("Active · dernière synchro à {t}", { t: new Date(m.at).toLocaleTimeString() }) : tr("Active · en attente de la première synchro");
}

const THEMES = [["default", "Chaturbate", "#f47321"], ["midnight", "Minuit", "#6b8cff"], ["graphite", "Graphite", "#4fb3a3"], ["forest", "Forêt", "#4fb477"], ["oled", "Noir OLED", "#000000"]];

function renderSettings() {
  const dis = (sel, off) => { const el = document.querySelector(sel); if (el) { el.disabled = off; el.closest(".row").classList.toggle("disabled", off); } };
  dis('[data-s="afkNotify"]', !!state.settings.autoReturn);   // remplacé par la notification de retour
  dis('[data-s="archiveDays"]', !state.settings.autoArchive);
  fillSoundSelect($("sound"), state.customSounds);
  fillSoundSelect($("sound-return"), state.customSounds);
  const lang = $("lang");
  lang.replaceChildren(...Object.entries(LANGS).map(([v, l]) => { const o = document.createElement("option"); o.value = v; o.textContent = v === "auto" ? tr("Automatique") : l; return o; }));
  $("sync-info").textContent = syncText();
  document.querySelectorAll("[data-s]").forEach((el) => {
    const v = state.settings[el.dataset.s];
    if (el.type === "checkbox") el.checked = !!v;
    else if (el.type === "range") el.value = Math.round(v * 100);
    else el.value = v;
  });
  const live = realLiveSet();
  $("count").textContent = state.watch.length;
  $("chips").replaceChildren(...[...state.watch].sort().map((n) => chip(n, () => toggleWatch(n), live.has(n))));
  $("afk-count").textContent = state.afk.length;
  $("afk-chips").replaceChildren(...[...state.afk].sort().map((n) => chip(n, () => toggleAfk(n), statusOf(n) === "public")));
  $("oth-count").textContent = state.others.length;
  $("oth-chips").replaceChildren(...[...state.others].sort().map((n) => chip(n, () => toggleOther(n), statusOf(n) === "public")));
  $("help-version").textContent = "v" + chrome.runtime.getManifest().version;
  document.querySelectorAll("#settabs button").forEach((b) => b.classList.toggle("active", b.dataset.st === state.setTab));
  document.querySelectorAll(".spane").forEach((p) => (p.hidden = p.dataset.pane !== state.setTab));
  $("themes").replaceChildren(...THEMES.map(([id, label, color]) => {
    const b = document.createElement("button");
    b.className = "theme-btn" + (state.settings.theme === id ? " active" : "");
    const dot = document.createElement("i");
    dot.style.background = color;
    b.append(dot, tr(label));
    b.onclick = () => saveSettings({ theme: id });
    return b;
  }));
}

function renderGenderBar() {
  const bar = $("genderbar");
  const isAll = state.view === "all";
  const needLogin = isLocalView() && state.error === "AUTH";
  bar.hidden = needLogin || !(state.view === "featured" || isAll);
  if (bar.hidden) return;
  const current = isAll ? state.allGender : state.gender;
  bar.replaceChildren(...GENDERS.map((g) => {
    const b = document.createElement("button");
    b.className = "pill" + (g.id === current ? " active" : "");
    b.textContent = g.label;
    b.onclick = () => {
      if (isAll) { // sur Following, un second clic retire le filtre
        state.allGender = state.allGender === g.id ? null : g.id;
        chrome.storage.local.set({ allGender: state.allGender });
        render();
        return;
      }
      if (state.gender === g.id) return;
      state.gender = g.id;
      chrome.storage.local.set({ gender: g.id });
      render();
      if (remoteKey()) loadRemote();
    };
    return b;
  }));
}

/* ---------- pied de fenêtre ---------- */
let footTimer;
function footMsg(t, ms = 4000) {
  $("footmsg").textContent = t;
  clearTimeout(footTimer);
  if (t) footTimer = setTimeout(() => ($("footmsg").textContent = ""), ms);
}

const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function renderFooter() {
  $("version").textContent = "v" + chrome.runtime.getManifest().version;
  const u = state.updateInfo, avail = !!(u && u.available);
  $("foot-update").classList.toggle("avail", avail);
  $("foot-update").title = avail ? tr("Installer la version {v}", { v: u.latest }) : tr("Chercher une mise à jour");
  const muted = (state.settings.mutedUntil || 0) > Date.now();
  $("foot-mute").classList.toggle("on", muted);
  $("foot-mute").title = muted ? tr("Notifications en pause jusqu'à {t}", { t: fmtClock(state.settings.mutedUntil) }) : tr("Mettre les notifications en pause");
  $("mute-off").hidden = !muted;
  const st = !!state.settings.stealth;
  $("foot-stealth").classList.toggle("on", st);
  $("foot-stealth").title = st ? tr("Mode discret activé (clic pour désactiver)") : tr("Mode discret");
}

/* ---------- rendu général ---------- */
function render() {
  document.body.dataset.theme = state.settings.theme || "default";
  document.body.classList.toggle("blur", !!state.settings.blur);
  document.body.classList.toggle("stealth", !!state.settings.stealth);
  renderFooter();
  document.querySelectorAll(".nav").forEach((b) => b.classList.toggle("active", b.dataset.view === state.view));

  const settings = state.view === "settings";
  const needLogin = isLocalView() && state.error === "AUTH";
  $("login").hidden = !needLogin;
  $("toolbar").hidden = settings || needLogin;
  syncSortControls();

  renderGenderBar();
  const offTab = inOffline();
  $("list").hidden = settings || needLogin || offTab;
  $("offline-view").hidden = true;
  renderFavTabs();
  $("fav-addbar").hidden = !(state.view === "watch" && state.favTab === "fav" && !needLogin);
  if (!$("fav-addbar").hidden) {
    const n = liveVisible().length;
    $("open-all").textContent = tr("Tout ouvrir ({n})", { n });
    $("open-all").disabled = n === 0;
  }
  $("afk-addbar").hidden = !(state.view === "watch" && state.favTab !== "fav" && !needLogin);
  $("open-all-oth").hidden = !inFollow(); // « Tout ouvrir » aussi dans l'onglet Follow
  if (inFollow()) {
    const n = liveVisible().length;
    $("open-all-oth").textContent = tr("Tout ouvrir ({n})", { n });
    $("open-all-oth").disabled = n === 0;
  }
  $("afk-add").placeholder = tr(state.favTab === "oth" ? "Ajouter des rooms Follow (pseudos ou liens)" : "Ajouter des rooms AFK (pseudos ou liens)");
  $("settings-view").hidden = !settings;

  if (needLogin) { $("msg").hidden = true; return; }
  if (settings) { $("msg").hidden = true; renderSettings(); return; }
  if (offTab) { renderManual(); refreshStatuses(manualList()).then(fillLastBroadcasts); }
  else if (state.view === "watch") {
    renderFav();
    refreshStatuses([...offlineNames(), ...state.others]); // favoris en show privé… et nombre de rooms Follow en ligne
    fillLastBroadcasts();
  } else {
    renderList();
  }
  $("updated").textContent = isLocalView() && state.updatedAt ? tr("MAJ {t}", { t: new Date(state.updatedAt).toLocaleTimeString() }) : "";
}

/* ---------- chargement du stockage ---------- */
async function load() {
  const s = await chrome.storage.local.get(["rooms", "error", "updatedAt", "watch", "gender", "last", "lastApi", "allGender", "afk", "others", "afkStatus", "customSounds", "syncCfg", "syncMeta", "sortPrefs", "updateInfo", "autoArchived", "following"]);
  state.gender = s.gender || "f";
  state.allGender = s.allGender ?? null;
  state.rooms = s.rooms || [];
  state.error = s.error || null;
  state.updatedAt = s.updatedAt || 0;
  state.watch = s.watch || [];
  state.afk = s.afk || [];
  state.others = s.others || [];
  state.last = s.last || {};
  state.lastApi = s.lastApi || {};
  state.afkStatus = s.afkStatus || {};
  state.customSounds = s.customSounds || [];
  state.syncCfg = s.syncCfg || null;
  state.syncMeta = s.syncMeta || null;
  state.updateInfo = s.updateInfo || null;
  state.autoArchived = s.autoArchived || {};
  state.follow = {};
  for (const f of s.following || []) state.follow[f.username.toLowerCase()] = f;
  if (s.sortPrefs) {
    const p = s.sortPrefs;
    state.sortKey = p.sortKey || state.sortKey;
    state.sortDir = p.sortDir || state.sortDir;
    state.offSortKey = p.offSortKey || state.offSortKey;
    state.offSortDir = p.offSortDir || state.offSortDir;
  }
  state.settings = await getSettings();
  const L = resolveLang(state.settings.lang);
  if (!i18nReady || L !== getLang()) { setLang(L); applyI18n(); i18nReady = true; $("sort").dataset.mode = ""; }
  render();
}

/* ---------- fenêtre modale : nouveautés et rapport de bug ---------- */
function openModal(title, content) {
  $("modal-title").textContent = title;
  $("modal-body").replaceChildren(content);
  $("modal").hidden = false;
}
const closeModal = () => { $("modal").hidden = true; };
$("modal-close").onclick = closeModal;
$("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeModal(); });

function showPatchNotes() {
  const v = chrome.runtime.getManifest().version;
  const notes = PATCH_NOTES[v] || PATCH_NOTES[Object.keys(PATCH_NOTES).pop()];
  const items = notes[getLang()] || notes.fr;
  const ul = document.createElement("ul");
  for (const t of items) { const li = document.createElement("li"); li.textContent = t; ul.append(li); }
  openModal(tr("Nouveautés de la version {v}", { v }), ul);
}

// Aide : à quoi sert chaque bouton (les icônes sont copiées depuis la fenêtre elle-même)
function showHelp() {
  const box = document.createElement("div");
  box.className = "help";
  const glyph = (t) => { const b = document.createElement("b"); b.textContent = t; return b; };
  const svg = (sel) => { const n = document.querySelector(sel + " svg"); return n ? n.cloneNode(true) : glyph("•"); };
  const item = (icon, text) => {
    const li = document.createElement("li");
    const ic = document.createElement("span");
    ic.className = "help-ic";
    ic.append(icon);
    const t = document.createElement("span");
    t.textContent = tr(text);
    li.append(ic, t);
    return li;
  };
  const section = (title, items) => {
    const h = document.createElement("h4");
    h.textContent = tr(title);
    const ul = document.createElement("ul");
    ul.append(...items);
    box.append(h, ul);
  };
  section("Barre latérale", [
    item(svg('.nav[data-view="watch"]'), "Tes rooms favorites, avec les notifications de live."),
    item(svg("#nav-g-female"), "Ouvre sur le site tes follows femmes."),
    item(svg("#nav-g-couple"), "Ouvre sur le site tes follows couples."),
    item(svg("#nav-g-trans"), "Ouvre sur le site tes follows trans."),
    item(svg('.nav[data-view="settings"]'), "Réglages : notifications, sons, thèmes, synchronisation, mise à jour."),
  ]);
  section("Barre du haut", [
    item(glyph("🔍"), "Cherche une room par son nom ou son titre."),
    item(glyph("▾"), "Choisit le tri : temps en ligne, spectateurs ou nom."),
    item(glyph("↑↓"), "Inverse l'ordre du tri."),
    item(glyph("⟳"), "Actualise la liste maintenant."),
  ]);
  section("Onglets", [
    item(glyph("Favoris"), "Tes rooms importantes : en live d'abord, puis hors ligne. Notification quand elles passent en live."),
    item(glyph("Follow"), "Comme Favoris, mais sans notification de live."),
    item(glyph("AFK"), "Rooms absentes : elles reviennent toutes seules dans leur onglet dès qu'elles sont de retour."),
  ]);
  section("Ajouter des rooms", [
    item(glyph("+"), "Ajoute des rooms avec leur pseudo ou leur lien."),
    item(glyph("▶"), "Ouvre toutes les rooms en live dans des onglets."),
  ]);
  section("Sur chaque room", [
    item(copyButton("x").querySelector("svg"), "Copie le lien de la room."),
    item(moveButton("x", "others").querySelector("svg"), "Déplace la room entre Favoris et Follow."),
    item(glyph("★"), "Ajoute ou retire des favoris."),
    item(glyph("×"), "Retire la room de la liste."),
  ]);
  section("En bas de la fenêtre", [
    item(svg("#foot-mute"), "Met les notifications en pause (1 h, 2 h, jusqu'à demain)."),
    item(svg("#foot-stealth"), "Mode discret : floute la fenêtre et coupe les sons (Alt+Maj+H)."),
    item(svg("#foot-sync"), "Synchronise tes listes entre tes PC (si activé dans les réglages)."),
    item(svg("#foot-update"), "Cherche une nouvelle version. Un point apparaît quand il y en a une."),
    item(svg("#foot-bug"), "Envoie un signalement de bug."),
    ...(CONFIG.SUPPORT_URL ? [item(svg("#foot-support"), "Soutenir le projet (don libre).")] : []),
    item(glyph("v" + chrome.runtime.getManifest().version), "Affiche les nouveautés de la version."),
  ]);
  openModal(tr("À quoi sert chaque bouton"), box);
}
$("foot-help").onclick = showHelp;
if (CONFIG.SUPPORT_URL) {
  $("foot-support").hidden = false;
  $("foot-support").onclick = () => chrome.tabs.create({ url: CONFIG.SUPPORT_URL });
}

function buildReport(text, withInfo) {
  const m = chrome.runtime.getManifest();
  const lines = [`Roomwatch v${m.version}`, text.trim()];
  if (withInfo) {
    const { mutedUntil, stealth, ...cfg } = state.settings;
    lines.push("---",
      `UA: ${navigator.userAgent}`,
      `Lang: ${getLang()} (setting: ${state.settings.lang}) · Theme: ${state.settings.theme}`,
      `Lists: favorites=${state.watch.length}, AFK=${state.afk.length}, others=${state.others.length}`,
      `Logged in: ${state.error === "AUTH" ? "no" : "yes"} · Error: ${state.error || "-"}`,
      `Sync: ${state.syncCfg && state.syncCfg.enabled ? "on" : "off"}${state.syncMeta && state.syncMeta.error ? " / " + state.syncMeta.error : ""}`,
      `Update check: ${(state.updateInfo && state.updateInfo.error) || "ok"}`,
      `Settings: ${JSON.stringify(cfg)}`);
  }
  return lines.join("\n");
}

async function sendReport(text) {
  if (CONFIG.REPORT_WEBHOOK) {
    const post = () => fetch(CONFIG.REPORT_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text.slice(0, 1900) }) });
    let res;
    try {
      res = await post(); // en principe sans aucune autorisation à accorder
    } catch {
      try { await chrome.permissions.request({ origins: [new URL(CONFIG.REPORT_WEBHOOK).origin + "/*"] }); } catch { /* refusée */ }
      res = await post();
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    return "sent";
  }
  if (CONFIG.REPORT_EMAIL) {
    chrome.tabs.create({ url: `mailto:${CONFIG.REPORT_EMAIL}?subject=${encodeURIComponent("Roomwatch bug report")}&body=${encodeURIComponent(text.slice(0, 1500))}` });
    return "mail";
  }
  if (CONFIG.ISSUES_URL) {
    chrome.tabs.create({ url: `${CONFIG.ISSUES_URL}/new?title=${encodeURIComponent("Bug report")}&body=${encodeURIComponent(text.slice(0, 1500))}` });
    return "issue";
  }
  await navigator.clipboard.writeText(text);
  return "copied";
}

function showBugReport() {
  const box = document.createElement("div");
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = tr("Décris le problème : ce que tu as fait, ce que tu attendais, ce qui s'est passé.");
  const ta = document.createElement("textarea");
  const lab = document.createElement("label");
  lab.className = "chk";
  const chk = document.createElement("input");
  chk.type = "checkbox";
  chk.checked = true;
  const span = document.createElement("span");
  span.textContent = tr("Joindre les informations techniques (version, navigateur, réglages ; aucun nom de room)");
  lab.append(chk, span);
  const send = document.createElement("button");
  send.className = "btn";
  send.textContent = tr("Envoyer");
  const out = document.createElement("div");
  out.className = "status";
  send.onclick = async () => {
    if (!ta.value.trim()) { out.textContent = tr("Écris d'abord quelques mots."); return; }
    send.disabled = true;
    try {
      const r = await sendReport(buildReport(ta.value, chk.checked));
      closeModal(); // le panneau se ferme après l'envoi, puis une confirmation s'affiche en bas
      footMsg(r === "sent" ? tr("Rapport envoyé, merci !") : r === "mail" ? tr("Ton application de messagerie va s'ouvrir : envoie le message.") : r === "issue" ? tr("La page GitHub va s'ouvrir : valide le signalement.") : tr("Rapport copié : colle-le dans un message au développeur."), 6000);
    } catch (e) {
      out.textContent = tr("Envoi impossible : {e}", { e: e.message });
    }
    send.disabled = false;
  };
  box.append(hint, ta, lab, send, out);
  openModal(tr("Signaler un bug"), box);
}

/* ---------- navigation ---------- */
function openView(v) {
  state.view = v;
  $("q").value = "";
  render();
  if (v === "featured") loadRemote();
}
document.querySelectorAll(".nav").forEach((b) => (b.onclick = () => openView(b.dataset.view)));
document.querySelectorAll("#favtabs button").forEach((b) => {
  b.onclick = () => { state.favTab = b.dataset.t; render(); };
});

/* ---------- tri ---------- */
const defaultDir = (key) => (key === "name" || key === "uptime" ? "asc" : "desc"); // temps en ligne : le plus récent en haut
const saveSort = () => chrome.storage.local.set({ sortPrefs: { sortKey: state.sortKey, sortDir: state.sortDir, offSortKey: state.offSortKey, offSortDir: state.offSortDir } });
$("sort").onchange = () => {
  const v = $("sort").value;
  if (inOffline()) { state.offSortKey = v; state.offSortDir = defaultDir(v); }
  else { state.sortKey = v; state.sortDir = defaultDir(v); }
  saveSort();
  render();
};
$("dir").onclick = () => {
  if (inOffline()) state.offSortDir = state.offSortDir === "asc" ? "desc" : "asc";
  else state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
  saveSort();
  render();
};
$("q").addEventListener("input", render);
$("refresh").onclick = async () => {
  if (inOffline() && state.favTab === "afk") { // vérifie tout de suite si une room de la liste est en live
    const before = state.afk.length;
    await chrome.runtime.sendMessage("check-returns");
    await load();
    if (state.afk.length < before) footMsg(tr("{n} room(s) passée(s) dans les favoris ✓", { n: before - state.afk.length }), 6000);
    await refreshStatuses(state.afk, true);
    return;
  }
  if (inOffline()) { await refreshStatuses(manualList(), true); return; }
  if (isLocalView()) { await chrome.runtime.sendMessage("refresh"); load(); }
  else loadRemote(true);
};



/* ---------- réglages : champs ---------- */
document.querySelectorAll("[data-s]").forEach((el) => {
  el.addEventListener("change", () => {
    const k = el.dataset.s;
    let v;
    if (el.type === "checkbox") v = el.checked;
    else if (el.type === "range") v = Number(el.value) / 100;
    else if ("num" in el.dataset) v = Number(el.value);
    else v = el.value;
    saveSettings({ [k]: v });
    if (k === "sound" || k === "volume") previewSound($("sound").value, Number($("vol").value) / 100, state.customSounds);
    if (k === "returnSound" || k === "returnVolume") previewSound($("sound-return").value, Number($("vol-return").value) / 100, state.customSounds);
  });
});

$("login-btn").onclick = () => chrome.tabs.create({ url: "https://chaturbate.com/auth/login/" });
$("open-options").onclick = () => chrome.runtime.openOptionsPage();
document.querySelectorAll(".js-test-return").forEach((b) => (b.onclick = () => chrome.runtime.sendMessage("test-return")));
document.querySelectorAll(".js-test-notif").forEach((b) => (b.onclick = () => chrome.runtime.sendMessage("test")));
$("sound-preview").onclick = () => previewSound($("sound").value, Number($("vol").value) / 100, state.customSounds);
$("sound-return-preview").onclick = () => previewSound($("sound-return").value, Number($("vol-return").value) / 100, state.customSounds);
$("open-sounds").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("options.html#sound") });
$("open-sync").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("options.html#sync") });
$("sync-now").onclick = async () => { $("sync-info").textContent = tr("Synchronisation…"); await syncNow(); load(); };
document.querySelectorAll("#settabs button").forEach((b) => {
  b.onclick = () => { state.setTab = b.dataset.st; renderSettings(); };
});
$("help-notes").onclick = showPatchNotes;
$("help-bug").onclick = showBugReport;
$("help-tuto").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });

/* ---------- ajout de rooms ---------- */
function addFavFrom(input) {
  const names = parseNames(input.value);
  if (names.length) saveWatch([...new Set([...state.watch, ...names])]);
  input.value = "";
}
$("fav-add-btn").onclick = () => addFavFrom($("fav-add"));
$("fav-add").addEventListener("keydown", (e) => { if (e.key === "Enter") addFavFrom($("fav-add")); });

const openAllLive = () => { // ouvre toutes les rooms en live dans des onglets (en arrière-plan)
  const rooms = liveVisible();
  if (!rooms.length) return;
  if (rooms.length > 5 && !window.confirm(tr("Ouvrir {n} rooms ?", { n: rooms.length }))) return;
  for (const room of rooms) chrome.tabs.create({ url: `https://chaturbate.com/${room.username}/`, active: false });
};
$("open-all").onclick = openAllLive;
$("open-all-oth").onclick = openAllLive;
for (const kind of ["female", "couple", "trans"]) { // pages « suivis » du site, par genre
  $("nav-g-" + kind).onclick = () => chrome.tabs.create({ url: `https://chaturbate.com/followed-cams/${kind}/` });
}

function addManualFrom(input) { // onglet AFK ou Others selon l'onglet affiché
  const names = parseNames(input.value);
  const others = state.favTab === "oth";
  if (names.length) (others ? saveOthers : saveAfk)([...new Set([...(others ? state.others : state.afk), ...names])]);
  input.value = "";
}
$("afk-add-btn").onclick = () => addManualFrom($("afk-add"));
$("afk-add").addEventListener("keydown", (e) => { if (e.key === "Enter") addManualFrom($("afk-add")); });

function addFavorite() {
  const n = parseName($("add").value);
  if (n && !state.watch.includes(n)) saveWatch([...state.watch, n]);
  $("add").value = "";
}
$("add-btn").onclick = addFavorite;
$("add").addEventListener("keydown", (e) => { if (e.key === "Enter") addFavorite(); });

$("afk-export").onclick = async () => {
  const text = state.afk.join("\n");
  try { await navigator.clipboard.writeText(text); } catch {}
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = "roomwatch-liste-afk.txt";
  a.click();
  $("afk-status").textContent = tr("{n} room(s) exportée(s) : copiées dans le presse-papiers + fichier téléchargé.", { n: state.afk.length });
};
$("afk-import-toggle").onclick = () => { $("afk-import-box").hidden = !$("afk-import-box").hidden; $("afk-import-text").focus(); };
$("afk-import-go").onclick = () => {
  const names = parseNames($("afk-import-text").value);
  if (!names.length) { $("afk-status").textContent = tr("Aucun pseudo valide trouvé."); return; }
  const merged = [...new Set([...state.afk, ...names])];
  const added = merged.length - state.afk.length;
  saveAfk(merged);
  $("afk-import-text").value = "";
  $("afk-import-box").hidden = true;
  $("afk-status").textContent = tr("{n} room(s) ajoutée(s).", { n: added });
};

/* ---------- pied de fenêtre : actions ---------- */
const SYNC_MSG = { push: "Envoyé au serveur ✓", pull: "Récupéré depuis le serveur ✓", merge: "Fusion effectuée ✓", same: "Déjà à jour ✓" };
$("foot-sync").onclick = async () => {
  footMsg(tr("Synchronisation…"), 20000);
  const r = await syncNow();
  if (r.skipped) { footMsg(tr("Synchro non configurée")); chrome.tabs.create({ url: chrome.runtime.getURL("options.html#sync") }); }
  else if (r.error) footMsg(tr("Erreur : {e}", { e: syncErrorText(r.error) }), 8000);
  else footMsg(tr(SYNC_MSG[r.action] || "Terminé ✓"));
  load();
};
$("foot-update").onclick = async () => {
  try {
    footMsg(tr("Recherche…"), 20000);
    let info = state.updateInfo;
    if (!info || !info.available) { info = await checkUpdate(); load(); }
    if (!info.available) return footMsg(tr("À jour (v{v})", { v: info.current }));
    // l'installation se fait dans un onglet (le popup se ferme dès qu'il perd le focus et interromprait l'écriture des fichiers)
    footMsg(tr("v{v} disponible : voir la marche à suivre", { v: info.latest }), 8000);
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html#update") });
  } catch (e) {
    footMsg(tr("Erreur : {e}", { e: e.message === "NO_DIR" ? tr("dossier de l'extension non choisi") : updateErrorText(e.message) }), 8000);
  }
};
$("foot-bug").onclick = showBugReport;
$("version").onclick = showPatchNotes;

// pause des notifications
$("foot-mute").onclick = (e) => { e.stopPropagation(); $("mutemenu").hidden = !$("mutemenu").hidden; };
document.querySelectorAll("#mutemenu button").forEach((b) => {
  b.onclick = async () => {
    const v = b.dataset.mute;
    let until = 0;
    if (v === "tomorrow") { const d = new Date(); d.setHours(8, 0, 0, 0); if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); until = d.getTime(); }
    else if (v !== "0") until = Date.now() + Number(v) * 60000;
    await chrome.storage.local.set({ mutedUntil: until });
    $("mutemenu").hidden = true;
    footMsg(until ? tr("Notifications en pause jusqu'à {t}", { t: fmtClock(until) }) : tr("Notifications réactivées"), 6000);
  };
});
document.addEventListener("click", (e) => { if (!e.target.closest("#mutemenu")) $("mutemenu").hidden = true; });

// mode discret
$("foot-stealth").onclick = () => chrome.storage.local.set({ stealth: !state.settings.stealth });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("modal").hidden) closeModal();
  else window.close(); // touche « panique » : ferme la fenêtre
});

/* ---------- export / import ---------- */
$("export").onclick = async () => {
  const { mutedUntil, stealth, ...cfg } = state.settings;
  const json = JSON.stringify({ app: "roomwatch", version: 3, watch: state.watch, afk: state.afk, others: state.others, settings: cfg }, null, 2);
  try { await navigator.clipboard.writeText(json); } catch {}
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  a.download = "roomwatch-settings.json";
  a.click();
  status(tr("Exporté ({n} favoris) : copié dans le presse-papiers + fichier téléchargé.", { n: state.watch.length }));
};
$("import-toggle").onclick = () => { $("import-box").hidden = !$("import-box").hidden; $("import-text").focus(); };
$("import-go").onclick = async () => {
  try {
    const data = JSON.parse($("import-text").value);
    if (data.app !== "roomwatch" || !Array.isArray(data.watch)) throw new Error();
    const norm = (arr) => arr.map((n) => parseName(String(n))).filter(Boolean);
    const mergedWatch = [...new Set([...state.watch, ...norm(data.watch)])];
    const added = mergedWatch.length - state.watch.length;
    const patch = { watch: mergedWatch };
    if (Array.isArray(data.afk)) patch.afk = [...new Set([...state.afk, ...norm(data.afk)])];
    if (Array.isArray(data.others)) patch.others = [...new Set([...state.others, ...norm(data.others)])];
    await chrome.storage.local.set(patch);
    const incoming = { ...(data.settings || {}) };
    if (typeof data.notify === "boolean" && incoming.notify === undefined) incoming.notify = data.notify;
    const clean = {};
    for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) if (typeof incoming[k] === typeof def) clean[k] = incoming[k];
    if (Object.keys(clean).length) await saveSettings(clean);
    $("import-text").value = "";
    $("import-box").hidden = true;
    status(tr("Import terminé : {n} favori(s) ajouté(s).", { n: added }));
  } catch {
    status(tr("Import impossible : JSON invalide."));
  }
};

/* ---------- init ---------- */
chrome.storage.onChanged.addListener(load);
setInterval(() => {
  document.querySelectorAll("[data-start]").forEach((el) => (el.textContent = fmtUptime(Number(el.dataset.start))));
}, 1000);
load();
