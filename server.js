// Screen-share signaling server — the ONLY server piece.
// It never sees the video. It just introduces the two browsers
// (exchanges WebRTC offer/answer/ICE), then the stream flows
// directly browser -> browser (peer-to-peer).
//
// Rooms: one host (sharer) + one guest (watcher) per 6-char code.
// Run:  node server.js        (PORT env, default 8080)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const PUBLIC = __dirname;

// Grace window for a dropped HOST connection: if the host's socket
// closes (refresh, crash, network loss) the room is held this long
// for the host to come back before the guest is told it ended. An
// explicit End stream never waits — it closes the room at once.
const HOST_GRACE_MS = (() => {
  const n = parseInt(process.env.HOST_GRACE_MS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 30000;
})();

// TURN relay (coturn on the VPS) with short-lived credentials:
// username = unix expiry, credential = base64(HMAC-SHA1(secret, username)).
// The secret itself lives only in this service's env and on the relay.
const TURN_SECRET = process.env.TURN_SECRET || "";
const TURN_URLS = [
  "turn:137.23.34.173:3478?transport=udp",
  "turn:137.23.34.173:3478?transport=tcp",
];

// Preferred relay: Cloudflare TURN — a global relay network that stays
// reachable on strict networks (it can run over the standard secure-web
// port). The server mints short-lived credentials from Cloudflare's API;
// the key itself lives only in this service's env. If Cloudflare is not
// configured or its API fails, we fall back to the self-hosted relay.
const CF_TURN_KEY_ID = process.env.CF_TURN_KEY_ID || "";
const CF_TURN_TOKEN = process.env.CF_TURN_TOKEN || "";

// Second relay: ExpressTURN free plan — fixed long-term credentials from
// the account dashboard, kept only in this service's env. Included
// alongside the others so browsers can use whichever relay answers.
const ET_TURN_USERNAME = process.env.ET_TURN_USERNAME || "";
const ET_TURN_CREDENTIAL = process.env.ET_TURN_CREDENTIAL || "";
// Optional extra ExpressTURN accounts — separate free quota pools
// sharing the same server URLs; /turn rotates across all of them.
const ET2_TURN_USERNAME = process.env.ET2_TURN_USERNAME || "";
const ET2_TURN_CREDENTIAL = process.env.ET2_TURN_CREDENTIAL || "";
const ET3_TURN_USERNAME = process.env.ET3_TURN_USERNAME || "";
const ET3_TURN_CREDENTIAL = process.env.ET3_TURN_CREDENTIAL || "";
const ET4_TURN_USERNAME = process.env.ET4_TURN_USERNAME || "";
const ET4_TURN_CREDENTIAL = process.env.ET4_TURN_CREDENTIAL || "";
const ET5_TURN_USERNAME = process.env.ET5_TURN_USERNAME || "";
const ET5_TURN_CREDENTIAL = process.env.ET5_TURN_CREDENTIAL || "";
const ET6_TURN_USERNAME = process.env.ET6_TURN_USERNAME || "";
const ET6_TURN_CREDENTIAL = process.env.ET6_TURN_CREDENTIAL || "";
const ET7_TURN_USERNAME = process.env.ET7_TURN_USERNAME || "";
const ET7_TURN_CREDENTIAL = process.env.ET7_TURN_CREDENTIAL || "";
const ET_TURN_URLS = (process.env.ET_TURN_URLS || "turn:free.expressturn.com:3478?transport=udp,turn:free.expressturn.com:3478?transport=tcp")
  .split(",").map(s => s.trim()).filter(Boolean);

let turnCounter = 0;

// GIF/sticker picker feed: Klipy (the library Discord uses). The API
// key lives only in this service's env; the page receives a small
// normalized list and hotlinks Klipy's CDN for the images themselves.
// KLIPY_BASE exists so tests (and a future domain change) can point
// the feed elsewhere.
const KLIPY_API_KEY = process.env.KLIPY_API_KEY || "";
const KLIPY_BASE = process.env.KLIPY_BASE || "https://api.klipy.com";
const gifCache = new Map(); // type|mode|q|page -> { t, body }
function gifRendition(file, sizes, kinds) {
  if (!file) return null;
  for (const s of sizes) {
    const r = file[s];
    if (!r) continue;
    for (const k of kinds) {
      if (r[k] && typeof r[k].url === "string" && (r[k].url.startsWith("https://") || /^http:\/\/(127\.0\.0\.1|localhost)/.test(r[k].url))) return r[k];
    }
  }
  return null;
}
// emoji.gg: a public, keyless API listing Discord-style emojis.
// One big list (~2 MB) — fetched once, the animated subset cached
// in memory for an hour, then searched/paged here. Titles are
// user-submitted, so a small explicit-terms filter keeps the
// picker clean. Images hotlink straight from emoji.gg's CDN.
let ggCache = { t: 0, items: null };
const GG_BLOCK = /sex|porn|hentai|nsfw|nudes?|dick|cock|pussy|boobs?|titty|titties|cumshot|penis|vagina|blowjob|handjob|horny|ahegao|bdsm|nigger|nigga|faggot|\btits?\b|\banal\b|\blewd\b|\bmilf\b|\bfap\b/i;
async function ggAnimated() {
  if (ggCache.items && Date.now() - ggCache.t < 3600000) return ggCache.items;
  const r = await fetch("https://emoji.gg/api", {
    signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "ScreenShare/1.0 (personal chat app)" },
  });
  if (!r.ok) throw new Error("emoji.gg " + r.status);
  const all = await r.json();
  const items = (Array.isArray(all) ? all : [])
    .filter(e => e && typeof e.image === "string" && e.image.endsWith(".gif") && !GG_BLOCK.test(e.title || ""))
    .sort((a, b) => (b.faves || 0) - (a.faves || 0))
    .map(e => ({ id: "gg" + e.id, title: String(e.title || "emoji").slice(0, 80), preview: e.image, url: e.image, w: 128, h: 128 }));
  ggCache = { t: Date.now(), items };
  return items;
}
function normalizeGif(item) {
  if (!item || !item.file) return null;
  const full = gifRendition(item.file, ["hd", "md", "sm", "xs"], ["gif", "webp"]);
  const prev = gifRendition(item.file, ["xs", "sm", "md", "hd"], ["webp", "gif"]);
  if (!full && !prev) return null;
  const main = full || prev;
  return {
    id: String(item.id || item.slug || main.url),
    title: String(item.title || "").slice(0, 80),
    preview: (prev || full).url,
    url: main.url,
    w: main.width || (prev && prev.width) || 0,
    h: main.height || (prev && prev.height) || 0,
  };
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  if (url === "/turn") {
    // Return EVERY configured relay; the browser tries them all and uses
    // whichever answers. Order = preference: Cloudflare, ExpressTURN,
    // then the self-hosted VPS relay.
    const servers = [];
    if (CF_TURN_KEY_ID && CF_TURN_TOKEN) {
      try {
        const r = await fetch("https://rtc.live.cloudflare.com/v1/turn/keys/" + CF_TURN_KEY_ID + "/credentials/generate", {
          method: "POST",
          headers: { Authorization: "Bearer " + CF_TURN_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({ ttl: 86400 }),
          signal: AbortSignal.timeout(6000),
        });
        if (r.ok) {
          const data = await r.json();
          const ice = data.iceServers || {};
          if (ice.urls) servers.push({ urls: ice.urls, username: ice.username, credential: ice.credential });
        }
      } catch (e) { /* skip Cloudflare, keep the other relays */ }
    }
    // ExpressTURN accounts rotate: each /turn call hands out the next
    // account as the session's relay, so the free quota pools drain
    // evenly instead of burning one account dry first.
    const etEntries = [];
    if (ET_TURN_USERNAME && ET_TURN_CREDENTIAL) {
      etEntries.push({ urls: ET_TURN_URLS, username: ET_TURN_USERNAME, credential: ET_TURN_CREDENTIAL });
    }
    if (ET2_TURN_USERNAME && ET2_TURN_CREDENTIAL) {
      etEntries.push({ urls: ET_TURN_URLS, username: ET2_TURN_USERNAME, credential: ET2_TURN_CREDENTIAL });
    }
    if (ET3_TURN_USERNAME && ET3_TURN_CREDENTIAL) {
      etEntries.push({ urls: ET_TURN_URLS, username: ET3_TURN_USERNAME, credential: ET3_TURN_CREDENTIAL });
    }
    if (ET4_TURN_USERNAME && ET4_TURN_CREDENTIAL) {
      etEntries.push({ urls: ET_TURN_URLS, username: ET4_TURN_USERNAME, credential: ET4_TURN_CREDENTIAL });
    }
    if (ET5_TURN_USERNAME && ET5_TURN_CREDENTIAL) {
      etEntries.push({ urls: ET_TURN_URLS, username: ET5_TURN_USERNAME, credential: ET5_TURN_CREDENTIAL });
    }
    if (ET6_TURN_USERNAME && ET6_TURN_CREDENTIAL) {
      etEntries.push({ urls: ET_TURN_URLS, username: ET6_TURN_USERNAME, credential: ET6_TURN_CREDENTIAL });
    }
    if (ET7_TURN_USERNAME && ET7_TURN_CREDENTIAL) {
      etEntries.push({ urls: ET_TURN_URLS, username: ET7_TURN_USERNAME, credential: ET7_TURN_CREDENTIAL });
    }
    if (etEntries.length) {
      turnCounter += 1;
      servers.push(etEntries[turnCounter % etEntries.length]);
    }
    if (TURN_SECRET) {
      const username = String(Math.floor(Date.now() / 1000) + 3600);
      const credential = crypto.createHmac("sha1", TURN_SECRET).update(username).digest("base64");
      servers.push({ urls: TURN_URLS, username, credential });
    }
    if (!servers.length) { res.writeHead(503); res.end("turn not configured"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    // Top-level fields mirror the first server, for older cached pages.
    res.end(JSON.stringify({ servers, urls: servers[0].urls, username: servers[0].username, credential: servers[0].credential }));
    return;
  }
  if (url.startsWith("/sounds/")) {
    // Soundboard recordings (see SOUNDS-CREDITS.md). Only plain
    // lowercase mp3 names are allowed — no paths, no traversal.
    const name = url.slice("/sounds/".length);
    if (!/^[a-z0-9-]+\.mp3$/.test(name)) { res.writeHead(404); res.end("not found"); return; }
    const file = path.join(PUBLIC, "sounds", name);
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Content-Length": st.size,
        "Cache-Control": "public, max-age=86400",
      });
      fs.createReadStream(file).pipe(res);
    });
    return;
  }
  if (url === "/gifs") {
    const q = new URL(req.url, "http://localhost").searchParams;
    const type = ["gifs", "stickers", "emojis", "ggemojis"].includes(q.get("type")) ? q.get("type") : "gifs";
    const mode = q.get("mode") === "search" ? "search" : "trending";
    const query = (q.get("q") || "").slice(0, 60).trim();
    if (type === "ggemojis") {
      // No key needed — emoji.gg is an open API.
      try {
        const all = await ggAnimated();
        const needle = query.toLowerCase();
        const filtered = needle ? all.filter(i => i.title.toLowerCase().includes(needle)) : all;
        const page = Math.min(20, Math.max(1, parseInt(q.get("page") || "1", 10) || 1));
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" });
        res.end(JSON.stringify({ items: filtered.slice((page - 1) * 24, page * 24) }));
      } catch (e) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "emoji feed failed" }));
      }
      return;
    }
    if (!KLIPY_API_KEY) {
      res.writeHead(501, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "gif search is not set up yet" }));
      return;
    }
    if (mode === "search" && !query) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "empty search" }));
      return;
    }
    const page = Math.min(5, Math.max(1, parseInt(q.get("page") || "1", 10) || 1));
    const cacheKey = [type, mode, query, page].join("|");
    const hit = gifCache.get(cacheKey);
    if (hit && Date.now() - hit.t < 180000) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(hit.body);
      return;
    }
    const up = KLIPY_BASE + "/api/v1/" + encodeURIComponent(KLIPY_API_KEY) + "/" + type + "/" + mode +
      "?per_page=24&page=" + page + "&content_filter=medium" +
      (mode === "search" ? "&q=" + encodeURIComponent(query) : "");
    try {
      const r = await fetch(up, { signal: AbortSignal.timeout(7000) });
      if (!r.ok) throw new Error("upstream " + r.status);
      const data = await r.json();
      const items = ((((data || {}).data || {}).data) || []).map(normalizeGif).filter(Boolean);
      const body = JSON.stringify({ items });
      gifCache.set(cacheKey, { t: Date.now(), body });
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=120" });
      res.end(body);
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "gif search failed" }));
    }
    return;
  }
  if (url !== "/") { res.writeHead(404); res.end("not found"); return; }
  // Only the page is public — server code and package files are never served.
  res.writeHead(200, { "Content-Type": "text/html" });
  fs.createReadStream(path.join(PUBLIC, "index.html")).pipe(res);
});

