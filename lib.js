// Accès à l'API Chaturbate (session du navigateur) + réglages partagés.
const API = "https://chaturbate.com/api/ts/roomlist/room-list/";

export const DEFAULT_SETTINGS = {
  notify: true,
  filterByRoom: true,   // true = alertes uniquement pour les rooms cochées
  afkNotify: false,     // notifier quand une room de cette liste passe en live
  autoArchive: true,    // favoris hors ligne depuis longtemps -> liste « Absents »
  archiveDays: 7,
  autoReturn: true,     // room archivée automatiquement qui revient en live -> de nouveau dans les favoris
  returnSound: "bell",  // son (et notification) spécifiques au retour d'une room
  returnVolume: 0.7,    // volume indépendant du son de live
  theme: "default",     // apparence : default | midnight | graphite | forest | oled
  lang: "auto",         // langue : auto | fr | en | ru | de
  sound: "ding",        // system | none | ding | chime | pop | alert | double
  volume: 0.7,
  interval: 1,          // minutes entre deux vérifications
  quiet: false,
  quietFrom: "23:00",
  quietTo: "08:00",
  badge: true,
  blur: false,
};


// mutedUntil (pause des notifications) et stealth (mode discret) sont propres à chaque PC : jamais synchronisés
export async function getSettings() {
  const { settings = {}, notify, mutedUntil = 0, stealth = false } = await chrome.storage.local.get(["settings", "notify", "mutedUntil", "stealth"]);
  return { ...DEFAULT_SETTINGS, ...(notify !== undefined ? { notify } : {}), ...settings, mutedUntil, stealth };
}

export async function saveSettings(patch) {
  const { mutedUntil, stealth, ...cur } = await getSettings();
  await chrome.storage.local.set({ settings: { ...cur, ...patch } });
}

export function inQuietHours(s, d = new Date()) {
  if ((s.mutedUntil || 0) > d.getTime()) return true; // pause manuelle
  if (!s.quiet) return false;
  const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };
  const now = d.getHours() * 60 + d.getMinutes(), a = toMin(s.quietFrom), b = toMin(s.quietTo);
  return a <= b ? now >= a && now < b : now >= a || now < b;
}

