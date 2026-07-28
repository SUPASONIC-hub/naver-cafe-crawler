const state = {
  boards: [],
  excludedBoards: [],
  results: [],
  filteredResults: [],
  currentJobId: null,
  pausedJobId: null,
  boardsCafeUrl: "",
  progressTimer: null,
  autoResumeTimer: null,
};

const els = {
  cafeUrl: document.getElementById("cafeUrl"),
  nickname: document.getElementById("nickname"),
  collectionMode: document.getElementById("collectionMode"),
  nicknameMatchType: document.getElementById("nicknameMatchType"),
  caseSensitive: document.getElementById("caseSensitive"),
  loadBoardsBtn: document.getElementById("loadBoardsBtn"),
  loadedBoardCount: document.getElementById("loadedBoardCount"),
  includeBoard: document.getElementById("includeBoard"),
  excludeBoardPicker: document.getElementById("excludeBoardPicker"),
  addExcludeBoardBtn: document.getElementById("addExcludeBoardBtn"),
  clearExcludeBoardsBtn: document.getElementById("clearExcludeBoardsBtn"),
  excludeBoardList: document.getElementById("excludeBoardList"),
  startDate: document.getElementById("startDate"),
  endDate: document.getElementById("endDate"),
  minChars: document.getElementById("minChars"),
  maxChars: document.getElementById("maxChars"),
  crawlScope: document.getElementById("crawlScope"),
  fastListDatePruning: document.getElementById("fastListDatePruning"),
  fastCommentPrecheck: document.getElementById("fastCommentPrecheck"),
  stopAfterFirstMatch: document.getElementById("stopAfterFirstMatch"),
  maxPages: document.getElementById("maxPages"),
  startPage: document.getElementById("startPage"),
  endPage: document.getElementById("endPage"),
  retries: document.getElementById("retries"),
  delayMs: document.getElementById("delayMs"),
  resultSearch: document.getElementById("resultSearch"),
  resultSort: document.getElementById("resultSort"),
  startBtn: document.getElementById("startBtn"),
  resumeBtn: document.getElementById("resumeBtn"),
  cancelBtn: document.getElementById("cancelBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  resetBtn: document.getElementById("resetBtn"),
  autoResume: document.getElementById("autoResume"),
  status: document.getElementById("status"),
  progressFill: document.getElementById("progressFill"),
  runMeta: document.getElementById("runMeta"),
  messageBox: document.getElementById("messageBox"),
  diagnosticList: document.getElementById("diagnosticList"),
  resultBody: document.getElementById("resultBody"),
};

function setStatus(message) {
  els.status.textContent = message;
}

function setBusy(isBusy) {
  els.startBtn.disabled = isBusy;
  els.resumeBtn.disabled = isBusy || !state.pausedJobId;
  els.resumeBtn.hidden = !state.pausedJobId;
  els.cancelBtn.disabled = !isBusy && !state.pausedJobId;
  els.loadBoardsBtn.disabled = isBusy;
}

function setMessage(message = "", kind = "info") {
  els.messageBox.hidden = !message;
  els.messageBox.textContent = message;
  els.messageBox.className = `message-box ${kind === "error" || kind === "warning" ? kind : ""}`.trim();
}

function renderMeta(data) {
  const p = data.progress || {};
  const memory = p.memory || data.memory || {};
  const stats = data.stats || p.stats || data.result?.stats || {};
  const items = [];
  if (data.status) items.push(`상태 ${data.status}`);
  if (p.stage) items.push(`단계 ${p.stage}`);
  if (memory.containerMb || memory.rssMb) items.push(`메모리 ${memory.containerMb || memory.rssMb}MB`);
  if (stats.pagesVisited || p.scannedPages) items.push(`페이지 ${stats.pagesVisited || p.scannedPages}`);
  if (stats.articleCandidates || p.collectedArticles) items.push(`후보 ${stats.articleCandidates || p.collectedArticles}건`);
  if (stats.articlesScanned) items.push(`상세 ${stats.articlesScanned}건`);
  if (stats.commentsDetected) items.push(`댓글 ${stats.commentsDetected}건`);
  if (stats.commentNicknameMatches) items.push(`닉네임 일치 ${stats.commentNicknameMatches}건`);
  if (stats.postAuthorMatches) items.push(`게시글 작성자 일치 ${stats.postAuthorMatches}건`);
  if (stats.commentPrechecks) items.push(`댓글 사전검색 ${stats.commentPrechecks}건`);
  if (stats.skippedByCommentPrecheck) items.push(`사전검색 스킵 ${stats.skippedByCommentPrecheck}건`);
  if (stats.skippedNoComments) items.push(`댓글없음 스킵 ${stats.skippedNoComments}건`);
  if (stats.skippedByListDate) items.push(`날짜 스킵 ${stats.skippedByListDate}건`);
  if (stats.filteredOut) items.push(`필터 제외 ${stats.filteredOut}건`);
  els.runMeta.innerHTML = items.map((item) => `<span>${escapeHtml(item)}</span>`).join("");
}

function renderProgress(data = {}) {
  const p = data.progress || {};
  const stats = data.stats || p.stats || data.result?.stats || {};
  let percent = 0;
  if (data.status === "done") {
    percent = 100;
  } else if (data.status === "paused") {
    percent = 100;
  } else if (p.totalBoards) {
    const boardBase = Math.max(0, (p.boardIndex || 1) - 1);
    const pagePart = stats.pagesVisited && p.totalBoards ? Math.min(0.9, stats.pagesVisited / Math.max(1, p.totalBoards * Number(els.maxPages.value || 1))) : 0;
    percent = Math.min(95, Math.round(((boardBase / p.totalBoards) + pagePart / p.totalBoards) * 100));
  }
  els.progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function renderDiagnostics(rows = []) {
  els.diagnosticList.innerHTML = "";
  rows.slice(-5).reverse().forEach((row) => {
    const li = document.createElement("li");
    const mem = row.memory?.containerMb || row.memory?.rssMb;
    li.textContent = `${row.message}${mem ? ` | 메모리 ${mem}MB` : ""}`;
    els.diagnosticList.appendChild(li);
  });
}

function summarizeRows(rows) {
  const posts = rows.filter((row) => row.type === "게시글").length;
  const comments = rows.filter((row) => row.type !== "게시글").length;
  return `게시글 ${posts}건, 댓글 ${comments}건`;
}

function makeClientResultKey(row) {
  return [row.type, row.nickname, row.boardName, row.title, row.url, row.comment, row.writtenAt]
    .map((value) => String(value || "").replace(/\s+/g, " ").trim())
    .join("\u001F");
}

function mergeResults(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return false;
  const map = new Map(state.results.map((row) => [makeClientResultKey(row), row]));
  let changed = false;
  for (const row of rows) {
    const key = makeClientResultKey(row);
    if (!key || map.has(key)) continue;
    map.set(key, row);
    changed = true;
  }
  if (changed) state.results = Array.from(map.values());
  return changed;
}

function updateResultsFromProgress(data) {
  const rows = Array.isArray(data.partialResults)
    ? data.partialResults
    : Array.isArray(data.result?.partialResults)
    ? data.result.partialResults
    : Array.isArray(data.result?.results)
    ? data.result.results
    : Array.isArray(data.recentResults)
    ? data.recentResults
    : [];
  if (mergeResults(rows)) applyResultFilter({ silent: true });
}

function updateCollectionModeHelp() {
  if (els.collectionMode.value === "posts") {
    els.nickname.placeholder = "작성자 닉네임 (비우면 전체 게시글)";
    els.fastCommentPrecheck.disabled = true;
    els.fastCommentPrecheck.checked = false;
    return;
  }
  els.nickname.placeholder = "검색할 닉네임";
  els.fastCommentPrecheck.disabled = false;
}

function updateLoadedBoardCountLabel() {
  els.loadedBoardCount.textContent = state.boards.length ? `게시판 ${state.boards.length}개 조회됨` : "게시판 미조회";
}

function renderBoardControls() {
  els.includeBoard.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "all";
  allOpt.textContent = "전체 포함";
  els.includeBoard.appendChild(allOpt);

  els.excludeBoardPicker.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "제외할 게시판 선택";
  els.excludeBoardPicker.appendChild(empty);

  for (const board of state.boards) {
    const option = document.createElement("option");
    option.value = board.id;
    option.textContent = board.name;
    els.includeBoard.appendChild(option);

    const ex = document.createElement("option");
    ex.value = board.id;
    ex.textContent = board.name;
    els.excludeBoardPicker.appendChild(ex);
  }
  renderExcludedBoards();
  updateLoadedBoardCountLabel();
}

function renderExcludedBoards() {
  els.excludeBoardList.innerHTML = "";
  if (!state.excludedBoards.length) {
    const li = document.createElement("li");
    li.className = "empty-chip";
    li.textContent = "제외 게시판 없음";
    els.excludeBoardList.appendChild(li);
    return;
  }
  for (const boardId of state.excludedBoards) {
    const board = state.boards.find((item) => item.id === boardId);
    const li = document.createElement("li");
    li.textContent = board?.name || boardId;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "삭제";
    btn.addEventListener("click", () => {
      state.excludedBoards = state.excludedBoards.filter((id) => id !== boardId);
      renderExcludedBoards();
    });
    li.appendChild(btn);
    els.excludeBoardList.appendChild(li);
  }
}

function renderResults(rows) {
  els.resultBody.innerHTML = "";
  rows.forEach((row, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td><span class="type-badge ${row.type === "게시글" ? "post" : "comment"}">${escapeHtml(row.type || "댓글")}</span></td>
      <td>${escapeHtml(row.nickname)}</td>
      <td>${escapeHtml(row.boardName)}</td>
      <td><a href="${escapeAttr(row.url)}" target="_blank" rel="noreferrer">${escapeHtml(row.title)}</a></td>
      <td>${escapeHtml(row.comment)}</td>
      <td>${escapeHtml(row.writtenAt || row.parsedDate || "")}</td>
      <td>${Number(row.charCount || 0)}</td>
    `;
    els.resultBody.appendChild(tr);
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

async function postJson(url, payload = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await readJsonResponse(res, "요청 실패");
  if (!res.ok || data.ok === false) throw new Error(data.message || `요청 실패: ${res.status}`);
  return data;
}

async function readJsonResponse(res, fallbackMessage) {
  const text = await res.text();
  if (!text.trim()) {
    throw new Error(`${fallbackMessage}: 서버가 빈 응답을 반환했습니다. Render 로그를 확인하세요.`);
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 180);
    throw new Error(`${fallbackMessage}: JSON이 아닌 응답을 받았습니다. ${preview || `HTTP ${res.status}`}`);
  }
}

async function loadBoards() {
  try {
    setMessage("");
    setStatus("게시판 조회 중");
    const data = await postJson("/api/boards", { cafeUrl: els.cafeUrl.value });
    if (!data.ok) throw new Error(data.message || "게시판 조회 실패");
    state.boards = data.boards || [];
    state.boardsCafeUrl = els.cafeUrl.value.trim();
    state.excludedBoards = [];
    renderBoardControls();
    setStatus(`게시판 ${state.boards.length}개 조회 완료`);
  } catch (error) {
    setMessage(error.message, "error");
    setStatus("게시판 조회 실패");
  }
}

function applyResultFilter(options = {}) {
  const query = els.resultSearch.value.trim().toLowerCase();
  let rows = [...state.results];
  if (query) {
    rows = rows.filter((row) => [row.type, row.nickname, row.boardName, row.title, row.comment, row.writtenAt].some((v) => String(v || "").toLowerCase().includes(query)));
  }
  if (els.resultSort.value === "date_desc") {
    rows.sort((a, b) => new Date(b.parsedDate || 0) - new Date(a.parsedDate || 0));
  } else if (els.resultSort.value === "chars_desc") {
    rows.sort((a, b) => Number(b.charCount || 0) - Number(a.charCount || 0));
  } else if (els.resultSort.value === "board") {
    rows.sort((a, b) => String(a.boardName || "").localeCompare(String(b.boardName || ""), "ko"));
  }
  state.filteredResults = rows;
  renderResults(rows);
  if (!options.silent) setStatus(`표시 결과: ${rows.length}건 (${summarizeRows(rows)}) | 원본 ${state.results.length}건`);
}

function timestampForFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function sanitizeFilePart(value) {
  return String(value || "results")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildCsvFilename(tag = "results") {
  const cafe = sanitizeFilePart(els.cafeUrl.value || "naver_cafe");
  const nickname = sanitizeFilePart(els.nickname.value || "nickname");
  return `naver_cafe_crawl_${tag}_${cafe}_${nickname}_${timestampForFilename()}.csv`;
}

function downloadCsvRows(rows, filenameTag = "results") {
  const header = ["순번", "유형", "닉네임", "게시판", "제목", "URL", "내용", "작성일시", "글자수"];
  const body = rows.map((row, i) => [
    i + 1,
    row.type || "댓글",
    row.nickname,
    row.boardName,
    row.title,
    row.url,
    row.comment,
    row.writtenAt || row.parsedDate || "",
    row.charCount || 0,
  ]);
  const csv = [header, ...body].map((cols) => cols.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = buildCsvFilename(filenameTag);
  a.click();
  URL.revokeObjectURL(a.href);
}

function buildPayload() {
  return {
    cafeUrl: els.cafeUrl.value,
    nickname: els.nickname.value,
    collectionMode: els.collectionMode.value,
    nicknameMatchType: els.nicknameMatchType.value,
    caseSensitive: els.caseSensitive.checked,
    includeBoardId: els.includeBoard.value,
    excludedBoardIds: state.excludedBoards,
    boards: state.boardsCafeUrl === els.cafeUrl.value.trim() ? state.boards : [],
    startDate: els.startDate.value,
    endDate: els.endDate.value,
    minChars: Number(els.minChars.value || 0),
    maxChars: Number(els.maxChars.value || 0),
    crawlScope: els.crawlScope.value,
    fastListDatePruning: els.fastListDatePruning.checked,
    fastCommentPrecheck: els.fastCommentPrecheck.checked,
    stopAfterFirstMatch: els.stopAfterFirstMatch.checked,
    maxPages: Number(els.maxPages.value || 3),
    startPage: Number(els.startPage.value || 1),
    endPage: Number(els.endPage.value || 0),
    retries: Number(els.retries.value || 3),
    delayMs: Number(els.delayMs.value || 900),
  };
}

function progressMessage(data) {
  const p = data.progress || {};
  const boardPart = p.totalBoards ? ` | 게시판 ${p.boardIndex || 0}/${p.totalBoards}` : "";
  const scanLabel = p.stage === "comment_scan" ? "댓글글" : p.stage === "article_comment_scan" ? "상세" : "게시글";
  const articlePart = p.totalArticlesInBoard ? ` | ${scanLabel} ${p.scannedArticles || 0}/${p.totalArticlesInBoard}` : "";
  const resultPart = ` | 결과 ${Math.max(Number(p.collectedResults || 0), state.results.length)}건`;
  return `${p.message || data.status}${boardPart}${articlePart}${resultPart}`;
}

function clearAutoResumeTimer() {
  if (state.autoResumeTimer) clearTimeout(state.autoResumeTimer);
  state.autoResumeTimer = null;
}

function scheduleAutoResume(jobId, data = {}) {
  clearAutoResumeTimer();
  if (data.result?.pauseReason === "memory") return false;
  if (!els.autoResume.checked) return false;
  state.autoResumeTimer = setTimeout(() => {
    state.autoResumeTimer = null;
    if (els.autoResume.checked && state.pausedJobId === jobId) void resumeCrawl(jobId, { automatic: true });
  }, 1200);
  return true;
}

async function pollProgress(jobId) {
  const res = await fetch(`/api/crawl/progress/${encodeURIComponent(jobId)}`);
  const data = await readJsonResponse(res, "진행률 조회 실패");
  if (!res.ok || data.ok === false) throw new Error(data.message || "진행률 조회 실패");
  setStatus(progressMessage(data));
  renderProgress(data);
  renderMeta(data);
  renderDiagnostics(data.diagnostics || data.progress?.diagnostics || data.result?.diagnostics || []);
  updateResultsFromProgress(data);

  if (data.status === "paused") {
    stopProgressPolling();
    state.pausedJobId = jobId;
    applyResultFilter();
    const willAutoResume = scheduleAutoResume(jobId, data);
    setBusy(willAutoResume);
    const pauseReason = data.result?.pauseReason;
    setMessage(
      `${data.result?.message || data.error || "작업을 분할 일시정지했습니다."} ${
        willAutoResume
          ? "잠시 후 자동으로 이어서 진행합니다."
          : pauseReason === "memory"
          ? "메모리 보호 일시정지는 자동 재개하지 않습니다. 범위를 줄이거나 잠시 후 이어서 진행하세요."
          : "이어서 진행 버튼으로 계속할 수 있습니다."
      }`,
      "warning"
    );
    setStatus(`일시정지됨: ${state.results.length}건 보존됨${willAutoResume ? " | 자동 재개 대기 중" : ""}`);
    return;
  }

  if (["done", "failed", "cancelled"].includes(data.status)) {
    stopProgressPolling();
    clearAutoResumeTimer();
    setBusy(false);
    if (data.status !== "done") {
      updateResultsFromProgress(data);
      applyResultFilter();
      state.pausedJobId = null;
      if (data.status === "cancelled" && state.results.length) downloadCsvRows(state.filteredResults, "cancelled_partial");
      setMessage(data.result?.message || data.error || (data.status === "cancelled" ? "크롤링 취소됨" : "크롤링 실패"), data.status === "cancelled" ? "warning" : "error");
      setStatus(data.status === "cancelled" ? "크롤링 취소됨" : "크롤링 실패");
      return;
    }
    if (!data.result?.ok) {
      setMessage(data.result?.message || "크롤링 실패", "error");
      return;
    }
    state.pausedJobId = null;
    setBusy(false);
    const notices = [];
    if (!data.result.nicknameFound) notices.push(data.result.message || "조건에 맞는 결과를 찾지 못했습니다.");
    if (Number(data.result.truncatedResults || 0) > 0) notices.push(`결과 한도 초과로 ${data.result.truncatedResults}건은 저장하지 않았습니다. 게시판/기간/페이지 범위를 줄여 다시 실행하세요.`);
    if (Number(data.result.selectorRiskCount || 0) > 0) notices.push(`댓글 선택자 감지 실패 가능성이 ${data.result.selectorRiskCount}건 있습니다.`);
    setMessage(notices.join(" "), notices.length ? "warning" : "");
    state.results = data.result.results || [];
    applyResultFilter();
    setStatus(`크롤링 완료: ${state.results.length}건 (${summarizeRows(state.results)})`);
  }
}

function startProgressPolling(jobId) {
  stopProgressPolling();
  state.progressTimer = setInterval(() => {
    void pollProgress(jobId).catch((error) => {
      stopProgressPolling();
      setBusy(false);
      setMessage(`${error.message} 이미 수집된 화면 결과가 있으면 CSV 다운로드로 먼저 보존하세요. Render가 재시작되었을 수 있습니다.`, "error");
      setStatus("진행률 조회 실패");
    });
  }, 1500);
}

function stopProgressPolling() {
  if (state.progressTimer) clearInterval(state.progressTimer);
  state.progressTimer = null;
}

async function startCrawl() {
  try {
    clearAutoResumeTimer();
    state.results = [];
    state.filteredResults = [];
    state.pausedJobId = null;
    renderResults([]);
    setBusy(true);
    setMessage("");
    renderDiagnostics([]);
    renderMeta({});
    renderProgress({});
    setStatus("크롤링 시작 요청 중");
    const data = await postJson("/api/crawl/start", buildPayload());
    state.currentJobId = data.jobId;
    setStatus("크롤링 실행 중");
    startProgressPolling(data.jobId);
    await pollProgress(data.jobId);
  } catch (error) {
    setBusy(false);
    setMessage(error.message, "error");
    setStatus("크롤링 시작 실패");
  }
}

async function resumeCrawl(jobId, options = {}) {
  try {
    clearAutoResumeTimer();
    state.pausedJobId = null;
    setBusy(true);
    setMessage(options.automatic ? "자동으로 이어서 진행합니다." : "");
    setStatus(options.automatic ? "자동 재개 요청 중" : "크롤링 재개 요청 중");
    const data = await postJson(`/api/crawl/resume/${encodeURIComponent(jobId)}`);
    state.currentJobId = data.jobId;
    setStatus(options.automatic ? "자동 재개 중" : "크롤링 재개 중");
    startProgressPolling(data.jobId);
    await pollProgress(data.jobId);
  } catch (error) {
    state.pausedJobId = jobId;
    setBusy(false);
    setMessage(error.message, "error");
    setStatus("크롤링 재개 실패");
  }
}

async function cancelCrawl() {
  if (!state.currentJobId) return;
  try {
    clearAutoResumeTimer();
    await postJson(`/api/crawl/cancel/${encodeURIComponent(state.currentJobId)}`);
    setStatus("취소 요청됨");
  } catch (error) {
    setMessage(error.message, "error");
  }
}

async function resetAll() {
  stopProgressPolling();
  clearAutoResumeTimer();
  await postJson("/api/reset");
  state.boards = [];
  state.excludedBoards = [];
  state.results = [];
  state.filteredResults = [];
  state.currentJobId = null;
  state.pausedJobId = null;
  renderBoardControls();
  renderResults([]);
  renderDiagnostics([]);
  renderMeta({});
  renderProgress({});
  setMessage("");
  setBusy(false);
  setStatus("초기화 완료");
}

function updateScopeControl() {
  els.maxPages.disabled = els.crawlScope.value === "all";
}

function updateFastListDatePruningControl() {
  const hasDateFilter = Boolean(els.startDate.value || els.endDate.value);
  els.fastListDatePruning.disabled = !hasDateFilter;
  if (!hasDateFilter) els.fastListDatePruning.checked = false;
}

function resetBoardsForCafeChange() {
  if (!state.boards.length) return;
  if (state.boardsCafeUrl === els.cafeUrl.value.trim()) return;
  state.boards = [];
  state.excludedBoards = [];
  state.boardsCafeUrl = "";
  renderBoardControls();
  setMessage("카페 URL이 변경되어 게시판 목록을 초기화했습니다.", "warning");
}

els.loadBoardsBtn.addEventListener("click", loadBoards);
els.addExcludeBoardBtn.addEventListener("click", () => {
  const id = els.excludeBoardPicker.value;
  if (id && !state.excludedBoards.includes(id)) state.excludedBoards.push(id);
  renderExcludedBoards();
});
els.clearExcludeBoardsBtn.addEventListener("click", () => {
  state.excludedBoards = [];
  renderExcludedBoards();
});
els.startBtn.addEventListener("click", startCrawl);
els.resumeBtn.addEventListener("click", () => {
  if (state.pausedJobId) void resumeCrawl(state.pausedJobId);
});
els.cancelBtn.addEventListener("click", cancelCrawl);
els.downloadBtn.addEventListener("click", () => {
  if (!state.filteredResults.length) return alert("다운로드할 결과가 없습니다.");
  downloadCsvRows(state.filteredResults, "results");
});
els.resetBtn.addEventListener("click", () => void resetAll().catch((error) => setMessage(error.message, "error")));
els.resultSearch.addEventListener("input", () => applyResultFilter({ silent: true }));
els.resultSort.addEventListener("change", () => applyResultFilter({ silent: true }));
els.crawlScope.addEventListener("change", updateScopeControl);
els.startDate.addEventListener("change", updateFastListDatePruningControl);
els.endDate.addEventListener("change", updateFastListDatePruningControl);
els.fastCommentPrecheck.addEventListener("change", () => {
  if (els.fastCommentPrecheck.checked) {
    setMessage("댓글 빠른 사전검색은 상세 렌더링 전에 닉네임을 먼저 확인해 속도를 높입니다. 일부 동적 댓글 화면에서는 정확도 우선 모드가 더 안정적입니다.", "warning");
  } else {
    setMessage("");
  }
});
els.collectionMode.addEventListener("change", () => {
  updateCollectionModeHelp();
  if (els.collectionMode.value === "posts") {
    setMessage("게시글만 수집은 목록 기반 빠른 모드로 실행됩니다.", "");
  } else {
    setMessage("댓글 수집은 정확도 우선으로 먼저 확인하세요. 결과가 확인된 뒤 속도가 필요하면 댓글 빠른 사전검색을 켜세요.", "warning");
  }
});
els.cafeUrl.addEventListener("change", resetBoardsForCafeChange);

renderBoardControls();
updateScopeControl();
updateFastListDatePruningControl();
updateCollectionModeHelp();
renderProgress({});
