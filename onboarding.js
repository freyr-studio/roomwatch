// Tutoriel affiché à la première installation (et via Aide > Revoir le tutoriel).
import { getSettings, saveSettings } from "./lib.js";
import { tr, setLang, resolveLang, captureI18n, applyI18n, LANGS } from "./i18n.js";

const $ = (id) => document.getElementById(id);
captureI18n();

const STEPS = [
  { title: "Bienvenue dans Roomwatch", body: ["Ce petit tutoriel te montre l'essentiel en 1 minute.", "L'extension te prévient dès qu'une de tes rooms passe en live, sans que tu aies besoin de garder le site ouvert."], tip: "Astuce : épingle l'extension (icône puzzle de la barre du navigateur) pour la retrouver facilement." },
  { title: "1. Connecte-toi à Chaturbate", body: ["Ouvre le site et connecte-toi à ton compte, dans ce navigateur. L'extension utilise ta session : elle ne te demande ni ne stocke aucun mot de passe."], action: "login" },
  { title: "2. Les vues", list: ["Favoris : tes rooms importantes (en live d'abord, puis hors ligne), avec notifications. Follow et AFK sont des listes manuelles, sans notification de live.", "Les trois boutons de genre, sous le cœur, ouvrent tes pages de suivis sur Chaturbate."] },
  { title: "3. Choisis tes favoris", list: ["Dans ⚙ > Notifications, « Choisir mes alertes room par room » liste tous tes abonnements : coche tes favoris.", "Ou ajoute des pseudos avec le champ en haut de l'onglet Favoris.", "Les notifications ne concernent que tes favoris."] },
  { title: "4. Notifications et sons", list: ["Ouvre ⚙ > Notifications pour tout régler : sons, heures silencieuses, retour des rooms AFK.", "La cloche en bas met les notifications en pause (1 h, 2 h, jusqu'à demain).", "Le bouton en forme d'œil active le mode discret (raccourci Alt+Shift+H) : miniatures floutées, sons coupés."] },
  { title: "5. C'est parti !", body: ["Tu peux changer la langue et l'apparence dans ⚙ > Affichage, et signaler un problème avec le bouton en forme d'insecte.", "Ce tutoriel reste disponible dans ⚙ > Aide.", "Le bouton ? en bas de la fenêtre explique à quoi sert chaque bouton."] },
];

let i = 0, settings = {};

function render() {
  const s = STEPS[i];
  const card = $("card");
  card.replaceChildren();
  if (i === 0) { const img = document.createElement("img"); img.src = "icons/icon128.png"; card.append(img); }
  const h = document.createElement("h1");
  h.textContent = tr(s.title);
  card.append(h);
  for (const t of s.body || []) { const p = document.createElement("p"); p.textContent = tr(t); card.append(p); }
  if (s.list) { const ul = document.createElement("ul"); for (const t of s.list) { const li = document.createElement("li"); li.textContent = tr(t); ul.append(li); } card.append(ul); }
  if (s.tip) { const p = document.createElement("p"); p.className = "muted"; p.textContent = tr(s.tip); card.append(p); }
  const grow = document.createElement("div");
  grow.className = "grow";
  card.append(grow);
  if (s.action === "login") {
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = tr("Ouvrir Chaturbate");
    b.onclick = () => window.open("https://chaturbate.com/auth/login/", "_blank");
    card.append(b);
  }
  $("dots").replaceChildren(...STEPS.map((_, k) => { const d = document.createElement("i"); if (k === i) d.className = "on"; return d; }));
  $("prev").style.visibility = i === 0 ? "hidden" : "visible";
  $("next").textContent = i === STEPS.length - 1 ? tr("Terminer") : tr("Suivant");
  $("prev").textContent = tr("Précédent");
  document.title = tr("Roomwatch – Tutoriel");
}

async function init() {
  settings = await getSettings();
  document.body.dataset.theme = settings.theme || "default";
  setLang(resolveLang(settings.lang));
  const sel = $("lang");
  sel.replaceChildren(...Object.entries(LANGS).map(([v, l]) => { const o = document.createElement("option"); o.value = v; o.textContent = v === "auto" ? tr("Automatique") : l; return o; }));
  sel.value = settings.lang || "auto";
  sel.onchange = async () => {
    await saveSettings({ lang: sel.value });
    setLang(resolveLang(sel.value));
    applyI18n();
    sel.firstChild.textContent = tr("Automatique");
    render();
  };
  applyI18n();
  render();
}

$("prev").onclick = () => { if (i > 0) { i--; render(); } };
$("next").onclick = async () => {
  if (i < STEPS.length - 1) { i++; render(); return; }
  await chrome.storage.local.set({ onboarded: true });
  window.close();
};
init();
