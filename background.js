import { syncNow, SYNC_KEYS } from "./sync.js";
import { checkUpdate } from "./update.js";
import { tr, setLang, resolveLang } from "./i18n.js";
import { fetchLastBroadcast, lastLiveEnd, fetchFollowed, getSettings, inQuietHours, syncFollowing, fetchRoomStatuses, mergeStatuses, SEED_AFK } from "./lib.js";

const ALARM = "poll";

async function ensureAlarm() {
  const s = await getSettings();
  chrome.alarms.create(ALARM, { periodInMinutes: Math.max(0.5, s.interval) });
}

const applyLang = (s) => setLang(resolveLang(s.lang));

async function seedLists() {
  const { afk, others } = await chrome.storage.local.get(["afk", "others"]);
  const patch = {};
  if (!afk) patch.afk = SEED_AFK;
  if (!others) patch.others = [];
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

chrome.runtime.onInstalled.addListener((details) => {
  seedLists(); ensureAlarm(); poll();
  if (details && details.reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") }); // tutoriel à la première installation
});
chrome.runtime.onStartup.addListener(() => { seedLists(); ensureAlarm(); poll(); syncNow().catch(() => {}); });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) poll();
  else if (a.name === "sync") syncNow().catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg === "refresh") { poll().then(() => send(true)); return true; }
  if (msg === "test") { testNotification(); }
  if (msg === "test-return") { // aperçu de la notification de retour (sans rien déplacer)
    getSettings().then((s) => {
      applyLang(s);
      createNotification("test-return", tr("Test : une room est enfin de retour"), tr("Absente depuis {n} jours", { n: 12 }) + " · " + tr("Titre du live"), s, s.returnSound);
      playConfiguredSound(s, s.returnSound, s.returnVolume);
    });
  }
  if (msg === "archive-now") { // vérification immédiate des favoris hors ligne depuis longtemps
    getSettings().then((s) => { applyLang(s); return archiveCheck(s, true); }).then((moved) => send({ moved })).catch(() => send({ moved: 0 }));
    return true;
  }
  if (msg === "check-returns") { // vérification immédiate de la liste « Absents »
    getSettings().then((s) => { applyLang(s); return checkReturns(s, true); }).then(() => send(true)).catch(() => send(false));
    return true;
  }
  if (msg === "sync") { syncFollowing().then(() => send(true)).catch(() => send(false)); return true; }
});

chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith("live:")) chrome.tabs.create({ url: `https://chaturbate.com/${id.slice(5)}/` });
  if (id === "update") chrome.tabs.create({ url: chrome.runtime.getURL("options.html#update") });
});

// Dès qu'une page Chaturbate se charge alors que l'extension n'est pas connectée, on revérifie la session
chrome.tabs.onUpdated.addListener(async (_id, info, tab) => {
  if (info.status !== "complete" || !tab.url || !tab.url.startsWith("https://chaturbate.com/")) return;
  const { error } = await chrome.storage.local.get("error");
  if (error === "AUTH") poll();
});

chrome.commands.onCommand.addListener(async (cmd) => { // raccourcis clavier
  if (cmd === "toggle-stealth") { // mode discret
    const { stealth = false } = await chrome.storage.local.get("stealth");
    await chrome.storage.local.set({ stealth: !stealth });
  } else if (cmd === "open-live-favorites") { // ouvre les favoris en live (5 au maximum, pour ne pas inonder le navigateur)
    const { rooms = [], watch = [] } = await chrome.storage.local.get(["rooms", "watch"]);
    for (const r of rooms.filter((x) => watch.includes(x.username.toLowerCase())).slice(0, 5)) chrome.tabs.create({ url: `https://chaturbate.com/${r.username}/`, active: false });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.stealth) updateBadge();
  if (changes.settings) ensureAlarm();
  if (SYNC_KEYS.some((k) => changes[k])) chrome.alarms.create("sync", { delayInMinutes: 0.5 }); // envoie les changements au serveur
  if (changes.settings || changes.watch || changes.others) updateBadge();
});

// --- Son (un document « offscreen » est nécessaire pour jouer de l'audio depuis le service worker)
async function playConfiguredSound(s, which = s.sound, volume = s.volume) {
  if (s.stealth || ["system", "none"].includes(which) || !chrome.offscreen) return; // mode discret : aucun son
  let name = which, data = null;
  if (String(name).startsWith("custom:")) { // fichier audio personnel (sinon : son par défaut)
    const { customSounds = [] } = await chrome.storage.local.get("customSounds");
    const c = customSounds.find((x) => "custom:" + x.id === name);
    if (c) data = c.data; else name = "ding";
  }
  try {
    const ctxs = await chrome.runtime.getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (!ctxs || !ctxs.length) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Jouer un son lors d'une notification de live",
      });
    }
  } catch (e) { /* le document existe déjà */ }
  chrome.runtime.sendMessage({ type: "play-sound", name, volume, data }).catch(() => {});
}

