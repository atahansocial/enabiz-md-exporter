import { buildMarkdownArchive } from './lib/markdown-builder.js';
import { base64ToUint8Array, extractPdfText } from './lib/pdf-extractor.js';
import { createZipBlob } from './lib/zip.js';

const ENABIZ_ZİYARET_URL = 'https://enabiz.gov.tr/Home/Ziyaretlerim';

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
  resultMeta: document.getElementById('resultMeta'),
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
let isRunning = false;
let timerInterval = null;
let startTimestamp = 0;
let collectedPdfBlobs = [];
let lastArchiveEntries = null; // Map<string, string | Uint8Array>
let lastStats = null;

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
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content.js'] });
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
      'Önce e-Nabız\'ı açıp e-Devlet veya şifrenizle giriş yapın, ardından buradan tek tıkla çekin.',
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
  setStatus(
    'status-ready',
    'e-Nabız oturumu hazır',
    `${who}Arşiv çekmeye hazır ${yr}`.trim(),
    false
  );
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
    el.btnStart.classList.remove('btn-stop');
    el.btnStartLabel.textContent = 'Sağlık Arşivimi Çek';
    stopTimer();
    refreshTabStatus();
  }
}

function updateProgressUI(stageIndex, totalStages, label) {
  const pct = Math.max(4, Math.min(100, Math.round((stageIndex / totalStages) * 100)));
  el.progressBar.style.width = `${pct}%`;
  el.progressStage.textContent = `Adım ${stageIndex}/${totalStages}`;
  el.progressDetail.textContent = label;
}

async function processPdfsAndBuildArchive(rawData) {
  const labPdfTexts = {};
  const rawPdfFiles = [];
  const totalPdfs = collectedPdfBlobs.length;

  for (let i = 0; i < totalPdfs; i++) {
    const item = collectedPdfBlobs[i];
    updateProgressUI(
      9,
      10,
      `PDF metinleri yerel olarak çözümleniyor (${i + 1}/${totalPdfs})...`
    );

    const u8 = base64ToUint8Array(item.base64);
    if (el.optRawPdfs.checked) {
      rawPdfFiles.push({ path: item.relativePath, content: u8 });
    }

    try {
      const parsed = await extractPdfText(u8);
      if (item.kind === 'rapor' && rawData.raporlar?.raporlar?.[item.raporIndex]) {
        const rp = rawData.raporlar.raporlar[item.raporIndex];
        rp.pdf = {
          ...(rp.pdf || {}),
          pageCount: parsed.pageCount,
          extractedText: parsed.text
        };
      } else if (item.kind === 'radyoloji' && rawData.radyoloji?.[item.radIndex]) {
        const rad = rawData.radyoloji[item.radIndex];
        rad.pdf = {
          ...(rad.pdf || {}),
          pageCount: parsed.pageCount,
          extractedText: parsed.text
        };
      } else if (item.kind === 'lab') {
        labPdfTexts[item.filename] = parsed.text;
        if (rawData.tahlillerim?.panels?.[item.panelIndex]?.pdf) {
          rawData.tahlillerim.panels[item.panelIndex].pdf.extractedText = parsed.text;
        }
      }
    } catch (err) {
      console.warn('PDF parse skipped for', item.filename, err);
    }
  }

  updateProgressUI(10, 10, 'Markdown klasör yapısı derleniyor...');
  const { files, stats } = buildMarkdownArchive(rawData, { labPdfTexts });

  const allEntries = new Map();
  for (const [p, content] of files.entries()) {
    allEntries.set(p, content);
  }
  for (const pf of rawPdfFiles) {
    allEntries.set(pf.path, pf.content);
  }
  if (el.optRawJson.checked) {
    allEntries.set('enabiz_ham_veri.json', JSON.stringify(rawData, null, 2));
  }

  return { entries: allEntries, stats };
}

