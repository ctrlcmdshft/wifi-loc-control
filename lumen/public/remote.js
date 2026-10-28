import { command, connect, uploadFile } from "./client.js";
import { formatTime, livePosition } from "./format.js";
import { PROMPTS, ROAD_KIT } from "./prompts.js";

const RATES = [0.75, 1, 1.25, 1.5, 2];
const LOOP_LABEL = { off: "Loop off", all: "Loop all", one: "Loop one" };
const QUALITY = {
  light: { width: 960, fps: 6, quality: 0.55 },
  balanced: { width: 1280, fps: 10, quality: 0.62 },
  smooth: { width: 1280, fps: 15, quality: 0.7 },
};

const $ = (selector) => document.querySelector(selector);
const scrub = $("#scrub");
const volume = $("#volume");
let latest = null;
let rev = 0;
let scrubbing = false;
let sharing = null;

$("#play").addEventListener("click", () => command({ type: "togglePlay" }).catch(showError));
$("#prev").addEventListener("click", () => command({ type: "prev" }));
$("#next").addEventListener("click", () => command({ type: "next" }));
$("#back").addEventListener("click", () => command({ type: "seek", seconds: Math.max(0, livePosition(latest || {}) - 10) }));
$("#forward").addEventListener("click", () => command({ type: "seek", seconds: livePosition(latest || {}) + 10 }));
$("#loop").addEventListener("click", () => command({ type: "setLoop" }));
$("#shuffle").addEventListener("click", () => command({ type: "setShuffle", value: !latest?.shuffle }));
$("#rate").addEventListener("click", () => {
  const index = RATES.indexOf(Number(latest?.rate) || 1);
  command({ type: "setRate", rate: RATES[(index + 1) % RATES.length] });
});
volume.addEventListener("change", () => command({ type: "setVolume", value: Number(volume.value) }));
scrub.addEventListener("pointerdown", () => { scrubbing = true; });
scrub.addEventListener("change", () => {
  scrubbing = false;
  command({ type: "seek", seconds: Number(scrub.value) });
});
document.querySelectorAll("#modes button").forEach((button) => {
  button.addEventListener("click", () => command({ type: "setMode", mode: button.dataset.mode }));
});
$("#audio-drive").addEventListener("change", () => command({ type: "setAudioInDrive", value: $("#audio-drive").checked }));
$("#relock").addEventListener("click", () => command({ type: "lockTheater" }));
$("#add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#link");
  const error = $("#add-error");
  error.hidden = true;
  try {
    const result = await command({ type: "addLink", url: input.value });
    input.value = "";
    if (result.errors?.length) {
      error.textContent = result.errors.join(" ");
      error.hidden = false;
    }
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});
$("#file").addEventListener("change", () => uploadList($("#file").files, $("#file")));
$("#photos").addEventListener("change", () => uploadList($("#photos").files, $("#photos")));
$("#clear").addEventListener("click", () => {
  if (confirm("Clear the queue?")) command({ type: "clearQueue" });
});
$("#save-pl").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#pl-name");
  try {
    await command({ type: "savePlaylist", name: input.value });
    input.value = "";
  } catch (err) {
    showError(err);
  }
});
$("#queue").addEventListener("click", onQueueClick);
$("#queue").addEventListener("change", (event) => {
  const input = event.target.closest("[data-rename]");
  if (input) command({ type: "renameItem", id: input.dataset.rename, title: input.value });
});
$("#playlists").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.load) command({ type: "loadPlaylist", id: button.dataset.load, mode: "replace" });
  if (button.dataset.append) command({ type: "loadPlaylist", id: button.dataset.append, mode: "append" });
  if (button.dataset.delete && confirm("Delete this playlist?")) command({ type: "deletePlaylist", id: button.dataset.delete });
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
  if (!input.value.trim()) return;
  command({ type: "addCheck", text: input.value }).then(() => { input.value = ""; }).catch(showError);
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
$("#frame-seconds").addEventListener("change", () => command({ type: "setFrameSeconds", value: Number($("#frame-seconds").value) }));
$("#photo-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-photo]");
  if (button) command({ type: "removePhoto", id: button.dataset.photo });
});
$("#import").addEventListener("change", async () => {
  const file = $("#import").files?.[0];
  $("#import").value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    await command({
      type: "importData",
      playlists: data.playlists,
      destination: data.destination,
      notes: data.notes,
      checklist: data.checklist,
    });
  } catch (err) {
    showError(err);
  }
});
$("#share-start").addEventListener("click", () => startShare().catch((error) => {
  if (error?.name === "NotAllowedError") return;
  showError(error);
}));
$("#share-stop").addEventListener("click", () => sharing?.stop());
bindText($("#destination"), "setDestination");
bindText($("#notes"), "setNotes");

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

