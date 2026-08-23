# Configuration

The canonical template is `backend/.env.example`. Keep `.env` untracked. Restart the process after changing runtime configuration.

| Variable | Required | Type / example | Description and security |
| --- | --- | --- | --- |
| `NODE_ENV` | Recommended | `production` | Enables secure cookies. Use production only behind HTTPS. |
| `PORT` | No | Integer, `3000` | Local HTTP listen port. |
| `ALLOWED_ORIGINS` | Production | `https://wedding.example.com` | Comma-separated exact browser origins. Do not use `*` with credentials. |
| `SESSION_SECRET` | Yes | Random string, 32+ chars | Protect as a secret; rotate deliberately because sessions become invalid. |
| `DEFAULT_ADMIN_USERNAME` | Optional pair | `admin` | Bootstrap account name. Prefer the CLI for managed users. |
| `DEFAULT_ADMIN_PASSWORD` | Optional pair | `change-this-password` | Must be replaced; remove from runtime environment after bootstrap. |
| `EVENT_UNLOCK_AT` | Yes | ISO 8601 timestamp | Server-side unlock time. Must precede `WEDDING_AT`. |
| `WEDDING_AT` | Yes | ISO 8601 timestamp | Countdown/event time. |
| `ADMIN_EMAIL` | Yes | `admin@example.com` | Recipient passed to the host `mail` command. |
| `ADMIN_PANEL_URL` | Yes | `https://wedding.example.com/admin.html` | Link placed in moderation notifications. |
| `COUPLE_NOTIFICATION_EMAIL` | Yes | `couple@example.com` | Voice-message notification recipient. |
| `COUPLE_PANEL_URL` | Yes | `https://wedding.example.com/admin.html` | Link placed in voice notifications. |
| `VOICE_MESSAGES_DIR` | Yes | Absolute filesystem path | Must be writable and outside public uploads. Back it up as private data. |

## Time zones

Use ISO 8601 with an explicit `Z` or numeric offset. Example: `2030-06-15T08:00:00+02:00`. Values without a zone are rejected. Daylight-saving rules are not inferred from a city name, so choose the correct offset for the event date.

## Test-only variables

`TEST_DATA_ROOT` is mandatory under `NODE_ENV=test`. The suite also uses `TEST_SKIP_AI_MODERATION`, `TEST_DISABLE_PROCESSING_WORKER`, processor stubs/delays/failures, retry timing, stale timing, and notification stubs. They are test controls, not production configuration.
