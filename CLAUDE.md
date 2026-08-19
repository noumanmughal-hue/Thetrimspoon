# The Trim Spoon

## Purpose

The Trim Spoon is an AI-powered assistant web app for The Trim Spoon, a healthy
high-protein food brand. It helps customers with things like browsing the menu,
asking questions, and getting recommendations through a chat-style interface
backed by an LLM.

## Architecture

- `frontend/` — static client (`index.html`, `styles.css`, `app.js`). Renders the
  UI and talks to the backend over HTTP.
- `backend/` — server-side code. Handles requests from the frontend, calls the
  LLM, and returns responses.
- `data/` — static/structured data the app reads (e.g. menu items, config).
- `prompts/` — prompt templates and context fed to the LLM. Kept separate from
  code so prompts can be edited without touching logic.

Flow: frontend → backend → LLM (using a prompt from `prompts/` + data from
`data/`) → backend → frontend.

## Coding Rules

- Keep changes minimal and scoped to the task — no speculative features or
  premature abstractions.
- Match existing structure and naming; don't introduce new folders or patterns
  without a clear need.
- No comments unless they explain a non-obvious "why."
- Keep prompts in `prompts/`, not hardcoded inline in backend code.
- Keep data in `data/`, not hardcoded inline in code.

## Security Rules

- Never commit secrets, API keys, or credentials — use environment variables.
- Never log sensitive user data (payment info, personal identifiers).
- Validate and sanitize any user input before it reaches the LLM or is stored.
- Treat all LLM output as untrusted before rendering it in the frontend (avoid
  injecting raw HTML from model responses).

## Token-Saving Rules

- Read only the files relevant to the current task, not the whole project.
- Prefer targeted edits over rewriting whole files.
- Don't re-read files already open in context unless they may have changed.
- Keep prompt templates in `prompts/` concise — avoid redundant context.

## Scope Discipline

- Only modify files needed for the current task. Do not touch unrelated files,
  folders, or configuration as a side effect of a change.