prepareShare();
setInterval(syncScrub, 250);

function render(state) {
  const item = state.queue.find((entry) => entry.id === state.currentId) || null;
  $("#now-kicker").textContent = state.status === "playing" ? "Playing" : item ? "Paused" : "Queue";
  $("#now-title").textContent = item?.title || "Nothing queued";
  $("#play").classList.toggle("is-playing", state.status === "playing");
  $("#play").setAttribute("aria-label", state.status === "playing" ? "Pause" : "Play");
  $("#loop").textContent = LOOP_LABEL[state.loop] || "Loop off";
  $("#shuffle").setAttribute("aria-pressed", String(Boolean(state.shuffle)));
  $("#rate").textContent = `${state.rate}×`;
  if (document.activeElement !== volume) volume.value = state.volume;
  $("#audio-drive").checked = Boolean(state.audioInDrive);
  $("#gate-hint").hidden = !(state.mode === "theater" && !state.theaterUnlocked && item && item.kind !== "audio");
  for (const button of document.querySelectorAll("#modes button")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === state.mode));
  }
  fill($("#destination"), state.destination);
  fill($("#notes"), state.notes);
  if (document.activeElement !== $("#frame-seconds")) $("#frame-seconds").value = state.frameSeconds;
  $("#trip-start").disabled = Boolean(state.tripStartedAt);
  $("#trip-elapsed").textContent = state.tripStartedAt ? formatTime((Date.now() - state.tripStartedAt) / 1000) : "0:00";
  $("#prompt-text").textContent = PROMPTS[(state.promptIndex || 0) % PROMPTS.length];
  $("#clear").hidden = state.queue.length === 0;
  renderQueue(state);
  renderPlaylists(state);
  renderChecks(state);
  renderPhotos(state);
  syncScrub();
}

function renderQueue(state) {
  const list = $("#queue");
  if (list.contains(document.activeElement)) return;
  const sig = state.queue.map((item) => `${item.id}:${item.title}:${item.id === state.currentId}`).join("|");
  if (list.dataset.sig === sig) return;
  list.dataset.sig = sig;
  list.innerHTML = state.queue.map((item) => `
    <li>
      <button type="button" data-play="${item.id}" ${item.id === state.currentId ? "aria-current=\"true\"" : ""}>${escapeHtml(item.title)}</button>
      <input data-rename="${item.id}" value="${escapeHtml(item.title)}" aria-label="Rename ${escapeHtml(item.title)}" />
      <button type="button" class="icon" data-up="${item.id}" aria-label="Move up">↑</button>
      <button type="button" class="icon" data-down="${item.id}" aria-label="Move down">↓</button>
      <button type="button" class="icon" data-remove="${item.id}" aria-label="Remove">×</button>
    </li>
  `).join("") || `<li class="hint">Add a link or a file.</li>`;
}

function renderPlaylists(state) {
  const list = $("#playlists");
  const sig = state.playlists.map((playlist) => `${playlist.id}:${playlist.name}:${playlist.items.length}`).join("|");
  if (list.dataset.sig === sig) return;
  list.dataset.sig = sig;
  list.innerHTML = state.playlists.map((playlist) => `
    <li>
      <span>${escapeHtml(playlist.name)} · ${playlist.items.length}</span>
      <button type="button" data-load="${playlist.id}">Play</button>
      <button type="button" data-append="${playlist.id}">Add</button>
      <button type="button" class="icon" data-delete="${playlist.id}" aria-label="Delete ${escapeHtml(playlist.name)}">×</button>
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
      <button type="button" data-check="${item.id}" aria-pressed="${item.done}"><span class="box"></span><span>${escapeHtml(item.text)}</span></button>
      <button type="button" class="icon" data-drop="${item.id}" aria-label="Remove">×</button>
    </li>
  `).join("");
}

