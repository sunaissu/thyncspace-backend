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

## Quick capture and account consistency

POST /api/notes/capture accepts { captureId, title, text } and creates an owned private document in Inbox. A per-account unique generation key makes concurrent/retried identical captures return the same note. A changed or trashed existing capture returns 409; no retry overwrites it. Document limits, authentication, CSRF/origin checks and the creation rate limit apply. Incoming URLs remain text and are never fetched.

Clients can send X-Account-Id on authenticated requests. A mismatch with the session user returns 409 before execution, preventing accidental cross-account writes after another tab signs in. The header does not grant access and is never used as the acting identity. The frontend preserves it across CSRF retries.

## Account privacy

GET /api/users/privacy/export streams version 1 JSON Lines with a manifest and completion record. It includes the current profile, authentication provider (no credentials), owned notes including trash/history, current shared-membership references, workspace preferences, daily-note links, schedules, device metadata and deletion request. Records reflect their individual read times. Passwords, OAuth IDs, session fingerprints, CRDT internals, other owners' private content/organization, and browser-only calculator/study-card/draft data are excluded. Clients must reject an export without its complete footer.

GET/POST/DELETE /api/users/privacy/deletion reads, submits, or cancels the authenticated account's request. Submission requires { confirmation: exactCurrentUsername }. The unique owner index makes retries idempotent; cancelled requests may be reopened. Authentication, account consistency, CSRF and per-account limits apply. Requests require operator processing; no automatic deletion deadline is promised.

Operator procedure: build the backend, then run `node dist/privacyMaintenance.js list` to review pending request IDs and account names. To fulfil one, stop every API/worker instance and keep them stopped through cleanup; run `node dist/privacyMaintenance.js fulfill REQUEST_ID "EXACT_USERNAME" --service-stopped`, then restart the service. The flag acknowledges maintenance isolation, which prevents concurrent edits or account changes during deletion. Do not invoke fulfilment while any service instance is running.

Fulfilment rechecks the pending request and exact current account name inside a transaction, deletes the account/authentication records and owned notes/history/preferences/schedules, removes its memberships/favorites and references to removed notes, and invalidates affected caches. Other owners' note content is preserved. Revoked device tombstones remain until their existing session expiry to block stale cached identities. Deployments must separately apply their backup-retention policy; already downloaded third-party copies cannot be recalled. No production request was processed during development.

## Email verification and password recovery

Configure SMTP_HOST and MAIL_FROM (a single address). SMTP_PORT defaults to 587; SMTP_SECURE defaults to false and requires STARTTLS. Set SMTP_SECURE=true for implicit TLS, normally port 465. SMTP_USER and SMTP_PASSWORD must be supplied together when authentication is required. Certificate validation remains enabled, outbound messages use explicit single-recipient address objects, and file/URL message-content access is disabled. These settings are deployment inputs; development did not read or modify secret files or send real email.

POST /api/auth/request-reset accepts { email } and returns the same message for local, Google and unknown addresses. It queues before account lookup to avoid exposing existence through lookup timing. POST /api/auth/request-verification requires a session. GET /api/auth/security returns provider, verified and emailDeliveryAvailable. POST /api/auth/account-action accepts { purpose: "reset" | "verify", token, password? }; POST /api/auth/change-password requires { currentPassword, newPassword } and an authenticated session. Existing password length/byte limits apply. Missing email configuration returns an explicit service-wide 503 for email requests; password changes remain available.

A 15-second worker claims up to 20 queued messages per pass, with a two-minute lease and at most four delivery attempts. Requests are deduplicated per address/purpose/five-minute window. Queue and links expire 30 minutes after requesting. Completed queue markers retain no payload until TTL removal. Recipients and pending raw links are AES-GCM encrypted using a purpose-derived session-secret key; action records store only a SHA-256 token hash. Changing SESSION_SECRET invalidates pending encrypted mail, so users must request new links after secret rotation. Links use a URL fragment and require explicit confirmation. Tokens are random 32-byte values, purpose/email/credential-version bound, single-use and transactionally consumed. Delivery retries can send the same link more than once; only one use succeeds.

