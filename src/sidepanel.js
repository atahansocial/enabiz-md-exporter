import { buildMarkdownArchive } from './lib/markdown-builder.js';
import { base64ToUint8Array, extractPdfText } from './lib/pdf-extractor.js';
import { createZipBlob } from './lib/zip.js';
import {
  extractOtac,
  enumerateWorkItem,
  TELERADYOLOJI_ORIGIN,
  TELERADYOLOJI_API_BASE
} from './lib/teleradyoloji.js';
import {
  radiologyPageAuth,
  radiologyPageDownload,
  enabizFetchViewerLink
} from './lib/teleradyoloji-page.js';

const ENABIZ_ZIYARET_URL = 'https://enabiz.gov.tr/Home/Ziyaretlerim';
const TOTAL_STAGES = 10;
const ALL_SECTIONS = ['visits', 'tanilar_ilaclar', 'tahliller', 'radyoloji', 'raporlar', 'ek_bolumler'];
const WATCHDOG_MS = 60000;

const el = {
  statusCard: document.getElementById('statusCard'),
  statusTitle: document.getElementById('statusTitle'),
  statusDesc: document.getElementById('statusDesc'),
  statusActions: document.getElementById('statusActions'),
  btnOpenEnabiz: document.getElementById('btnOpenEnabiz'),
  btnRecheck: document.getElementById('btnRecheck'),
  secCheckboxes: Array.from(document.querySelectorAll('input[name="exportSection"]')),
  secRadyoloji: document.getElementById('secRadyoloji'),
  presetBtns: Array.from(document.querySelectorAll('.preset-btn[data-preset]')),
  startYear: document.getElementById('startYear'),
  endYear: document.getElementById('endYear'),
  optReportPdfs: document.getElementById('optReportPdfs'),
  optLabTimes: document.getElementById('optLabTimes'),
  optRawPdfs: document.getElementById('optRawPdfs'),
  optRawJson: document.getElementById('optRawJson'),
  optRadImages: document.getElementById('optRadImages'),
  radWarnBox: document.getElementById('radWarnBox'),
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
let tabReady = false;
let activeTotalStages = TOTAL_STAGES;
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

// Radyoloji görüntüleri (Teleradyoloji WADO)
const RAD_IMG_PREFIX = 'radyoloji_goruntuleri/';
const TELERADYOLOJI_VIEWER_URL = `${TELERADYOLOJI_ORIGIN}/robots.txt`; // nginx 404 sayfası: SPA çalışmaz, origin doğru kalır
const RAD_SPEED_CONFIG = {
  fast: { concurrency: 8, delayMs: 0 },
  balanced: { concurrency: 6, delayMs: 0 },
  slow: { concurrency: 2, delayMs: 120 }
};
let runRadImageFiles = [];
let runRadImageStats = null;
let radImageTabId = null;
let activeRadJobId = null;
const radChunkBuffers = new Map();

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

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
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

function getSelectedSections() {
  return el.secCheckboxes.filter((cb) => cb.checked).map((cb) => cb.value);
}

function getExpectedTotalStages(sections) {
  const s = new Set(sections);
  return (
    1 +
    (s.has('visits') ? 2 : 0) +
    (s.has('tanilar_ilaclar') ? 1 : 0) +
    (s.has('tahliller') ? 1 : 0) +
    (s.has('radyoloji') ? 1 : 0) +
    (s.has('raporlar') ? 1 : 0) +
    (s.has('ek_bolumler') ? 1 : 0) +
    2
  );
}

function syncPresetHighlight() {
  const selected = getSelectedSections();
  const isAll = selected.length === ALL_SECTIONS.length && !el.optRadImages.checked;
  const isRadOnly = selected.length === 1 && selected[0] === 'radyoloji' && el.optRadImages.checked;
  const isLabOnly = selected.length === 1 && selected[0] === 'tahliller' && !el.optRadImages.checked;
  const match = isAll ? 'all' : isRadOnly ? 'radyoloji' : isLabOnly ? 'tahliller' : '';
  for (const btn of el.presetBtns) {
    btn.classList.toggle('is-active', btn.dataset.preset === match);
  }
}

function syncStartButtonState() {
  syncPresetHighlight();
  if (el.radWarnBox) {
    el.radWarnBox.classList.toggle('hidden', !el.optRadImages.checked);
  }
  if (isRunning) return;
  const selected = getSelectedSections();
  el.btnStart.disabled = !tabReady || selected.length === 0;
  if (selected.length === ALL_SECTIONS.length) {
    el.btnStartLabel.textContent = 'Sağlık Arşivimi Çek';
  } else if (selected.length === 1 && selected[0] === 'radyoloji') {
    el.btnStartLabel.textContent = 'Radyoloji Arşivini Çek';
  } else {
    el.btnStartLabel.textContent = 'Seçili Bölümleri Çek';
  }
}

function applyScopePreset(preset) {
  if (preset === 'all') {
    el.secCheckboxes.forEach((cb) => { cb.checked = true; });
    el.optRadImages.checked = false;
  } else if (preset === 'radyoloji') {
    el.secCheckboxes.forEach((cb) => { cb.checked = cb.value === 'radyoloji'; });
    el.optRadImages.checked = true;
  } else if (preset === 'tahliller') {
    el.secCheckboxes.forEach((cb) => { cb.checked = cb.value === 'tahliller'; });
    el.optRadImages.checked = false;
  }
  syncStartButtonState();
}

async function ensureTeleradyolojiPermission() {
  if (!chrome.permissions?.request) return { ok: true };
  try {
    const granted = await chrome.permissions.request({ origins: [`${TELERADYOLOJI_ORIGIN}/*`] });
    if (!granted) {
      return {
        ok: false,
        error: 'Radyoloji görüntüleri için Teleradyoloji erişim izni verilmedi. İzni onaylayın veya "Radyoloji görüntülerini de indir" seçeneğini kapatın.'
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: 'Teleradyoloji izni eklentide yüklü değil. chrome://extensions sayfasında eklentiyi Yenile (Reload) yapıp tekrar deneyin.'
    };
  }
}

async function refreshTabStatus() {
  if (isRunning) return;
  const tab = await getActiveTab();
  activeTabId = tab?.id || null;
  const info = await ensureContentScriptAndPing(tab);

  if (!info.onEnabiz) {
    tabReady = false;
    setStatus(
      'status-warn',
      'e-Nabız sekmesi açık değil',
      "Önce e-Nabız'ı açıp e-Devlet veya şifrenizle giriş yapın, ardından buradan tek tıkla çekin.",
      true
    );
    syncStartButtonState();
    return;
  }

  if (!info.loggedIn) {
    tabReady = false;
    setStatus(
      'status-warn',
      'e-Nabız oturumu bekleniyor',
      'Giriş yaptıktan sonra "Yenile"ye tıklayın veya doğrudan arşivlemeyi başlatın.',
      true
    );
    syncStartButtonState();
    return;
  }

  tabReady = true;
  const who = info.patientName ? `${info.patientName} — ` : '';
  const yr = info.yearRange?.min && info.yearRange?.max ? `(${info.yearRange.min}–${info.yearRange.max})` : '';
  setStatus('status-ready', 'e-Nabız oturumu hazır', `${who}Arşiv çekmeye hazır ${yr}`.trim(), false);
  syncStartButtonState();
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
  runRadImageFiles = [];
  runRadImageStats = null;
  radChunkBuffers.clear();
}

// ---------------------------------------------------------------------------
// Radyoloji görüntüleri (Teleradyoloji)
// ---------------------------------------------------------------------------

function closeRadImageTab() {
  if (radImageTabId != null) {
    const id = radImageTabId;
    radImageTabId = null;
    try {
      chrome.tabs.remove(id).catch(() => {});
    } catch {}
  }
}

function stopRadImageDownload() {
  const tabId = radImageTabId;
  if (tabId != null && activeRadJobId) {
    chrome.tabs.sendMessage(tabId, { type: 'RAD_IMG_CANCEL', jobId: activeRadJobId, runId: currentRunId }).catch(() => {});
  }
  activeRadJobId = null;
  radChunkBuffers.clear();
  closeRadImageTab();
}

async function waitForTabReady(tabId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('Görüntüleyici sekmesi kapandı.');
    const url = tab.pendingUrl || tab.url || '';
    if (url && url !== 'about:blank' && tab.status === 'complete') return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Görüntüleyici sekmesi zaman aşımına uğradı.');
}

async function ensureRadImageTab() {
  if (radImageTabId != null) {
    try {
      const tab = await chrome.tabs.get(radImageTabId);
      if (tab && tab.url && tab.url.startsWith(TELERADYOLOJI_ORIGIN)) {
        if (tab.status !== 'complete') await waitForTabReady(radImageTabId);
        return radImageTabId;
      }
    } catch {}
    closeRadImageTab();
  }
  const tab = await chrome.tabs.create({ url: TELERADYOLOJI_VIEWER_URL, active: false });
  radImageTabId = tab.id;
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  await waitForTabReady(radImageTabId);
  const current = await chrome.tabs.get(radImageTabId);
  if (!current?.url || !current.url.startsWith(TELERADYOLOJI_ORIGIN)) {
    closeRadImageTab();
    throw new Error('Görüntüleyici beklenmeyen bir adrese yönlendi.');
  }
  return radImageTabId;
}

async function runInTeleradyolojiTab(tabId, func, args) {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return results?.[0]?.result;
  } catch (err) {
    // Sekme kapanmış/yönlenmiş olabilir; bir sonraki çalışmada yeniden açılır.
    closeRadImageTab();
    throw err;
  }
}

async function fetchViewerLinkForAccession(accession) {
  if (activeTabId == null) throw new Error('e-Nabız sekmesi bulunamadı.');
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      func: enabizFetchViewerLink,
      args: [accession]
    });
  } catch (err) {
    throw new Error(`e-Nabız sekmesine erişilemedi: ${(err && err.message) || err}`);
  }
  const result = results?.[0]?.result;
  if (!result?.ok || !result.link) {
    throw new Error(result?.error || 'Görüntüleyici bağlantısı alınamadı.');
  }
  return result.link;
}

