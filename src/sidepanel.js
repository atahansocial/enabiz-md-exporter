import { buildMarkdownArchive } from './lib/markdown-builder.js';
import { base64ToUint8Array, extractPdfText } from './lib/pdf-extractor.js';
import { createZipBlob } from './lib/zip.js';

const ENABIZ_ZIYARET_URL = 'https://enabiz.gov.tr/Home/Ziyaretlerim';
const TOTAL_STAGES = 10;
const WATCHDOG_MS = 60000;

const el = {
  statusCard: document.getElementById('statusCard'),
  statusTitle: document.getElementById('statusTitle'),
  statusDesc: document.getElementById('statusDesc'),
  statusActions: document.getElementById('statusActions'),
  btnOpenEnabiz: document.getElementById('btnOpenEnabiz'),
  btnRecheck: document.getElementById('btnRecheck'),
  startYear: document.getElementById('startYear'),
  endYear: document.getElementById('endYear'),
  optReportPdfs: document.getElementById('optReportPdfs'),
  optLabTimes: document.getElementById('optLabTimes'),
  optRawPdfs: document.getElementById('optRawPdfs'),
  optRawJson: document.getElementById('optRawJson'),
  requestSpeed: document.getElementById('requestSpeed'),
  btnStart: document.getElementById('btnStart'),
  btnStartLabel: document.getElementById('btnStartLabel'),
  progressCard: document.getElementById('progressCard'),
  progressStage: document.getElementById('progressStage'),
  progressTimer: document.getElementById('progressTimer'),
  progressBar: document.getElementById('progressBar'),
  progressDetail: document.getElementById('progressDetail'),
  errorCard: document.getElementById('errorCard'),
  errorMsg: document.getElementById('errorMsg'),
  resultCard: document.getElementById('resultCard'),
  resultBadge: document.getElementById('resultBadge'),
  resultMeta: document.getElementById('resultMeta'),
  warningBanner: document.getElementById('warningBanner'),
  warningTitle: document.getElementById('warningTitle'),
  warningList: document.getElementById('warningList'),
  statsGrid: document.getElementById('statsGrid'),
  btnDownloadZip: document.getElementById('btnDownloadZip'),
  btnSaveFolder: document.getElementById('btnSaveFolder'),
  btnCopyPrompt: document.getElementById('btnCopyPrompt'),
  fileTree: document.getElementById('fileTree'),
  previewModal: document.getElementById('previewModal'),
  modalBackdrop: document.getElementById('modalBackdrop'),
  modalTitle: document.getElementById('modalTitle'),
  modalContent: document.getElementById('modalContent'),
  btnCloseModal: document.getElementById('btnCloseModal')
};

let activeTabId = null;
let activePort = null;
let currentRunId = 0;
let isRunning = false;
let timerInterval = null;
let watchdogTimer = null;
let startTimestamp = 0;
let lastArchiveEntries = null;
let lastStats = null;
let lastFocusedElement = null;

// Incremental per-run PDF state (eliminates holding base64 strings in memory)
let runPdfQueue = Promise.resolve();
let runPdfProcessedCount = 0;
let runLabPdfTexts = {};
let runReportExtracts = new Map();
let runRadExtracts = new Map();
let runRawPdfFiles = [];

function populateYearDropdowns() {
  const currentYear = new Date().getFullYear();
  for (let y = 2014; y <= currentYear; y++) {
    const opt = document.createElement('option');
    opt.value = String(y);
    opt.textContent = String(y);
    el.startYear.appendChild(opt);
  }
  for (let y = currentYear; y >= 2018; y--) {
    const opt = document.createElement('option');
    opt.value = String(y);
    opt.textContent = String(y);
    el.endYear.appendChild(opt);
  }
}

function formatElapsed(ms) {
  const sec = Math.floor(ms / 1000);
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function setStatus(mode, title, desc, showOpenBtn = false) {
  el.statusCard.classList.remove('status-checking', 'status-ready', 'status-warn');
  el.statusCard.classList.add(mode);
  el.statusTitle.textContent = title;
  el.statusDesc.textContent = desc;
  el.statusActions.classList.toggle('hidden', !showOpenBtn);
}

function showError(message) {
  el.errorMsg.textContent = message;
  el.errorCard.classList.remove('hidden');
}

function hideError() {
  el.errorCard.classList.add('hidden');
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function ensureContentScriptAndPing(tab) {
  if (!tab?.id || !tab.url || !tab.url.startsWith('https://enabiz.gov.tr/')) {
    return { onEnabiz: false };
  }
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'PING_ENABIZ' });
    return { onEnabiz: true, ...res };
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/lib/dom-parsers.js', 'src/content.js']
      });
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'PING_ENABIZ' });
      return { onEnabiz: true, ...res };
    } catch (err) {
      return { onEnabiz: true, loggedIn: false, error: String(err) };
    }
  }
}

