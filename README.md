# LAN Chat

A self-hosted chat app for your local network — accounts, direct messages, a shared
**General** room, and file sharing with inline image / video / audio preview.

## Features

- **Accounts** — register / log in / log out, scrypt-hashed passwords, HTTP-only session
  cookies (30 days), login attempt rate-limiting
- **Real-time messaging** — WebSocket delivery, typing indicators, online presence
- **General room** — everyone on the server; **direct messages** with any registered user
- **File sharing** — up to 10 files / 200 MB each per message
  - images render as thumbnails, click for fullscreen lightbox with download
  - videos play inline (`<video>` with seeking via HTTP Range)
  - audio plays inline
  - everything else shows as a downloadable file card
- **Nice-to-haves** — unread badges, message history with infinite scroll-up, day
  dividers, message grouping, drag & drop + clipboard paste uploads, upload progress,
  search people, mobile-friendly layout

## Run it

```bash
npm install
npm start
```

Then open `http://localhost:3000` (the server prints its LAN addresses on startup —
open that from any device on the same network).

Options:

- `PORT=4000 npm start` — change port (default 3000)
- `HOST=127.0.0.1 npm start` — bind to localhost only (default `0.0.0.0`, i.e. LAN-wide)

Data lives in `./data/` (SQLite database + uploaded files). Delete that folder to reset
everything.

## Tech

Node.js (≥ 22.13, uses the built-in `node:sqlite`), Express 5, ws, multer, and a
dependency-free vanilla JS frontend. No build step.

## Notes

- Runs over plain HTTP — fine for a trusted LAN, not for exposure to the public
  internet (put it behind a TLS reverse proxy if you need that).
- Uploaded HTML/SVG files are served with a `Content-Security-Policy: sandbox` header so
  they can never execute scripts in the app's origin.
