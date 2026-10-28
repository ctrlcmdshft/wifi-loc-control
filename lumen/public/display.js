import { command, connect } from "./client.js";
import { artGradient, formatTime, livePosition } from "./format.js";
import { PROMPTS, ROAD_KIT } from "./prompts.js";

const RATES = [0.75, 1, 1.25, 1.5, 2];
const LOOP_LABEL = { off: "Loop", all: "Loop all", one: "Loop one" };

const $ = (selector) => document.querySelector(selector);
const player = $("#player");
const scrub = $("#scrub");
const volume = $("#volume");
const dim = $("#dim");

let latest = null;
let rev = 0;
let scrubbing = false;
let loadedKey = "";
let fileNonce = -1;
let ytPlayer = null;
let ytKey = "";
let ytNonce = -1;
let ytApi = null;
let frameKey = "";
let frameTimer = 0;
let frameIndex = 0;
let frameOn = false;
let mirrorOn = false;
let errorFor = "";

const remoteUrl = `${location.origin}/remote`;
$("#pair-url").textContent = remoteUrl;
$("#empty-url").textContent = remoteUrl;
$("#qr").src = "/api/qr.svg";
$("#qr-empty").src = "/api/qr.svg";
if (!document.documentElement.requestFullscreen) $("#full").hidden = true;

$("#pair-btn").addEventListener("click", () => {
  const pop = $("#pair-pop");
  pop.hidden = !pop.hidden;
  $("#pair-btn").setAttribute("aria-expanded", String(!pop.hidden));
});
$("#full").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});
document.querySelectorAll(".modes button").forEach((button) => {
  button.addEventListener("click", () => command({ type: "setMode", mode: button.dataset.mode }).catch(() => {}));
});
$("#prev").addEventListener("click", () => command({ type: "prev" }));
$("#next").addEventListener("click", () => command({ type: "next" }));
$("#play").addEventListener("click", () => {
  if (latest?.status !== "playing") player.play().catch(() => showSoundUnlock());
  command({ type: "togglePlay" }).catch(() => {});
});
$("#unlock").addEventListener("click", () => {
  const attempt = player.play();
  attempt?.catch(() => {});
  command({ type: "unlockTheater" }).then(() => player.play().catch(() => showSoundUnlock()));
});
$("#dismiss-gate").addEventListener("click", () => command({ type: "setMode", mode: "drive" }));
$("#hide-picture").addEventListener("click", () => command({ type: "lockTheater" }));
$("#loop").addEventListener("click", () => command({ type: "setLoop" }));
$("#shuffle").addEventListener("click", () => command({ type: "setShuffle", value: !latest?.shuffle }));
$("#rate").addEventListener("click", () => {
  const index = RATES.indexOf(Number(latest?.rate) || 1);
  command({ type: "setRate", rate: RATES[(index + 1) % RATES.length] });
});
$("#captions").addEventListener("click", () => {
  const track = player.textTracks[0];
  if (!track) return;
  track.mode = track.mode === "showing" ? "hidden" : "showing";
  $("#captions").setAttribute("aria-pressed", String(track.mode === "showing"));
});
$("#sound-unlock").addEventListener("click", () => {
  $("#sound-unlock").hidden = true;
  const attempt = player.play();
  attempt?.then(() => {
    if (latest?.status !== "playing") player.pause();
  }).catch(() => {});
  if (ytPlayer?.playVideo && latest?.status === "playing") ytPlayer.playVideo();
});
volume.addEventListener("input", () => { player.volume = Number(volume.value); });
volume.addEventListener("change", () => command({ type: "setVolume", value: Number(volume.value) }));
dim.addEventListener("input", () => document.documentElement.style.setProperty("--dim", dim.value));
dim.addEventListener("change", () => command({ type: "setDim", value: Number(dim.value) }));
scrub.addEventListener("pointerdown", () => { scrubbing = true; });
scrub.addEventListener("change", () => {
  scrubbing = false;
  command({ type: "seek", seconds: Number(scrub.value) });
});
$("#queue").addEventListener("click", (event) => {
  const button = event.target.closest("[data-play]");
  if (button) command({ type: "playIndex", id: button.dataset.play });
});
$("#checks").addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-check]");
  const drop = event.target.closest("[data-drop]");
  if (toggle) command({ type: "toggleCheck", id: toggle.dataset.check });
  if (drop) command({ type: "removeCheck", id: drop.dataset.drop });
});
$("#check-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#check-text");
  const text = input.value.trim();
  if (!text) return;
  command({ type: "addCheck", text }).then(() => { input.value = ""; });
});
$("#road-kit").addEventListener("click", async () => {
  const have = new Set((latest?.checklist || []).map((item) => item.text));
  for (const text of ROAD_KIT) {
    if (!have.has(text)) await command({ type: "addCheck", text });
  }
});
$("#next-prompt").addEventListener("click", () => command({ type: "nextPrompt", count: PROMPTS.length }));
$("#trip-start").addEventListener("click", () => command({ type: "tripStart" }));
$("#trip-reset").addEventListener("click", () => command({ type: "tripReset" }));
bindText($("#destination"), "setDestination");
bindText($("#trip-destination"), "setDestination");
bindText($("#notes"), "setNotes");

