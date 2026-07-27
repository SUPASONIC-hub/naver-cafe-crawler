# Naver Cafe Crawler

Windows executable build for the Naver Cafe crawler.

## Run

1. Download `naver-cafe-crawler.exe`.
2. Run the executable.
3. Use the page that opens automatically.

Node.js and npm are not required for this packaged build. If Chromium is not available, the app tries to use Edge or Chrome.

## Render deployment

This repository currently contains only a Windows `.exe` distribution.

Render cannot deploy this executable directly as a normal web service. To deploy the service on Render, the project needs one of the following:

- the original web app source code with a start command, or
- a Docker setup that runs on Linux and exposes an HTTP port.

CSV crawl result files and packaged ZIP artifacts are intentionally ignored by git.
