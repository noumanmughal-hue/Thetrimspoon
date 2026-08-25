# The Trim Spoon

Healthy, high-protein food brand web app.

## Structure

- `frontend/` — index.html, styles.css, app.js
- `backend/` — server-side code
- `data/` — data files
  - `orders.json` — temporary local-dev order storage (plain JSON array, no database). Dev-only; revisit before production.
- `prompts/` — prompt files

## Setup

1. `cd backend && npm install`
2. Copy `.env.example` to `.env` in the project root and fill in real values:
   - `ANTHROPIC_API_KEY` — required for the chat assistant.
   - `PORT` — defaults to 3000 if unset.
   - `STAFF_USERNAME` / `STAFF_PASSWORD` — required for the staff dashboard
     (`/staff.html`, `/api/orders`); without these set, the dashboard is
     unreachable rather than left open.
3. `npm start` (from `backend/`) — serves the API and the static frontend
   together on `PORT`.

Note: order storage (`data/orders.json`) is a local JSON file — see
`backend/server.js` for details on why this is dev/demo-only and not suitable
as-is for serverless/production hosting.
