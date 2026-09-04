# Security policy

## Reporting a vulnerability

Please do not open a public issue containing exploit details or private event data. Use a private GitHub security advisory for this repository. Include affected versions, reproduction steps, impact, and a safe proof of concept.

## Security model

- Event access is checked server-side; frontend visibility is not authorization.
- Passwords are hashed with bcrypt. Sessions are stored in SQLite and cookies are HttpOnly, SameSite=Lax, and Secure in production.
- Admin and couple APIs enforce separate roles.
- CORS/trusted-origin checks and rate limits reduce cross-site and abuse risk; configure exact HTTPS origins.
- Multer limits uploads; code checks media type/signature and processing tools validate decodability.
- ffprobe rejects voice uploads without audio or with video streams. Normalization strips metadata.
- Voice files remain outside public uploads and have no static route. Access is through authenticated endpoints, including bounded Range streaming.
- Generated ZIP names are sanitized. Filesystem paths are generated/resolved rather than trusted from user input.
- Output is inserted with safe DOM operations where implemented; preserve escaping and avoid introducing raw untrusted HTML.

## Deployment checklist

Use HTTPS, a dedicated low-privilege account, restrictive file permissions, a long random session secret, exact allowed origins, current supported dependencies, controlled upload/body limits, Nginx security headers, monitoring, and tested backups. Never publish `.env`, SQLite files, WAL/SHM files, uploaded media, private voice storage, or logs containing sensitive data.

AI moderation is probabilistic and must not be treated as complete content safety. Operators remain responsible for review and incident response.
