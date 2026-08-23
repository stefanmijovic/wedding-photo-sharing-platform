# Backup and recovery

Back up SQLite data, public media, and private voice storage as one operational dataset. Encrypt backups and restrict access because guest media and identities may be personal data.

## Consistent SQLite backup

SQLite uses WAL mode. Do not copy only the main database while writes are active. Prefer SQLite's online backup command/API or stop the service cleanly before a filesystem snapshot.

```bash
sqlite3 database.sqlite ".backup '/secure-backup/database.sqlite'"
sqlite3 sessions.sqlite ".backup '/secure-backup/sessions.sqlite'"
```

Session backups are optional if users can log in again; application data and processing jobs are not. Include public upload directories and `VOICE_MESSAGES_DIR`. Keep an offsite encrypted copy according to a documented retention schedule.

## Restore

Restore into an isolated location, verify file ownership and configured absolute paths, run SQLite integrity checks, start the service without public traffic, inspect processing recovery, and test representative photo/video/voice access. A backup is not reliable until restoration has been rehearsed.
