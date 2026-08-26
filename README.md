# The Trim Spoon

Healthy, high-protein food brand web app.

## Structure

- `frontend/` — index.html, styles.css, app.js
- `backend/` — server-side code
- `data/` — menu/fees/promotions/subscriptions data files
- `prompts/` — prompt files

## Setup

1. `cd backend && npm install`
2. Copy `.env.example` to `.env` in the project root and fill in real values:
   - `ANTHROPIC_API_KEY` — required for the chat assistant.
   - `PORT` — defaults to 3000 if unset.
   - `STAFF_USERNAME` / `STAFF_PASSWORD` — required for the staff dashboard
     (`/staff.html`, `/api/orders`); without these set, the dashboard is
     unreachable rather than left open.
   - `DATABASE_URL` — Postgres connection string (Neon, via Vercel Marketplace)
     for order storage. Without this set, the app still runs but placing/
     viewing orders fails with a clear error instead of a crash.
3. `npm start` (from `backend/`) — serves the API and the static frontend
   together on `PORT`. The `orders` table is created automatically on first
   use if it doesn't already exist.

Orders are stored in Postgres (see `backend/server.js`) so they survive
redeploys and are visible from any serverless instance — this replaced an
earlier local-JSON-file approach that didn't work reliably on Vercel.