function parseStart(r) {
  const v = r.start_dt_utc ?? r.start_timestamp ?? null;
  if (v == null && typeof r.seconds_online === "number") return Date.now() - r.seconds_online * 1000;
  if (v == null) return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  let s = String(v).replace(" ", "T");
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += "Z";
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function normalize(r) {
  return {
    username: r.username,
    viewers: r.num_users ?? 0,
    subject: r.room_subject ?? r.subject ?? "",
    show: r.current_show ?? "public",
    img: r.img || `https://roomimg.stream.highwebmedia.com/ri/${r.username}.jpg`,
    startedAt: parseStart(r),
    gender: r.gender ?? null,
  };
}

// follow: cams suivies ; sans option: liste « featured » de la page d'accueil
export async function fetchRooms({ follow = false, genders = null, limit = 90, all = false, extra = {} } = {}) {
  const rooms = [];
  let offset = 0;
  while (true) {
    const p = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (follow) p.set("follow", "true");
    if (genders) p.set("genders", genders);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    const res = await fetch(`${API}?${p}`, {
      credentials: "include",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    if (res.status === 401 || res.status === 403) throw new Error(follow ? "AUTH" : "HTTP " + res.status);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const batch = data.rooms || [];
    rooms.push(...batch.map(normalize));
    if (!all) break;
    offset += limit;
    if (!batch.length || offset >= (data.total_count ?? 0)) break;
  }
  return rooms;
}

// Catégories de la page d'accueil (femmes / couples / trans). Les codes API sont testés dans l'ordre.
export const GENDERS = [
  { id: "f", label: "Women", codes: ["f"] },
  { id: "c", label: "Couples", codes: ["c"] },
  { id: "t", label: "Trans", codes: ["t", "s"] },
];

export async function fetchByGender({ gender = "f", limit = 90 } = {}) {
  const g = GENDERS.find((x) => x.id === gender) ?? GENDERS[0];
  const keep = (rooms) => (rooms.some((r) => r.gender) ? rooms.filter((r) => !r.gender || g.codes.includes(String(r.gender).toLowerCase())) : rooms);
  let refused = false;
  for (const code of g.codes) {
    try {
      const rooms = keep(await fetchRooms({ limit, genders: code }));
      if (rooms.length) return rooms;
    } catch (e) {
      if (!String(e.message).includes("HTTP 400")) throw e; // seul « valeur refusée » est toléré
      refused = true;
    }
  }
  // Le site refuse ce code de genre : on prend la liste du tag et on filtre ici
  if (refused) {
    try {
      const rooms = await fetchRooms({ limit });
      return rooms.filter((r) => r.gender && g.codes.includes(String(r.gender).toLowerCase()));
    } catch (e) {
      if (!String(e.message).includes("HTTP 400")) throw e;
    }
  }
  return []; // → « Aucun résultat »
}

// Meilleur effort : date du dernier live d'une room hors ligne (endpoint non vérifié)
export async function fetchLastBroadcast(username) {
  const res = await fetch(`https://chaturbate.com/api/biocontext/${encodeURIComponent(username)}/`, {
    credentials: "include",
    headers: { "X-Requested-With": "XMLHttpRequest" },
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const d = await res.json();
  const v = d.time_since_last_broadcast ?? d.last_broadcast ?? null;
  return v == null || v === "" ? null : String(v);
}

export const fetchFollowed = () => fetchRooms({ follow: true, all: true });

// ---------- Abonnements complets (en live + hors ligne) ----------
// Variantes testées pour obtenir aussi les rooms hors ligne ; la première qui ajoute des rooms est retenue.
const OFFLINE_STRATEGIES = [{ offline: "true" }, { online: "false" }, { status: "offline" }];

async function scrapeOfflinePages(addRoom) {
  let total = 0;
  for (let page = 1; page <= 15; page++) {
    const res = await fetch(`https://chaturbate.com/followed-cams/offline/?page=${page}`, { credentials: "include" });
    if (!res.ok) break;
    const html = await res.text();
    let added = 0;
    for (const m of html.matchAll(/data-room="([A-Za-z0-9_]{2,40})"/g)) {
      if (addRoom({ username: m[1], gender: null })) added++;
    }
    total += added;
    if (!added) break;
  }
  return total;
}

export async function syncFollowing() {
  const online = await fetchRooms({ follow: true, all: true }); // lève "AUTH" si non connecté
  const map = new Map();
  const add = (r, isOnline) => {
    const k = r.username.toLowerCase();
    if (map.has(k)) return false;
    map.set(k, { username: r.username, gender: r.gender ?? null, online: isOnline });
    return true;
  };
  online.forEach((r) => add(r, true));

  let strategy = "online-only";
  for (const extra of OFFLINE_STRATEGIES) {
    try {
      const rooms = await fetchRooms({ follow: true, all: true, extra });
      const fresh = rooms.filter((r) => !map.has(r.username.toLowerCase()));
      if (fresh.length && fresh.length <= 2000) {
        rooms.forEach((r) => add(r, false));
        strategy = JSON.stringify(extra);
        break;
      }
    } catch { /* variante non supportée */ }
  }
  if (strategy === "online-only") {
    try { if (await scrapeOfflinePages((r) => add(r, false))) strategy = "html"; } catch { /* ignoré */ }
  }

  const list = [...map.values()];
  await chrome.storage.local.set({
    following: list,
    followingAt: Date.now(),
    followingInfo: { strategy, online: online.length, total: list.length },
  });
  return list;
}

// Rapport technique (sans pseudos) pour savoir quelle méthode renvoie la liste complète
export async function diagnoseFollowing() {
  const out = [];
  const probe = async (label, url, html = false) => {
    try {
      const res = await fetch(url, { credentials: "include", headers: { "X-Requested-With": "XMLHttpRequest" } });
      const row = { label, status: res.status };
      if (html) {
        const t = await res.text();
        row.dataRoomAttributes = (t.match(/data-room="/g) || []).length;
        row.length = t.length;
      } else {
        const d = await res.json();
        const first = (d.rooms || [])[0] || {};
        row.rooms = (d.rooms || []).length;
        row.total_count = d.total_count ?? null;
        row.responseKeys = Object.keys(d).join(",");
        row.roomKeys = Object.keys(first).join(",");
      }
      out.push(row);
    } catch (e) {
      out.push({ label, error: e.message });
    }
  };
  const base = `${API}?limit=5&offset=0`;
  await probe("follow=true", `${base}&follow=true`);
  for (const [k, v] of [["offline", "true"], ["online", "false"], ["status", "offline"]]) {
    await probe(`follow=true&${k}=${v}`, `${base}&follow=true&${k}=${v}`);
  }
  await probe("page /followed-cams/offline/", "https://chaturbate.com/followed-cams/offline/", true);
  await probe("sans follow (featured)", base);
  return out;
}

// ---------- Liste « Absents » (3e onglet) ----------
export const SEED_AFK = []; // vide : la version partagée ne contient aucune room personnelle

// Statut d'une room (public / away / private / offline…) via l'endpoint utilisé par le lecteur du site
export async function fetchRoomStatus(username) {
  const res = await fetch(`https://chaturbate.com/api/chatvideocontext/${encodeURIComponent(username)}/`, {
    credentials: "include",
    headers: { "X-Requested-With": "XMLHttpRequest" },
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const d = await res.json();
  return {
    username: d.broadcaster_username || null,
    status: String(d.room_status || "unknown").toLowerCase(),
    title: d.room_title || "",
    gender: d.broadcaster_gender || null,
    viewers: d.num_viewers ?? null,
    at: Date.now(),
  };
}

export async function fetchRoomStatuses(names, concurrency = 4) {
  const out = {};
  const queue = [...names];
  const worker = async () => {
    while (queue.length) {
      const n = queue.shift();
      try { out[n] = await fetchRoomStatus(n); }
      catch { out[n] = { status: "unknown", title: "", gender: null, viewers: null, at: Date.now() }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return out;
}

// Une vérification ratée ne doit pas écraser un statut connu
export function mergeStatuses(prev, next) {
  const out = { ...prev };
  for (const [n, v] of Object.entries(next)) {
    out[n] = v.status === "unknown" && prev[n] ? { ...prev[n], at: v.at } : v;
  }
  return out;
}

// ---------- Dernier live d'une room hors ligne ----------
export const AGO_UNITS = { second: 1e3, sec: 1e3, minute: 6e4, min: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 };

// Convertit « 3 hours, 2 minutes ago » (texte du site) en durée en millisecondes
export function parseAgoMs(text) {
  let ms = 0, found = false;
  for (const m of String(text).matchAll(/(\d+|an?)\s*(second|sec|minute|min|hour|day|week|month|year)s?/gi)) {
    ms += (/^an?$/i.test(m[1]) ? 1 : Number(m[1])) * AGO_UNITS[m[2].toLowerCase()];
    found = true;
  }
  return found ? ms : null;
}

// Moment (ms) du dernier live d'une room : suivi par l'extension, sinon texte du site ; null si inconnu
// Précision (ms) d'un texte « 21 hours ago » : la plus petite unité citée
function agoPrecisionMs(text) {
  let p = Infinity;
  for (const m of String(text).matchAll(/(?:\d+|an?)\s*(second|sec|minute|min|hour|day|week|month|year)s?/gi)) p = Math.min(p, AGO_UNITS[m[1].toLowerCase()]);
  return p === Infinity ? 0 : p;
}

// Quand la room a diffusé alors que le navigateur était fermé, le suivi de l'extension est périmé :
// on prend donc la date la plus récente des deux sources (le texte du site n'est retenu que s'il est
// plus récent que le suivi de plus que sa propre précision, pour ne pas « rajeunir » une date exacte).
export function lastLiveEnd(name, last = {}, lastApi = {}) {
  const tracked = last[name] ? last[name].end : null;
  let fromApi = null, prec = 0;
  const a = lastApi[name];
  if (a && a.text) {
    if (/^\d{4}-\d\d-\d\d/.test(a.text)) { const t = Date.parse(a.text); fromApi = Number.isNaN(t) ? null : t; prec = /^\d{4}-\d\d-\d\d$/.test(a.text) ? 864e5 : 0; }
    else { const ms = parseAgoMs(a.text); fromApi = ms === null ? null : a.at - ms; prec = agoPrecisionMs(a.text); }
  }
  if (tracked !== null && fromApi !== null) return fromApi - tracked > prec ? fromApi : tracked;
  return tracked !== null ? tracked : fromApi;
}

// ---------- Icônes de genre et étiquettes de statut ----------
export function genderKind(code) {
  const g = String(code || "").toLowerCase();
  if (["f", "female", "woman", "women"].includes(g)) return "female";
  if (["c", "couple", "couples"].includes(g)) return "couple";
  if (["t", "s", "ts", "tf", "tm", "trans", "transgender"].includes(g)) return "trans";
  if (["m", "male", "man", "men"].includes(g)) return "male";
  return null;
}

export function showKind(v) {
  const x = String(v || "").toLowerCase();
  if (x.includes("private")) return "private";
  if (x.includes("group")) return "group";
  if (x.includes("away")) return "away";
  if (x.includes("hidden")) return "hidden";
  if (x.includes("password")) return "password";
  if (x.includes("offline")) return "offline";
  if (x === "public" || x === "") return "public";
  return "other";
}
