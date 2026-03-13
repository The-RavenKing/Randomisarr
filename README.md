# Randomisarr

Randomisarr is a self-hosted media roulette app that picks a movie or show with verifiable drand randomness, then reveals the winner on a spin wheel.

It supports:

- Radarr and Sonarr as library sources
- Emby, Jellyfin, and Plex as watch-state and library sources
- Optional unwatched-only filtering
- Optional TMDb franchise-aware movie ordering
- Password-protected admin setup and settings

## Current Status

The app is in active beta prep. Core flows are implemented, and the repo now includes smoke tests for setup, auth, settings, health, and no-library spin behavior.

## Requirements

- Node.js 22 or newer
- Access to whichever services you want to connect

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Copy the example environment file if you want to override defaults:

```bash
cp .env.example .env
```

3. Start the app:

```bash
npm run dev
```

4. Open the printed local URL in your browser and complete initial setup.

## Environment Variables

`PORT`

- HTTP port for the Express server.

`DATA_DIR`

- Directory used for persisted settings. Defaults to `./data` inside the project.

`COOKIE_SECURE`

- Set to `true` when the app is served behind HTTPS.

`TRUST_PROXY`

- Set to `true` when a reverse proxy terminates TLS in front of the app.

`CORS_ORIGIN`

- Optional single allowed origin for cross-origin API access. Leave unset for same-origin browser access only.

`RADARR_URL`, `RADARR_API_KEY`

- Optional Radarr bootstrap config.

`SONARR_URL`, `SONARR_API_KEY`

- Optional Sonarr bootstrap config.

## Settings And Secrets

- Persistent settings are stored in `data/settings.json` or the directory specified by `DATA_DIR`.
- The file contains secrets and should stay private.
- The settings UI treats API keys and tokens as write-only values. Secret fields come back blank on reload; leave them blank to keep the currently saved value.

## Health Check

`GET /api/health` is public and returns a small readiness payload:

```json
{
  "ok": true,
  "version": "1.0.0",
  "authConfigured": true
}
```

## Testing

Run the smoke tests with:

```bash
npm test
```

The same suite now runs in GitHub Actions on every push and pull request.

The test suite launches the real server against a temporary data directory and verifies:

- public health and auth status
- initial setup and cookie-based auth
- settings save behavior
- secret redaction and preservation
- no-library spin errors

## Beta Checklist

- Verify your real Emby, Jellyfin, Plex, Radarr, Sonarr, and TMDb credentials from the settings page.
- Run `npm test` before shipping changes.
- Use HTTPS and `COOKIE_SECURE=true` outside local development.