async function downloadRadiologyImages(runId, rawData, options = {}) {
  const targets = (rawData.radyoloji || [])
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record && record.accession);
  if (targets.length === 0) return;

  const speedCfg = RAD_SPEED_CONFIG[options?.speed] || RAD_SPEED_CONFIG.balanced;
  const stats = {
    studyCount: 0,
    seriesCount: 0,
    frameCount: 0,
    failedFrames: 0,
    bytes: 0,
    errors: []
  };
  runRadImageStats = stats;
  rawData.radyolojiImages = stats;
  const seenStudyUids = new Set();

  const label = (r) => `${r.tarih || ''} ${r.aciklama || ''}`.trim();

  try {
    resetWatchdog(runId);
    await ensureRadImageTab();
  } catch (err) {
    stats.errors.push(`Görüntüleyici açılamadı: ${(err && err.message) || err}`);
    return;
  }

  try {
    for (let n = 0; n < targets.length; n += 1) {
      if (runId !== currentRunId) return;
      resetWatchdog(runId);
      const { record, index } = targets[n];
      updateProgressUI(
        Math.max(1, activeTotalStages - 1),
        activeTotalStages,
        `Radyoloji görüntüleri hazırlanıyor (${n + 1}/${targets.length}): ${record.aciklama || ''}`
      );

      let link = '';
      try {
        link = await fetchViewerLinkForAccession(record.accession);
      } catch (err) {
        stats.errors.push(`${label(record)}: ${(err && err.message) || err}`);
        continue;
      }
      const otac = extractOtac(link);
      if (!otac) {
        stats.errors.push(`${label(record)}: görüntüleyici bağlantısında OTAC bulunamadı.`);
        continue;
      }

      let auth = null;
      try {
        const tabId = await ensureRadImageTab();
        auth = await runInTeleradyolojiTab(tabId, radiologyPageAuth, [
          { base: TELERADYOLOJI_API_BASE, otac }
        ]);
      } catch (err) {
        stats.errors.push(`${label(record)}: görüntüleyici oturumu açılamadı (${(err && err.message) || err}).`);
        continue;
      }
      if (!auth?.ok) {
        stats.errors.push(`${label(record)}: ${auth?.error || 'görüntüleyici oturumu açılamadı.'}`);
        console.warn('[radyoloji] OTAC/çalışma alınamadı:', auth?.status, auth?.error || '');
        continue;
      }

      const plan = enumerateWorkItem(
        auth.workItem,
        { tarih: record.tarih, aciklama: record.aciklama, index, seenStudyUids },
        TELERADYOLOJI_ORIGIN
      );
      if (plan.warnings.length) stats.errors.push(`${label(record)}: ${plan.warnings.join(' ')}`);
      const items = plan.frames.filter((f) => f.url).map((f) => ({ path: f.path, url: f.url }));
      console.info('[radyoloji]', record.aciklama || record.tarih, '→', plan.studies.length, 'çalışma,', items.length, 'kesit');
      if (items.length === 0) continue;

      const bytesBefore = stats.bytes;
      const framesBefore = stats.frameCount;
      const filesBefore = runRadImageFiles.length;
      const pathStem = (p) => String(p || '').replace(/\.(jpg|jpeg|dcm)$/i, '');

      let download = null;
      let downloadErr = null;
      let attempt = 0;
      while (attempt < 2 && runId === currentRunId) {
        const savedStems = new Set(runRadImageFiles.slice(filesBefore).map((f) => pathStem(f.path)));
        const pendingItems = attempt === 0 ? items : items.filter((it) => !savedStems.has(pathStem(it.path)));
        if (pendingItems.length === 0) {
          download = { ok: true, done: savedStems.size, failed: 0, cancelled: false };
          downloadErr = null;
          break;
        }
        const jobId = `rad-${runId}-${index}-${attempt}-${Date.now()}`;
        activeRadJobId = jobId;
        updateProgressUI(
          Math.max(1, activeTotalStages - 1),
          activeTotalStages,
          attempt === 0
            ? `Radyoloji görüntüleri indiriliyor: ${record.aciklama || ''} (0/${pendingItems.length})`
            : `Radyoloji sekmesi yenileniyor, kalan kesitler (${pendingItems.length}): ${record.aciklama || ''}`
        );

        try {
          resetWatchdog(runId);
          const tabId = await ensureRadImageTab();
          download = await runInTeleradyolojiTab(tabId, radiologyPageDownload, [
            {
              runId,
              jobId,
              items: pendingItems,
              token: auth.token,
              concurrency: speedCfg.concurrency,
              delayMs: speedCfg.delayMs
            }
          ]);
          downloadErr = null;
          break;
        } catch (err) {
          downloadErr = err;
        } finally {
          activeRadJobId = null;
          radChunkBuffers.clear();
        }
        attempt += 1;
      }

      if (downloadErr) {
        stats.errors.push(`${label(record)}: görüntü indirme hatası (${(downloadErr && downloadErr.message) || downloadErr}).`);
      }

      if (runId !== currentRunId) return;

      const downloaded = stats.frameCount - framesBefore;
      const seriesCount = plan.studies.reduce((sum, s) => sum + (s.seriesCount || 0), 0);
      if (downloaded > 0) {
        stats.studyCount += 1;
        stats.seriesCount += seriesCount;
        const studyFolders = plan.studies.map((s) => s.folder).filter(Boolean);
        record.images = {
          folder: studyFolders[0] || '',
          folders: studyFolders,
          count: downloaded,
          seriesCount,
          bytes: stats.bytes - bytesBefore,
          failed: download?.failed || 0
        };
        if (!downloadErr && !(download?.failed > 0)) {
          for (const st of plan.studies) {
            if (st.studyUid) seenStudyUids.add(st.studyUid);
          }
        }
      } else if (download?.abortedEarly) {
        stats.errors.push(
          `${label(record)}: sunucudan görüntü alınamadı (${download.firstError || 'bağlantı hatası'}), kalan kesitler atlandı.`
        );
      } else if (!download && !downloadErr) {
        stats.errors.push(`${label(record)}: hiç görüntü indirilemedi.`);
      }
      if (download?.cancelled && !download?.abortedEarly) return;
    }
  } finally {
    closeRadImageTab();
  }
}

