# Testing

## Commands

```bash
cd backend
npm ci
npm run build
npm test
```

`npm run build` is the TypeScript typecheck and production compilation. `npm test` uses Node's built-in test runner against `test/*.test.mjs`.

## Coverage areas

- Event configuration validation and locked/unlocked API behavior
- Likes and media authorization behavior
- Atomic queue claims, retry, failure, and stale recovery
- Video processing, recovery, and manual retry
- Voice upload validation and event lock
- Admin/couple role authorization
- Voice list, statistics, Range streaming, listened status, download, ZIP, and deletion

Tests launch isolated application processes and must use `TEST_DATA_ROOT`, normally a generated temporary directory. Test-only processor and notification stubs avoid production storage, AI, FFmpeg-heavy work, and external mail where the scenario does not require them. Never point tests at production paths or databases.