function renderResults(entries, stats) {
  lastArchiveEntries = entries;
  lastStats = stats;

  const totalBytes = Array.from(entries.values()).reduce(
    (sum, v) => sum + (typeof v === 'string' ? new TextEncoder().encode(v).length : v.byteLength),
    0
  );
  el.resultMeta.textContent = `${entries.size} dosya · ${(totalBytes / 1024).toFixed(0)} KB · ${el.progressTimer.textContent}`;

  const gridItems = [
    { val: stats.totalVisits, lbl: 'Ziyaret' },
    { val: stats.totalIslemRows, lbl: 'Tıbbi İşlem' },
    { val: `${stats.labRowsCount} (${stats.oorCount}!)`, lbl: 'Tahlil (Ref. Dışı)' },
    { val: stats.radCount, lbl: 'Radyoloji' },
    { val: stats.raporCount, lbl: 'Sağlık Raporu' },
    { val: stats.receteCount, lbl: 'Reçete' }
  ];
  el.statsGrid.innerHTML = gridItems
    .map(
      (g) => `<div class="stat-box"><div class="stat-val">${g.val}</div><div class="stat-lbl">${g.lbl}</div></div>`
    )
    .join('');

  el.fileTree.innerHTML = '';
  const encoder = new TextEncoder();
  for (const [path, content] of entries.entries()) {
    const byteLen = typeof content === 'string' ? encoder.encode(content).length : content.byteLength;
    const sizeStr = byteLen >= 1024 ? `${(byteLen / 1024).toFixed(1)} KB` : `${byteLen} B`;
    const row = document.createElement('div');
    row.className = 'file-item';
    row.innerHTML = `<span>${path}</span><span class="file-size">${sizeStr}</span>`;
    row.addEventListener('click', () => {
      if (typeof content !== 'string') {
        el.modalTitle.textContent = path;
        el.modalContent.textContent = `[İkili PDF dosyası — ${(byteLen / 1024).toFixed(1)} KB]`;
      } else {
        el.modalTitle.textContent = path;
        el.modalContent.textContent = content;
      }
      el.previewModal.classList.remove('hidden');
    });
    el.fileTree.appendChild(row);
  }

  el.btnSaveFolder.classList.toggle('hidden', typeof window.showDirectoryPicker !== 'function');
  el.progressCard.classList.add('hidden');
  el.resultCard.classList.remove('hidden');
}

async function handleStartClick() {
  if (isRunning) {
    if (activeTabId) {
      chrome.tabs.sendMessage(activeTabId, { type: 'CANCEL_EXPORT' }).catch(() => {});
    }
    setRunningState(false);
    return;
  }

  const tab = await getActiveTab();
  const info = await ensureContentScriptAndPing(tab);
  if (!info.onEnabiz || !info.loggedIn) {
    showError('Lütfen önce e-Nabız sekmesinde oturum açın.');
    return;
  }

  activeTabId = tab.id;
  collectedPdfBlobs = [];
  setRunningState(true);
  updateProgressUI(1, 10, 'e-Nabız bağlantısı başlatılıyor...');

  try {
    const res = await chrome.tabs.sendMessage(tab.id, {
      type: 'START_EXPORT',
      options: {
        startYear: el.startYear.value,
        endYear: el.endYear.value,
        includeReportPdfs: el.optReportPdfs.checked,
        includeLabPdfTimes: el.optLabTimes.checked,
        includeRawPdfs: el.optRawPdfs.checked
      }
    });

    if (!res?.ok) {
      if (res?.cancelled) {
        el.progressCard.classList.add('hidden');
      } else if (res?.sessionExpired) {
        showError('e-Nabız oturumunuzun süresi dolmuş. Lütfen e-Nabız sayfasını yenileyip tekrar giriş yapın.');
      } else {
        showError(res?.error || 'Veriler çekilirken beklenmeyen bir hata oluştu.');
      }
      setRunningState(false);
      return;
    }

    const { entries, stats } = await processPdfsAndBuildArchive(res.data);
    renderResults(entries, stats);
  } catch (err) {
    showError(`İletişim hatası: ${err?.message || err}`);
  } finally {
    setRunningState(false);
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

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'EXPORT_PROGRESS' && isRunning) {
    updateProgressUI(msg.stageIndex || 1, 10, msg.label || '');
  } else if (msg.type === 'EXPORT_PDF_BLOB' && isRunning) {
    collectedPdfBlobs.push(msg);
  }
});

chrome.tabs.onActivated.addListener(() => refreshTabStatus());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTabId && changeInfo.status === 'complete') {
    refreshTabStatus();
  }
});

el.btnOpenEnabiz.addEventListener('click', () => chrome.tabs.create({ url: ENABIZ_ZİYARET_URL }));
el.btnRecheck.addEventListener('click', refreshTabStatus);
el.btnStart.addEventListener('click', handleStartClick);
el.btnDownloadZip.addEventListener('click', handleDownloadZip);
el.btnSaveFolder.addEventListener('click', handleSaveFolder);
el.btnCopyPrompt.addEventListener('click', handleCopyPrompt);
el.btnCloseModal.addEventListener('click', () => el.previewModal.classList.add('hidden'));
el.modalBackdrop.addEventListener('click', () => el.previewModal.classList.add('hidden'));

refreshTabStatus();