// Görüntüleyici sekmesinden gelen görüntü parçalarını topla.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'RAD_SLEEP') {
    if (msg.runId !== currentRunId) {
      sendResponse({ ok: false });
      return;
    }
    const wait = Math.min(15000, Math.max(0, Number(msg.ms) || 0));
    setTimeout(() => sendResponse({ ok: true, slept: true }), wait);
    return true;
  }
  if (!['RAD_IMG_FILE', 'RAD_IMG_CHUNK', 'RAD_IMG_PROGRESS', 'RAD_IMG_ERROR'].includes(msg.type)) return;
  if (msg.runId !== currentRunId || !runRadImageStats) {
    sendResponse({ ok: false });
    return;
  }
  resetWatchdog(msg.runId);

  if (msg.type === 'RAD_IMG_FILE' || msg.type === 'RAD_IMG_CHUNK') {
    const path = String(msg.path || '');
    if (!path.startsWith(RAD_IMG_PREFIX)) {
      sendResponse({ ok: false });
      return;
    }

    let base64 = msg.base64;
    if (msg.type === 'RAD_IMG_CHUNK') {
      const buffer = radChunkBuffers.get(path) || {
        parts: new Array(msg.chunkCount),
        received: 0,
        count: msg.chunkCount
      };
      buffer.parts[msg.chunkIndex] = msg.data;
      buffer.received += 1;
      if (buffer.received < buffer.count) {
        radChunkBuffers.set(path, buffer);
        sendResponse({ ok: true });
        return;
      }
      radChunkBuffers.delete(path);
      base64 = buffer.parts.join('');
    }

    const bytes = base64ToUint8Array(base64);
    runRadImageFiles.push({ path, content: bytes });
    runRadImageStats.frameCount += 1;
    runRadImageStats.bytes += bytes.byteLength;
    if (msg.total) {
      updateProgressUI(
        Math.max(1, activeTotalStages - 1),
        activeTotalStages,
        `Radyoloji görüntüleri: ${msg.done || runRadImageStats.frameCount}/${msg.total} kesit · ${(runRadImageStats.bytes / 1048576).toFixed(1)} MB`
      );
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'RAD_IMG_PROGRESS') {
    if (msg.label) updateProgressUI(Math.max(1, activeTotalStages - 1), activeTotalStages, msg.label);
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'RAD_IMG_ERROR') {
    runRadImageStats.failedFrames += 1;
    if (runRadImageStats.errors.length < 12) {
      const detail = msg.error ? ` (${msg.error})` : '';
      runRadImageStats.errors.push(`${msg.path || 'görüntü'} indirilemedi${detail}`);
    }
    sendResponse({ ok: true });
  }
});

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
    syncStartButtonState();
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
  stopRadImageDownload();
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

