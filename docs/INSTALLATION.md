# Installation

## Prerequisites

- Node.js 22 and npm
- FFmpeg and ffprobe on `PATH`
- Build tools supported by the native packages when prebuilt binaries are unavailable

## Local setup

```bash
git clone https://github.com/your-username/wedding-photo-sharing-platform.git
cd wedding-photo-sharing-platform/backend
cp .env.example .env
npm ci
npm run build
npm start
```

Edit `.env` before starting. `VOICE_MESSAGES_DIR` must be an absolute writable directory outside `uploads`. On first start the application creates empty SQLite databases and required runtime directories.

## Development

```bash
cd backend
npm ci
npm run dev
```

The static frontend is served by Express, so a separate frontend build is not required.

## FFmpeg check

```bash
ffmpeg -version
ffprobe -version
```

Both programs must be discoverable by the service account.

## TensorFlow native dependency

`@tensorflow/tfjs-node`, `better-sqlite3`, `bcrypt`, and Sharp may use platform-specific native binaries. Never copy `node_modules` between Windows and Linux, or between different CPU architectures. Run `npm ci` on the target system from the committed lockfile.

## Windows and Linux

PowerShell can use `Copy-Item .env.example .env` instead of `cp`. Windows private paths may look like `D:\\wedding-private\\voice-messages`; Linux paths may look like `/var/lib/wedding-app/voice-messages`. Production is easiest on Linux with a dedicated service account.
