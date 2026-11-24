# ScreenShare — peer-to-peer browser screen sharing

Share your screen to one person, live, from your browser to theirs.
The video never touches a server: WebRTC carries it directly between
the two browsers (encrypted). A tiny Node server only introduces them.

## Run it

```
npm install
npm start          # http://localhost:8080
```

## Use it

1. Sharer opens the page → **Share my screen** → picks a screen/tab
   (tick "Share audio" in Chrome's picker for sound) → gets a 6-letter
   code and a copyable link.
2. Watcher opens the link (code fills itself in) or types the code →
   **Watch**. Fullscreen button on the watch side.
3. Stop sharing ends the room for both.

## Important notes

- **HTTPS is required** for screen capture (`getDisplayMedia`) anywhere
  except localhost. To use it over the internet, put it behind any
  HTTPS front — e.g. a Cloudflare quick tunnel:
  `cloudflared tunnel --url http://localhost:8080`
  gives an https://…trycloudflare.com address that works for both sides.
- **Quality** is capped by the sharer's PC and upload speed:
  1080p ≈ 8 Mbps, 1440p ≈ 20 Mbps, 4K30 ≈ 25–45 Mbps upload.
  The picker on the share side sets the cap; "Auto" lets the browser adapt.
- **View-only** — the watcher cannot click/type (browsers don't allow it).
- **One viewer per room** in this version. Some strict networks (certain
  office/campus Wi-Fi, symmetric NAT) can block the direct connection;
  the fix is a TURN relay (coturn) — not included yet.
- STUN servers used are Google's public ones; they only help the two
  browsers find each other and see no content.
