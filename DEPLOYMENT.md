# Deployment Notes

## Current status

This repository currently contains a Windows executable distribution:

- `naver-cafe-crawler.exe`
- `README-EXE.txt`

The executable can be downloaded and run on Windows, but it is not enough to deploy a public Render web service.

## Why Render cannot deploy this repository yet

Render web services run from source code or Docker images and must expose an HTTP service on a network port.

This repository does not currently include:

- the original application source code
- a package manifest such as `package.json`, `requirements.txt`, or equivalent
- a server start command
- a Linux-compatible Dockerfile

## Required files for Render deployment

Provide one of the following:

### Option A: Original source code

Recommended if the app was originally built with Node.js, Python, or another Render-supported runtime.

Needed:

- application source files
- dependency manifest
- build command
- start command
- any required environment variables

### Option B: Docker deployment

Recommended if the app needs OS-level dependencies or a custom runtime.

Needed:

- `Dockerfile`
- app entrypoint that runs on Linux
- HTTP server that binds to `0.0.0.0:$PORT`

## Render setup target

Once source code or Docker support is available, create a Render Web Service with:

- Repository: `https://github.com/SUPASONIC-hub/naver-cafe-crawler`
- Branch: `main`
- Runtime: source runtime or Docker
- Build command: project-specific
- Start command: project-specific

