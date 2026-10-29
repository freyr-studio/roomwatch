// Sons synthétisés (aucun fichier nécessaire) + lecture de fichiers audio personnels.
import { tr } from "./i18n.js";

export const SOUND_LABELS = {
  ding: "Ding",
  chime: "Carillon",
  pop: "Pop",
  double: "Double bip",
  alert: "Alerte",
  bell: "Cloche",
  coin: "Pièce",
  marimba: "Marimba",
  sonar: "Sonar",
  arpeggio: "Arpège",
  bubble: "Bulle",
  chirp: "Gazouillis",
  digital: "Numérique",
};

export function playSound(name, volume = 0.7) {
  const v = Math.max(0.02, Math.min(1, volume));
  const ctx = new AudioContext();
  ctx.resume?.();
  const t0 = ctx.currentTime;
  const tone = (freq, start, dur, type = "sine", gain = 1, slideTo = null) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0 + start);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + start + dur);
    g.gain.setValueAtTime(0.0001, t0 + start);
    g.gain.exponentialRampToValueAtTime(v * gain, t0 + start + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t0 + start);
    o.stop(t0 + start + dur + 0.05);
  };
  switch (name) {
    case "chime": tone(784, 0, 0.5); tone(988, 0.12, 0.5); tone(1319, 0.24, 0.9); break;
    case "pop": tone(520, 0, 0.12, "triangle"); tone(780, 0.08, 0.2, "triangle"); break;
    case "double": tone(660, 0, 0.14); tone(660, 0.2, 0.14); break;
    case "alert": tone(880, 0, 0.15, "square", 0.35); tone(880, 0.22, 0.15, "square", 0.35); tone(1175, 0.44, 0.3, "square", 0.35); break;
    case "bell": tone(880, 0, 1.3, "sine", 0.8); tone(1760, 0, 0.9, "sine", 0.3); tone(2640, 0, 0.6, "sine", 0.15); break;
    case "coin": tone(988, 0, 0.08, "square", 0.3); tone(1319, 0.08, 0.45, "square", 0.3); break;
    case "marimba": tone(523, 0, 0.25, "triangle"); tone(659, 0.12, 0.25, "triangle"); tone(784, 0.24, 0.4, "triangle"); break;
    case "sonar": tone(1200, 0, 0.9, "sine", 0.9); tone(1200, 0.55, 0.7, "sine", 0.35); break;
    case "arpeggio": [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.3, "sine", 0.8)); break;
    case "bubble": tone(400, 0, 0.16, "sine", 1, 900); tone(600, 0.14, 0.16, "sine", 1, 1300); break;
    case "chirp": tone(1800, 0, 0.1, "sine", 0.7, 2600); tone(2200, 0.13, 0.1, "sine", 0.7, 3000); break;
    case "digital": [1320, 990, 660].forEach((f, i) => tone(f, i * 0.1, 0.12, "square", 0.3)); break;
    default: tone(1046, 0, 0.7); tone(1568, 0, 0.7, "sine", 0.4);
  }
  setTimeout(() => ctx.close(), 2000);
}

// Fichier audio personnel (data URL)
export function playData(data, volume = 0.7) {
  const a = new Audio(data);
  a.volume = Math.max(0, Math.min(1, volume));
  return a.play().catch(() => {});
}

// Remplit une liste déroulante : sons intégrés puis sons personnels (valeur « custom:<id> »)
export function fillSoundSelect(sel, customSounds = []) {
  const fixed = [...sel.options].filter((o) => o.value === "system" || o.value === "none");
  const opt = (value, text) => { const o = document.createElement("option"); o.value = value; o.textContent = text; return o; };
  fixed.forEach((o) => { o.textContent = o.value === "system" ? tr("Son système") : tr("Aucun son"); });
  sel.replaceChildren(
    ...fixed,
    ...Object.entries(SOUND_LABELS).map(([id, label]) => opt(id, tr(label))),
    ...customSounds.map((c) => opt("custom:" + c.id, "♪ " + c.name))
  );
}

export function previewSound(name, volume, customSounds = []) {
  if (String(name).startsWith("custom:")) {
    const c = customSounds.find((x) => "custom:" + x.id === name);
    if (c) playData(c.data, volume);
  } else if (name in SOUND_LABELS) {
    playSound(name, volume);
  }
}
