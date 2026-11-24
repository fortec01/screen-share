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
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const PUBLIC = __dirname;

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
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
