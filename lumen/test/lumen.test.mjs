import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyLink } from "../lib/links.mjs";
import { initialState, livePosition, reduce } from "../lib/reduce.mjs";
import { start } from "../server.mjs";

const NOW = 1_700_000_000_000;
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGf/9k=",
  "base64",
);

test("classifies youtube and direct links, and rejects other protocols", () => {
  assert.equal(classifyLink("https://youtu.be/dQw4w9WgXcQ").videoId, "dQw4w9WgXcQ");
  assert.equal(classifyLink("https://www.youtube.com/shorts/abcdefghijk").kind, "youtube");
  assert.equal(classifyLink("https://cdn.example.com/film.mp4").kind, "url");
  assert.equal(classifyLink("javascript:alert(1)").error.includes("http"), true);
  assert.equal(classifyLink("not a link").error.includes("not a link"), true);
});

test("video stays paused until the car screen allows the picture", () => {
  let state = initialState();
  state = reduce(state, {
    type: "addItem",
    item: { id: "q1", kind: "file", title: "Film", fileId: "m1" },
  }, { now: NOW });
  state = reduce(state, { type: "togglePlay" }, { now: NOW });
  assert.equal(state.mode, "theater");
  assert.equal(state.theaterUnlocked, false);
  assert.equal(state.status, "paused");

  state = reduce(state, { type: "unlockTheater" }, { now: NOW + 1000 });
  assert.equal(state.mode, "theater");
  assert.equal(state.status, "playing");

  state = reduce(state, { type: "setMode", mode: "drive" }, { now: NOW + 5000 });
  assert.equal(state.status, "paused");
  assert.ok(state.position >= 3.9 && state.position <= 4.1);
});

test("audio keeps playing on the drive screen, and sound-only video is opt-in", () => {
  let state = initialState();
  state = reduce(state, {
    type: "addItem",
    item: { id: "song", kind: "audio", title: "Song", fileId: "a1" },
  }, { now: NOW });
  state = reduce(state, { type: "togglePlay" }, { now: NOW });
  assert.equal(state.mode, "drive");
  assert.equal(state.status, "playing");

  state = reduce(state, {
    type: "addItem",
    item: { id: "film", kind: "file", title: "Film", fileId: "m1" },
  }, { now: NOW });
  state = reduce(state, { type: "playIndex", id: "film" }, { now: NOW });
  assert.equal(state.status, "paused");
  state = reduce(state, { type: "setAudioInDrive", value: true }, { now: NOW });
  state = reduce(state, { type: "setMode", mode: "drive" }, { now: NOW });
  state = reduce(state, { type: "togglePlay" }, { now: NOW });
  assert.equal(state.mode, "drive");
  assert.equal(state.status, "playing");
});

test("loop, shuffle, and the end of a queue", () => {
  let state = queueThree();
  state = reduce(state, { type: "unlockTheater" }, { now: NOW });
  state = reduce(state, { type: "setLoop", loop: "one" }, { now: NOW });
  const before = state.seekNonce;
  state = reduce(state, { type: "ended" }, { now: NOW + 1000 });
  assert.equal(state.currentId, "a");
  assert.equal(state.position, 0);
  assert.equal(state.status, "playing");
  assert.equal(state.seekNonce, before + 1);

  state = reduce(state, { type: "setLoop", loop: "off" }, { now: NOW });
  state = reduce(state, { type: "seek", seconds: 20 }, { now: NOW });
  state = reduce(state, { type: "next" }, { now: NOW });
  state = reduce(state, { type: "next" }, { now: NOW });
  assert.equal(state.currentId, "c");
  state = reduce(state, { type: "ended" }, { now: NOW + 2000 });
  assert.equal(state.currentId, "c");
  assert.equal(state.status, "paused");

  state = reduce(state, { type: "setShuffle", value: true }, { now: NOW });
  state = reduce(state, { type: "next" }, { now: NOW, rng: () => 0 });
  assert.equal(state.currentId, "a");
});

