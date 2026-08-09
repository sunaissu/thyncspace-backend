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
