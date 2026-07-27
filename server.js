const express = require("express");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_JOB_HISTORY = 3;
const JOB_TTL_MS = 1000 * 60 * 10;
const MAX_ALL_PAGES = Number(process.env.MAX_ALL_PAGES || 20);
const MAX_RESULT_ROWS = Number(process.env.MAX_RESULT_ROWS || 300);
const PROGRESS_PREVIEW_LIMIT = Number(process.env.PROGRESS_PREVIEW_LIMIT || 25);
const MEMORY_PAUSE_RSS_MB = Number(process.env.MEMORY_PAUSE_RSS_MB || 260);
const BROWSER_RECYCLE_ARTICLES = Number(process.env.BROWSER_RECYCLE_ARTICLES || 4);
const BROWSER_RECYCLE_PAGES = Number(process.env.BROWSER_RECYCLE_PAGES || 1);
const MEMORY_RECOVERY_WAIT_MS = Number(process.env.MEMORY_RECOVERY_WAIT_MS || 1800);
const MAX_PAGE_ERRORS = Number(process.env.MAX_PAGE_ERRORS || 8);
const MAX_ARTICLE_ERRORS = Number(process.env.MAX_ARTICLE_ERRORS || 20);

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

const jobs = new Map();
let activeJobId = null;

function createJob(payload) {
  pruneJobs();
  const job = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: "queued",
    payload,
    progress: {
      stage: "queued",
      message: "대기 중",
      boardIndex: 0,
      totalBoards: 0,
      scannedArticles: 0,
      totalArticlesInBoard: 0,
      collectedResults: 0,
      scannedPages: 0,
      collectedArticles: 0,
    },
    result: null,
    recentResults: [],
    partialResults: [],
    checkpoint: null,
    cancelRequested: false,
    error: null,
    diagnostics: [],
    startedAt: new Date().toISOString(),
    updatedAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status !== "running" && now - job.updatedAt > JOB_TTL_MS) jobs.delete(id);
  }
  const all = Array.from(jobs.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const job of all.slice(MAX_JOB_HISTORY)) {
    if (job.status !== "running") jobs.delete(job.id);
  }
}

function sendError(res, status, code, message) {
  return res.status(status).json({ ok: false, code, message });
}

function memorySnapshot() {
  const usage = process.memoryUsage();
  const containerBytes = readFirstExistingNumber([
    "/sys/fs/cgroup/memory.current",
    "/sys/fs/cgroup/memory/memory.usage_in_bytes",
  ]);
  return {
    rssMb: Math.round(usage.rss / 1024 / 1024),
    heapUsedMb: Math.round(usage.heapUsed / 1024 / 1024),
    containerMb: containerBytes ? Math.round(containerBytes / 1024 / 1024) : null,
  };
}

function isMemoryNearLimit() {
  const snapshot = memorySnapshot();
  return (snapshot.containerMb || snapshot.rssMb) >= MEMORY_PAUSE_RSS_MB;
}

function readFirstExistingNumber(files) {
  for (const file of files) {
    try {
      const value = Number(fs.readFileSync(file, "utf8").trim());
      if (Number.isFinite(value) && value > 0) return value;
    } catch (_error) {
      // Not running inside a Linux cgroup, fall back to process RSS.
    }
  }
  return null;
}

