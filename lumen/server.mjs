import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import QRCode from "qrcode";
import { classifyLink, splitLinks } from "./lib/links.mjs";
import { initialState, normalize, publicState, reduce } from "./lib/reduce.mjs";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(rootDir, "public");
const defaultDataDir = path.join(rootDir, "data");

const MIME = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".vtt": "text/vtt",
};

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

const FILE_GC = new Set([
  "removeItem",
  "clearQueue",
  "deletePlaylist",
  "loadPlaylist",
  "removePhoto",
  "setCaption",
  "importData",
]);

const PAGES = {
  "/": "index.html",
  "/remote": "remote.html",
};

export async function start(options = {}) {
  const dataDir = options.dataDir ?? defaultDataDir;
  const mediaDir = path.join(dataDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });

  let state = loadState(dataDir);
  pruneMissing(state, mediaDir);

  const clients = new Set();
  const screen = { buf: null, at: 0, viewers: new Set() };
  let httpsPort = null;

  const apply = (next, { gc = false } = {}) => {
    if (next === state) return false;
    state = next;
    if (gc) collectFiles(state, mediaDir);
    saveState(dataDir, state);
    broadcast();
    return true;
  };

  const broadcast = () => {
    const payload = `data: ${JSON.stringify(publicState(state))}\n\n`;
    for (const client of clients) {
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  };

  async function handle(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    try {
      if (req.method === "GET" && (url.pathname === "/api/state" || url.pathname === "/api/info")) {
        return send(res, 200, {
          ...publicState(state),
          httpsPort,
          screenLive: Boolean(screen.buf) && Date.now() - screen.at < 1500,
        });
      }
      if (req.method === "GET" && url.pathname === "/api/events") return serveEvents(req, res);
      if (req.method === "GET" && url.pathname === "/api/export") {
        return send(res, 200, {
          playlists: state.playlists,
          destination: state.destination,
          notes: state.notes,
          checklist: state.checklist,
        });
      }
      if (req.method === "GET" && url.pathname === "/api/qr.svg") return serveQr(req, res, url);
      if (req.method === "GET" && url.pathname === "/screen.mjpeg") return serveMjpeg(req, res);
      if (req.method === "GET" && url.pathname === "/api/screen.jpg") return serveScreenStill(res);
      if (req.method === "POST" && url.pathname === "/api/screen-frame") return serveScreenFrame(req, res);
      if (req.method === "POST" && url.pathname === "/api/screen-stop") {
        screen.buf = null;
        screen.at = 0;
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/command") return serveCommand(req, res);
      if (req.method === "POST" && url.pathname === "/api/upload") return serveUpload(req, res);
      if (req.method === "GET" && url.pathname.startsWith("/media/")) return serveMedia(req, res, url.pathname);
      if (req.method === "GET") return serveStatic(req, res, url.pathname);
      return send(res, 405, { error: "Method not allowed." });
    } catch (error) {
      if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : "Something went wrong." });
    }

    function serveEvents(req, res) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(publicState(state))}\n\n`);
      clients.add(res);
      const ping = setInterval(() => {
        if (!res.destroyed) res.write(": ping\n\n");
      }, 20000);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
    }

    async function serveCommand(req, res) {
      const body = await readJson(req);
      const type = body?.type;
      if (type === "addLink") return addLinks(res, body.url);
      if (type === "savePlaylist") {
        if (!String(body.name || "").trim()) return send(res, 400, { error: "Name the playlist." });
        if (state.queue.length === 0) return send(res, 400, { error: "The queue is empty." });
        const changed = apply(reduce(state, { type, name: body.name, id: nid("p") }));
        if (!changed) return send(res, 400, { error: "Could not save that playlist." });
        return send(res, 200, { ok: true, state: publicState(state) });
      }
      if (type === "loadPlaylist") {
        const playlist = state.playlists.find((entry) => entry.id === body.id);
        if (!playlist) return send(res, 404, { error: "That playlist is gone." });
        apply(reduce(state, {
          type,
          id: body.id,
          mode: body.mode === "append" ? "append" : "replace",
          ids: playlist.items.map(() => nid("q")),
        }), { gc: true });
        return send(res, 200, { ok: true, state: publicState(state) });
      }
      if (type === "addCheck") {
        const changed = apply(reduce(state, { type, text: body.text, id: nid("c") }));
        if (!changed) return send(res, 400, { error: "Could not add that item." });
        return send(res, 200, { ok: true, state: publicState(state) });
      }
      if (type === "importData") {
        apply(reduce(state, {
          type,
          playlists: body.playlists,
          destination: body.destination,
          notes: body.notes,
          checklist: body.checklist,
        }), { gc: true });
        return send(res, 200, { ok: true, state: publicState(state) });
      }
      if (![
        "setMode", "unlockTheater", "lockTheater", "setAudioInDrive", "setDim",
        "removeItem", "moveItem", "renameItem", "clearQueue", "togglePlay", "playIndex", "seek",
        "next", "prev", "ended", "setRate", "setLoop", "setShuffle", "setVolume",
        "report", "deletePlaylist", "setDestination", "setNotes", "toggleCheck",
        "removeCheck", "removePhoto", "setFrameSeconds", "nextPrompt", "tripStart",
        "tripReset",
      ].includes(type)) {
        return send(res, 400, { error: "Unknown command." });
      }
      apply(reduce(state, body), { gc: FILE_GC.has(type) });
      return send(res, 200, { ok: true, state: publicState(state) });
    }

    function addLinks(res, raw) {
      const parts = splitLinks(raw);
      if (parts.length === 0) return send(res, 400, { error: "Enter a link." });
      const errors = [];
      const added = [];
      for (const part of parts) {
        const parsed = classifyLink(part);
        if (parsed.error) {
          errors.push(parsed.error);
          continue;
        }
        const item = { id: nid("q"), ...parsed };
        const next = reduce(state, { type: "addItem", item });
        if (next === state) {
          errors.push("Could not add that link.");
          continue;
        }
        state = next;
        added.push(item);
      }
      if (added.length === 0) return send(res, 400, { error: errors[0] || "Could not add that link." });
      saveState(dataDir, state);
      broadcast();
      for (const item of added) {
        if (item.kind === "youtube") rememberTitle(item.id, item.videoId);
      }
      return send(res, 200, { ok: true, added: added.length, errors, state: publicState(state) });
    }

    function rememberTitle(itemId, videoId) {
      youtubeTitle(videoId).then((title) => {
        if (!title) return;
        apply(reduce(state, { type: "renameItem", id: itemId, title }));
      }).catch(() => {});
    }

    async function serveUpload(req, res) {
      const filename = safeName(req.headers["x-filename"]);
      const ext = path.extname(filename).toLowerCase();
      const mime = MIME[ext];
      if (!mime) {
        drain(req);
        return send(res, 415, { error: "Use an mp4, webm, audio file, photo, or vtt subtitles." });
      }
      const limit = mime.startsWith("image/") || ext === ".vtt" ? 30 * 1024 * 1024 : 4 * 1024 * 1024 * 1024;
      const declared = Number(req.headers["content-length"] || 0);
      if (declared > limit) {
        drain(req);
        return send(res, 413, { error: "That file is too large." });
      }
      const id = nid("m");
      const dest = path.join(mediaDir, `${id}${ext}`);
      try {
        await writeBody(req, dest, limit);
      } catch (error) {
        fs.rmSync(dest, { force: true });
        return send(res, error.status || 500, { error: error.status ? error.message : "Upload failed." });
      }
      const size = fs.statSync(dest).size;
      if (size === 0) {
        fs.rmSync(dest, { force: true });
        return send(res, 400, { error: "That file is empty." });
      }
      state.files[id] = { ext, mime, name: filename };
      const title = filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ") || "Upload";
      let next = state;
      if (ext === ".vtt") {
        if (!state.currentId) {
          delete state.files[id];
          fs.rmSync(dest, { force: true });
          return send(res, 409, { error: "Select a video before adding subtitles." });
        }
        next = reduce(state, { type: "setCaption", itemId: state.currentId, fileId: id });
      } else if (mime.startsWith("image/")) {
        next = reduce(state, { type: "addPhoto", photo: { id: nid("h"), fileId: id, title } });
      } else if (mime.startsWith("audio/")) {
        next = reduce(state, { type: "addItem", item: { id: nid("q"), kind: "audio", title, fileId: id } });
      } else {
        next = reduce(state, { type: "addItem", item: { id: nid("q"), kind: "file", title, fileId: id } });
      }
      if (next === state) {
        delete state.files[id];
        fs.rmSync(dest, { force: true });
        return send(res, 400, { error: "Could not add that file." });
      }
      apply(next, { gc: ext === ".vtt" });
      return send(res, 200, { ok: true, state: publicState(state) });
    }

    function serveMedia(req, res, pathname) {
      const id = decodeURIComponent(pathname.slice("/media/".length));
      if (!/^[\w-]+$/.test(id)) return send(res, 400, { error: "Unknown file." });
      const meta = state.files[id];
      const filePath = meta ? path.join(mediaDir, `${id}${meta.ext}`) : "";
      if (!meta || !filePath.startsWith(mediaDir) || !fs.existsSync(filePath)) {
        return send(res, 404, { error: "That file is gone." });
      }
      return serveFile(req, res, filePath, meta.mime);
    }

    async function serveQr(req, res, url) {
      const hostHeader = req.headers.host || `localhost:${httpServer.address().port}`;
      const hostname = hostHeader.replace(/:\d+$/, "");
      const target = url.searchParams.get("target") === "https" && httpsPort
        ? `https://${hostname}:${httpsPort}/remote`
        : `http://${hostHeader}/remote`;
      const svg = await QRCode.toString(target, {
        type: "svg",
        margin: 1,
        color: { dark: "#f3f0e6", light: "#00000000" },
      });
      res.writeHead(200, {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(svg);
    }

    function serveMjpeg(req, res) {
      res.writeHead(200, {
        "Content-Type": "multipart/x-mixed-replace; boundary=frame",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      screen.viewers.add(res);
      if (screen.buf) writeFrame(res, screen.buf);
      req.on("close", () => screen.viewers.delete(res));
    }

    function serveScreenStill(res) {
      if (!screen.buf) return send(res, 404, { error: "No screen yet." });
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store",
        "Content-Length": screen.buf.length,
      });
      res.end(screen.buf);
    }

    function serveScreenFrame(req, res) {
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > 2_500_000) {
          tooBig = true;
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (tooBig || res.headersSent) return;
        const buf = Buffer.concat(chunks);
        if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
          return send(res, 400, { error: "Expected a JPEG frame." });
        }
        screen.buf = buf;
        screen.at = Date.now();
        for (const viewer of screen.viewers) writeFrame(viewer, buf);
        return send(res, 200, { ok: true });
      });
      req.on("close", () => {
        if (tooBig && !res.headersSent) send(res, 413, { error: "That frame is too large." });
      });
      req.on("error", () => {
        if (!res.headersSent && !tooBig) send(res, 400, { error: "Frame failed." });
      });
    }
  }

  const httpServer = http.createServer(handle);
  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 60_000;
  await listen(httpServer, options.port ?? 0);

  let httpsServer = null;
  if (options.https !== false) {
    try {
      const cert = ensureCert(dataDir, lanAddresses());
      httpsServer = https.createServer({ key: fs.readFileSync(cert.key), cert: fs.readFileSync(cert.cert) }, handle);
      httpsServer.requestTimeout = 0;
      httpsServer.headersTimeout = 60_000;
      await listen(httpsServer, options.httpsPort ?? 0);
      httpsPort = httpsServer.address().port;
    } catch (error) {
      console.error(`HTTPS remote unavailable: ${error.message}`);
    }
  }

  const httpPort = httpServer.address().port;
  return {
    port: httpPort,
    httpsPort,
    close() {
      for (const client of clients) client.end();
      for (const viewer of screen.viewers) viewer.end();
      httpServer.close();
      httpsServer?.close();
    },
  };
}

