# ThyncSpace backend

The Express, MongoDB, and Hocuspocus backend for ThyncSpace. It provides local
and Google authentication, note ownership and sharing, persistent collaboration,
CSRF protection, and health/readiness endpoints.

This directory is intended to become the standalone private GitHub repository
`sunaissu/thyncspace-backend`.

## Requirements

- Node.js 24
- npm
- MongoDB replica set or Atlas deployment
- Redis 8 (optional; the backend falls back to MongoDB when it is unavailable)

Transactions are used by application flows, so a standalone MongoDB server is
not sufficient. `docker-compose.yaml` starts a single-member replica set for
local development only.

## Local setup

Install the locked dependencies:

```powershell
npm.cmd ci
```

Start local MongoDB if needed:

```powershell
docker compose up -d
```

Copy `.env.example` to `.env`, replace every placeholder, and keep `.env`
untracked. For local development, use localhost origins and a local database
name rather than production credentials.

Set `REDIS_URL=redis://127.0.0.1:6379` to enable the local cache started by
Docker Compose. Leave it empty to disable caching. Cached note lists expire
after `REDIS_CACHE_TTL_SECONDS` and are explicitly invalidated after note,
sharing, favorite, and collaboration changes. Redis is never authoritative for
note content.

Build and start:

```powershell
npm.cmd run lint
npm.cmd run build
npm.cmd start
```

The default local API URL is `http://127.0.0.1:5000` when `HOST` and `PORT` use
the example values.

## Production

Deploy an immutable tag or full SHA from `sunaissu/thyncspace-backend`. Build
from the repository root and run `dist/server.js` as the unprivileged
`thyncspace` service user. Production secrets belong in a managed secret store,
not `.env` inside the Git checkout.

Production database authentication is selected explicitly with
`MONGO_AUTH_MODE`. The current EC2 deployment uses `aws-iam` with a passwordless
`MONGODB-AWS` URI and credentials obtained from the attached instance role. A
future non-AWS deployment can use `password` with URL-encoded Atlas SCRAM
credentials stored in that platform's managed secret store. Use exactly one
mode and one `MONGO_CONN` value at a time; `.env.example` documents both forms
with AWS IAM active by default.

The public API is `https://thyncspace-api.bg-labs.com`, and `CLIENT_URL` must be
exactly `https://thyncspace.bg-labs.com`.

See `docs/DEPLOYMENT.md`, `docs/EC2_PRODUCTION_REBUILD_GUIDE.md`, and
`docs/FRESH_START_AND_GIT_SPLIT.md` after the repository split.

## Note organization and recovery

All new endpoints require a session; mutations retain origin/CSRF and rate limits.
Organization, trash, and history are owner-only.

| Method | Path | Behavior |
| --- | --- | --- |
| PATCH | /api/notes/:noteId/organization | Set notebook (80 characters) and tags (20, each up to 40 characters). |
| GET | /api/notes/trash | List the owner's deleted notes. |
| GET | /api/notes/:noteId/history | List IDs/timestamps of the last five saved versions. |
| POST | /api/notes/:noteId/recover | Restore trash, or pass versionId to recover a historical copy. |
| DELETE | /api/notes/:noteId | Move to trash, remove sharing/favorites, disconnect live access. |

Content changes atomically retain the prior title/content with the current Yjs
state. History is capped at five snapshots to bound the MongoDB document size;
it is recovery history, not an audit log. Unchanged title/content does not consume
another version; generated board timestamps are ignored for this comparison. History and organization are omitted from collaborator responses.
Trash has no automatic expiration. Permanent deletion requires explicit confirmation.

Recovery uses a MongoDB transaction and creates a fresh private note ID without
old Yjs state, collaborators, or favorites. Restoring trash consumes the original
tombstone in the same transaction. Historical recovery leaves the original live
note untouched. Only server-saved content is recoverable; browser drafts remain
a separate recovery path. The five-version history starts after this update.

Existing records need no destructive migration: notebook/tags/history default
to empty values. Back up MongoDB before rollout. Deploy backend before frontend;
older frontends do not expose trash/history. Rolling back loses the new UI,
not the stored snapshots. Do not resume permanent deletion without reviewing
these semantics. The single collaboration process remains authoritative; this
change does not add multi-instance synchronization or distributed mutation locks.

Run `npm run check` for lint, types, build, and regression tests. Local watch mode
uses Node 24's built-in watcher. See REVIEW-2026-10-12.md for review evidence.

## Revision protection and integration checks

PATCH content requests must include expectedRevision from the latest contentRevision
response. Missing revisions return 428; mismatches return 409 without replacing
content. First-share snapshots carry expectedRevision too. Shared content updates
use the collaboration provider; REST title changes remain supported. Deploy the
frontend and backend together and refresh old clients, whose unversioned saves
will be rejected. Existing notes begin at content revision zero without rewriting
their content. Do not roll back the revision checks while newer clients are editing.