function createNotification(id, title, message, s, sound = s.sound) {
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    // mode discret : texte neutre (ni pseudo ni titre) et aucun son
    title: s.stealth ? "Roomwatch" : title,
    message: s.stealth ? tr("Une de tes rooms est en ligne") : message,
    silent: !!s.stealth || sound !== "system", // son géré par l'extension, sauf si « Son système » est choisi
  });
}

async function testNotification() {
  const s = await getSettings();
  applyLang(s);
  createNotification("live:test", tr("Test : un streamer est en live"), tr("Si tu vois ça, les notifications fonctionnent."), s);
  playConfiguredSound(s);
}

async function updateBadge() {
  const { rooms = [], watch = [], others = [], error = null } = await chrome.storage.local.get(["rooms", "watch", "others", "error"]);
  const s = await getSettings();
  if (error) {
    chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
    chrome.action.setBadgeText({ text: "!" });
    return;
  }
  const n = s.filterByRoom ? rooms.filter((r) => watch.includes(r.username.toLowerCase()) || others.includes(r.username.toLowerCase())).length : rooms.length;
  chrome.action.setBadgeBackgroundColor({ color: "#f47321" });
  chrome.action.setBadgeText({ text: !s.stealth && s.badge && n ? String(n) : "" });
}

// Favoris ET Follow hors ligne depuis plus de N jours -> liste AFK (vérifié au plus toutes les 6 h, ou tout de suite sur demande).
// On retient d'où vient la room (« from ») pour la remettre dans le bon onglet à son retour.
// Une room dont la date du dernier live est inconnue n'est jamais déplacée.
async function archiveCheck(s, force = false) {
  if (!s.autoArchive && !force) return 0;
  const { watch = [], others = [], afk = [], rooms = [], last = {}, lastApi = {}, autoArchived = {}, archiveCheckedAt = 0 } =
    await chrome.storage.local.get(["watch", "others", "afk", "rooms", "last", "lastApi", "autoArchived", "archiveCheckedAt"]);
  const now = Date.now();
  if (!force && now - archiveCheckedAt < 6 * 3600e3) return 0;
  const live = new Set(rooms.map((r) => r.username.toLowerCase()));
  const limit = Math.max(1, Number(s.archiveDays) || 7) * 864e5;
  const pool = [...new Set([...watch, ...others])].filter((n) => !afk.includes(n));

  // complète au besoin la date du dernier live (texte du site, mis en cache 12 h)
  const api = { ...lastApi };
  const queue = pool.filter((n) => !live.has(n) && !(api[n] && now - api[n].at < 12 * 3600e3)).slice(0, 60);
  const worker = async () => {
    while (queue.length) {
      const n = queue.shift();
      let text = null;
      try { text = await fetchLastBroadcast(n); } catch { /* inconnu */ }
      api[n] = { text, at: Date.now() };
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  const moved = pool.filter((n) => {
    if (live.has(n)) return false;
    const end = lastLiveEnd(n, last, api);
    return end !== null && now - end > limit;
  });
  const patch = { lastApi: api, archiveCheckedAt: now };
  if (moved.length) {
    const archived = { ...autoArchived };
    for (const n of moved) archived[n] = { at: now, end: lastLiveEnd(n, last, api), from: watch.includes(n) ? "watch" : "others" };
    Object.assign(patch, {
      watch: watch.filter((n) => !moved.includes(n)),
      others: others.filter((n) => !moved.includes(n)),
      afk: [...new Set([...afk, ...moved])],
      autoArchived: archived,
    });
  }
  await chrome.storage.local.set(patch);
  if (moved.length && !force && s.notify && !s.stealth && !inQuietHours(s)) {
    chrome.notifications.create("archive", {
      type: "basic", iconUrl: "icons/icon128.png", silent: true,
      title: tr("{n} room(s) déplacée(s) vers AFK", { n: moved.length }),
      message: tr("Hors ligne depuis plus de {d} jours : {names}", { d: s.archiveDays, names: moved.slice(0, 5).join(", ") + (moved.length > 5 ? "…" : "") }),
    });
  }
  return moved.length;
}

// Toute room AFK (archivée automatiquement OU ajoutée à la main) est surveillée. Elle revient quand elle est en live
// OU quand son dernier live date de moins de N jours (elle n'est donc plus « absente »). Une room archivée automatiquement
// retourne dans l'onglet d'où elle vient (Favoris ou Follow) ; les autres retournent dans Favoris.
async function checkReturns(s, force = false) {
  if (!s.autoReturn) return;
  const { autoArchived = {}, afk = [], watch = [], others = [], returnCheckedAt = 0, afkStatus = {}, last = {}, lastApi = {} } =
    await chrome.storage.local.get(["autoArchived", "afk", "watch", "others", "returnCheckedAt", "afkStatus", "last", "lastApi"]);
  const tracked = Object.keys(autoArchived).filter((n) => afk.includes(n));
  if (tracked.length !== Object.keys(autoArchived).length) { // rooms retirées à la main de AFK : on les oublie
    const aa = {};
    for (const n of tracked) aa[n] = autoArchived[n];
    await chrome.storage.local.set({ autoArchived: aa });
  }
  const now = Date.now();
  if (!afk.length || (!force && now - returnCheckedAt < 110000)) return;

  const res = await fetchRoomStatuses(afk);
  // date du dernier live des rooms AFK : texte du site, mis en cache 3 h
  const api = { ...lastApi };
  const queue = afk.filter((n) => force || !(api[n] && now - api[n].at < 3 * 3600e3)).slice(0, 30);
  const worker = async () => {
    while (queue.length) {
      const n = queue.shift();
      let text = null;
      try { text = await fetchLastBroadcast(n); } catch { /* inconnu */ }
      api[n] = { text, at: Date.now() };
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  const limit = Math.max(1, Number(s.archiveDays) || 7) * 864e5;
  // Marge d'un jour sous le seuil d'archivage (le site arrondit « il y a N jours ») : une room ne peut pas être archivée puis rappelée en boucle
  const window = Math.max(limit - 864e5, 12 * 3600e3);
  const isBack = (n) => {
    if (res[n].status === "public") return true; // « unknown » (vérification ratée) ne déclenche rien
    const end = lastLiveEnd(n, last, api);
    return end !== null && now - end <= window;
  };
  const back = afk.filter(isBack);
  await chrome.storage.local.set({ returnCheckedAt: now, afkStatus: mergeStatuses(afkStatus, res), lastApi: api });
  if (!back.length) return;

  const aa = {};
  for (const n of tracked) if (!back.includes(n)) aa[n] = autoArchived[n];
  const toOthers = back.filter((n) => autoArchived[n] && autoArchived[n].from === "others");
  const toWatch = back.filter((n) => !toOthers.includes(n));
  await chrome.storage.local.set({
    afk: afk.filter((n) => !back.includes(n)),
    watch: [...new Set([...watch, ...toWatch])],
    others: [...new Set([...others, ...toOthers])],
    autoArchived: aa,
  });
  if (s.notify && !inQuietHours(s)) {
    for (const n of back) {
      const end = autoArchived[n] && autoArchived[n].end ? autoArchived[n].end : null;
      const days = end ? Math.round((now - end) / 864e5) : 0;
      const since = days >= 1 ? tr("Absente depuis {n} jours", { n: days }) : "";
      const text = [since, res[n].title].filter(Boolean).join(" · ") || tr("Elle est en live");
      createNotification(`live:${n}`, tr("{name} est enfin de retour", { name: n }), text, s, s.returnSound);
    }
    playConfiguredSound(s, s.returnSound, s.returnVolume);
  }
}

// Notifie quand une room de la liste « Absents » passe en live (public) ; vérifiée au plus toutes les ~2 minutes
async function checkAfk(s, notified = new Set()) {
  if (!s.afkNotify || !s.notify || s.autoReturn) return; // avec le retour automatique, c'est la notification « enfin de retour » qui s'applique
  const { afk = [], afkStatus = {}, afkCheckedAt = 0, autoArchived = {} } = await chrome.storage.local.get(["afk", "afkStatus", "afkCheckedAt", "autoArchived"]);
  const now = Date.now();
  if (!afk.length || now - afkCheckedAt < 110000) return;
  const merged = mergeStatuses(afkStatus, await fetchRoomStatuses(afk));
  if (Object.keys(afkStatus).length && !inQuietHours(s)) {
    const fresh = afk.filter((n) => merged[n]?.status === "public" && afkStatus[n] && afkStatus[n].status !== "public" && !notified.has(n) && !autoArchived[n]);
    for (const n of fresh) {
      createNotification(`live:${n}`, tr("{name} est en live", { name: n }), `AFK · ${merged[n].title || tr("Un live vient de commencer")}`, s);
    }
    if (fresh.length) playConfiguredSound(s);
  }
  await chrome.storage.local.set({ afkStatus: merged, afkCheckedAt: now });
}

// Mise à jour automatique : si les fichiers sur le disque ont changé (ex. tâche planifiée qui copie la nouvelle version depuis
// le NAS), l'extension se recharge toute seule. Vérifié au plus toutes les 5 minutes.
// Après un rechargement dû à une mise à jour : confirme (ou signale) la version réellement chargée
async function confirmUpdate() {
  const { updatePending } = await chrome.storage.local.get("updatePending");
  if (!updatePending) return;
  await chrome.storage.local.set({ updatePending: null });
  const s = await getSettings();
  applyLang(s);
  const cur = chrome.runtime.getManifest().version;
  const ok = cur === updatePending.to;
  chrome.notifications.create("update-done", {
    type: "basic", iconUrl: "icons/icon128.png", silent: true,
    title: ok ? tr("Roomwatch mis à jour") : tr("La mise à jour n'a pas pris effet"),
    message: ok ? tr("Version installée : v{v}", { v: cur }) : tr("Version attendue : v{e}, version actuelle : v{c}. Clique sur ⟳ dans chrome://extensions.", { e: updatePending.to, c: cur }),
  });
}
confirmUpdate().catch(() => { /* sans gravité */ });

async function checkDiskVersion() {
  const { diskCheckedAt = 0 } = await chrome.storage.local.get("diskCheckedAt");
  if (Date.now() - diskCheckedAt < 5 * 60000) return;
  await chrome.storage.local.set({ diskCheckedAt: Date.now() });
  const res = await fetch(chrome.runtime.getURL("manifest.json") + "?t=" + Date.now(), { cache: "no-store" });
  const disk = await res.json();
  if (disk.version && disk.version !== chrome.runtime.getManifest().version) chrome.runtime.reload();
}

async function poll() {
  const s = await getSettings();
  applyLang(s);
  const { known = null, watch = [] } = await chrome.storage.local.get(["known", "watch"]);
  const notified = new Set(); // rooms déjà notifiées pendant ce passage (évite un doublon avec la liste Absents)
  try {
    const rooms = await fetchFollowed();
    if (known && s.notify && !inQuietHours(s)) {
      const fresh = rooms.filter((r) => !known.includes(r.username) && (!s.filterByRoom || watch.includes(r.username.toLowerCase())));
      for (const r of fresh) {
        notified.add(r.username.toLowerCase());
        createNotification(`live:${r.username}`, tr("{name} est en live", { name: r.username }), r.subject || tr("Un live vient de commencer"), s);
      }
      if (fresh.length) playConfiguredSound(s);
    }
    // Mémorise la dernière fois où chaque favori a été vu en live
    const now = Date.now();
    const { last: prevLast = {} } = await chrome.storage.local.get("last");
    const last = {};
    for (const n of watch) if (prevLast[n]) last[n] = prevLast[n];
    for (const r of rooms) {
      const u = r.username.toLowerCase();
      if (!watch.includes(u)) continue;
      const cont = prevLast[u] && now - prevLast[u].end < 5 * 60000;
      last[u] = { start: r.startedAt ?? (cont ? prevLast[u].start : now), end: now };
    }
    await chrome.storage.local.set({
      rooms, last, known: rooms.map((r) => r.username), error: null, updatedAt: now,
    });
  } catch (e) {
    await chrome.storage.local.set({ error: e.message });
  }
  try { await checkReturns(s); } catch { /* sans gravité */ }
  try { await archiveCheck(s); } catch { /* sans gravité */ }
  try { await checkAfk(s, notified); } catch { /* sans gravité */ }
  // Rafraîchit la liste complète des abonnements toutes les 6 h
  try {
    const { followingAt = 0, error } = await chrome.storage.local.get(["followingAt", "error"]);
    if (!error && Date.now() - followingAt > 6 * 3600e3) await syncFollowing();
  } catch { /* sans gravité */ }
  try { // synchronisation automatique entre PC (au plus toutes les 5 minutes)
    const { syncCfg, syncMeta } = await chrome.storage.local.get(["syncCfg", "syncMeta"]);
    if (syncCfg && syncCfg.enabled && Date.now() - ((syncMeta && syncMeta.at) || 0) > 5 * 60000) await syncNow();
  } catch { /* sans gravité */ }
  try { // nouvelle version publiée sur le NAS ? (vérifié toutes les 6 h)
    const { updateInfo, updateNotifiedFor } = await chrome.storage.local.get(["updateInfo", "updateNotifiedFor"]);
    if (Date.now() - ((updateInfo && updateInfo.at) || 0) > 6 * 3600e3) {
      const info = await checkUpdate();
      if (info.available && updateNotifiedFor !== info.latest) {
        chrome.notifications.create("update", {
          type: "basic", iconUrl: "icons/icon128.png", silent: true,
          title: tr("Roomwatch : mise à jour disponible"),
          message: tr("La version {latest} est prête (installée : {current}). Clique ici pour l'installer.", { latest: info.latest, current: info.current }),
        });
        await chrome.storage.local.set({ updateNotifiedFor: info.latest });
      }
    }
  } catch { /* NAS injoignable ou rien de publié : sans gravité */ }
  try { await checkDiskVersion(); } catch { /* sans gravité */ }
  await updateBadge();
}