async function refreshTabStatus() {
  if (isRunning) return;
  const tab = await getActiveTab();
  activeTabId = tab?.id || null;
  const info = await ensureContentScriptAndPing(tab);

  if (!info.onEnabiz) {
    setStatus(
      'status-warn',
      'e-Nabız sekmesi açık değil',
      "Önce e-Nabız'ı açıp e-Devlet veya şifrenizle giriş yapın, ardından buradan tek tıkla çekin.",
      true
    );
    el.btnStart.disabled = true;
    return;
  }

  if (!info.loggedIn) {
    setStatus(
      'status-warn',
      'e-Nabız oturumu bekleniyor',
      'Giriş yaptıktan sonra "Yenile"ye tıklayın veya doğrudan arşivlemeyi başlatın.',
      true
    );
    el.btnStart.disabled = true;
    return;
  }

  const who = info.patientName ? `${info.patientName} — ` : '';
  const yr = info.yearRange?.min && info.yearRange?.max ? `(${info.yearRange.min}–${info.yearRange.max})` : '';
  setStatus('status-ready', 'e-Nabız oturumu hazır', `${who}Arşiv çekmeye hazır ${yr}`.trim(), false);
  el.btnStart.disabled = false;
}

function startTimer() {
  startTimestamp = Date.now();
  el.progressTimer.textContent = '00:00';
  timerInterval = setInterval(() => {
    el.progressTimer.textContent = formatElapsed(Date.now() - startTimestamp);
  }, 500);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function clearWatchdog() {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

function resetWatchdog(runId) {
  clearWatchdog();
  watchdogTimer = setTimeout(() => {
    if (!isRunning || runId !== currentRunId) return;
    cancelCurrentRun('e-Nabız uzun süredir yanıt vermiyor (60 sn zaman aşımı). İnternet veya oturumunuzu kontrol edip tekrar deneyin.');
  }, WATCHDOG_MS);
}

function updateProgressUI(stageIndex, totalStages, label) {
  const pct = Math.max(4, Math.min(100, Math.round((stageIndex / totalStages) * 100)));
  el.progressBar.style.width = `${pct}%`;
  el.progressStage.textContent = `Adım ${stageIndex}/${totalStages}`;
  el.progressDetail.textContent = label;
}

function resetRunBuffers() {
  runPdfQueue = Promise.resolve();
  runPdfProcessedCount = 0;
  runLabPdfTexts = {};
  runReportExtracts = new Map();
  runRadExtracts = new Map();
  runRawPdfFiles = [];
}

function setRunningState(running) {
  isRunning = running;
  if (running) {
    el.btnStart.classList.add('btn-stop');
    el.btnStartLabel.textContent = 'Durdur';
    el.btnStart.disabled = false;
    el.progressCard.classList.remove('hidden');
    el.resultCard.classList.add('hidden');
    hideError();
    startTimer();
  } else {
    clearWatchdog();
    stopTimer();
    el.btnStart.classList.remove('btn-stop');
    el.btnStartLabel.textContent = 'Sağlık Arşivimi Çek';
    refreshTabStatus();
  }
}

function disconnectActivePort() {
  if (activePort) {
    try {
      activePort.disconnect();
    } catch {}
    activePort = null;
  }
}

function cancelCurrentRun(errorMessage = '') {
  currentRunId += 1; // invalidates any in-flight messages or queued PDF tasks from old run
  if (activePort) {
    try {
      activePort.postMessage({ type: 'CANCEL_EXPORT' });
    } catch {}
    disconnectActivePort();
  }
  el.progressCard.classList.add('hidden');
  setRunningState(false);
  if (errorMessage) showError(errorMessage);
}

function enqueuePdfBlob(runId, msg, opts) {
  runPdfQueue = runPdfQueue.then(async () => {
    if (!isRunning || runId !== currentRunId) return;

    const u8 = base64ToUint8Array(msg.base64);
    msg.base64 = null; // release base64 string immediately

    if (opts.includeRawPdfs && msg.relativePath) {
      runRawPdfFiles.push({ path: msg.relativePath, content: u8 });
    }

    const needsText =
      (msg.kind === 'lab' && opts.includeLabPdfTimes) ||
      ((msg.kind === 'rapor' || msg.kind === 'radyoloji') && opts.includeReportPdfs);

    if (!needsText) return;

    try {
      const parsed = await extractPdfText(u8);
      if (!isRunning || runId !== currentRunId) return;
      runPdfProcessedCount += 1;
      if (msg.kind === 'rapor') {
        runReportExtracts.set(msg.raporIndex, parsed);
      } else if (msg.kind === 'radyoloji') {
        runRadExtracts.set(msg.radIndex, parsed);
      } else if (msg.kind === 'lab') {
        runLabPdfTexts[msg.filename] = parsed.text;
        runLabPdfTexts[`__panel_${msg.panelIndex}`] = parsed.text;
      }
    } catch (err) {
      console.warn('PDF çözümleme atlandı:', msg.filename, err);
    }
  });
}

async function finalizeArchive(runId, rawData) {
  if (runId !== currentRunId) return;

  updateProgressUI(9, TOTAL_STAGES, `PDF metinleri tamamlanıyor (${runPdfProcessedCount} adet)...`);
  await runPdfQueue;
  if (runId !== currentRunId) return;

  // Attach extracted PDF texts back onto rawData
  for (const [idx, parsed] of runReportExtracts.entries()) {
    if (rawData.raporlar?.raporlar?.[idx]) {
      rawData.raporlar.raporlar[idx].pdf = {
        ...(rawData.raporlar.raporlar[idx].pdf || {}),
        pageCount: parsed.pageCount,
        extractedText: parsed.text
      };
    }
  }
  for (const [idx, parsed] of runRadExtracts.entries()) {
    if (rawData.radyoloji?.[idx]) {
      rawData.radyoloji[idx].pdf = {
        ...(rawData.radyoloji[idx].pdf || {}),
        pageCount: parsed.pageCount,
        extractedText: parsed.text
      };
    }
  }
  for (let i = 0; i < (rawData.tahlillerim?.panels || []).length; i++) {
    const p = rawData.tahlillerim.panels[i];
    if (p.pdf && runLabPdfTexts[`__panel_${i}`]) {
      p.pdf.extractedText = runLabPdfTexts[`__panel_${i}`];
    }
  }

  updateProgressUI(10, TOTAL_STAGES, 'Markdown klasör yapısı derleniyor...');
  const { files, stats } = buildMarkdownArchive(rawData, { labPdfTexts: runLabPdfTexts });

  const allEntries = new Map();
  for (const [p, content] of files.entries()) {
    allEntries.set(p, content);
  }
  for (const pf of runRawPdfFiles) {
    allEntries.set(pf.path, pf.content);
  }
  if (el.optRawJson.checked) {
    allEntries.set('enabiz_ham_veri.json', JSON.stringify(rawData, null, 2));
  }

  if (runId !== currentRunId) return;
  renderResults(allEntries, stats);
  setRunningState(false);
  disconnectActivePort();
}

function renderResults(entries, stats) {
  lastArchiveEntries = entries;
  lastStats = stats;

  const encoder = new TextEncoder();
  const totalBytes = Array.from(entries.values()).reduce(
    (sum, v) => sum + (typeof v === 'string' ? encoder.encode(v).length : v.byteLength),
    0
  );
  el.resultMeta.textContent = `${entries.size} dosya · ${(totalBytes / 1024).toFixed(0)} KB · ${el.progressTimer.textContent}`;

  const hasWarnings = Boolean(stats.warnings?.length);
  el.resultBadge.textContent = hasWarnings ? 'Kısmi Arşiv (Uyarı Var)' : 'Arşiv Hazır';
  el.resultBadge.classList.toggle('is-warn', hasWarnings);

  el.warningList.textContent = '';
  if (hasWarnings) {
    el.warningTitle.textContent = `Dikkat: ${stats.warnings.length} uyarı tespit edildi`;
    for (const w of stats.warnings) {
      const li = document.createElement('li');
      li.textContent = w;
      el.warningList.appendChild(li);
    }
    el.warningBanner.classList.remove('hidden');
  } else {
    el.warningBanner.classList.add('hidden');
  }

  // Safe DOM creation (no innerHTML with dynamic data)
  el.statsGrid.textContent = '';
  const gridItems = [
    { val: String(stats.totalVisits), lbl: 'Ziyaret' },
    { val: String(stats.totalIslemRows), lbl: 'Tıbbi İşlem' },
    { val: `${stats.labRowsCount} (${stats.oorCount}!)`, lbl: 'Tahlil (Ref. Dışı)' },
    { val: String(stats.radCount), lbl: 'Radyoloji' },
    { val: String(stats.raporCount), lbl: 'Sağlık Raporu' },
    { val: String(stats.receteCount), lbl: 'Reçete' }
  ];
  for (const g of gridItems) {
    const box = document.createElement('div');
    box.className = 'stat-box';
    const valEl = document.createElement('div');
    valEl.className = 'stat-val';
    valEl.textContent = g.val;
    const lblEl = document.createElement('div');
    lblEl.className = 'stat-lbl';
    lblEl.textContent = g.lbl;
    box.append(valEl, lblEl);
    el.statsGrid.appendChild(box);
  }

  el.fileTree.textContent = '';
  for (const [path, content] of entries.entries()) {
    const byteLen = typeof content === 'string' ? encoder.encode(content).length : content.byteLength;
    const sizeStr = byteLen >= 1024 ? `${(byteLen / 1024).toFixed(1)} KB` : `${byteLen} B`;

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'file-item';
    const pathSpan = document.createElement('span');
    pathSpan.textContent = path;
    const sizeSpan = document.createElement('span');
    sizeSpan.className = 'file-size';
    sizeSpan.textContent = sizeStr;
    row.append(pathSpan, sizeSpan);

    row.addEventListener('click', () => {
      lastFocusedElement = row;
      el.modalTitle.textContent = path;
      el.modalContent.textContent =
        typeof content === 'string'
          ? content
          : `[İkili PDF dosyası — ${(byteLen / 1024).toFixed(1)} KB]`;
      el.previewModal.classList.remove('hidden');
      el.btnCloseModal.focus();
    });
    el.fileTree.appendChild(row);
  }

  el.btnSaveFolder.classList.toggle('hidden', typeof window.showDirectoryPicker !== 'function');
  el.progressCard.classList.add('hidden');
  el.resultCard.classList.remove('hidden');
}

function closeModal() {
  if (el.previewModal.classList.contains('hidden')) return;
  el.previewModal.classList.add('hidden');
  if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
    lastFocusedElement.focus();
    lastFocusedElement = null;
  }
}

async function handleStartClick() {
  if (isRunning) {
    cancelCurrentRun();
    return;
  }

  const tab = await getActiveTab();
  const info = await ensureContentScriptAndPing(tab);
  if (!info.onEnabiz || !info.loggedIn) {
    showError('Lütfen önce e-Nabız sekmesinde oturum açın.');
    return;
  }

  activeTabId = tab.id;
  disconnectActivePort();
  resetRunBuffers();

  const runId = ++currentRunId;
  const options = {
    startYear: el.startYear.value,
    endYear: el.endYear.value,
    includeReportPdfs: el.optReportPdfs.checked,
    includeLabPdfTimes: el.optLabTimes.checked,
    includeRawPdfs: el.optRawPdfs.checked,
    speed: el.requestSpeed.value
  };

  setRunningState(true);
  updateProgressUI(1, TOTAL_STAGES, 'e-Nabız bağlantısı başlatılıyor...');
  resetWatchdog(runId);

  try {
    const port = chrome.tabs.connect(tab.id, { name: 'enabiz-export' });
    activePort = port;

    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.runId !== currentRunId) return; // Strict run isolation

      resetWatchdog(runId);

      if (msg.type === 'EXPORT_PROGRESS') {
        updateProgressUI(msg.stageIndex || 1, msg.totalStages || TOTAL_STAGES, msg.label || '');
      } else if (msg.type === 'EXPORT_PDF_BLOB') {
        enqueuePdfBlob(runId, msg, options);
      } else if (msg.type === 'EXPORT_COMPLETE') {
        clearWatchdog();
        finalizeArchive(runId, msg.data).catch((err) => {
          if (runId === currentRunId) {
            setRunningState(false);
            disconnectActivePort();
            showError(`Arşiv derleme hatası: ${err?.message || err}`);
          }
        });
      } else if (msg.type === 'EXPORT_ERROR') {
        clearWatchdog();
        disconnectActivePort();
        setRunningState(false);
        el.progressCard.classList.add('hidden');
        if (msg.sessionExpired) {
          showError('e-Nabız oturumunuzun süresi dolmuş. Lütfen e-Nabız sayfasını yenileyip tekrar giriş yapın.');
        } else if (!msg.cancelled) {
          showError(msg.error || 'Veriler çekilirken beklenmeyen bir hata oluştu.');
        }
      }
    });

    port.onDisconnect.addListener(() => {
      if (activePort === port) activePort = null;
      if (isRunning && runId === currentRunId) {
        clearWatchdog();
        setRunningState(false);
        el.progressCard.classList.add('hidden');
        showError('e-Nabız sekmesiyle bağlantı kesildi (sayfa yenilenmiş veya kapatılmış olabilir).');
      }
    });

    port.postMessage({ type: 'START_EXPORT', runId, options });
  } catch (err) {
    setRunningState(false);
    showError(`Bağlantı hatası: ${err?.message || err}`);
  }
}