GET /api/notes/:noteId/history/:versionId returns an owner-only saved snapshot.
PATCH at that path names it with a label of at most 80 characters. Names do not pin
versions beyond the five-snapshot limit. DELETE /api/notes/trash/:noteId requires
{ confirmation: noteId } and permanently removes only an owned trashed note.
Imported sourcePath values are bounded relative metadata, never filesystem paths.

Run npm run test:integration for disposable replica-set tests, including rollback
and concurrency. MongoDB 8.0.16 downloads on first run; no Docker or production
connection is used. With the sibling frontend installed, its npm run test:live
checks this built server with Chrome and real WebSocket/database traffic.

## Cursor ownership

Awareness accepts one cursor session per connection. The server replaces incoming account IDs, names, and colors with authenticated identity and an available session color, rejects attempts to reuse another connection's cursor ID, and strips unrelated fields. Positions are finite and bounded. Disconnects remove presence; it is never stored as note content. Accepted username changes refresh the live session identity. Only document and whiteboard state belongs in collaboration; the frontend calculator is private.

## Workspace organization and preferences

Organization accepts isTemplate (boolean) and slash-separated notebook paths with
nonempty levels; dot/traversal levels are rejected. Template markers stay owner-only.
POST /api/notes/organization/bulk accepts either
{ action: "move", noteIds, notebook } (1–100 owned active notes), or
{ action: "rename-tag", from, to }. Moves verify the entire set in a transaction;
tag changes merge duplicates and treat names literally. Neither replaces content.

GET /api/notes/storage reports UTF-8 content, retained history and collaboration
snapshot bytes for owned notes, including trash, and the 20 largest notes. It
excludes indexes, record overhead and workspace preference metadata.

GET/PATCH /api/notes/workspace reads or updates account-owned preferences. PATCH
actions are pin/unpin/open with noteId, clear-recent, save-search with search, and
delete-search with id. A search contains id, name, query, notebook, tag, owner
(all/mine/shared), type (all/document/whiteboard), view
(all/shared/documents/boards/favorites/pinned/recent), and from/to ISO dates or "".
Limits are 100 pins, 40 recent notes, and 20 saved searches. Pin/open checks current
note access. Mutations serialize per account within the process; optimistic database
versions reject cross-process races with 409 instead of silently losing changes.
Responses carry revision so clients can ignore out-of-order replies.

Organization also accepts isArchived (boolean). Bulk organization accepts { action: "archive", noteIds, isArchived }, with the same transactional ownership checks as bulk move. This owner-only flag does not change active collaboration status or sharing. Collaborator projections omit it. Archived notes remain in the owned-note API so clients can offer search and recovery from archive. Saved workspace searches accept view: "archived".

## Session revocation

GET /api/users/sessions lists up to 100 current account sessions; DELETE
/api/users/sessions/:deviceId revokes one owned session. Authentication and existing
origin/CSRF checks apply. Raw cookie IDs and session fingerprints are never returned.
The ledger stores an HMAC fingerprint, a bounded browser user-agent description,
first/last request timestamps and expiry. Revocation tombstones remain until expiry
to prevent a stale cookie from registering itself again.

Authenticated requests check this ledger. Logout and remote sign-out close matching
live connections. Collaboration tokens must carry the originating session fingerprint;
authentication, token refresh and incoming document sync check active session status.
The periodic connection check also rejects expired/revoked sessions and fails closed
if revocation storage is unavailable. Trusted internal note updates do not use browser
tokens. The supported deployment still has one authoritative collaboration process.

The server waits for the device and workspace unique indexes before listening.
Deploy backend and frontend together: pre-update collaboration tokens lack session
binding and are rejected, so existing clients must reconnect and obtain fresh tokens.
Session discovery starts with each device's first authenticated request after rollout.

## Daily notes and recurring templates

POST /api/notes/daily takes { date: "YYYY-MM-DD", templateId? } and returns the same
owned note for that date. DailyNote has a unique owner/date ledger. Creating content
and its ledger entry is transactional; trash recovery moves the ledger pointer in
the same recovery transaction. A permanently removed daily note can be recreated.

GET/POST /api/notes/schedules lists/creates owner-only schedules. Creation requires
title (1–120 characters), templateId, cadence (daily/weekly), time (HH:mm UTC), and
weekday (0–6, Sunday first). PATCH /api/notes/schedules/:scheduleId accepts isActive;
DELETE removes a schedule without removing generated notes. A unique owner/slot
index enforces the 20-schedule cap across processes.

The server starts a minute worker after index initialization and waits for it during
graceful shutdown. A pass processes up to 25 due schedules. Each transaction creates
one private template copy and advances nextRunAt together; generation keys prevent
duplicate occurrences under retry. Downtime produces one catch-up note, then the
next future occurrence. Missing/invalid templates pause instead of blocking the queue.
No external scheduler or browser session is required.