async function finalizeArchive(runId, rawData, options = {}) {
  try {
    if (runId !== currentRunId) return;

    updateProgressUI(Math.max(1, activeTotalStages - 1), activeTotalStages, `PDF metinleri tamamlanıyor (${runPdfProcessedCount} adet)...`);
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

    if (options.includeRadImages) {
      await downloadRadiologyImages(runId, rawData, options);
      if (runId !== currentRunId) return;
    }

    updateProgressUI(activeTotalStages, activeTotalStages, 'Markdown klasör yapısı derleniyor...');
    const { files, stats } = buildMarkdownArchive(rawData, { labPdfTexts: runLabPdfTexts });

    const allEntries = new Map();
    for (const [p, content] of files.entries()) {
      allEntries.set(p, content);
    }
    for (const pf of runRawPdfFiles) {
      allEntries.set(pf.path, pf.content);
    }
    for (const rf of runRadImageFiles) {
      allEntries.set(rf.path, rf.content);
    }
    if (el.optRawJson.checked) {
      allEntries.set('enabiz_ham_veri.json', JSON.stringify(rawData, null, 2));
    }

    if (runId !== currentRunId) return;
    renderResults(allEntries, stats);
    setRunningState(false);
    disconnectActivePort();
  } finally {
    if (runId === currentRunId) clearWatchdog();
  }
}

