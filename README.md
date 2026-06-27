# Wedding Photo Sharing Platform

<p align="center">
  <img src="docs/img/landing-page.png" alt="Wedding Photo Sharing Platform">
</p>

<p align="center">

![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Express](https://img.shields.io/badge/Express-5-black?logo=express)
![SQLite](https://img.shields.io/badge/SQLite-3-003B57?logo=sqlite)
![Ubuntu](https://img.shields.io/badge/Ubuntu-24.04%20LTS-E95420?logo=ubuntu)
![Nginx](https://img.shields.io/badge/Nginx-Reverse%20Proxy-009639?logo=nginx)
![License](https://img.shields.io/badge/License-MIT-green)

</p>

A production-ready, self-hosted web application that enables wedding guests to upload, browse and download photos and videos through a modern, responsive interface.

The application is built with **Node.js**, **Express**, **TypeScript**, and **SQLite**, and is designed to run on **Ubuntu Server** behind an **Nginx** reverse proxy with **Cloudflare** DNS and **Let's Encrypt** HTTPS.

> **Note**
>
> Screenshots included in this repository use demonstration content only.

---

# Features

## Guest Features

- Upload multiple photos and videos
- Upload progress indicator
- Responsive mobile-first interface
- Public gallery with infinite scrolling
- Lazy-loaded thumbnails
- Full-screen image preview
- Download original media
- Multi-language support
  - 🇬🇧 English
  - 🇷🇸 Serbian
  - 🇩🇪 German

---

## Administration

- Password-protected admin panel
- AI-powered media moderation
- Gallery management
- Statistics dashboard
- Approve, hide or delete uploaded media
- Download all photos as ZIP archive
- Download all videos as ZIP archive
- Email notifications

---

## Media Processing

- Automatic thumbnail generation
- Automatic video transcoding
- Background processing queue
- EXIF orientation correction
- Image optimization using Sharp

---

## Security

- HTTPS using Let's Encrypt
- Cloudflare DNS
- Nginx Reverse Proxy
- Upload validation
- MIME type validation
- File size validation
- Rate limiting
- Protected administration endpoints
- Environment-based configuration

---

# Screenshots

## Landing Page

![](docs/img/landing-page.png)

---

## Mobile View

![](docs/img/mobile-home.png)

---

## Gallery

![](docs/img/gallery.png)

---

## Upload

![](docs/img/upload.png)

---

## Admin Dashboard

![](docs/img/admin-dashboard.png)

---

# Media Processing Pipeline

Every uploaded file goes through a processing pipeline before becoming available in the public gallery.

```text
                     Client Upload
                           │
                           ▼
                   File Validation
                           │
                           ▼
                    Rate Limiter
                           │
                           ▼
                 Background Processing Queue
                           │
          ┌────────────────┴────────────────┐
          ▼                                 ▼
 Thumbnail Generation             Video Transcoding
          │                                 │
          └──────────────┬──────────────────┘
                         ▼
               AI Image Moderation
                         │
                         ▼
                  SQLite Database
                         │
                         ▼
                  Public Gallery
```

The pipeline ensures uploaded media is validated, processed and moderated before becoming publicly accessible.

---

# Architecture

```text
                        Internet
                            │
                     Cloudflare DNS
                            │
                      HTTPS (443)
                            │
                  Nginx Reverse Proxy
                            │
            ┌───────────────┴───────────────┐
            │                               │
            ▼                               ▼
    Static Frontend                 Express Backend
                                            │
          ┌─────────────────────────────────┼─────────────────────────┐
          ▼                                 ▼                         ▼
   SQLite Database                  Upload Storage          Background Queue
          │                                 │                         │
          └─────────────────────────┬───────┴─────────────────────────┘
                                    ▼
                           Media Processing
                                    │
                                    ▼
                          AI Image Moderation
                                    │
                                    ▼
                             Public Gallery
```

---

# Technology Stack

| Category | Technologies |
|----------|--------------|
| Backend | Node.js, Express 5, TypeScript |
| Frontend | HTML5, CSS3, JavaScript, Bootstrap |
| Database | SQLite |
| Media Processing | Sharp, Multer, Archiver |
| AI Moderation | TensorFlow.js, NSFWJS |
| Web Server | Nginx |
| Infrastructure | Ubuntu Server, Cloudflare, Let's Encrypt |
| Development | Git, GitHub, Visual Studio Code |

---

# Installation

Clone the repository:

```bash
git clone https://github.com/<your-github-username>/wedding-photo-sharing-platform.git
cd wedding-photo-sharing-platform
```

Install backend dependencies:

```bash
cd backend
npm install
```

Return to the project root:

```bash
cd ..
```

Copy the example environment configuration:

```bash
cp .env.example .env
```

Update the values inside `.env` according to your environment.

Build and start the application:

```bash
cd backend
npm run build
npm start
```

---

# Environment Variables

Copy `.env.example` to `.env` and update the values according to your environment.

```env
ADMIN_EMAIL=admin@example.com
ADMIN_PANEL_URL=/admin.html
```

---

# Project Structure

```text
backend/
├── moderation.ts
├── server.ts
├── package.json
└── tsconfig.json

frontend/
├── css/
├── js/
├── img/
└── index.html

uploads/
├── original/
└── thumbs/

docs/
└── img/

README.md
LICENSE
.env.example
```

---

# Deployment Notes

The project can also be adapted for containerized deployments or deployed behind alternative reverse proxies.

Production deployment consists of:

- Ubuntu Server
- Node.js
- Nginx Reverse Proxy
- SQLite
- Cloudflare DNS
- Let's Encrypt HTTPS certificates

---

# Roadmap

The following improvements are planned for future versions:

- User authentication and role-based access control
- Gallery search and media filtering
- EXIF metadata viewer
- Object storage support (Amazon S3 / MinIO)
- PostgreSQL support for larger deployments
- Docker Compose deployment
- GitHub Actions CI/CD pipeline
- Automated unit and integration testing
- Prometheus & Grafana monitoring
- Progressive Web App (PWA) support

---

# License

This project is licensed under the MIT License.

See the [LICENSE](LICENSE) file for details.