function writeFrame(res, buf) {
  if (res.destroyed || res.writableNeedDrain) return;
  res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
  res.write(buf);
  res.write("\r\n");
}

function serveStatic(req, res, pathname) {
  const rel = PAGES[pathname] || pathname.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(publicDir, rel));
  const inside = filePath === publicDir || filePath.startsWith(`${publicDir}${path.sep}`);
  if (!inside || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return send(res, 404, { error: "Not found." });
  }
  const type = STATIC_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  const cache = path.extname(filePath) === ".woff2" ? "public, max-age=31536000, immutable" : "no-store";
  return serveFile(req, res, filePath, type, cache);
}

function serveFile(req, res, filePath, type, cache = "no-store") {
  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  const common = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": cache,
    "X-Content-Type-Options": "nosniff",
  };
  if (!range) {
    res.writeHead(200, { ...common, "Content-Length": stat.size });
    const stream = fs.createReadStream(filePath);
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
    res.end();
    return;
  }
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : stat.size - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
    res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
    res.end();
    return;
  }
  end = Math.min(end, stat.size - 1);
  res.writeHead(206, {
    ...common,
    "Content-Range": `bytes ${start}-${end}/${stat.size}`,
    "Content-Length": end - start + 1,
  });
  const stream = fs.createReadStream(filePath, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

function loadState(dataDir) {
  try {
    return normalize(JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8")));
  } catch {
    return initialState();
  }
}

function saveState(dataDir, state) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "state.json");
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

function pruneMissing(state, mediaDir) {
  let changed = false;
  for (const [id, meta] of Object.entries(state.files)) {
    if (!fs.existsSync(path.join(mediaDir, `${id}${meta.ext}`))) {
      delete state.files[id];
      changed = true;
    }
  }
  const missing = (item) => item.fileId && !state.files[item.fileId];
  const queue = state.queue.filter((item) => !missing(item));
  if (queue.length !== state.queue.length) {
    state.queue = queue;
    changed = true;
  }
  const photos = state.photos.filter((photo) => !missing(photo));
  if (photos.length !== state.photos.length) {
    state.photos = photos;
    changed = true;
  }
  for (const playlist of state.playlists) {
    const items = playlist.items.filter((item) => !missing(item));
    if (items.length !== playlist.items.length) {
      playlist.items = items;
      changed = true;
    }
  }
  if (state.currentId && !state.queue.some((item) => item.id === state.currentId)) {
    state.currentId = state.queue[0]?.id ?? null;
    state.status = "paused";
    changed = true;
  }
  return changed;
}

function collectFiles(state, mediaDir) {
  const used = new Set();
  const take = (item) => {
    if (item?.fileId) used.add(item.fileId);
    if (item?.captionFileId) used.add(item.captionFileId);
  };
  state.queue.forEach(take);
  state.photos.forEach(take);
  state.playlists.forEach((playlist) => playlist.items.forEach(take));
  for (const id of Object.keys(state.files)) {
    if (used.has(id)) continue;
    fs.rmSync(path.join(mediaDir, `${id}${state.files[id].ext}`), { force: true });
    delete state.files[id];
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListen);
      reject(error);
    };
    const onListen = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListen);
    server.listen(port, "0.0.0.0");
  });
}