test("playlists, notes, and playback reports", () => {
  let state = queueThree();
  state = reduce(state, { type: "savePlaylist", name: "Night", id: "p1" }, { now: NOW });
  assert.equal(state.playlists[0].items.length, 3);
  state = reduce(state, { type: "clearQueue" }, { now: NOW });
  state = reduce(state, {
    type: "loadPlaylist",
    id: "p1",
    mode: "replace",
    ids: ["n1", "n2", "n3"],
  }, { now: NOW });
  assert.deepEqual(state.queue.map((item) => item.id), ["n1", "n2", "n3"]);
  assert.equal(state.currentId, "n1");

  state = reduce(state, { type: "setNotes", value: "Line one\nLine two" }, { now: NOW });
  assert.equal(state.notes, "Line one\nLine two");

  const playing = { ...state, status: "playing", position: 5, positionAt: NOW, seekNonce: 4, currentId: "n1" };
  const ignored = reduce(playing, {
    type: "report",
    itemId: "n1",
    status: "playing",
    seekNonce: 3,
    position: 50,
  }, { now: NOW + 1000 });
  assert.equal(ignored, playing);
  const accepted = reduce(playing, {
    type: "report",
    itemId: "n1",
    status: "playing",
    seekNonce: 4,
    position: 40,
    duration: 90,
  }, { now: NOW + 1000 });
  assert.equal(accepted.position, 40);
  assert.equal(accepted.queue[0].duration, 90);
  assert.ok(Math.abs(livePosition(playing, NOW + 1000) - 6) < 0.01);
});

test("the server streams files, keeps playlist media, and relays a screen", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-"));
  const server = await start({ port: 0, https: false, dataDir });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Show video on this screen/);

    const qr = await fetch(`${base}/api/qr.svg`);
    assert.equal(qr.status, 200);
    assert.match(await qr.text(), /<svg/);

    const earlyCaption = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { "Content-Type": "text/vtt", "X-Filename": "captions.vtt" },
      body: "WEBVTT\n",
    });
    assert.equal(earlyCaption.status, 409);

    const bad = await fetch(`${base}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "addLink", url: "file:///etc/passwd" }),
    });
    assert.equal(bad.status, 400);

    const added = await fetch(`${base}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "addLink", url: "https://youtu.be/dQw4w9WgXcQ https://cdn.example.com/a.mp4" }),
    });
    const addedBody = await added.json();
    assert.equal(addedBody.added, 2);
    assert.equal(addedBody.state.queue[0].kind, "youtube");

    const upload = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { "Content-Type": "video/mp4", "X-Filename": encodeURIComponent("road trip.mp4") },
      body: Buffer.from("0123456789abcdef"),
    });
    assert.equal(upload.status, 200);
    const uploaded = await upload.json();
    const file = uploaded.state.queue.find((item) => item.kind === "file");
    const media = await fetch(`${base}/media/${file.fileId}`, { headers: { Range: "bytes=0-3" } });
    assert.equal(media.status, 206);
    assert.equal(media.headers.get("content-range"), "bytes 0-3/16");
    assert.equal(await media.text(), "0123");

    await fetch(`${base}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "playIndex", id: file.id }),
    });
    const captioned = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { "Content-Type": "text/vtt", "X-Filename": "captions.vtt" },
      body: "WEBVTT\n",
    });
    assert.equal(captioned.status, 200);

    const photo = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { "Content-Type": "image/jpeg", "X-Filename": "bridge.jpg" },
      body: JPEG,
    });
    assert.equal(photo.status, 200);
    assert.equal((await photo.json()).state.photos.length, 1);

    const saved = await fetch(`${base}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "savePlaylist", name: "Road" }),
    });
    const playlist = (await saved.json()).state.playlists[0];
    await fetch(`${base}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "clearQueue" }),
    });
    assert.equal((await fetch(`${base}/media/${file.fileId}`)).status, 200);
    await fetch(`${base}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "deletePlaylist", id: playlist.id }),
    });
    assert.equal((await fetch(`${base}/media/${file.fileId}`)).status, 404);

    const frame = await fetch(`${base}/api/screen-frame`, { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: JPEG });
    assert.equal(frame.status, 200);
    const still = await fetch(`${base}/api/screen.jpg`);
    const bytes = Buffer.from(await still.arrayBuffer());
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8);
    const info = await (await fetch(`${base}/api/info`)).json();
    assert.equal(info.screenLive, true);

    const events = await fetch(`${base}/api/events`);
    const reader = events.body.getReader();
    const chunk = await reader.read();
    assert.match(Buffer.from(chunk.value).toString("utf8"), /"mode":/);
    await reader.cancel();
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

function queueThree() {
  let state = initialState();
  for (const id of ["a", "b", "c"]) {
    state = reduce(state, {
      type: "addItem",
      item: { id, kind: "file", title: id, fileId: `file-${id}` },
    }, { now: NOW });
  }
  return reduce(state, { type: "playIndex", id: "a" }, { now: NOW });
}
