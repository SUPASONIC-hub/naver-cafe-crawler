# Naver Cafe Crawler

Naver Cafe comment crawler with a browser-based UI and a Render-ready Docker deployment.

## Local Run

```powershell
npm install
npm start
```

Open `http://localhost:3000`.

For the old Windows packaged build, run `naver-cafe-crawler.exe`.

## Render Deployment

This project includes:

- `Dockerfile`
- `render.yaml`
- Express server on `0.0.0.0:$PORT`
- Playwright Chromium runtime via the official Playwright Docker image

Create a Render Web Service from:

```text
https://github.com/SUPASONIC-hub/naver-cafe-crawler
```

Render should detect `render.yaml` and deploy the Docker service.

## Login

Local Windows usage can open a browser for manual login.

Render runs headless, so manual login is not available. If the target cafe requires login, set the Render environment variable `NAVER_COOKIE` to a valid Naver cookie header value. Do not commit cookies to git.

CSV crawl result files and packaged ZIP artifacts are intentionally ignored by git.