player.addEventListener("ended", () => command({ type: "ended" }).catch(() => {}));
player.addEventListener("error", () => {
  const item = currentItem(latest);
  if (!item || item.kind === "youtube" || !loadedKey) return;
  showMediaError("This file will not play here. An mp4 using H.264 is the reliable choice.");
});

document.addEventListener("keydown", (event) => {
  if (event.target.matches("input, textarea")) return;
  if (event.code === "Space") {
    event.preventDefault();
    $("#play").click();
  } else if (event.key === "ArrowRight") {
    command({ type: "seek", seconds: livePosition(latest || {}) + 10 });
  } else if (event.key === "ArrowLeft") {
    command({ type: "seek", seconds: Math.max(0, livePosition(latest || {}) - 10) });
  } else if (event.key === "f") {
    $("#full").click();
  }
});

connect({
  onState: (state) => {
    if (state.rev < rev) return;
    rev = state.rev;
    latest = state;
    render(state);
  },
  onStatus: (status) => {
    const node = $("#conn");
    node.dataset.state = status;
    node.textContent = status === "live" ? "Live" : status === "reconnecting" ? "Reconnecting" : "Connecting";
  },
});

navigator.wakeLock?.request("screen").catch(() => {});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") navigator.wakeLock?.request("screen").catch(() => {});
});

setInterval(paintClock, 1000);
paintClock();
setInterval(syncScrub, 250);
setInterval(reportPlayback, 4000);
setInterval(pollMirror, 1000);

function render(state) {
  document.body.dataset.mode = state.mode;
  document.body.dataset.hasMedia = state.queue.length ? "1" : "0";
  for (const button of document.querySelectorAll(".modes button")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === state.mode));
  }
  if (document.activeElement !== dim) {
    dim.value = state.dim;
    document.documentElement.style.setProperty("--dim", String(state.dim));
  }
  const item = currentItem(state);
  const showVideo = Boolean(item && item.kind !== "audio" && state.mode === "theater" && state.theaterUnlocked);
  document.body.dataset.showVideo = showVideo ? "1" : "0";
  $("#gate").hidden = !(state.mode === "theater" && !state.theaterUnlocked);
  $("#theater-empty").hidden = !(state.mode === "theater" && state.theaterUnlocked && !item);
  $("#passenger-note").hidden = !showVideo;
  if (errorFor && errorFor !== state.currentId) {
    errorFor = "";
    $("#media-error").hidden = true;
  }
  fill($("#destination"), state.destination);
  fill($("#trip-destination"), state.destination);
  fill($("#notes"), state.notes);
  $("#trip-start").disabled = Boolean(state.tripStartedAt);
  $("#drive-now").hidden = !item;
  $("#drive-now").textContent = item ? item.title : "";
  $("#drive-now").style.background = "";
  $("#ambient-title").textContent = item ? item.title : "The cabin is quiet.";
  if (item && (state.mode === "ambient" || item.kind === "audio")) {
    $("#ambient-title").style.backgroundImage = artGradient(item.title);
  }
  $("#prompt-text").textContent = PROMPTS[(state.promptIndex || 0) % PROMPTS.length];
  $("#now-title").textContent = item?.title || "Nothing queued";
  $("#play").classList.toggle("is-playing", state.status === "playing");
  $("#play").setAttribute("aria-label", state.status === "playing" ? "Pause" : "Play");
  $("#loop").textContent = LOOP_LABEL[state.loop] || "Loop";
  $("#shuffle").setAttribute("aria-pressed", String(state.shuffle));
  $("#rate").textContent = `${state.rate}×`;
  $("#captions").hidden = !item?.captionFileId;
  if (document.activeElement !== volume) volume.value = state.volume;
  renderQueue(state);
  renderChecks(state);
  syncMirror(state);
  syncFrame(state);
  applyMedia(state);
}

