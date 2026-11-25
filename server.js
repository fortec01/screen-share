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
  if (url !== "/") { res.writeHead(404); res.end("not found"); return; }
  // Only the page is public — server code and package files are never served.
  res.writeHead(200, { "Content-Type": "text/html" });
  fs.createReadStream(path.join(PUBLIC, "index.html")).pipe(res);
});

const wss = new WebSocketServer({ server });
const rooms = new Map(); // code -> { host: ws|null, guest: ws|null }

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
      rooms.set(code, { host: ws, guest: null });
      myRoom = code; myRole = "host";
      send(ws, { type: "created", code });
      return;
    }

    if (msg.type === "join") {
      const room = rooms.get(msg.code);
      if (!room) { send(ws, { type: "error", message: "Room not found — check the code." }); return; }
      if (room.guest) { send(ws, { type: "error", message: "That room already has a viewer." }); return; }
      room.guest = ws;
      myRoom = msg.code; myRole = "guest";
      send(ws, { type: "joined" });
      send(room.host, { type: "guest-joined" });
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
    if (myRole === "host") {
      send(room.guest, { type: "host-left" });
      rooms.delete(myRoom);
    } else if (myRole === "guest") {
      room.guest = null;
      send(room.host, { type: "guest-left" });
    }
  });
});

server.listen(PORT, () => console.log(`screen-share signaling on :${PORT}`));