Password reset/change atomically updates the credential version, invalidates outstanding actions and queued recovery requests, revokes device sessions, and queues a change notification when delivery is configured. Live connections close. Session deserialization checks the database version on every request, including legacy ID-only sessions as version zero. Live tokens check both device revocation and the current account credential version, closing the late-session-registration race. Deploy backend and frontend together; old backend versions do not support the new serialized session identity.

Email-based sharing now requires completed email verification. Existing accounts, including Google accounts, use the explicit emailed verification link; verification is not automatically granted during sign-in. Google password recovery remains with Google. Username-based sharing stays available when the owner confirms the teammate's username. Existing sharing grants are preserved.

The implementation follows the [OWASP password recovery guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html) and [Nodemailer SMTP transport settings](https://nodemailer.com/smtp). SMTP delivery configuration and a real mailbox smoke check are required before enabling the feature in production.

## Note activity

GET /api/notes/:noteId/activity returns the owner's recent timeline, including trash. Current collaborators cannot read it. Up to 100 events are stored on each note, hidden from ordinary note responses. Content saves append an edit event in the same update as content/history; failed revision checks create none. Sharing and permission changes append their event atomically, and first-share rollback removes its event. Organization, bulk moves/tag changes, trash and restore also record events.

Live save events identify a combined collaboration save, because a stored snapshot may contain edits from several people. Private writes identify the acting account. Names resolve from current profiles; removed identities appear as former accounts. Account deletion scrubs actor/target references in other owners' activity. Trash recovery carries retained events into the new private identity; version recovery records its source version on the new copy. Exports include owned activity. Recording begins after this update; older events are not reconstructed.

## Attachment library

Authenticated /api/attachments endpoints list/search files, upload, stream content, link/unlink a note reference, and delete owned files with explicit ID confirmation. JSON uploads accept name, mime, and base64 data. Limits are 2 MiB per file, 100 files / 50 MiB per owner, and 100 note references per file. A transaction updates quota with storage; identical normalized contents deduplicate within the same owner. Files are stored in MongoDB and included in owner account exports/deletion. Permanent note deletion removes references; private recovery transfers or copies them transactionally.

Only owners may add file references, and they must also be able to edit the destination note. Reading a linked file requires ownership or current access to an active referenced note. Note sharing therefore grants file access; revocation/trash removes it on the next request. Previously downloaded copies cannot be recalled. Viewers cannot alter references; editors may unlink from their editable notes. File owners can remove obsolete references. Note-reference grants write the note in the same transaction to serialize against concurrent permission changes.

Admission allows UTF-8 text without NUL, signature-checked PDFs, and static PNG/JPEG/WebP. Images are decoded and re-encoded with [Sharp](https://sharp.pixelplumbing.com/api-constructor/), limited to 12 million pixels and two concurrent decodes; metadata is stripped. SVG/HTML and animated images are rejected. PDF admission checks its container signature, not every embedded object. Content responses use no-store, nosniff, attachment disposition and a sandbox CSP. The frontend uses a canvas-only PDF renderer without scripting, forms or annotation actions. Upload/mutation/account limits apply before expensive work; the global API limiter precedes JSON parsing.

Validation: 46 unit tests and 21 replica-set integration tests/subtests pass, including owner isolation, concurrent duplicate uploads, quota rollback, revocation, restoration and permanent reference cleanup. Production dependency audit reports no known vulnerabilities.

### Image search indexing

GET/PUT /api/attachments/:attachmentId/index is owner-only. Saving requires consent:true, the current expectedRevision, and text of at most 50,000 characters without NUL. Only PNG/JPEG/WebP attachments accept an index. Updates atomically advance a separate OCR revision; stale writes fail with 409. An empty string removes the index. Search matches file names and explicitly saved OCR text, while returning metadata only and enforcing current note access. OCR text is included in the owner's account export and removed with its attachment/account. File-byte usage counts original normalized file bytes; search metadata is bounded separately. The replica-set suite now has 22 passing tests/subtests, including consent, concurrency, search visibility and revocation.

## Private reminders

GET/PATCH /api/notes/reminders manages an owner-only document with up to 100 entries. Creation requires an accessible active note, a valid UTC timestamp, a 0–365-day interval and an expectedRevision. Optional document tasks carry an exact source line/text checked outside code fences. Reads recheck note access and task provenance; unavailable sources omit titles/task text, while changed or completed tasks are flagged. Updates use optimistic document concurrency and reject stale revisions; completing a recurring review advances once past missed intervals. No reminder mutation edits note content.

Reminders are included in owner account exports and deleted during account fulfillment. Notification delivery is a frontend opt-in while its workspace is open; the backend does not send email or push notifications. Replica-set coverage includes cross-account isolation, simultaneous completion, a racing 100-entry limit, invalid dates, code fences, changed/completed tasks and revoked source access.

## Linked document and board sources

GET/PATCH /api/notes/:noteId/embeds lists and manages up to 20 source-note references. GET /api/notes/:noteId/embeds/:sourceId returns one current content preview. All reads require active access to the host; source titles/types/content require independent active access to the source. Linking never changes either note's sharing. Missing/revoked sources return an unavailable label and no source content. IDs are canonicalized before reference storage.

Host owners/editors can add, remove or mark a source revision reviewed. A separate embedRevision compare-and-swap rejects concurrent metadata edits and rechecks host edit permission in the write query. Review actions also carry expectedSourceRevision, so a changed preview cannot be silently marked reviewed. Source content revision differences drive stale indicators; previews always return current content. No nested embed expansion runs on the server. Linked references are retained on private note recovery and in owner account exports; links to deleted or freshly restored source identities stay unavailable until explicitly relinked. Activity records metadata changes.

Backend checks: 46 unit tests and 24 replica-set tests/subtests, covering viewer mutation rejection, hidden source titles/content, host/source revocation, changed source revisions, concurrent reviews and private host recovery.

### Discussions and mentions

THY-10 is implemented. GET /api/notes/discussions supports noteId, filter (all, unresolved, mentions, replies), and a cursor for 50-row pages. GET /api/notes/:noteId/discussions/:threadId returns the thread and current collaborator names. POST /api/notes/:noteId/discussions creates a thread; PATCH on the thread supports reply, edit, delete-post, resolve, reopen, and owner-confirmed remove. All writes require current owner/editor access. Viewers can read.

Comments are plain text, limited to 4,000 characters, 10 mentions, 50 comments per thread, and 100 threads per note. Mentions must name current note members. Create/reply request IDs support retries after a lost response. Thread changes require expectedRevision; concurrent changes return 409. Transactions touch the host note to serialize writes with sharing changes and deletion. Inbox queries filter through current note access, use bounded pages, and have a five-second database limit. The inbox is in-app only; comments send no email.

Trash recovery transfers discussions to the new private note. Version copies start without discussions. Permanent deletion removes discussions. Account exports include discussions on owned notes and only that account's comments elsewhere; deletion removes owned threads and scrubs the account's authorship, comment text, and mentions elsewhere.

### Shared notebooks

THY-11 adds shared notebooks separate from private folder labels. GET/POST /api/notes/notebooks lists or creates notebooks; GET/PATCH /api/notes/notebooks/:notebookId reads or changes one. List pages contain 50 entries with a nextCursor. An account can own 20 notebooks. Each notebook holds up to 100 owned notes and 100 viewer/editor members. Create requests use a UUID for retry safety; changes require expectedRevision.

Notebook owners manage membership, rename, attach saved private notes, detach notes, and delete the notebook. Attach requires expectedContentRevision. Per-note sharing must be removed before attachment; contained notes inherit only notebook membership. The existing sharedWith field is the effective access list, maintained with notebook membership in a MongoDB transaction. All existing note, attachment, reminder, discussion, offline admission, and collaboration checks therefore use the inherited permissions. Notebook changes lock affected notes in stable order, flush accepted live changes, and update live roles or disconnect removed members after commit. Per-note share/remove routes reject inherited notes. Adding or changing an existing member binds to their account ID; new invitations use a confirmed username or verified email.

Detaching or deleting a notebook makes contained notes private without deleting content. Trashing a note removes notebook membership; recovery makes a private copy. Account exports include owned notebook membership and only the requester's membership elsewhere. Account deletion removes owned notebooks and removes the account from other notebooks and their effective note access. The collaboration service remains a single authoritative process; do not run independent in-memory collaboration instances against one database.

Role updates are server-origin messages. Clients update editor controls and labels when access becomes viewer/editor, and retain recovery storage for a session that has had edit access. The installed Hocuspocus server rejects client BroadcastStateless opcodes; application code does not relay arbitrary client stateless payloads.

### Selected-passage AI

THY-32 adds opt-in summaries and stated-variable extraction. AI_ACTIONS_ENABLED defaults to false. To enable it, configure a server-only OPENAI_API_KEY and an OPENAI_AI_MODEL that supports Responses structured outputs. No key belongs in frontend configuration. Set provider-side spending limits before deployment. No live provider call was made during this review.

Authenticated GET /api/notes/ai-settings reports availability. POST /api/notes/:noteId/ai requires action, start/end offsets, exact excerpt, expectedRevision and consent:true. Only a currently accessible saved document is eligible. The server checks the revision and passage before calling OpenAI, then rechecks access before returning. Output includes source identity, revision, range and exact passage. A changed source is flagged. It never updates a note or reads calculator state.

Requests include only the selected passage and action instructions, use store:false, and expose no tools. Limits are 8,000 UTF-16 units, 2,000 output tokens, a 30-second timeout, a 256 KiB response, two active calls, five requests per account per hour and 60 per workspace process per hour. Process-local limits reset on restart and do not replace provider spending controls. Calls are not automatically retried. Invalid, oversized, incomplete, refused or ungrounded quote responses fail without exposing provider diagnostics. Quotes must match the passage literally; this does not verify the generated claims.

The integration follows [Responses structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs). Disabling response storage does not disable all provider logging: see [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data). Unit tests use a fake key and mocked transport to check input scope, output bounds, concurrency, consent, stale sources and access removal.

### Portable workspace archives

THY-19 adds authenticated GET /api/notes/archive/export and GET/POST /api/notes/archive/import. The JSON Lines format contains a versioned manifest, owned document/board records (including archived notes and Trash), attachment records, and a completion footer. UTF-8 note contents use base64 to keep each record within request limits. The footer hashes the ordered per-record SHA-256 digests. Interrupted exports lack a valid footer and are rejected by the client. Records reflect their read time; save pending edits before exporting. This is a content-portability archive, separate from the broader account-data export.

Imports use a caller UUID, expected record count and digest. One import per account stages up to 20 records per request; retries verify existing record hashes. Each note, folder path, board and attachment passes normal validation. Staged content stays separate from visible notes and expires after six hours. Commit verifies the complete checksum and restores notes, attachment references, quota and a receipt in one MongoDB transaction. Failed commits retain staging for retry. Completed receipts last 30 days; dismissing a receipt permits another independent restore. Account export/deletion includes or removes staged records.

Restored notes have new IDs, no members and no shared notebook membership. Trash remains Trash. Included ID links and unambiguous title/path wiki links point to restored notes; inline/fenced code remains literal. Ambiguous names remain unchanged for manual review. Linked-source references are remapped, while sources outside the archive retain their original access requirements. Files retain references only to included notes. Identical owned files reuse storage and retain existing names/OCR; previously admitted owned image bytes avoid another JPEG encode. New image bytes pass normal normalization.

Limits are 1,000 notes, 100 files, 175 MiB encoded records, 50 MiB attachment bytes, and the normal account file/reference limits. A note still has a 1 MiB content limit. Export is limited to two requests per account per hour; import allows 360 requests per 15 minutes within the global API limit. A long transaction can time out without exposing partial copies; retry or cancel the staged import. No archive path is used as a filesystem path. Sharing grants, discussions, history, account settings and browser-only data are outside this portable format. Run npm run test:integration for real replica-set restore, isolation, remapping, quota rollback, deduplication, malformed records and concurrent/lost-receipt retries.