function renderQueue(state) {
  const list = $("#queue");
  const sig = `${state.currentId}|${state.queue.map((item) => `${item.id}:${item.title}`).join("|")}`;
  if (list.dataset.sig === sig) return;
  list.dataset.sig = sig;
  if (state.queue.length === 0) {
    list.innerHTML = `<li class="queue-empty">The queue is empty.</li>`;
    return;
  }
  list.innerHTML = state.queue.map((item, index) => `
    <li class="${item.id === state.currentId ? "is-current" : ""}">
      <button type="button" data-play="${item.id}">
        <span>${index + 1}</span>
        <strong>${escapeHtml(item.title)}</strong>
      </button>
    </li>
  `).join("");
}

function renderChecks(state) {
  const list = $("#checks");
  const sig = state.checklist.map((item) => `${item.id}:${item.text}:${item.done}`).join("|");
  if (list.dataset.sig === sig) return;
  list.dataset.sig = sig;
  list.innerHTML = state.checklist.map((item) => `
    <li>
      <button type="button" data-check="${item.id}" aria-pressed="${item.done}">
        <span class="box"></span><span>${escapeHtml(item.text)}</span>
      </button>
      <button type="button" class="icon" data-drop="${item.id}" aria-label="Remove ${escapeHtml(item.text)}">×</button>
    </li>
  `).join("");
}

function applyMedia(state) {
  const item = currentItem(state);
  const allow = allowPlay(state, item);
  if (!item) {
    stopMedia();
    return;
  }
  if (item.kind === "youtube") {
    applyYouTube(item, state, allow).catch(() => showMediaError("This screen could not load YouTube. Use an mp4, or check the connection."));
    return;
  }
  destroyYouTube();
  applyFile(item, state, allow);
}

function applyFile(item, state, allow) {
  if (ytKey || ytPlayer) {
    ytKey = "";
    destroyYouTube();
  }
  const src = item.kind === "url" ? item.src : `/media/${item.fileId}`;
  const key = `${item.id}:${src}:${item.captionFileId || ""}`;
  if (loadedKey !== key) {
    loadedKey = key;
    fileNonce = -1;
    clearMediaError();
    player.pause();
    player.src = src;
    for (const track of [...player.querySelectorAll("track")]) track.remove();
    if (item.captionFileId) {
      const track = document.createElement("track");
      track.kind = "subtitles";
      track.label = "Subtitles";
      track.srclang = "en";
      track.src = `/media/${item.captionFileId}`;
      track.default = true;
      player.appendChild(track);
    }
    player.load();
  }
  player.playbackRate = state.rate || 1;
  if (document.activeElement !== volume) player.volume = state.volume;
  if (state.seekNonce !== fileNonce) {
    fileNonce = state.seekNonce;
    const at = livePosition(state);
    const seek = () => { if (Math.abs(player.currentTime - at) > 0.35) player.currentTime = at; };
    if (player.readyState >= 1) seek();
    else player.addEventListener("loadedmetadata", seek, { once: true });
  }
  if (allow && state.status === "playing") player.play().catch(() => showSoundUnlock());
  else player.pause();
}

async function applyYouTube(item, state, allow) {
  const key = `${item.id}:${item.videoId}`;
  if (loadedKey) clearFile();
  if (ytKey === key) {
    syncYouTube(state, allow);
    return;
  }
  ytKey = key;
  ytNonce = -1;
  clearMediaError();
  destroyYouTube();
  try {
    await loadYouTube();
  } catch {
    if (ytKey === key) showMediaError("This screen could not load YouTube. Use an mp4, or check the connection.");
    return;
  }
  if (ytKey !== key || !window.YT?.Player) return;
  const mount = document.createElement("div");
  $("#yt").appendChild(mount);
  ytPlayer = new window.YT.Player(mount, {
    videoId: item.videoId,
    playerVars: { autoplay: 0, controls: 0, rel: 0, modestbranding: 1, playsinline: 1 },
    events: {
      onReady: () => syncYouTube(latest, allowPlay(latest, currentItem(latest))),
      onStateChange: (event) => {
        if (event.data === 0) command({ type: "ended" }).catch(() => {});
      },
      onError: () => showMediaError("YouTube would not play this video on this screen."),
    },
  });
}

