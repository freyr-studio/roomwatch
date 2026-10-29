import { playSound, playData } from "./sounds.js";
chrome.runtime.onMessage.addListener((m) => {
  if (!m || m.type !== "play-sound") return;
  if (m.data) playData(m.data, m.volume);
  else playSound(m.name, m.volume);
});