function parseSafeDateOnly(value, endOfDay = false) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const date = new Date(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sanitizeCrawlPayload(body = {}) {
  const allowedCollectionModes = new Set(["comments", "posts", "both"]);
  return {
    cafeUrl: String(body.cafeUrl || "").trim(),
    nickname: String(body.nickname || "").trim(),
    collectionMode: allowedCollectionModes.has(body.collectionMode) ? body.collectionMode : "comments",
    nicknameMatchType: body.nicknameMatchType === "contains" ? "contains" : "exact",
    caseSensitive: Boolean(body.caseSensitive),
    includeBoardId: String(body.includeBoardId || "all"),
    excludedBoardIds: Array.isArray(body.excludedBoardIds) ? body.excludedBoardIds.map(String) : [],
    startDate: String(body.startDate || "").trim(),
    endDate: String(body.endDate || "").trim(),
    minChars: Number(body.minChars || 0),
    maxChars: Number(body.maxChars || 0),
    crawlScope: body.crawlScope === "all" ? "all" : "limited",
    maxPages: Number(body.maxPages || 3),
    startPage: Number(body.startPage || 1),
    endPage: Number(body.endPage || 0),
    retries: Number(body.retries || 3),
    delayMs: Number(body.delayMs || 900),
  };
}

function validateCrawlPayload(payload) {
  if (!payload.cafeUrl) return "카페 URL은 필수입니다.";
  if (payload.collectionMode !== "posts" && !payload.nickname) return "댓글 수집에는 닉네임이 필수입니다.";
  if (!/^https?:\/\//i.test(payload.cafeUrl) && !/^cafe\.naver\.com\//i.test(payload.cafeUrl) && !/^[a-z0-9][a-z0-9_-]{1,}$/i.test(payload.cafeUrl)) {
    return "카페 URL 형식이 올바르지 않습니다.";
  }
  if (payload.minChars < 0 || payload.maxChars < 0) return "글자수 조건은 0 이상이어야 합니다.";
  if (payload.maxChars > 0 && payload.minChars > payload.maxChars) return "최소 글자수가 최대 글자수보다 클 수 없습니다.";
  if (payload.maxPages < 1 || payload.startPage < 1 || payload.endPage < 0 || payload.startPage > MAX_ALL_PAGES) return "페이지 범위를 확인하세요.";
  if (payload.maxPages > MAX_ALL_PAGES || payload.endPage > MAX_ALL_PAGES) return `페이지 범위는 최대 ${MAX_ALL_PAGES}페이지까지 가능합니다.`;
  return null;
}

class NaverCafeCrawler {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.currentCafeUrl = "";
  }

  async init() {
    if (this.page) return;
    const isProduction = process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);
    const launchOptions = [
      {
        headless: isProduction,
        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-extensions",
          "--disable-background-networking",
          "--disable-sync",
          "--disable-default-apps",
          "--disable-site-isolation-trials",
          "--disable-features=IsolateOrigins,site-per-process,Translate,BackForwardCache",
          "--js-flags=--max-old-space-size=128",
        ],
      },
      {
        headless: isProduction,
        channel: "chromium",
        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-extensions",
          "--disable-background-networking",
          "--disable-sync",
          "--disable-default-apps",
          "--disable-site-isolation-trials",
          "--disable-features=IsolateOrigins,site-per-process,Translate,BackForwardCache",
          "--js-flags=--max-old-space-size=128",
        ],
      },
      { headless: false, channel: "msedge", args: ["--start-maximized"] },
      { headless: false, channel: "chrome", args: ["--start-maximized"] },
    ];
    const launchErrors = [];

    for (const option of launchOptions) {
      try {
        this.browser = await chromium.launch(option);
        break;
      } catch (error) {
        launchErrors.push(error?.message || String(error));
      }
    }

    if (!this.browser) {
      throw new Error(`브라우저 실행에 실패했습니다. (${launchErrors.join(" | ")})`);
    }

    this.context = await this.browser.newContext({
      viewport: isProduction ? { width: 1280, height: 800 } : null,
      serviceWorkers: "block",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    });
    await this.context.route("**/*", async (route) => {
      const request = route.request();
      const type = request.resourceType();
      if (["image", "media", "font", "stylesheet"].includes(type)) return route.abort();
      return route.continue();
    });
    await this.applyCookieEnv();
    this.page = await this.context.newPage();
  }

  async applyCookieEnv() {
    const cookieHeader = process.env.NAVER_COOKIE;
    if (!cookieHeader) return;
    const cookies = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf("=");
        if (idx < 0) return null;
        return {
          name: part.slice(0, idx).trim(),
          value: part.slice(idx + 1).trim(),
          domain: ".naver.com",
          path: "/",
          httpOnly: false,
          secure: true,
          sameSite: "Lax",
        };
      })
      .filter(Boolean);
    if (cookies.length) await this.context.addCookies(cookies);
  }

  async close() {
    if (this.browser) await this.browser.close();
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async recycleBrowser() {
    await this.close();
    await this.init();
  }

  async releaseBrowserMemory() {
    await this.close();
    await new Promise((resolve) => setTimeout(resolve, MEMORY_RECOVERY_WAIT_MS));
    return memorySnapshot();
  }

  compactError(error) {
    return String(error?.message || error || "알 수 없는 오류").replace(/\s+/g, " ").slice(0, 500);
  }

  normalizeSpace(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  normalizeCafeUrl(input) {
    const value = String(input || "").trim();
    if (!value) return "";
    if (/^https?:\/\//i.test(value)) return value;
    if (/^cafe\.naver\.com\//i.test(value)) return `https://${value}`;
    return `https://cafe.naver.com/${value.replace(/^\/+/, "")}`;
  }

  isLoginUrl(url) {
    return /nidlogin\.login|\/login/i.test(url || "");
  }

  async gotoCafe(cafeUrl) {
    await this.init();
    const normalized = this.normalizeCafeUrl(cafeUrl);
    this.currentCafeUrl = normalized;
    await this.gotoWithRetry(normalized, { attempts: 3, delayMs: 1000, timeout: 60000 });
    await this.page.waitForTimeout(1000);
    return normalized;
  }

  resolveHref(href) {
    if (!href) return null;
    if (href.startsWith("http")) return href;
    if (href.startsWith("/")) return `https://cafe.naver.com${href}`;
    return `https://cafe.naver.com/${href}`;
  }

  parseMenuId(raw) {
    const text = String(raw || "");
    const patterns = [
      /[?&](?:search\.)?menuid=(\d+)/i,
      /\/menus\/(\d+)/i,
      /(?:goMenu|moveMenu|goArticleList|showArticleList)\s*\(\s*['"]?(\d+)/i,
      /(?:menuid|menuId)[^0-9]{0,10}(\d+)/i,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  parseArticleId(raw) {
    const text = String(raw || "");
    const patterns = [/[?&]articleid=(\d+)/i, /\/articles\/(\d+)/i, /articleid[^0-9]{0,10}(\d+)/i];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  parseDate(text) {
    const cleaned = this.normalizeSpace(text);
    if (!cleaned) return null;
    const now = new Date();
    let m = cleaned.match(/(\d+)\s*분\s*전/);
    if (m) return new Date(now.getTime() - Number(m[1]) * 60000);
    m = cleaned.match(/(\d+)\s*시간\s*전/);
    if (m) return new Date(now.getTime() - Number(m[1]) * 3600000);
    m = cleaned.match(/(\d+)\s*일\s*전/);
    if (m) return new Date(now.getTime() - Number(m[1]) * 86400000);
    m = cleaned.match(/(\d{1,2}):(\d{2})/);
    if (m) return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2]));
    m = cleaned.match(/^(\d{4})[./-]\s*(\d{1,2})[./-]\s*(\d{1,2})\.?\s*(\d{1,2})?:?(\d{2})?/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0));
    m = cleaned.match(/^(\d{1,2})[./-]\s*(\d{1,2})\.?\s*(\d{1,2})?:?(\d{2})?/);
    if (m) return new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]), Number(m[3] || 0), Number(m[4] || 0));
    return null;
  }

  makeResultKey(row) {
    return [row.type, row.nickname, row.boardName, row.title, row.url, row.comment, row.writtenAt]
      .map((value) => this.normalizeSpace(value))
      .join("\u001F");
  }

  matchText(actual, expected, matchType = "exact", caseSensitive = false) {
    const a = this.normalizeSpace(actual);
    const b = this.normalizeSpace(expected);
    if (!a || !b) return false;
    const left = caseSensitive ? a : a.toLowerCase();
    const right = caseSensitive ? b : b.toLowerCase();
    return matchType === "contains" ? left.includes(right) : left === right;
  }

  async getBoards(cafeUrl) {
    await this.gotoCafe(cafeUrl);
    if (this.isLoginUrl(this.page.url())) {
      return {
        ok: false,
        needsLogin: true,
        message: process.env.NODE_ENV === "production"
          ? "로그인이 필요합니다. Render 환경변수 NAVER_COOKIE에 네이버 쿠키를 설정하세요."
          : "열린 브라우저에서 네이버 로그인 후 다시 시도하세요.",
      };
    }

    const boards = await this.page.evaluate(() => {
      const selectors = [
        "a[href*='menuid=']",
        "a[href*='/menus/']",
        "[data-menuid]",
        "[data-menu-id]",
        "[onclick*='goMenu']",
        "[onclick*='menuid']",
      ];
      const nodes = new Set(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))));
      return Array.from(nodes).map((node) => ({
        text: (node.textContent || node.getAttribute("title") || node.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim(),
        href: node.getAttribute("href") || "",
        onclick: node.getAttribute("onclick") || "",
        dataMenuId: node.getAttribute("data-menuid") || node.getAttribute("data-menu-id") || "",
      }));
    });

    const map = new Map();
    for (const row of boards) {
      const menuId = this.parseMenuId([row.href, row.onclick, row.dataMenuId].join(" "));
      if (!menuId) continue;
      const name = row.text || `게시판 ${menuId}`;
      const url = row.href
        ? this.resolveHref(row.href)
        : `${this.normalizeCafeUrl(cafeUrl).replace(/\/$/, "")}/ArticleList.nhn?search.menuid=${menuId}`;
      if (!map.has(menuId)) map.set(menuId, { id: menuId, name, url });
    }

    return {
      ok: true,
      boards: Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, "ko")),
    };
  }

  buildBoardPageUrl(boardUrl, pageNo) {
    try {
      const u = new URL(boardUrl);
      const hasSearchMenuId = u.searchParams.has("search.menuid");
      const isArticleList = /ArticleList\.nhn/i.test(u.pathname);
      if (hasSearchMenuId || isArticleList) {
        u.searchParams.set("search.page", String(pageNo));
        if (!u.searchParams.has("userDisplay")) u.searchParams.set("userDisplay", "50");
      } else {
        u.searchParams.set("page", String(pageNo));
      }
      return u.toString();
    } catch (_error) {
      const joiner = boardUrl.includes("?") ? "&" : "?";
      return `${boardUrl}${joiner}search.page=${pageNo}`;
    }
  }

  async gotoWithRetry(url, options = {}) {
    await this.init();
    const attempts = Math.max(1, Number(options.attempts || 3));
    let lastError = null;
    for (let i = 0; i < attempts; i += 1) {
      try {
        await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeout || 60000 });
        return;
      } catch (error) {
        lastError = error;
        const message = String(error?.message || "");
        if (/net::ERR_ABORTED/i.test(message)) {
          await this.page.waitForTimeout(options.delayMs || 700);
          if (!this.isLoginUrl(this.page.url())) return;
        }
        await this.page.waitForTimeout(options.delayMs || 700);
      }
    }
    throw lastError;
  }

  async collectArticleLinks(boardUrl, options = {}, onProgress = null, shouldStop = null) {
    const { crawlScope = "limited", maxPages = 3, startPage = 1, endPage = 0, retries = 3, delayMs = 900 } = options;
    const links = new Map();
    const safeStartPage = Math.max(1, Number(startPage) || 1);
    const safeEndPageInput = Math.max(0, Number(endPage) || 0);
    const fallbackLimitedEnd = safeStartPage + Math.max(1, Number(maxPages) || 3) - 1;
    const finalEndPage = Math.max(safeStartPage, safeEndPageInput > 0 ? safeEndPageInput : crawlScope === "all" ? MAX_ALL_PAGES : fallbackLimitedEnd);
    let stableEmptyCount = 0;
    let previousSignature = "";
    let stableSamePageCount = 0;

    for (let pageNo = safeStartPage; pageNo <= finalEndPage; pageNo += 1) {
      if (shouldStop?.()) return { ok: false, cancelled: true, message: "사용자 요청으로 크롤링이 취소되었습니다.", articles: Array.from(links.values()) };
      const url = this.buildBoardPageUrl(boardUrl, pageNo);
      await this.gotoWithRetry(url, { attempts: retries, delayMs, timeout: 60000 });
      await this.page.waitForTimeout(delayMs);
      if (this.isLoginUrl(this.page.url())) return { ok: false, needsLogin: true, message: "크롤링 중 로그인 세션이 만료되었습니다." };

      const pageLinks = await this.page.evaluate(() => {
        const parseArticleId = (raw) => {
          const text = String(raw || "");
          for (const pattern of [/[?&]articleid=(\d+)/i, /\/articles\/(\d+)/i, /articleid[^0-9]{0,10}(\d+)/i]) {
            const match = text.match(pattern);
            if (match) return match[1];
          }
          return null;
        };
        const parseCommentCount = (node) => {
          const candidates = [];
          const near = node.closest("tr, li, .article, .inner_list")?.querySelector(".num_comment, .comment_count, [class*='comment'], em, strong");
          if (near) candidates.push(near.textContent || "");
          candidates.push(node.textContent || "");
          for (const raw of candidates) {
            const t = String(raw || "").replace(/\s+/g, " ").trim();
            let m = t.match(/댓글\s*[:：]?\s*(\d{1,5})/i);
            if (m) return Number(m[1]);
            m = t.match(/\((\d{1,5})\)\s*$/);
            if (m) return Number(m[1]);
          }
          return null;
        };
        const selectors = [
          "a[href*='ArticleRead.nhn'][href*='articleid=']",
          "a[href*='articleid='][href*='menuid=']",
          "a[href*='/articles/']",
          "[onclick*='articleid=']",
          "[data-articleid]",
        ];
        const nodes = new Set(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))));
        const result = [];
        for (const node of nodes) {
          const href = node.getAttribute?.("href") || "";
          const onclick = node.getAttribute?.("onclick") || "";
          const dataArticleId = node.getAttribute?.("data-articleid") || "";
          const articleId = parseArticleId([href, onclick, dataArticleId].join(" "));
          if (!articleId) continue;
          let absolute = href || `/ArticleRead.nhn?articleid=${articleId}`;
          absolute = absolute.startsWith("http") ? absolute : absolute.startsWith("/") ? `https://cafe.naver.com${absolute}` : `https://cafe.naver.com/${absolute}`;
          const title = (node.textContent || "").replace(/\s+/g, " ").trim();
          result.push({ articleId, url: absolute, title: title || "(제목 없음)", commentCount: parseCommentCount(node) });
        }
        return result;
      });

      if (!pageLinks.length) {
        stableEmptyCount += 1;
        if (stableEmptyCount >= 2) break;
      } else {
        stableEmptyCount = 0;
      }

      const signature = pageLinks.slice(0, 5).map((item) => item.articleId).join("|");
      stableSamePageCount = signature && signature === previousSignature ? stableSamePageCount + 1 : 0;
      previousSignature = signature;
      if (stableSamePageCount >= 2) break;

      for (const item of pageLinks) links.set(item.articleId, item);
      onProgress?.({
        stage: "collect_articles",
        message: `게시글 수집 중: 페이지 ${pageNo}/${finalEndPage}`,
        scannedPages: pageNo,
        collectedArticles: links.size,
      });
    }
    return { ok: true, articles: Array.from(links.values()) };
  }

  getBoardPagePlan(options = {}) {
    const { crawlScope = "limited", maxPages = 3, startPage = 1, endPage = 0 } = options;
    const safeStartPage = Math.max(1, Number(startPage) || 1);
    const safeEndPageInput = Math.max(0, Number(endPage) || 0);
    const fallbackLimitedEnd = safeStartPage + Math.max(1, Number(maxPages) || 3) - 1;
    const finalEndPage = Math.max(
      safeStartPage,
      safeEndPageInput > 0 ? safeEndPageInput : crawlScope === "all" ? MAX_ALL_PAGES : fallbackLimitedEnd
    );
    return { safeStartPage, finalEndPage };
  }

  async collectArticleLinksPage(boardUrl, pageNo, options = {}, shouldStop = null) {
    const { retries = 3, delayMs = 900 } = options;
    if (shouldStop?.()) return { ok: false, cancelled: true, message: "사용자 요청으로 크롤링이 취소되었습니다.", articles: [] };
    const url = this.buildBoardPageUrl(boardUrl, pageNo);
    await this.gotoWithRetry(url, { attempts: retries, delayMs, timeout: 60000 });
    await this.page.waitForTimeout(delayMs);
    if (this.isLoginUrl(this.page.url())) return { ok: false, needsLogin: true, message: "크롤링 중 로그인 세션이 만료되었습니다." };

    const articles = await this.page.evaluate(() => {
      const parseArticleId = (raw) => {
        const text = String(raw || "");
        for (const pattern of [/[?&]articleid=(\d+)/i, /\/articles\/(\d+)/i, /articleid[^0-9]{0,10}(\d+)/i]) {
          const match = text.match(pattern);
          if (match) return match[1];
        }
        return null;
      };
      const parseCommentCount = (node) => {
        const candidates = [];
        const near = node.closest("tr, li, .article, .inner_list")?.querySelector(".num_comment, .comment_count, [class*='comment'], em, strong");
        if (near) candidates.push(near.textContent || "");
        candidates.push(node.textContent || "");
        for (const raw of candidates) {
          const t = String(raw || "").replace(/\s+/g, " ").trim();
          let m = t.match(/댓글\s*[:：]?\s*(\d{1,5})/i);
          if (m) return Number(m[1]);
          m = t.match(/\((\d{1,5})\)\s*$/);
          if (m) return Number(m[1]);
        }
        return null;
      };
      const selectors = [
        "a[href*='ArticleRead.nhn'][href*='articleid=']",
        "a[href*='articleid='][href*='menuid=']",
        "a[href*='/articles/']",
        "[onclick*='articleid=']",
        "[data-articleid]",
      ];
      const nodes = new Set(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))));
      const result = [];
      const seen = new Set();
      for (const node of nodes) {
        const href = node.getAttribute?.("href") || "";
        const onclick = node.getAttribute?.("onclick") || "";
        const dataArticleId = node.getAttribute?.("data-articleid") || "";
        const articleId = parseArticleId([href, onclick, dataArticleId].join(" "));
        if (!articleId || seen.has(articleId)) continue;
        seen.add(articleId);
        let absolute = href || `/ArticleRead.nhn?articleid=${articleId}`;
        absolute = absolute.startsWith("http") ? absolute : absolute.startsWith("/") ? `https://cafe.naver.com${absolute}` : `https://cafe.naver.com/${absolute}`;
        const title = (node.textContent || "").replace(/\s+/g, " ").trim();
        result.push({ articleId, url: absolute, title: title || "(제목 없음)", commentCount: parseCommentCount(node) });
      }
      return result;
    });

    return { ok: true, articles };
  }

  async extractArticleAndComments(articleUrl, boardName, options = {}, shouldStop = null) {
    const { retries = 3, delayMs = 800, nickname = "", nicknameMatchType = "exact", caseSensitive = false } = options;
    await this.gotoWithRetry(articleUrl, { attempts: retries, delayMs, timeout: 60000 });
    await this.page.waitForTimeout(delayMs);
    if (shouldStop?.()) return { ok: false, cancelled: true, comments: [] };

    const frames = this.page.frames();
    const matchedComments = [];
    let articleInfo = {
      title: "(제목 없음)",
      author: "",
      content: "",
      writtenAt: "",
    };
    let sawCommentWord = false;
    let detectedCommentRows = 0;

    for (const frame of frames) {
      let payload = null;
      try {
        payload = await frame.evaluate(({ inputNickname, matchType, isCaseSensitive }) => {
          const norm = (value) => String(value || "").trim();
          const matchNickname = (actual) => {
            const a = norm(actual);
            const b = norm(inputNickname);
            if (!a || !b) return false;
            const left = isCaseSensitive ? a : a.toLowerCase();
            const right = isCaseSensitive ? b : b.toLowerCase();
            return matchType === "contains" ? left.includes(right) : left === right;
          };
          const pickText = (selectors) => {
            for (const selector of selectors) {
              const el = document.querySelector(selector);
              const text = (el?.textContent || "").replace(/\s+/g, " ").trim();
              if (text) return text;
            }
            return "";
          };
          const titleEl = document.querySelector("h3, .title_text, .ArticleTitle, .article_title");
          const frameTitle = (titleEl?.textContent || "").trim();
          const articleAuthor = pickText([
            ".nick_box .nickname",
            ".article_writer",
            ".writer",
            ".nickname",
            "button[class*='nickname']",
            "a[class*='nickname']",
          ]);
          const articleContent = pickText([
            ".se-main-container",
            ".article_viewer",
            ".ArticleContentBox",
            "#tbody",
            ".content",
          ]);
          const articleDate = pickText([
            ".date",
            ".article_info .date",
            ".ArticleTool .date",
            "span[class*='date']",
            "time",
          ]);
          const bodyText = document.body?.innerText || "";
          const hasCommentWord = /댓글|comment/i.test(bodyText);
          const blocks = Array.from(document.querySelectorAll(".CommentItem, .comment_item, .comment_box, li[class*='CommentItem'], div[class*='comment'], li[class*='comment']"));
          const rows = [];
          for (const block of blocks) {
            const nick = block.querySelector(".comment_nick, .nickname, .nick, a[class*='nick'], span[class*='nick']")?.textContent || "";
            const content = block.querySelector(".comment_text, .text_comment, .comment, p, span")?.textContent || "";
            const writtenAt = block.querySelector(".comment_info_date, .date, time, .txt_date, span[class*='date']")?.textContent || "";
            if (!nick.trim() && !content.trim()) continue;
            rows.push({ nickname: nick.trim(), content: content.trim(), writtenAt: writtenAt.trim() });
          }
          return {
            article: {
              title: frameTitle,
              author: articleAuthor,
              content: articleContent,
              writtenAt: articleDate,
            },
            hasCommentWord,
            rows,
            matchedRows: rows.filter((row) => matchNickname(row.nickname)),
          };
        }, { inputNickname: nickname, matchType: nicknameMatchType, isCaseSensitive: caseSensitive });
      } catch (_error) {
        payload = null;
      }
      if (!payload) continue;
      if (payload.article?.title && payload.article.title !== "(제목 없음)") articleInfo.title = payload.article.title;
      if (payload.article?.author && !articleInfo.author) articleInfo.author = payload.article.author;
      if (payload.article?.content && payload.article.content.length > articleInfo.content.length) articleInfo.content = payload.article.content;
      if (payload.article?.writtenAt && !articleInfo.writtenAt) articleInfo.writtenAt = payload.article.writtenAt;
      if (payload.hasCommentWord) sawCommentWord = true;
      detectedCommentRows += Array.isArray(payload.rows) ? payload.rows.length : 0;
      matchedComments.push(...(payload.matchedRows || []));
    }

    return {
      ok: true,
      ...articleInfo,
      url: articleUrl,
      boardName,
      comments: matchedComments,
      selectorRisk: sawCommentWord && detectedCommentRows === 0,
    };
  }

  async crawl(payload, onProgress = null, shouldStop = null, checkpoint = null) {
    const start = parseSafeDateOnly(payload.startDate);
    const end = parseSafeDateOnly(payload.endDate, true);
    const minChars = Number(payload.minChars || 0);
    const maxChars = Number(payload.maxChars || 0);
    const collectPosts = payload.collectionMode === "posts" || payload.collectionMode === "both";
    const collectComments = payload.collectionMode === "comments" || payload.collectionMode === "both";

    const boardResult = await this.getBoards(payload.cafeUrl);
    if (!boardResult.ok) return boardResult;
    await this.close();

    let boards = boardResult.boards;
    if (payload.includeBoardId && payload.includeBoardId !== "all") boards = boards.filter((board) => board.id === payload.includeBoardId);
    const excluded = new Set(payload.excludedBoardIds || []);
    boards = boards.filter((board) => !excluded.has(board.id));
    if (!boards.length) return { ok: false, message: "수집할 게시판이 없습니다." };

    const results = [];
    const seenResultKeys = new Set();
    const diagnostics = Array.isArray(checkpoint?.diagnostics) ? [...checkpoint.diagnostics] : [];
    let selectorRiskCount = 0;
    let truncatedResults = 0;
    let pageErrorCount = Number(checkpoint?.pageErrorCount || 0);
    let articleErrorCount = Number(checkpoint?.articleErrorCount || 0);
    if (Array.isArray(checkpoint?.results)) {
      for (const row of checkpoint.results) {
        results.push(row);
        seenResultKeys.add(this.makeResultKey(row));
      }
    }
    truncatedResults = Number(checkpoint?.truncatedResults || 0);
    const emitPartialResults = (message) => {
      onProgress?.({
        stage: "result_update",
        message,
        collectedResults: results.length,
        truncatedResults,
        partialResults: results.slice(-MAX_RESULT_ROWS),
        recentResults: results.slice(-PROGRESS_PREVIEW_LIMIT),
      });
    };
    const addResult = (row, messagePrefix) => {
      const key = this.makeResultKey(row);
      if (seenResultKeys.has(key)) return;
      seenResultKeys.add(key);
      if (results.length >= MAX_RESULT_ROWS) {
        truncatedResults += 1;
        return;
      }
      results.push(row);
      emitPartialResults(`${messagePrefix}: ${results.length}건`);
    };
    const pauseForMemory = (nextCheckpoint) => ({
      ok: false,
      paused: true,
      message: `메모리 사용량이 ${memorySnapshot().containerMb || memorySnapshot().rssMb}MB까지 올라가 작업을 일시정지했습니다. 계속하려면 재개하세요.`,
      partialResults: results,
      truncatedResults,
      diagnostics,
      checkpoint: {
        ...nextCheckpoint,
        results,
        truncatedResults,
        diagnostics,
        pageErrorCount,
        articleErrorCount,
      },
    });
    const recordDiagnostic = (message, fields = {}) => {
      const row = {
        at: new Date().toISOString(),
        message,
        ...fields,
        memory: memorySnapshot(),
      };
      diagnostics.push(row);
      if (diagnostics.length > 50) diagnostics.shift();
      onProgress?.({
        stage: "diagnostic",
        message,
        diagnostics,
        memory: row.memory,
        collectedResults: results.length,
        recentResults: results.slice(-PROGRESS_PREVIEW_LIMIT),
      });
    };
    const recoverMemoryOrPause = async (nextCheckpoint) => {
      const before = memorySnapshot();
      recordDiagnostic(`메모리 회수 시도 중: ${before.containerMb || before.rssMb}MB`, nextCheckpoint);
      const after = await this.releaseBrowserMemory();
      if ((after.containerMb || after.rssMb) >= MEMORY_PAUSE_RSS_MB) return pauseForMemory(nextCheckpoint);
      recordDiagnostic(`브라우저 재시작 전 메모리 회수 완료: ${after.containerMb || after.rssMb}MB`, nextCheckpoint);
      return null;
    };

    onProgress?.({ stage: "crawl", message: "크롤링 시작", totalBoards: boards.length, collectedResults: 0 });
    const startBoardIndex = Number(checkpoint?.boardIndex || 0);
    let processedArticlesSinceRecycle = 0;
    let processedPagesSinceRecycle = 0;
    for (let boardIndex = startBoardIndex; boardIndex < boards.length; boardIndex += 1) {
      const board = boards[boardIndex];
      if (shouldStop?.()) return { ok: false, cancelled: true, message: "사용자 요청으로 크롤링이 취소되었습니다.", partialResults: results };
      onProgress?.({ stage: "board", message: `게시판 처리 중: ${board.name}`, boardIndex: boardIndex + 1, totalBoards: boards.length, collectedResults: results.length });

      const { safeStartPage, finalEndPage } = this.getBoardPagePlan(payload);
      const firstPage = boardIndex === startBoardIndex ? Number(checkpoint?.pageNo || safeStartPage) : safeStartPage;
      let stableEmptyCount = 0;
      let previousSignature = "";
      let stableSamePageCount = 0;

      for (let pageNo = firstPage; pageNo <= finalEndPage; pageNo += 1) {
        if (shouldStop?.()) return { ok: false, cancelled: true, message: "사용자 요청으로 크롤링이 취소되었습니다.", partialResults: results };
        if (isMemoryNearLimit()) {
          const paused = await recoverMemoryOrPause({ boardIndex, pageNo, articleIndex: 0 });
          if (paused) return paused;
        }

        let pageResult = null;
        try {
          pageResult = await this.collectArticleLinksPage(board.url, pageNo, payload, shouldStop);
        } catch (error) {
          pageErrorCount += 1;
          recordDiagnostic(`페이지 ${pageNo} 게시글 목록 조회 실패: ${this.compactError(error)}`, { boardIndex, pageNo, pageErrorCount });
          await this.releaseBrowserMemory();
          if (pageErrorCount >= MAX_PAGE_ERRORS) {
            return {
              ok: false,
              message: `페이지 조회 실패가 ${pageErrorCount}회 발생해 중단했습니다. 마지막 오류: ${this.compactError(error)}`,
              partialResults: results,
              diagnostics,
            };
          }
          continue;
        }
        if (!pageResult.ok) {
          if (pageResult.cancelled) return { ...pageResult, partialResults: results };
          return pageResult;
        }

        const articles = pageResult.articles || [];
        processedPagesSinceRecycle += 1;
        if (processedPagesSinceRecycle >= BROWSER_RECYCLE_PAGES) {
          await this.close();
          processedPagesSinceRecycle = 0;
        }
        if (!articles.length) {
          stableEmptyCount += 1;
          if (stableEmptyCount >= 2) break;
        } else {
          stableEmptyCount = 0;
        }

        const signature = articles.slice(0, 5).map((item) => item.articleId).join("|");
        stableSamePageCount = signature && signature === previousSignature ? stableSamePageCount + 1 : 0;
        previousSignature = signature;
        if (stableSamePageCount >= 2) break;

        onProgress?.({
          stage: "collect_articles",
          message: `게시글 수집 중: 페이지 ${pageNo}/${finalEndPage}`,
          boardIndex: boardIndex + 1,
          totalBoards: boards.length,
          scannedPages: pageNo,
          collectedArticles: articles.length,
          collectedResults: results.length,
          recentResults: results.slice(-PROGRESS_PREVIEW_LIMIT),
        });

        const firstArticleIndex =
          boardIndex === startBoardIndex && pageNo === firstPage ? Number(checkpoint?.articleIndex || 0) : 0;
        for (let i = firstArticleIndex; i < articles.length; i += 1) {
          if (shouldStop?.()) return { ok: false, cancelled: true, message: "사용자 요청으로 크롤링이 취소되었습니다.", partialResults: results };
          if (isMemoryNearLimit()) {
            const paused = await recoverMemoryOrPause({ boardIndex, pageNo, articleIndex: i });
            if (paused) return paused;
          }
          const article = articles[i];
          onProgress?.({
            stage: "article_scan",
            message: `게시글 확인 중: ${i + 1}/${articles.length} (페이지 ${pageNo}/${finalEndPage})`,
            boardIndex: boardIndex + 1,
            totalBoards: boards.length,
            scannedArticles: i + 1,
            totalArticlesInBoard: articles.length,
            collectedResults: results.length,
            recentResults: results.slice(-PROGRESS_PREVIEW_LIMIT),
          });

          let extracted = null;
          try {
            extracted = await this.extractArticleAndComments(article.url, board.name, payload, shouldStop);
          } catch (error) {
            articleErrorCount += 1;
            recordDiagnostic(`게시글 조회 실패: ${this.compactError(error)}`, {
              boardIndex,
              pageNo,
              articleIndex: i,
              articleUrl: article.url,
              articleErrorCount,
            });
            await this.releaseBrowserMemory();
            if (articleErrorCount >= MAX_ARTICLE_ERRORS) {
              return {
                ok: false,
                message: `게시글 조회 실패가 ${articleErrorCount}회 발생해 중단했습니다. 마지막 오류: ${this.compactError(error)}`,
                partialResults: results,
                diagnostics,
              };
            }
            continue;
          }
          processedArticlesSinceRecycle += 1;
          if (!extracted.ok) {
            if (processedArticlesSinceRecycle >= BROWSER_RECYCLE_ARTICLES) {
              await this.close();
              processedArticlesSinceRecycle = 0;
            }
            if (extracted.cancelled) return { ok: false, cancelled: true, message: "사용자 요청으로 크롤링이 취소되었습니다.", partialResults: results };
            continue;
          }
          if (extracted.selectorRisk) selectorRiskCount += 1;

          if (collectPosts) {
            const articleContent = this.normalizeSpace(extracted.content || article.title || "");
            const articleCharCount = articleContent.replace(/\s/g, "").length;
            const articleDate = this.parseDate(extracted.writtenAt);
            const authorMatches = payload.nickname
              ? this.matchText(extracted.author, payload.nickname, payload.nicknameMatchType, payload.caseSensitive)
              : true;
            if (
              authorMatches &&
              (!Number.isFinite(minChars) || articleCharCount >= minChars) &&
              (!Number.isFinite(maxChars) || maxChars <= 0 || articleCharCount <= maxChars) &&
              (!start || (articleDate && articleDate >= start)) &&
              (!end || (articleDate && articleDate <= end))
            ) {
              const row = {
                type: "게시글",
                nickname: extracted.author || "",
                boardName: board.name,
                title: extracted.title || article.title,
                url: extracted.url || article.url,
                comment: articleContent,
                writtenAt: extracted.writtenAt,
                parsedDate: articleDate ? articleDate.toISOString() : "",
                charCount: articleCharCount,
              };
              addResult(row, "게시글 수집됨");
            }
          }

          if (collectComments) {
            for (const comment of extracted.comments) {
              const normalized = this.normalizeSpace(comment.content);
              const charCount = normalized.replace(/\s/g, "").length;
              if (Number.isFinite(minChars) && charCount < minChars) continue;
              if (Number.isFinite(maxChars) && maxChars > 0 && charCount > maxChars) continue;
              const dt = this.parseDate(comment.writtenAt);
              if (start && (!dt || dt < start)) continue;
              if (end && (!dt || dt > end)) continue;
              const row = {
                type: "댓글",
                nickname: comment.nickname,
                boardName: board.name,
                title: extracted.title || article.title,
                url: extracted.url || article.url,
                comment: normalized,
                writtenAt: comment.writtenAt,
                parsedDate: dt ? dt.toISOString() : "",
                charCount,
              };
              addResult(row, "댓글 수집됨");
            }
          }

          if (processedArticlesSinceRecycle >= BROWSER_RECYCLE_ARTICLES) {
            await this.close();
            processedArticlesSinceRecycle = 0;
          }
        }
      }
    }

    return {
      ok: true,
      needsLogin: false,
      needsPermission: false,
      nicknameFound: results.length > 0,
      selectorRiskCount,
      truncatedResults,
      diagnostics,
      results,
    };
  }
}