function syncYouTube(state, allow) {
  if (!ytPlayer?.seekTo || !state) return;
  try {
    ytPlayer.setPlaybackRate?.(state.rate);
    ytPlayer.setVolume?.(Math.round((state.volume ?? 1) * 100));
    if (state.seekNonce !== ytNonce) {
      ytNonce = state.seekNonce;
      ytPlayer.seekTo(livePosition(state), true);
    }
    if (allow && state.status === "playing") ytPlayer.playVideo();
    else ytPlayer.pauseVideo();
  } catch {
    /* the player is still attaching */
  }
}

function loadYouTube() {
  if (window.YT?.Player) return Promise.resolve();
  if (!ytApi) {
    ytApi = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 8000);
      window.onYouTubeIframeAPIReady = () => {
        clearTimeout(timer);
        resolve();
      };
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.onerror = () => {
        clearTimeout(timer);
        reject(new Error("youtube"));
      };
      document.head.appendChild(script);
    });
  }
  return ytApi;
}

function destroyYouTube() {
  try { ytPlayer?.destroy(); } catch { /* already gone */ }
  ytPlayer = null;
  $("#yt").replaceChildren();
}

function clearFile() {
  if (!loadedKey) return;
  player.pause();
  player.removeAttribute("src");
  for (const track of [...player.querySelectorAll("track")]) track.remove();
  player.load();
  loadedKey = "";
}

function stopMedia() {
  clearFile();
  ytKey = "";
  destroyYouTube();
}

function allowPlay(state, item) {
  if (!state || !item) return false;
  if (state.mode === "mirror") return false;
  if (item.kind === "audio") return true;
  if (state.mode === "theater" && state.theaterUnlocked) return true;
  if (state.audioInDrive && state.mode !== "theater") return true;
  return false;
}

function syncMirror(state) {
  const image = $("#mirror");
  if (state.mode === "mirror") {
    if (!mirrorOn) {
      mirrorOn = true;
      image.src = "/screen.mjpeg";
    }
  } else if (mirrorOn) {
    mirrorOn = false;
    image.removeAttribute("src");
  }
}

async function pollMirror() {
  if (latest?.mode !== "mirror") return;
  try {
    const info = await fetch("/api/info").then((response) => response.json());
    $("#mirror-status").textContent = info.screenLive ? "Live from the phone" : "Waiting for a phone screen";
    $("#mirror-help").hidden = Boolean(info.screenLive);
  } catch {
    /* the next poll will try again */
  }
}

function syncFrame(state) {
  const key = `${state.mode}|${state.frameSeconds}|${state.photos.map((photo) => photo.fileId).join(",")}`;
  if (key === frameKey) return;
  frameKey = key;
  clearInterval(frameTimer);
  const empty = $("#frame-empty");
  if (state.photos.length === 0) {
    empty.hidden = false;
    $("#frame-a").classList.remove("is-on");
    $("#frame-b").classList.remove("is-on");
    return;
  }
  empty.hidden = true;
  const show = (index) => {
    const photo = state.photos[index % state.photos.length];
    if (!photo) return;
    frameOn = !frameOn;
    const image = $(frameOn ? "#frame-a" : "#frame-b");
    const other = $(frameOn ? "#frame-b" : "#frame-a");
    image.src = `/media/${photo.fileId}`;
    image.alt = photo.title || "Photo";
    image.classList.add("is-on");
    other.classList.remove("is-on");
    $("#frame-caption").textContent = photo.title || "";
  };
  frameIndex = 0;
  show(0);
  if (state.mode === "frame" && state.photos.length > 1) {
    frameTimer = setInterval(() => {
      if (!latest?.photos?.length) return;
      frameIndex = (frameIndex + 1) % latest.photos.length;
      show(frameIndex);
    }, Math.max(3, state.frameSeconds) * 1000);
  }
}

