# Persistent processing queue

`processing_jobs` stores target type/id, job type, status, attempts, availability, timestamps, and a safe last-error message. Supported job types include `video_process` and `voice_normalize`.

## Lifecycle

`queued` jobs become `processing` through an atomic database claim. A successful processor marks the job `completed`. Failures are re-queued with configured delays until `max_attempts`, then marked `failed`. At startup, stale `processing` jobs are recovered so a terminated process does not strand work.

Global worker concurrency is intentionally one job at a time to limit CPU and memory pressure from FFmpeg and native processing. Uniqueness on target/job type supports idempotent enqueue behavior. Admins can manually retry failed video processing.

## Shutdown and deletion

Graceful shutdown stops new work and awaits the active worker before closing SQLite. Deletion coordinates database rows, job records, and filesystem artifacts so removed media is not later recreated by a queued processor. Operators should monitor failed/stale counts and preserve queue records in backups.