function renderPhotos(state) {
  const list = $("#photo-list");
  const sig = state.photos.map((photo) => photo.id).join("|");
  if (list.dataset.sig === sig) return;
  list.dataset.sig = sig;
  list.innerHTML = state.photos.map((photo) => `
    <li>
      <img src="/media/${photo.fileId}" alt="" width="56" height="56" />
      <span>${escapeHtml(photo.title)}</span>
      <button type="button" class="icon" data-photo="${photo.id}" aria-label="Remove photo">×</button>
    </li>
  `).join("");
}

function onQueueClick(event) {
  const play = event.target.closest("[data-play]");
  const up = event.target.closest("[data-up]");
  const down = event.target.closest("[data-down]");
  const remove = event.target.closest("[data-remove]");
  if (play) command({ type: "playIndex", id: play.dataset.play });
  if (up) command({ type: "moveItem", id: up.dataset.up, dir: -1 });
  if (down) command({ type: "moveItem", id: down.dataset.down, dir: 1 });
  if (remove) command({ type: "removeItem", id: remove.dataset.remove });
}

function syncScrub() {
  if (!latest || scrubbing) return;
  const item = latest.queue.find((entry) => entry.id === latest.currentId);
  const position = livePosition(latest);
  const duration = item?.duration || 0;
  if (document.activeElement !== scrub) {
    scrub.max = duration || 0;
    scrub.value = duration ? Math.min(position, duration) : 0;
  }
  $("#time-now").textContent = formatTime(position);
  $("#time-end").textContent = duration ? formatTime(duration) : "–:–";
  $("#trip-elapsed").textContent = latest.tripStartedAt ? formatTime((Date.now() - latest.tripStartedAt) / 1000) : "0:00";
}

async function uploadList(files, input) {
  const status = $("#upload-status");
  status.hidden = false;
  try {
    for (const file of files) {
      status.textContent = `Uploading ${file.name}`;
      await uploadFile(file);
    }
    status.textContent = "Added.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    input.value = "";
  }
}

async function prepareShare() {
  const help = $("#share-help");
  const link = $("#https-link");
  let httpsPort = null;
  try {
    const info = await fetch("/api/state").then((response) => response.json());
    httpsPort = info.httpsPort;
  } catch {
    httpsPort = null;
  }
  const secureUrl = httpsPort ? `https://${location.hostname}:${httpsPort}/remote` : "";
  const canCapture = Boolean(navigator.mediaDevices?.getDisplayMedia) && window.isSecureContext;
  if (canCapture) {
    help.textContent = "The car shows this phone’s screen. Pair Bluetooth if you want the phone’s audio. Android Chrome and desktop Chrome can share; an iPhone cannot.";
    return;
  }
  $("#share-start").hidden = true;
  $("#share-quality").closest("label").hidden = true;
  if (!window.isSecureContext && secureUrl) {
    link.hidden = false;
    link.href = secureUrl;
    help.textContent = "Screen share needs the secure remote. Accept the certificate warning once. The queue works from this page either way.";
    return;
  }
  help.textContent = "This browser cannot share its screen. The queue still works.";
}

async function startShare() {
  const preset = QUALITY[$("#share-quality").value] || QUALITY.balanced;
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: preset.fps, width: { ideal: preset.width } },
    audio: false,
  });
  const video = $("#share-preview");
  video.srcObject = stream;
  video.hidden = false;
  await video.play();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || !video.videoWidth) return;
    busy = true;
    try {
      const scale = Math.min(1, preset.width / video.videoWidth);
      canvas.width = Math.max(2, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(2, Math.round(video.videoHeight * scale));
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", preset.quality));
      if (blob) await fetch("/api/screen-frame", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob });
    } finally {
      busy = false;
    }
  }, 1000 / preset.fps);
  const stop = () => {
    clearInterval(timer);
    stream.getTracks().forEach((track) => track.stop());
    video.hidden = true;
    video.srcObject = null;
    fetch("/api/screen-stop", { method: "POST" }).catch(() => {});
    sharing = null;
    $("#share-start").hidden = false;
    $("#share-stop").hidden = true;
  };
  stream.getVideoTracks()[0]?.addEventListener("ended", stop);
  sharing = { stop };
  $("#share-start").hidden = true;
  $("#share-stop").hidden = false;
  await command({ type: "setMode", mode: "mirror" });
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

function fill(input, value) {
  if (document.activeElement === input || input.dataset.pending === "1") return;
  if (input.value !== value) input.value = value;
}

function showError(error) {
  const node = $("#add-error");
  node.textContent = error.message || "Something went wrong.";
  node.hidden = false;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}
