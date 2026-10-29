// Traduction : les textes sources sont en français ; i18n-dict.js donne l'anglais, le russe et l'allemand.
import { DICT } from "./i18n-dict.js";

export const LANGS = { auto: "Auto", fr: "Français", en: "English", ru: "Русский", de: "Deutsch" };
const SUPPORTED = ["fr", "en", "ru", "de"];
let LANG = "fr";

export function resolveLang(pref) {
  if (SUPPORTED.includes(pref)) return pref;
  const n = String((typeof navigator !== "undefined" && navigator.language) || "en").slice(0, 2).toLowerCase();
  return SUPPORTED.includes(n) ? n : "en";
}

export function setLang(l) {
  LANG = SUPPORTED.includes(l) ? l : "en";
  if (typeof document !== "undefined" && document.documentElement) document.documentElement.lang = LANG;
}

export const getLang = () => LANG;

export function tr(key, vars) {
  let s = key;
  if (LANG !== "fr") {
    const e = DICT[key];
    if (e && e[LANG]) s = e[LANG];
  }
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m)) : s;
}

// Textes statiques du HTML : on mémorise le texte français d'origine pour pouvoir changer de langue à volonté.
const TEXTS = [], ATTRS = [];
export function captureI18n(root = document.body) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    const p = n.parentNode.nodeName;
    if (p === "SCRIPT" || p === "STYLE") continue;
    const raw = n.nodeValue, key = raw.replace(/\s+/g, " ").trim();
    if (!key) continue;
    TEXTS.push({ node: n, key, lead: /^\s/.test(raw) ? " " : "", trail: /\s$/.test(raw) ? " " : "" });
  }
  root.querySelectorAll("[placeholder],[title],[aria-label]").forEach((el) => {
    for (const a of ["placeholder", "title", "aria-label"]) if (el.hasAttribute(a)) ATTRS.push({ el, attr: a, key: el.getAttribute(a) });
  });
}

export function applyI18n() {
  for (const t of TEXTS) t.node.nodeValue = t.lead + tr(t.key) + t.trail;
  for (const a of ATTRS) a.el.setAttribute(a.attr, tr(a.key));
}
