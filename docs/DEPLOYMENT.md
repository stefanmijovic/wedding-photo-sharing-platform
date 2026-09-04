# Production deployment

This example targets Ubuntu with Nginx and systemd. Adapt users, paths, domain, firewall, retention, and monitoring to your environment.

## Layout and install

```bash
sudo useradd --system --home /opt/wedding-app --shell /usr/sbin/nologin wedding
sudo install -d -o wedding -g wedding /opt/wedding-app /var/lib/wedding-app/voice-messages
cd /opt/wedding-app/backend
sudo -u wedding npm ci
sudo -u wedding npm run build
```

Create `/opt/wedding-app/backend/.env` with restrictive permissions. Do not place secrets in the unit file or repository.

## systemd

Copy and edit `deploy/wedding-backend.service.example`, then validate it before enabling. The service uses a dedicated account, explicit working directory, restart policy, and graceful SIGTERM handling.

## Nginx

Adapt `deploy/nginx.example.conf`. The proxy should terminate HTTPS, forward the original scheme/host/IP, allow request bodies large enough for configured media limits, and proxy API plus static frontend traffic.

Recommended headers include HSTS after HTTPS is proven, `X-Content-Type-Options`, clickjacking protection, a reviewed CSP, and `Permissions-Policy: microphone=(self)`. The CSP must permit same-origin media/blob playback required by previews and streaming. Avoid exposing directory listings or private voice storage.

## TLS and operations

Use certificates issued for your own domain; do not copy example paths literally. Verify secure session cookies, trusted origins, upload limits, FFmpeg availability, filesystem ownership, health endpoint behavior, backups, and restore procedures before accepting guest data.
