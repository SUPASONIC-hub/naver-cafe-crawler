# Deployment Notes

## Current status

This repository now includes a Render-ready Node.js web service.

The previous Windows executable distribution remains available:

- `naver-cafe-crawler.exe`
- `README-EXE.txt`

Render uses the source files and Docker configuration, not the Windows executable.

## Deployment files

- `server.js`
- `public/`
- `package.json`
- `Dockerfile`
- `render.yaml`

## Render setup target

Once source code or Docker support is available, create a Render Web Service with:

- Repository: `https://github.com/SUPASONIC-hub/naver-cafe-crawler`
- Branch: `main`
- Runtime: Docker
- Start command: Docker `CMD`, `npm start`

## Required environment variables

Optional:

- `NAVER_COOKIE`: Naver cookie header for cafes that require login. Keep this secret in Render settings.

## Notes

The service binds to `0.0.0.0:$PORT` for Render compatibility.
