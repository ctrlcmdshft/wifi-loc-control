const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
]);

const ID = /^[\w-]{6,20}$/;

export function classifyLink(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return { error: "Enter a link." };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: "That is not a link." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "Use an http or https link." };
  }

  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const youtubeId = youtubeVideoId(host, url);
  if (youtubeId) {
    if (!ID.test(youtubeId)) return { error: "That YouTube link is missing a video id." };
    return { kind: "youtube", videoId: youtubeId, title: "YouTube" };
  }

  const name = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "Video");
  return {
    kind: "url",
    src: url.toString(),
    title: name.slice(0, 200) || "Video",
  };
}

function youtubeVideoId(host, url) {
  if (host === "youtu.be") {
    return url.pathname.split("/").filter(Boolean)[0] || "";
  }
  if (!YOUTUBE_HOSTS.has(host)) return "";
  if (url.pathname === "/watch") return url.searchParams.get("v") || "";
  const nested = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
  return nested ? nested[1] : "";
}

export function splitLinks(input) {
  return String(input ?? "")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}
