# LAN Chat

Self-hosted chat app with accounts, direct messages, a shared General room, and file sharing with inline image / video / audio preview. Deploys to Vercel.

## Features

- **Accounts** -- register / log in / log out, scrypt-hashed passwords, HTTP-only session cookies (30 days), login attempt rate-limiting
- **Real-time messaging** -- polling-based delivery (2.5 s), typing indicators, online presence
- **General room** -- everyone on the server; **direct messages** with any registered user
- **File sharing** -- up to 10 files / 10 MB each per message (Vercel Blob)
  - images render as thumbnails, click for fullscreen lightbox with download
  - videos play inline (`<video>` with seeking)
  - audio plays inline
  - everything else shows as a downloadable file card
- **UI** -- unread badges, message history with infinite scroll, day dividers, message grouping, drag-and-drop + clipboard paste uploads, upload progress bar, search people, mobile-friendly layout
- **Deploy** -- push to GitHub, connect to Vercel, add two Vercel stores (Postgres + Blob), done

## Deploy to Vercel

1. **Push to GitHub.**

2. **Import the repo in Vercel** -- [vercel.com/new](https://vercel.com/new).

3. **Add stores** -- in the Vercel project dashboard go to **Storage** and add:
   - **Vercel Postgres** (Neon-backed, free tier available)
   - **Vercel Blob** (free tier available)

   Vercel automatically injects `POSTGRES_URL` and `BLOB_READ_WRITE_TOKEN` as environment variables. On first request the database schema is created automatically.

4. **Deploy.** Subsequent pushes to `main` auto-deploy.

## Run locally

You need either (a) a remote Vercel Postgres + Blob, or (b) a local Postgres + the Vercel CLI.

### Option A -- `vercel dev` (easiest)

```bash
npm install -g vercel
vercel link          # link to your Vercel project
vercel env pull .env.local   # pulls POSTGRES_URL and BLOB_READ_WRITE_TOKEN
npm install
vercel dev            # starts at localhost:3000, connected to your Vercel stores
```

### Option B -- local Postgres

```bash
docker compose up -d   # starts Postgres on localhost:5432
# Set env vars:
export POSTGRES_URL="postgres://lanchat:lanchat@localhost:5432/lanchat"
export BLOB_READ_WRITE_TOKEN="your-blob-token"
npm install
npm start              # starts at localhost:3000
```

For the Blob token you still need a Vercel project (or use `vercel env pull`).

## Tech

Node.js >= 18, Express 5, Vercel Postgres (Neon), Vercel Blob, multer, vanilla JS frontend. Zero build step.

## Notes

- File uploads go to Vercel Blob (public access, random filenames). Images and videos are served directly from the Blob CDN for fast loading.
- Download links (`/api/download/:id`) proxy through the server to set `Content-Disposition: attachment`.
- Uploaded files have a 10 MB per-file limit (Vercel serverless function body size). For larger files, upgrade to Vercel Pro (50 MB).
- The database schema is auto-created on first request (no manual migration step).