function ensureCert(dataDir, ips) {
  const dir = path.join(dataDir, "cert");
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  const stamp = path.join(dir, "names.txt");
  const names = ["localhost", "127.0.0.1", ...ips];
  const want = names.join("\n");
  if (fs.existsSync(cert) && fs.existsSync(key) && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === want) {
    return { key, cert };
  }
  fs.mkdirSync(dir, { recursive: true });
  const san = names
    .map((name) => (/^\d+\.\d+\.\d+\.\d+$/.test(name) ? `IP:${name}` : `DNS:${name}`))
    .join(",");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key,
    "-out", cert,
    "-days", "825",
    "-subj", "/CN=Lumen",
    "-addext", `subjectAltName=${san}`,
  ], { stdio: "ignore" });
  fs.writeFileSync(stamp, want, { mode: 0o600 });
  fs.chmodSync(key, 0o600);
  return { key, cert };
}

function lanAddresses() {
  const found = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      const family = entry.family === "IPv4" || entry.family === 4;
      if (family && !entry.internal) found.push(entry.address);
    }
  }
  return found.sort((a, b) => rank(b) - rank(a));
}

function rank(ip) {
  if (ip.startsWith("192.168.")) return 3;
  if (ip.startsWith("10.")) return 2;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 1;
  return 0;
}

