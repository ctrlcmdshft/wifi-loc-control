export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const whole = Math.floor(seconds);
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

export function livePosition(state, now = Date.now()) {
  const base = Number(state?.position) || 0;
  if (state?.status !== "playing") return Math.max(0, base);
  const rate = Number(state.rate) || 1;
  const elapsed = ((now - (state.positionAt || now)) / 1000) * rate;
  return Math.max(0, base + elapsed);
}

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

export function artGradient(title) {
  let hash = 0;
  for (const char of String(title || "Lumen")) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return `linear-gradient(160deg, hsl(${hue} 28% 28%) 0%, hsl(${(hue + 24) % 360} 18% 12%) 58%, #0c0d0b 100%)`;
}
