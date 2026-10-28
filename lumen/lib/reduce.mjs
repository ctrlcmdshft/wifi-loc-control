export const RATES = [0.75, 1, 1.25, 1.5, 2];
export const MODES = ["drive", "mirror", "theater", "ambient", "frame", "trip"];
export const LOOPS = ["off", "all", "one"];

const MAX_QUEUE = 500;
const MAX_PLAYLISTS = 50;
const MAX_CHECKS = 100;
const MAX_PHOTOS = 100;
const MAX_NOTES = 5000;

export function initialState() {
  return {
    rev: 1,
    mode: "drive",
    theaterUnlocked: false,
    audioInDrive: false,
    dim: 1,
    queue: [],
    playlists: [],
    files: {},
    currentId: null,
    status: "paused",
    position: 0,
    positionAt: 0,
    seekNonce: 0,
    rate: 1,
    loop: "off",
    shuffle: false,
    volume: 0.85,
    destination: "",
    notes: "",
    checklist: [],
    photos: [],
    frameSeconds: 8,
    promptIndex: 0,
    tripStartedAt: null,
  };
}

export function livePosition(state, now = Date.now()) {
  const base = Number(state.position) || 0;
  if (state.status !== "playing") return Math.max(0, base);
  const rate = Number(state.rate) || 1;
  const elapsed = ((now - (state.positionAt || now)) / 1000) * rate;
  return Math.max(0, base + elapsed);
}

export function publicState(state) {
  const { files: _files, ...rest } = state;
  return rest;
}

export function normalize(raw) {
  const base = initialState();
  if (!raw || typeof raw !== "object") return base;
  const next = {
    ...base,
    mode: MODES.includes(raw.mode) ? raw.mode : base.mode,
    theaterUnlocked: Boolean(raw.theaterUnlocked),
    audioInDrive: Boolean(raw.audioInDrive),
    dim: clamp(raw.dim, 0.55, 1, 1),
    queue: Array.isArray(raw.queue) ? raw.queue.map(cleanItem).filter(Boolean).slice(0, MAX_QUEUE) : [],
    playlists: Array.isArray(raw.playlists) ? raw.playlists.map(cleanPlaylist).filter(Boolean).slice(0, MAX_PLAYLISTS) : [],
    files: cleanFiles(raw.files),
    currentId: raw.currentId ? String(raw.currentId) : null,
    status: raw.status === "playing" ? "playing" : "paused",
    position: Math.max(0, Number(raw.position) || 0),
    positionAt: Number(raw.positionAt) || 0,
    seekNonce: Number(raw.seekNonce) || 0,
    rate: RATES.includes(Number(raw.rate)) ? Number(raw.rate) : 1,
    loop: LOOPS.includes(raw.loop) ? raw.loop : "off",
    shuffle: Boolean(raw.shuffle),
    volume: clamp(raw.volume, 0, 1, 0.85),
    destination: clip(raw.destination, 200),
    notes: clipBlock(raw.notes, MAX_NOTES),
    checklist: Array.isArray(raw.checklist) ? raw.checklist.map(cleanCheck).filter(Boolean).slice(0, MAX_CHECKS) : [],
    photos: Array.isArray(raw.photos) ? raw.photos.map(cleanPhoto).filter(Boolean).slice(0, MAX_PHOTOS) : [],
    frameSeconds: clamp(raw.frameSeconds, 3, 120, 8),
    promptIndex: Math.max(0, Number(raw.promptIndex) || 0),
    tripStartedAt: Number(raw.tripStartedAt) || null,
    rev: Number(raw.rev) || 1,
  };
  if (!next.queue.some((item) => item.id === next.currentId)) next.currentId = next.queue[0]?.id ?? null;
  return next;
}