const wss = new WebSocketServer({ server });
const rooms = new Map(); // code -> { host: ws|null, guest: ws|null, hostAway: bool, graceTimer: timer|null }

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

wss.on("connection", (ws) => {
  let myRoom = null, myRole = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "create") {
      // host asks for a room code
      let code;
      do { code = Math.random().toString(36).slice(2, 8).toUpperCase(); }
      while (rooms.has(code));
      rooms.set(code, { host: ws, guest: null, hostAway: false, graceTimer: null });
      myRoom = code; myRole = "host";
      send(ws, { type: "created", code });
      return;
    }

    if (msg.type === "join") {
      const room = rooms.get(msg.code);
      if (!room) { send(ws, { type: "error", message: "Room not found — check the code." }); return; }
      // A viewer whose previous socket is already dead (refresh,
      // reconnect) reclaims the seat instead of being told the room
      // is full. A live second viewer is still refused.
      if (room.guest && room.guest !== ws && room.guest.readyState === 1) { send(ws, { type: "error", message: "That room already has a viewer." }); return; }
      room.guest = ws;
      myRoom = msg.code; myRole = "guest";
      send(ws, { type: "joined" });
      // Joining (or re-joining after its own refresh) while the host
      // is inside the grace window: start in the waiting state too.
      if (room.hostAway) send(ws, { type: "host-away" });
      send(room.host, { type: "guest-joined" });
      return;
    }

    if (msg.type === "host-rejoin") {
      // A host whose page refreshed (or whose socket dropped and
      // reconnected) re-claims its room code instead of starting over
      // with a new one. Usually the room is still here, held by the
      // grace window; if it is already gone (window expired, or the
      // guest left meanwhile) it is recreated under the same code so
      // the host keeps its invite link.
      const code = String(msg.code || "").toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) { send(ws, { type: "error", message: "Bad room code." }); return; }
      const room = rooms.get(code);
      if (room && room.host && room.host !== ws && room.host.readyState === 1) {
        send(ws, { type: "error", message: "That room is already being hosted." });
        return;
      }
      if (room) {
        // The host made it back inside the grace window (or is
        // replacing its own dead socket): cancel the pending
        // room-end and tell the guest the wait is over.
        const wasAway = room.hostAway;
        if (room.graceTimer) { clearTimeout(room.graceTimer); room.graceTimer = null; }
        room.hostAway = false;
        room.host = ws;
        if (wasAway && room.guest) send(room.guest, { type: "host-back" });
      } else {
        rooms.set(code, { host: ws, guest: null, hostAway: false, graceTimer: null });
      }
      myRoom = code; myRole = "host";
      send(ws, { type: "created", code });
      // A viewer who is somehow still seated gets reconnected: the
      // host treats this like a fresh guest-joined and re-offers.
      if (room && room.guest) send(ws, { type: "guest-joined" });
      return;
    }

    if (msg.type === "end-room") {
      // The host pressed End: the room closes for everyone, now.
      // The guest is told directly (not via the relay fallthrough)
      // so it can leave even though the room is already deleted.
      if (myRoom && myRole === "host") {
        const room = rooms.get(myRoom);
        if (room && room.host === ws) {
          if (room.graceTimer) { clearTimeout(room.graceTimer); room.graceTimer = null; }
          send(room.guest, { type: "room-ended" });
          send(room.guest, { type: "host-left" });
          rooms.delete(myRoom);
        }
        myRoom = null; myRole = null;
      }
      return;
    }

    // relay everything else to the other side of the room
    if (myRoom && rooms.has(myRoom)) {
      const room = rooms.get(myRoom);
      const peer = myRole === "host" ? room.guest : room.host;
      if (peer) send(peer, msg);
    }
  });

  ws.on("close", () => {
    if (!myRoom || !rooms.has(myRoom)) return;
    const room = rooms.get(myRoom);
    const code = myRoom;
    // Identity guards: a stale socket closing late must never evict
    // the fresh socket that already replaced it (refresh / reconnect).
    if (myRole === "host" && room.host === ws) {
      // The host vanished (tab closed, crash, network gone) — but a
      // dropped socket is not the same as pressing End: hold the
      // room for the grace window so a host that merely refreshed
      // (or whose network blinked) can reclaim it, and put the
      // guest into a waiting state meanwhile. Only when the window
      // runs out is the room ended for the guest — with the same
      // messages an explicit end sends ("host-left" too, for any
      // older cached page that only knows that type).
      room.host = null;
      room.hostAway = true;
      send(room.guest, { type: "host-away" });
      if (room.graceTimer) clearTimeout(room.graceTimer);
      room.graceTimer = setTimeout(() => {
        room.graceTimer = null;
        if (rooms.get(code) !== room || !room.hostAway) return;
        send(room.guest, { type: "room-ended" });
        send(room.guest, { type: "host-left" });
        rooms.delete(code);
      }, HOST_GRACE_MS);
      if (room.graceTimer.unref) room.graceTimer.unref();
    } else if (myRole === "guest" && room.guest === ws) {
      room.guest = null;
      send(room.host, { type: "guest-left" });
      // The guest left while the host was away: nobody is waiting
      // for the host to come back, so there is nothing to hold —
      // cancel the window and delete the room at once.
      if (room.hostAway) {
        if (room.graceTimer) { clearTimeout(room.graceTimer); room.graceTimer = null; }
        rooms.delete(code);
      }
    }
  });
});

server.listen(PORT, () => console.log(`screen-share signaling on :${PORT}`));