const activeJobCrawlers = new Map();

function applyProgress(job, progress) {
  job.progress = { ...job.progress, ...progress };
  if (Array.isArray(progress.partialResults)) job.partialResults = progress.partialResults;
  if (Array.isArray(progress.recentResults)) job.recentResults = progress.recentResults;
  if (Array.isArray(progress.diagnostics)) job.diagnostics = progress.diagnostics;
  if (progress.memory) job.progress.memory = progress.memory;
  else if (Number.isFinite(progress.collectedResults)) job.progress.collectedResults = progress.collectedResults;
  job.updatedAt = Date.now();
}

function applyCrawlerResult(job, result) {
  job.result = result;
  if (result.paused) {
    job.status = "paused";
    job.error = result.message || "메모리 보호로 일시정지되었습니다.";
    job.checkpoint = result.checkpoint || job.checkpoint;
  } else {
    job.status = result.ok ? "done" : result.cancelled ? "cancelled" : "failed";
    if (!result.ok) job.error = result.message || "크롤링 실패";
    if (result.ok) job.checkpoint = null;
  }
  if (Array.isArray(result.results)) {
    job.partialResults = result.results;
    job.recentResults = result.results.slice(-PROGRESS_PREVIEW_LIMIT);
  }
  if (Array.isArray(result.partialResults)) {
    job.partialResults = result.partialResults;
    job.recentResults = result.partialResults.slice(-PROGRESS_PREVIEW_LIMIT);
  }
  if (Array.isArray(result.diagnostics)) job.diagnostics = result.diagnostics;
  job.progress = {
    ...job.progress,
    collectedResults: job.partialResults.length,
    diagnostics: job.diagnostics,
    memory: memorySnapshot(),
    message: result.message || job.progress.message,
  };
}