function nid(prefix) {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

function safeName(header) {
  const raw = decodeURIComponent(String(header || "upload"));
  const base = path.basename(raw).replace(/[^\w.\- ()[\]]+/g, "_");
  return base.slice(0, 180) || "upload";
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        req.destroy();
        reject(Object.assign(new Error("Request is too large."), { status: 413 }));
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Invalid JSON."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function writeBody(req, dest, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let failed = false;
    const out = fs.createWriteStream(dest);
    const fail = (error) => {
      if (failed) return;
      failed = true;
      req.destroy();
      out.destroy();
      reject(error);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) fail(Object.assign(new Error("That file is too large."), { status: 413 }));
    });
    req.on("error", fail);
    out.on("error", fail);
    out.on("finish", () => {
      if (!failed) resolve(size);
    });
    req.pipe(out);
  });
}

function drain(req) {
  req.resume();
}

async function youtubeTitle(videoId) {
  const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(2500) });
  if (!response.ok) return null;
  const data = await response.json();
  return typeof data.title === "string" ? data.title : null;
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

function printBanner(httpPort, httpsPort) {
  const ips = lanAddresses();
  const hosts = ips.length ? ips : ["127.0.0.1"];
  console.log("");
  console.log("Lumen is ready.");
  console.log("Open the car browser to:");
  for (const host of hosts) console.log(`  http://${host}:${httpPort}`);
  if (httpsPort) {
    console.log("Open this on the phone when you want to share its screen:");
    for (const host of hosts) console.log(`  https://${host}:${httpsPort}/remote`);
  }
  console.log("The phone remote on the same Wi-Fi:");
  for (const host of hosts) console.log(`  http://${host}:${httpPort}/remote`);
  console.log("");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT) || 4747;
  const httpsPort = Number(process.env.HTTPS_PORT) || 4748;
  start({ port, httpsPort }).then((server) => {
    printBanner(server.port, server.httpsPort);
  }).catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
