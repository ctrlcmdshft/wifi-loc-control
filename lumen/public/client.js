export function connect({ onState, onStatus }) {
  let source;
  let wait = 500;
  let stopped = false;

  const open = () => {
    if (stopped) return;
    onStatus?.("connecting");
    source = new EventSource("/api/events");
    source.onopen = () => {
      wait = 500;
      onStatus?.("live");
    };
    source.onmessage = (event) => {
      try {
        onState(JSON.parse(event.data));
      } catch {
        /* ignore a bad frame */
      }
    };
    source.onerror = () => {
      onStatus?.("reconnecting");
      source.close();
      window.setTimeout(open, wait);
      wait = Math.min(wait * 2, 8000);
    };
  };

  open();
  return () => {
    stopped = true;
    source?.close();
  };
}

export async function command(body) {
  const response = await fetch("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

export async function uploadFile(file) {
  const response = await fetch("/api/upload", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-Filename": encodeURIComponent(file.name || "upload"),
    },
    body: file,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Upload failed");
  return data;
}