function renderResults(entries, stats) {
  lastArchiveEntries = entries;
  lastStats = stats;

  const encoder = new TextEncoder();
  const totalBytes = Array.from(entries.values()).reduce(
    (sum, v) => sum + (typeof v === 'string' ? encoder.encode(v).length : v.byteLength),
    0
  );
  if (totalBytes > 1.5 * 1024 ** 3) {
    stats.warnings = stats.warnings || [];
    stats.warnings.push(
      'Arşiv 1,5 GB üzerinde. ZIP oluşturma bellek/2 GB sınırı nedeniyle başarısız olabilir; "Klasöre Kaydet" seçeneğini kullanmanız önerilir.'
    );
  }
  el.resultMeta.textContent = `${entries.size} dosya · ${formatBytes(totalBytes)} · ${el.progressTimer.textContent}`;

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
    { val: String(stats.radImageCount || 0), lbl: 'Radyo. Kesiti' },
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
  const openPreview = (path, content, byteLen, sourceRow) => {
    lastFocusedElement = sourceRow;
    el.modalTitle.textContent = path;
    el.modalContent.textContent =
      typeof content === 'string'
        ? content
        : `[İkili dosya — ${formatBytes(byteLen)}]`;
    el.previewModal.classList.remove('hidden');
    el.btnCloseModal.focus();
  };

  let hiddenImageCount = 0;
  let hiddenImageBytes = 0;
  const imageIndexPath = `${RAD_IMG_PREFIX}00-dizin.md`;
  for (const [path, content] of entries.entries()) {
    const byteLen = typeof content === 'string' ? encoder.encode(content).length : content.byteLength;

    if (path.startsWith(RAD_IMG_PREFIX) && path !== imageIndexPath) {
      hiddenImageCount += 1;
      hiddenImageBytes += byteLen;
      continue;
    }

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'file-item';
    const pathSpan = document.createElement('span');
    pathSpan.textContent = path;
    const sizeSpan = document.createElement('span');
    sizeSpan.className = 'file-size';
    sizeSpan.textContent = formatBytes(byteLen);
    row.append(pathSpan, sizeSpan);

    row.addEventListener('click', () => openPreview(path, content, byteLen, row));
    el.fileTree.appendChild(row);
  }

  if (hiddenImageCount > 0) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'file-item file-item-summary';
    const pathSpan = document.createElement('span');
    pathSpan.textContent = `${RAD_IMG_PREFIX} (${hiddenImageCount} görüntü)`;
    const sizeSpan = document.createElement('span');
    sizeSpan.className = 'file-size';
    sizeSpan.textContent = formatBytes(hiddenImageBytes);
    row.append(pathSpan, sizeSpan);
    const indexContent = entries.get(imageIndexPath);
    row.addEventListener('click', () => {
      if (indexContent !== undefined) openPreview(imageIndexPath, indexContent, encoder.encode(indexContent).length, row);
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

  const selectedSections = getSelectedSections();
  if (selectedSections.length === 0) {
    showError('Lütfen en az bir bölüm seçin.');
    return;
  }

  const wantRadImages = Boolean(el.optRadImages.checked && selectedSections.includes('radyoloji'));
  if (wantRadImages) {
    // Request Teleradyoloji host permission while user gesture is still active
    const perm = await ensureTeleradyolojiPermission();
    if (!perm.ok) {
      showError(perm.error);
      return;
    }
  }

  stopRadImageDownload();

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
  activeTotalStages = getExpectedTotalStages(selectedSections);
  const options = {
    sections: selectedSections,
    startYear: el.startYear.value,
    endYear: el.endYear.value,
    includeReportPdfs: el.optReportPdfs.checked,
    includeLabPdfTimes: el.optLabTimes.checked,
    includeRawPdfs: el.optRawPdfs.checked,
    includeRadImages: wantRadImages,
    speed: el.requestSpeed.value
  };

  setRunningState(true);
  updateProgressUI(1, activeTotalStages, 'e-Nabız bağlantısı başlatılıyor...');
  resetWatchdog(runId);

  try {
    const port = chrome.tabs.connect(tab.id, { name: 'enabiz-export' });
    activePort = port;

    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.runId !== currentRunId) return; // Strict run isolation

      resetWatchdog(runId);

      if (msg.type === 'EXPORT_PROGRESS') {
        if (msg.totalStages) activeTotalStages = msg.totalStages;
        updateProgressUI(msg.stageIndex || 1, activeTotalStages, msg.label || '');
      } else if (msg.type === 'EXPORT_PDF_BLOB') {
        enqueuePdfBlob(runId, msg, options);
      } else if (msg.type === 'EXPORT_COMPLETE') {
        disconnectActivePort();
        resetWatchdog(runId);
        finalizeArchive(runId, msg.data, options).catch((err) => {
          if (runId === currentRunId) {
            setRunningState(false);
            showError(`Arşiv derleme hatası: ${err?.message || err}`);
          }
        });
      } else if (msg.type === 'EXPORT_ERROR') {
        clearWatchdog();
        stopRadImageDownload();
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
        cancelCurrentRun('e-Nabız sekmesiyle bağlantı kesildi (sayfa yenilenmiş veya kapatılmış olabilir).');
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

window.addEventListener('pagehide', () => {
  closeRadImageTab();
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
el.presetBtns.forEach((btn) => {
  btn.addEventListener('click', () => applyScopePreset(btn.dataset.preset));
});
el.secCheckboxes.forEach((cb) => {
  cb.addEventListener('change', () => {
    if (cb === el.secRadyoloji && !cb.checked) {
      el.optRadImages.checked = false;
    }
    syncStartButtonState();
  });
});
el.optRadImages.addEventListener('change', () => {
  if (el.optRadImages.checked && el.secRadyoloji) {
    el.secRadyoloji.checked = true;
  }
  syncStartButtonState();
});
el.btnStart.addEventListener('click', handleStartClick);
el.btnDownloadZip.addEventListener('click', handleDownloadZip);
el.btnSaveFolder.addEventListener('click', handleSaveFolder);
el.btnCopyPrompt.addEventListener('click', handleCopyPrompt);
el.btnCloseModal.addEventListener('click', closeModal);
el.modalBackdrop.addEventListener('click', closeModal);

syncStartButtonState();
populateYearDropdowns();
refreshTabStatus();