export function reduce(state, action, ctx = {}) {
  if (!action || typeof action.type !== "string") return state;
  const now = ctx.now ?? Date.now();
  const rng = ctx.rng ?? Math.random;
  const next = structuredClone(state);
  let changed = false;
  const touch = () => {
    changed = true;
  };

  switch (action.type) {
    case "setMode": {
      if (!MODES.includes(action.mode) || action.mode === next.mode) return state;
      next.mode = action.mode;
      if (action.mode === "theater" && !next.theaterUnlocked) {
        const current = currentItem(next);
        if (current && current.kind !== "audio" && next.status === "playing") freeze(next, now);
      } else if (action.mode !== "theater") {
        pausePicture(next, now);
      }
      touch();
      break;
    }
    case "unlockTheater": {
      next.theaterUnlocked = true;
      next.mode = "theater";
      if (next.currentId) resume(next, now);
      touch();
      break;
    }
    case "lockTheater": {
      next.theaterUnlocked = false;
      next.mode = "drive";
      pausePicture(next, now);
      touch();
      break;
    }
    case "setAudioInDrive": {
      const value = Boolean(action.value);
      if (value === next.audioInDrive) return state;
      next.audioInDrive = value;
      if (!next.audioInDrive && next.mode !== "theater") pausePicture(next, now);
      touch();
      break;
    }
    case "setDim": {
      const dim = clamp(action.value, 0.55, 1, next.dim);
      if (dim === next.dim) return state;
      next.dim = dim;
      touch();
      break;
    }
    case "addItem": {
      const item = cleanItem(action.item);
      if (!item || next.queue.length >= MAX_QUEUE) return state;
      next.queue.push(item);
      if (!next.currentId) next.currentId = item.id;
      touch();
      break;
    }
    case "removeItem": {
      const index = next.queue.findIndex((item) => item.id === action.id);
      if (index < 0) return state;
      const removingCurrent = next.queue[index].id === next.currentId;
      next.queue.splice(index, 1);
      if (removingCurrent) {
        const replacement = next.queue[index] || next.queue[index - 1] || null;
        if (replacement) startItem(next, replacement.id, now);
        else stop(next, now);
      }
      touch();
      break;
    }
    case "moveItem": {
      const index = next.queue.findIndex((item) => item.id === action.id);
      const dir = action.dir < 0 ? -1 : 1;
      const target = index + dir;
      if (index < 0 || target < 0 || target >= next.queue.length) return state;
      const [item] = next.queue.splice(index, 1);
      next.queue.splice(target, 0, item);
      touch();
      break;
    }
    case "renameItem": {
      const item = next.queue.find((entry) => entry.id === action.id);
      const title = clip(action.title, 200);
      if (!item || !title || item.title === title) return state;
      item.title = title;
      touch();
      break;
    }
    case "setCaption": {
      const item = next.queue.find((entry) => entry.id === action.itemId);
      if (!item || !action.fileId) return state;
      item.captionFileId = String(action.fileId);
      touch();
      break;
    }
    case "clearQueue": {
      if (next.queue.length === 0 && !next.currentId) return state;
      next.queue = [];
      stop(next, now);
      touch();
      break;
    }
    case "playIndex": {
      const item = next.queue.find((entry) => entry.id === action.id);
      if (!item) return state;
      if (item.id === next.currentId && next.status === "playing" && pictureAllowed(next)) return state;
      if (item.id !== next.currentId) startItem(next, item.id, now);
      if (next.status !== "playing") {
        if (!pictureAllowed(next)) next.mode = "theater";
        if (pictureAllowed(next)) resume(next, now);
      }
      touch();
      break;
    }
    case "togglePlay": {
      if (!next.currentId && next.queue[0]) next.currentId = next.queue[0].id;
      if (!next.currentId) return state;
      if (next.status === "playing") {
        freeze(next, now);
        touch();
        break;
      }
      if (!pictureAllowed(next)) {
        next.mode = "theater";
        if (!pictureAllowed(next)) {
          touch();
          break;
        }
      }
      resume(next, now);
      touch();
      break;
    }
    case "seek": {
      if (!next.currentId) return state;
      next.position = Math.max(0, Number(action.seconds) || 0);
      next.positionAt = now;
      next.seekNonce += 1;
      touch();
      break;
    }
    case "next":
    case "prev": {
      if (next.queue.length === 0) return state;
      go(next, action.type === "next" ? 1 : -1, rng, false, now);
      touch();
      break;
    }
    case "ended": {
      if (next.queue.length === 0) return state;
      go(next, 1, rng, true, now);
      touch();
      break;
    }
    case "setRate": {
      const rate = Number(action.rate);
      if (!RATES.includes(rate) || rate === next.rate) return state;
      snapshot(next, now);
      next.rate = rate;
      touch();
      break;
    }
    case "setLoop": {
      const loop = LOOPS.includes(action.loop) ? action.loop : cycle(LOOPS, next.loop);
      if (loop === next.loop) return state;
      next.loop = loop;
      touch();
      break;
    }
    case "setShuffle": {
      const value = Boolean(action.value);
      if (value === next.shuffle) return state;
      next.shuffle = value;
      touch();
      break;
    }
    case "setVolume": {
      const volume = clamp(action.value, 0, 1, next.volume);
      if (volume === next.volume) return state;
      next.volume = volume;
      touch();
      break;
    }
    case "report": {
      if (action.seekNonce !== next.seekNonce) return state;
      if (action.status !== next.status) return state;
      if (action.itemId !== next.currentId) return state;
      const item = currentItem(next);
      const duration = Number(action.duration);
      if (item && duration > 0 && Math.abs((item.duration || 0) - duration) > 0.5) {
        item.duration = duration;
        touch();
      }
      const reported = Math.max(0, Number(action.position) || 0);
      if (Math.abs(livePosition(next, now) - reported) >= 1) {
        next.position = reported;
        next.positionAt = now;
        touch();
      }
      break;
    }
    case "savePlaylist": {
      const name = clip(action.name, 80);
      if (!name || next.queue.length === 0 || !action.id || next.playlists.length >= MAX_PLAYLISTS) return state;
      next.playlists.push({
        id: String(action.id),
        name,
        items: next.queue.map((item) => cleanItem(item)).filter(Boolean),
      });
      touch();
      break;
    }
    case "deletePlaylist": {
      const before = next.playlists.length;
      next.playlists = next.playlists.filter((playlist) => playlist.id !== action.id);
      if (next.playlists.length === before) return state;
      touch();
      break;
    }
    case "loadPlaylist": {
      const playlist = next.playlists.find((entry) => entry.id === action.id);
      const ids = Array.isArray(action.ids) ? action.ids.map(String) : [];
      if (!playlist || ids.length !== playlist.items.length) return state;
      const copies = playlist.items.map((item, index) => cleanItem({ ...item, id: ids[index] })).filter(Boolean);
      if (action.mode === "append") {
        next.queue = next.queue.concat(copies).slice(0, MAX_QUEUE);
        if (!next.currentId && next.queue[0]) next.currentId = next.queue[0].id;
      } else {
        next.queue = copies.slice(0, MAX_QUEUE);
        if (next.queue[0]) startItem(next, next.queue[0].id, now);
        else stop(next, now);
      }
      touch();
      break;
    }
    case "setDestination": {
      const destination = clip(action.value, 200);
      if (destination === next.destination) return state;
      next.destination = destination;
      touch();
      break;
    }
    case "setNotes": {
      const notes = clipBlock(action.value, MAX_NOTES);
      if (notes === next.notes) return state;
      next.notes = notes;
      touch();
      break;
    }
    case "addCheck": {
      const text = clip(action.text, 200);
      if (!text || !action.id || next.checklist.length >= MAX_CHECKS) return state;
      next.checklist.push({ id: String(action.id), text, done: false });
      touch();
      break;
    }
    case "toggleCheck": {
      const item = next.checklist.find((entry) => entry.id === action.id);
      if (!item) return state;
      item.done = !item.done;
      touch();
      break;
    }
    case "removeCheck": {
      const before = next.checklist.length;
      next.checklist = next.checklist.filter((entry) => entry.id !== action.id);
      if (next.checklist.length === before) return state;
      touch();
      break;
    }
    case "addPhoto": {
      const photo = cleanPhoto(action.photo);
      if (!photo || next.photos.length >= MAX_PHOTOS) return state;
      next.photos.push(photo);
      touch();
      break;
    }
    case "removePhoto": {
      const before = next.photos.length;
      next.photos = next.photos.filter((photo) => photo.id !== action.id);
      if (next.photos.length === before) return state;
      touch();
      break;
    }
    case "setFrameSeconds": {
      const frameSeconds = clamp(action.value, 3, 120, next.frameSeconds);
      if (frameSeconds === next.frameSeconds) return state;
      next.frameSeconds = frameSeconds;
      touch();
      break;
    }
    case "nextPrompt": {
      const count = Math.max(1, Number(action.count) || 1);
      next.promptIndex = (Number(next.promptIndex) + 1) % count;
      touch();
      break;
    }
    case "tripStart": {
      if (next.tripStartedAt) return state;
      next.tripStartedAt = now;
      touch();
      break;
    }
    case "tripReset": {
      if (!next.tripStartedAt) return state;
      next.tripStartedAt = null;
      touch();
      break;
    }
    case "importData": {
      if (Array.isArray(action.playlists)) {
        next.playlists = action.playlists.map(cleanPlaylist).filter(Boolean).slice(0, MAX_PLAYLISTS);
      }
      if (typeof action.destination === "string") next.destination = clip(action.destination, 200);
      if (typeof action.notes === "string") next.notes = clipBlock(action.notes, MAX_NOTES);
      if (Array.isArray(action.checklist)) {
        next.checklist = action.checklist.map(cleanCheck).filter(Boolean).slice(0, MAX_CHECKS);
      }
      touch();
      break;
    }
    default:
      return state;
  }

  if (!changed) return state;
  next.rev = (Number(state.rev) || 0) + 1;
  return next;
}