async function handleDownloadZip() {
  if (!lastArchiveEntries) return;
  const blob = await createZipBlob(lastArchiveEntries, { rootFolder: 'enabiz-md-arsiv' });
  const url = URL.createObjectURL(blob);
  const dateTag = new Date().toISOString().slice(0, 10);
  const filename = `enabiz-md-arsiv-${dateTag}.zip`;

  if (chrome.downloads?.download) {
    chrome.downloads.download({ url, filename, saveAs: true }, () => {
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    });
  } else {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

async function handleSaveFolder() {
  if (!lastArchiveEntries || typeof window.showDirectoryPicker !== 'function') return;
  try {
    const parentHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    const rootHandle = await parentHandle.getDirectoryHandle('enabiz-md-arsiv', { create: true });
    for (const [relPath, content] of lastArchiveEntries.entries()) {
      const parts = relPath.split('/');
      let dirHandle = rootHandle;
      for (let i = 0; i < parts.length - 1; i++) {
        dirHandle = await dirHandle.getDirectoryHandle(parts[i], { create: true });
      }
      const fileHandle = await dirHandle.getFileHandle(parts[parts.length - 1], { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(content);
      await writable.close();
    }
    const origText = el.btnSaveFolder.textContent;
    el.btnSaveFolder.textContent = 'Klasöre Kaydedildi ✓';
    setTimeout(() => {
      el.btnSaveFolder.textContent = origText;
    }, 2500);
  } catch (err) {
    if (err?.name !== 'AbortError') {
      showError(`Klasöre kaydetme hatası: ${err?.message || err}`);
    }
  }
}

async function handleCopyPrompt() {
  const visitCnt = lastStats?.totalVisits || '';
  const promptText = `Eklediğim e-Nabız sağlık arşivimi (${visitCnt} ziyaret, tüm tanılar, tahliller, radyoloji raporları, resmi raporlar ve reçeteler) baştan sona analiz et ve şu başlıklarda detaylı bir sağlık raporu çıkar:\n1. Özet Sağlık Profili\n2. Başvuru Sıklığı, Branş Dağılımı ve Mevsimsellik\n3. Hep Tekrar Eden Kronik Sorunlar / Eksenler\n4. Hastalıklar ve Tahliller Arasındaki Korelasyonlar / Gizli Bağlantılar\n5. Kayıtlardaki Çelişkiler, Eksik Takipler ve Yapılmamış Test/Aşılar\n6. Yaşıma Göre Durumum ve Geleceğe Yönelik Risk / Takip Yol Haritası`;
  await navigator.clipboard.writeText(promptText);
  const orig = el.btnCopyPrompt.textContent;
  el.btnCopyPrompt.textContent = 'Prompt Kopyalandı ✓';
  setTimeout(() => {
    el.btnCopyPrompt.textContent = orig;
  }, 2200);
}

window.addEventListener('beforeunload', (e) => {
  if (isRunning) {
    e.preventDefault();
    e.returnValue = '';
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

chrome.tabs.onActivated.addListener(() => refreshTabStatus());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTabId && changeInfo.status === 'complete') {
    refreshTabStatus();
  }
});

el.btnOpenEnabiz.addEventListener('click', () => chrome.tabs.create({ url: ENABIZ_ZIYARET_URL }));
el.btnRecheck.addEventListener('click', refreshTabStatus);
el.btnStart.addEventListener('click', handleStartClick);
el.btnDownloadZip.addEventListener('click', handleDownloadZip);
el.btnSaveFolder.addEventListener('click', handleSaveFolder);
el.btnCopyPrompt.addEventListener('click', handleCopyPrompt);
el.btnCloseModal.addEventListener('click', closeModal);
el.modalBackdrop.addEventListener('click', closeModal);

populateYearDropdowns();
refreshTabStatus();
