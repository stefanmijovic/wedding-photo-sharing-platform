# Contributing

1. Fork the repository and create a focused branch.
2. Keep changes small, documented, and consistent with the existing TypeScript/JavaScript style.
3. Run `npm run build` and `npm test` from `backend`.
4. Update documentation and tests when behavior changes.
5. Open a pull request describing the problem, approach, security/privacy impact, and verification performed.

Never commit secrets, `.env`, databases, WAL/SHM files, logs, private event details, uploaded media, voice recordings, backups, or machine-specific paths. Use neutral test names such as Alice, Bob, or Test Guest. Do not update dependencies or generated lockfiles unless the pull request explicitly explains why.