function runCrawlJob(job) {
  activeJobId = job.id;
  job.status = "running";
  job.cancelRequested = false;
  job.error = null;
  job.progress = { ...job.progress, stage: "starting", message: job.checkpoint ? "중단 지점부터 재개 중" : "브라우저 시작 중" };
  job.updatedAt = Date.now();
  const crawler = new NaverCafeCrawler();
  activeJobCrawlers.set(job.id, crawler);

  setImmediate(async () => {
    try {
      const result = await crawler.crawl(
        job.payload,
        (progress) => applyProgress(job, progress),
        () => job.cancelRequested,
        job.checkpoint
      );
      applyCrawlerResult(job, result);
    } catch (error) {
      job.status = "failed";
      job.error = error.message;
      job.result = { ok: false, message: `크롤링 실패: ${error.message}`, partialResults: job.partialResults };
    } finally {
      try {
        await crawler.close();
      } catch (closeError) {
        console.error(`Failed to close browser: ${closeError.message}`);
      }
      activeJobCrawlers.delete(job.id);
      job.updatedAt = Date.now();
      if (activeJobId === job.id) activeJobId = null;
      pruneJobs();
    }
  });
}

app.post("/api/boards", async (req, res) => {
  const crawler = new NaverCafeCrawler();
  try {
    const { cafeUrl } = req.body || {};
    if (!cafeUrl) return sendError(res, 400, "INVALID_CAFE_URL", "카페 URL을 입력하세요.");
    const result = await crawler.getBoards(cafeUrl);
    return res.json(result);
  } catch (error) {
    return sendError(res, 500, "BOARD_LOAD_FAILED", `게시판 조회 실패: ${error.message}`);
  } finally {
    try {
      await crawler.close();
    } catch (closeError) {
      console.error(`Failed to close board browser: ${closeError.message}`);
    }
  }
});