function syncScrub() {
  if (!latest || scrubbing) return;
  const item = currentItem(latest);
  const local = localPosition(item);
  const position = local ?? livePosition(latest);
  const duration = localDuration(item) || item?.duration || 0;
  if (document.activeElement !== scrub) {
    scrub.max = duration || 0;
    scrub.value = duration ? Math.min(position, duration) : position;
  }
  $("#now-time").textContent = duration
    ? `${formatTime(position)} / ${formatTime(duration)}`
    : formatTime(position);
  paintTrip(latest);
}

function reportPlayback() {
  if (!latest?.currentId) return;
  const item = currentItem(latest);
  if (!item) return;
  let position = null;
  let duration = null;
  if (item.kind === "youtube" && ytPlayer?.getCurrentTime) {
    try {
      position = ytPlayer.getCurrentTime();
      duration = ytPlayer.getDuration();
    } catch {
      return;
    }
  } else if (item.kind !== "youtube" && player.readyState >= 1 && loadedKey.startsWith(`${item.id}:`)) {
    position = player.currentTime;
    duration = Number.isFinite(player.duration) ? player.duration : null;
  }
  if (position == null) return;
  const drifted = Math.abs(position - livePosition(latest)) >= 1.25;
  const durationChanged = duration > 0 && Math.abs((item.duration || 0) - duration) > 0.5;
  if (!drifted && !durationChanged) return;
  command({
    type: "report",
    position,
    duration,
    seekNonce: latest.seekNonce,
    status: latest.status,
    itemId: latest.currentId,
  }).catch(() => {});
}

function localPosition(item) {
  if (!item) return null;
  if (item.kind === "youtube" && ytPlayer?.getCurrentTime) {
    try { return ytPlayer.getCurrentTime(); } catch { return null; }
  }
  if (player.readyState >= 1 && loadedKey.startsWith(`${item.id}:`)) return player.currentTime;
  return null;
}

function localDuration(item) {
  if (!item) return 0;
  if (item.kind === "youtube" && ytPlayer?.getDuration) {
    try { return ytPlayer.getDuration() || 0; } catch { return 0; }
  }
  return Number.isFinite(player.duration) ? player.duration : 0;
}

function paintClock() {
  const now = new Date();
  const hour = now.getHours();
  const shown = ((hour + 11) % 12) + 1;
  const hm = `${shown}:${String(now.getMinutes()).padStart(2, "0")}`;
  const sec = String(now.getSeconds()).padStart(2, "0");
  const period = hour >= 12 ? "PM" : "AM";
  const date = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  for (const node of document.querySelectorAll("[data-clock='hm']")) node.textContent = hm;
  for (const node of document.querySelectorAll("[data-clock='sec']")) node.textContent = sec;
  for (const node of document.querySelectorAll("[data-clock='period']")) node.textContent = period;
  for (const node of document.querySelectorAll("[data-clock='date']")) node.textContent = date;
  if (latest) paintTrip(latest);
}

function paintTrip(state) {
  const text = state.tripStartedAt ? formatTime((Date.now() - state.tripStartedAt) / 1000) : "0:00";
  $("#trip-elapsed").textContent = text;
  $("#trip-elapsed-2").textContent = text;
}

function showSoundUnlock() {
  if (latest?.status === "playing") $("#sound-unlock").hidden = false;
}

function showMediaError(message) {
  errorFor = latest?.currentId || "";
  const node = $("#media-error");
  node.textContent = message;
  node.hidden = false;
}

function clearMediaError() {
  errorFor = "";
  $("#media-error").hidden = true;
}

function currentItem(state) {
  return state?.queue?.find((item) => item.id === state.currentId) || null;
}

function fill(input, value) {
  if (document.activeElement === input || input.dataset.pending === "1") return;
  if (input.value !== value) input.value = value;
}

function bindText(input, type) {
  let timer = 0;
  input.addEventListener("input", () => {
    const value = input.value;
    input.dataset.pending = "1";
    clearTimeout(timer);
    timer = setTimeout(() => {
      command({ type, value }).catch(() => {}).finally(() => {
        if (input.value === value) delete input.dataset.pending;
      });
    }, 350);
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}