function currentItem(state) {
  return state.queue.find((item) => item.id === state.currentId) || null;
}

function pictureAllowed(state) {
  const current = currentItem(state);
  if (!current || current.kind === "audio") return true;
  if (state.mode === "theater" && state.theaterUnlocked) return true;
  if (state.audioInDrive && state.mode !== "theater") return true;
  return false;
}

function pausePicture(state, now) {
  const current = currentItem(state);
  if (!current || current.kind === "audio" || state.audioInDrive) return;
  if (state.status === "playing") freeze(state, now);
}

function freeze(state, now) {
  state.position = livePosition(state, now);
  state.positionAt = now;
  state.status = "paused";
}

function resume(state, now) {
  if (state.status === "playing") return;
  state.positionAt = now;
  state.status = "playing";
}

function snapshot(state, now) {
  state.position = livePosition(state, now);
  state.positionAt = now;
}

function stop(state, now) {
  state.currentId = null;
  state.status = "paused";
  state.position = 0;
  state.positionAt = now;
  state.seekNonce += 1;
}

function startItem(state, id, now) {
  state.currentId = id;
  state.position = 0;
  state.positionAt = now;
  state.seekNonce += 1;
  state.status = pictureAllowed(state) ? "playing" : "paused";
}

function go(state, dir, rng, fromEnded, now) {
  const id = step(state, dir, rng, fromEnded);
  if (id == null) {
    freeze(state, now);
    return;
  }
  startItem(state, id, now);
}