app.post("/api/crawl/start", (req, res) => {
  const payload = sanitizeCrawlPayload(req.body || {});
  const error = validateCrawlPayload(payload);
  if (error) return sendError(res, 400, "INVALID_PAYLOAD", error);
  if (activeJobId && jobs.get(activeJobId)?.status === "running") {
    return sendError(res, 409, "JOB_RUNNING", "이미 실행 중인 크롤링이 있습니다.");
  }

  const job = createJob(payload);
  runCrawlJob(job);

  return res.json({ ok: true, jobId: job.id });
});

app.post("/api/crawl/resume/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return sendError(res, 404, "JOB_NOT_FOUND", "작업을 찾을 수 없습니다.");
  if (job.status !== "paused" || !job.checkpoint) return sendError(res, 400, "JOB_NOT_PAUSED", "재개할 수 있는 일시정지 작업이 아닙니다.");
  if (activeJobId && jobs.get(activeJobId)?.status === "running") {
    return sendError(res, 409, "JOB_RUNNING", "이미 실행 중인 크롤링이 있습니다.");
  }
  runCrawlJob(job);
  return res.json({ ok: true, jobId: job.id });
});

app.get("/api/crawl/progress/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return sendError(res, 404, "JOB_NOT_FOUND", "작업을 찾을 수 없습니다.");
  return res.json({
    ok: true,
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error,
    diagnostics: job.diagnostics,
    memory: memorySnapshot(),
    result: ["done", "failed", "cancelled", "paused"].includes(job.status) ? job.result : null,
    recentResults: job.recentResults,
  });
});

app.post("/api/crawl/cancel/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return sendError(res, 404, "JOB_NOT_FOUND", "작업을 찾을 수 없습니다.");
  job.cancelRequested = true;
  job.updatedAt = Date.now();
  return res.json({ ok: true });
});

app.post("/api/reset", async (_req, res) => {
  try {
    await Promise.all(Array.from(activeJobCrawlers.values()).map((crawler) => crawler.close().catch(() => null)));
    activeJobCrawlers.clear();
    activeJobId = null;
    jobs.clear();
    return res.json({ ok: true });
  } catch (error) {
    return sendError(res, 500, "RESET_FAILED", `초기화 실패: ${error.message}`);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server started: http://0.0.0.0:${PORT}`);
});
