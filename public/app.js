const state = {
  boards: [],
  excludedBoards: [],
  results: [],
  filteredResults: [],
  currentJobId: null,
  progressTimer: null,
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
  maxPages: document.getElementById("maxPages"),
  startPage: document.getElementById("startPage"),
  endPage: document.getElementById("endPage"),
  retries: document.getElementById("retries"),
  delayMs: document.getElementById("delayMs"),
  resultSearch: document.getElementById("resultSearch"),
  resultSort: document.getElementById("resultSort"),
  startBtn: document.getElementById("startBtn"),
  cancelBtn: document.getElementById("cancelBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  resetBtn: document.getElementById("resetBtn"),
  status: document.getElementById("status"),
  resultBody: document.getElementById("resultBody"),
};

function setStatus(message) {
  els.status.textContent = message;
}

function setBusy(isBusy) {
  els.startBtn.disabled = isBusy;
  els.cancelBtn.disabled = !isBusy;
  els.loadBoardsBtn.disabled = isBusy;
}

function summarizeRows(rows) {
  const posts = rows.filter((row) => row.type === "게시글").length;
  const comments = rows.filter((row) => row.type !== "게시글").length;
  return `게시글 ${posts}건, 댓글 ${comments}건`;
}

function updateCollectionModeHelp() {
  if (els.collectionMode.value === "posts") {
    els.nickname.placeholder = "작성자 닉네임 (비우면 전체 게시글)";
    return;
  }
  els.nickname.placeholder = "검색할 닉네임";
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
    setStatus("게시판 조회 중");
    const data = await postJson("/api/boards", { cafeUrl: els.cafeUrl.value });
    if (!data.ok) throw new Error(data.message || "게시판 조회 실패");
    state.boards = data.boards || [];
    state.excludedBoards = [];
    renderBoardControls();
    setStatus(`게시판 ${state.boards.length}개 조회 완료`);
  } catch (error) {
    alert(error.message);
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
    startDate: els.startDate.value,
    endDate: els.endDate.value,
    minChars: Number(els.minChars.value || 0),
    maxChars: Number(els.maxChars.value || 0),
    crawlScope: els.crawlScope.value,
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
  const articlePart = p.totalArticlesInBoard ? ` | 게시글 ${p.scannedArticles || 0}/${p.totalArticlesInBoard}` : "";
  const resultPart = ` | 결과 ${p.collectedResults || 0}건`;
  return `${p.message || data.status}${boardPart}${articlePart}${resultPart}`;
}

async function pollProgress(jobId) {
  const res = await fetch(`/api/crawl/progress/${encodeURIComponent(jobId)}`);
  const data = await readJsonResponse(res, "진행률 조회 실패");
  if (!res.ok || data.ok === false) throw new Error(data.message || "진행률 조회 실패");
  setStatus(progressMessage(data));

  if (data.status === "running" && Array.isArray(data.recentResults)) {
    state.results = data.recentResults;
    applyResultFilter({ silent: true });
  }

  if (data.status === "paused") {
    stopProgressPolling();
    setBusy(false);
    const partialRows = Array.isArray(data.result?.partialResults)
      ? data.result.partialResults
      : Array.isArray(data.recentResults)
      ? data.recentResults
      : [];
    state.results = partialRows;
    applyResultFilter();
    const shouldResume = confirm(`${data.result?.message || data.error || "메모리 보호로 크롤링을 일시정지했습니다."}\n\n브라우저를 다시 시작해서 중단 지점부터 이어서 조회할까요?`);
    if (shouldResume) await resumeCrawl(jobId);
    else setStatus(`일시정지됨: ${state.results.length}건 저장됨`);
    return;
  }

  if (["done", "failed", "cancelled"].includes(data.status)) {
    stopProgressPolling();
    setBusy(false);
    if (data.status !== "done") {
      const partialRows = Array.isArray(data.result?.partialResults)
        ? data.result.partialResults
        : Array.isArray(data.recentResults)
        ? data.recentResults
        : [];
      state.results = partialRows;
      applyResultFilter();
      if (data.status === "cancelled" && partialRows.length) downloadCsvRows(state.filteredResults, "cancelled_partial");
      alert(data.result?.message || data.error || (data.status === "cancelled" ? "크롤링 취소됨" : "크롤링 실패"));
      setStatus(data.status === "cancelled" ? "크롤링 취소됨" : "크롤링 실패");
      return;
    }
    if (!data.result?.ok) {
      alert(data.result?.message || "크롤링 실패");
      return;
    }
    if (!data.result.nicknameFound) alert("조건에 맞는 결과를 찾지 못했습니다.");
    if (Number(data.result.truncatedResults || 0) > 0) alert(`메모리 보호를 위해 결과 ${data.result.truncatedResults}건은 저장하지 않았습니다. 게시판/기간/페이지 범위를 줄여 다시 실행하세요.`);
    if (Number(data.result.selectorRiskCount || 0) > 0) alert(`댓글 선택자 감지 실패 가능성이 ${data.result.selectorRiskCount}건 있습니다. 네이버 화면 구조 변경 여부를 확인하세요.`);
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
      alert(error.message);
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
    state.results = [];
    state.filteredResults = [];
    renderResults([]);
    setBusy(true);
    setStatus("크롤링 시작 요청 중");
    const data = await postJson("/api/crawl/start", buildPayload());
    state.currentJobId = data.jobId;
    setStatus("크롤링 실행 중");
    startProgressPolling(data.jobId);
    await pollProgress(data.jobId);
  } catch (error) {
    setBusy(false);
    alert(error.message);
    setStatus("크롤링 시작 실패");
  }
}

async function resumeCrawl(jobId) {
  try {
    setBusy(true);
    setStatus("크롤링 재개 요청 중");
    const data = await postJson(`/api/crawl/resume/${encodeURIComponent(jobId)}`);
    state.currentJobId = data.jobId;
    setStatus("크롤링 재개 중");
    startProgressPolling(data.jobId);
    await pollProgress(data.jobId);
  } catch (error) {
    setBusy(false);
    alert(error.message);
    setStatus("크롤링 재개 실패");
  }
}

async function cancelCrawl() {
  if (!state.currentJobId) return;
  try {
    await postJson(`/api/crawl/cancel/${encodeURIComponent(state.currentJobId)}`);
    setStatus("취소 요청됨");
  } catch (error) {
    alert(error.message);
  }
}

async function resetAll() {
  stopProgressPolling();
  await postJson("/api/reset");
  state.boards = [];
  state.excludedBoards = [];
  state.results = [];
  state.filteredResults = [];
  state.currentJobId = null;
  renderBoardControls();
  renderResults([]);
  setBusy(false);
  setStatus("초기화 완료");
}

function updateScopeControl() {
  els.maxPages.disabled = els.crawlScope.value === "all";
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
els.cancelBtn.addEventListener("click", cancelCrawl);
els.downloadBtn.addEventListener("click", () => {
  if (!state.filteredResults.length) return alert("다운로드할 결과가 없습니다.");
  downloadCsvRows(state.filteredResults, "results");
});
els.resetBtn.addEventListener("click", () => void resetAll().catch((error) => alert(error.message)));
els.resultSearch.addEventListener("input", () => applyResultFilter({ silent: true }));
els.resultSort.addEventListener("change", () => applyResultFilter({ silent: true }));
els.crawlScope.addEventListener("change", updateScopeControl);
els.collectionMode.addEventListener("change", updateCollectionModeHelp);

renderBoardControls();
updateScopeControl();
updateCollectionModeHelp();