function step(state, dir, rng, fromEnded) {
  const queue = state.queue;
  if (queue.length === 0) return null;
  const index = queue.findIndex((item) => item.id === state.currentId);
  if (fromEnded && state.loop === "one" && index >= 0) return queue[index].id;
  if (state.shuffle && queue.length > 1) {
    let pick = Math.floor(rng() * (queue.length - 1));
    if (index >= 0 && pick >= index) pick += 1;
    return queue[pick].id;
  }
  if (index < 0) return queue[0].id;
  const target = index + dir;
  if (target >= 0 && target < queue.length) return queue[target].id;
  if (dir > 0 && state.loop === "all") return queue[0].id;
  if (dir < 0) return queue[0].id;
  return null;
}

function cycle(list, value) {
  const index = list.indexOf(value);
  return list[(index + 1) % list.length];
}

function cleanItem(item) {
  if (!item || !item.id) return null;
  const kind = ["file", "url", "youtube", "audio"].includes(item.kind) ? item.kind : null;
  if (!kind) return null;
  if (kind === "youtube" && !/^[\w-]{6,20}$/.test(String(item.videoId || ""))) return null;
  if (kind === "url" && !/^https?:\/\//.test(String(item.src || ""))) return null;
  if ((kind === "file" || kind === "audio") && !item.fileId) return null;
  return {
    id: String(item.id),
    kind,
    title: clip(item.title || "Untitled", 200) || "Untitled",
    src: kind === "url" ? String(item.src) : "",
    videoId: kind === "youtube" ? String(item.videoId) : "",
    fileId: item.fileId ? String(item.fileId) : "",
    captionFileId: item.captionFileId ? String(item.captionFileId) : "",
    duration: positive(item.duration),
  };
}

function cleanPlaylist(playlist) {
  if (!playlist || !playlist.id) return null;
  const name = clip(playlist.name, 80);
  if (!name) return null;
  return {
    id: String(playlist.id),
    name,
    items: Array.isArray(playlist.items) ? playlist.items.map(cleanItem).filter(Boolean) : [],
  };
}

function cleanCheck(entry) {
  if (!entry || !entry.id) return null;
  const text = clip(entry.text, 200);
  if (!text) return null;
  return { id: String(entry.id), text, done: Boolean(entry.done) };
}

function cleanPhoto(photo) {
  if (!photo || !photo.id || !photo.fileId) return null;
  return {
    id: String(photo.id),
    fileId: String(photo.fileId),
    title: clip(photo.title || "Photo", 200) || "Photo",
  };
}

function cleanFiles(files) {
  const next = {};
  if (!files || typeof files !== "object") return next;
  for (const [id, meta] of Object.entries(files)) {
    if (!/^[\w-]+$/.test(id) || !meta || typeof meta !== "object") continue;
    if (!/^\.[a-z0-9]+$/.test(String(meta.ext || ""))) continue;
    next[id] = {
      ext: String(meta.ext),
      mime: String(meta.mime || "application/octet-stream"),
      name: clip(meta.name, 200),
    };
  }
  return next;
}

function clip(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function clipBlock(value, max) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
