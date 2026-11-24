/**
 * e-Nabız Markdown Arşivleyici — Salt Okunur (Read-Only) İçerik Betiği
 * Yalnızca kullanıcının kendi aktif https://enabiz.gov.tr oturumu üzerinden
 * salt-okunur isteklerle sağlık verilerini toplar; hiçbir kayıt eklemez veya değiştirmez.
 */
(() => {
  if (window.__enabizMdExporterLoaded) return;
  window.__enabizMdExporterLoaded = true;

  const P = globalThis.__enabizDomParsers;
  if (!P) {
    console.error('[e-Nabız Arşivleyici] __enabizDomParsers yüklenemedi.');
    return;
  }

  const TOTAL_STAGES = 10;
  const REQUEST_TIMEOUT_MS = 25000;

  let activeRunId = 0;
  let cancelRequested = false;
  let currentDelayMs = 120;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const htmlToDoc = (html) => new DOMParser().parseFromString(html || '', 'text/html');

  function isSessionExpiredResponse(res, text = '') {
    if (res.status === 401 || res.status === 403) return true;
    if (res.url && (res.url.includes('turkiye.gov.tr') || res.url.includes('/Account/Login'))) return true;
    if (text && text.includes('e-Devlet Kapısı') && text.includes('Kimlik Doğrulama')) return true;
    return false;
  }

  function isLoggedInDocument() {
    const path = location.pathname || '';
    if (path.includes('/Account/Login') || path.includes('/Account/')) return false;
    const bodyTxt = document.body?.innerText || '';
    if (bodyTxt.includes('e-Devlet Kapısı') && bodyTxt.includes('Kimlik Doğrulama')) return false;
    return Boolean(
      document.querySelector('input[name="__RequestVerificationToken"]') ||
        document.querySelector('a[href*="/Account/Logout"], a[href*="/Home/Profil"], .ziyaretCardList, main')
    );
  }

  function detectHeaderName() {
    const el = document.querySelector('a[href="#"].dropdown-toggle, header a[aria-expanded], .userName, .kullaniciAdi');
    const txt = P.cleanText(el);
    if (txt && txt.length >= 4 && !/çıkış|menü|profil/i.test(txt)) return txt;
    const candidate = Array.from(document.querySelectorAll('header a'))
      .map((a) => P.cleanText(a))
      .find((t) => /^[A-ZÇĞİÖŞÜ\s]{5,}$/.test(t));
    return candidate || '';
  }

  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    let bin = '';
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function hasPdfMagic(buf) {
    const b = new Uint8Array(buf);
    return b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d;
  }

  function bumpDelay() {
    currentDelayMs = currentDelayMs < 350 ? 350 : Math.min(700, currentDelayMs * 2);
  }

  function relaxDelay() {
    if (currentDelayMs > 120) {
      currentDelayMs = Math.max(120, Math.floor(currentDelayMs * 0.85));
    }
  }

  async function safeFetchText(url, opts = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (cancelRequested) return { ok: false, cancelled: true, status: 0, text: '' };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(url, { credentials: 'include', signal: controller.signal, ...opts });
        const text = await res.text();
        clearTimeout(timer);
        if (isSessionExpiredResponse(res, text)) {
          return { ok: false, sessionExpired: true, status: res.status, url: res.url, text: '' };
        }
        if (res.status === 429 || res.status >= 500) {
          bumpDelay();
          if (attempt === 0) {
            await sleep(600);
            continue;
          }
        } else if (res.ok) {
          relaxDelay();
        }
        return { ok: res.ok, status: res.status, url: res.url, text };
      } catch (err) {
        clearTimeout(timer);
        if (attempt === 0) {
          await sleep(500);
          continue;
        }
        return {
          ok: false,
          status: 0,
          error: err?.name === 'AbortError' ? 'Zaman aşımı (25 sn)' : String(err),
          text: ''
        };
      }
    }
    return { ok: false, status: 0, text: '' };
  }

  async function safeFetchBuffer(url, opts = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (cancelRequested) return { ok: false, cancelled: true, status: 0, buffer: null };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(url, { credentials: 'include', signal: controller.signal, ...opts });
        if (isSessionExpiredResponse(res, '')) {
          clearTimeout(timer);
          return { ok: false, sessionExpired: true, status: res.status, buffer: null };
        }
        const buffer = await res.arrayBuffer();
        clearTimeout(timer);
        if (res.status === 429 || res.status >= 500) {
          bumpDelay();
          if (attempt === 0) {
            await sleep(600);
            continue;
          }
        } else if (res.ok) {
          relaxDelay();
        }
        return {
          ok: res.ok,
          status: res.status,
          contentType: res.headers.get('content-type') || '',
          buffer
        };
      } catch (err) {
        clearTimeout(timer);
        if (attempt === 0) {
          await sleep(500);
          continue;
        }
        return {
          ok: false,
          status: 0,
          error: err?.name === 'AbortError' ? 'Zaman aşımı (25 sn)' : String(err),
          buffer: null
        };
      }
    }
    return { ok: false, status: 0, buffer: null };
  }

  async function postForm(url, paramsObj, xsrfToken) {
    return safeFetchText(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'XSRF-TOKEN': xsrfToken,
        'RequestVerificationToken': xsrfToken
      },
      body: new URLSearchParams(paramsObj || {})
    });
  }

  async function runExportOnPort(port, runId, options = {}) {
    activeRunId = runId;
    cancelRequested = false;
    currentDelayMs = 120;

    const fetchReportPdfs = Boolean(options.includeReportPdfs || options.includeRawPdfs);
    const fetchLabPdfs = Boolean(options.includeLabPdfTimes || options.includeRawPdfs);
    const currentYearStr = String(new Date().getFullYear());

    const postMsg = (payload) => {
      try {
        port.postMessage({ runId, ...payload });
      } catch {
        // Port may already be disconnected
      }
    };

    const emitProgress = (stage, stageIndex, label, extra = {}) => {
      postMsg({
        type: 'EXPORT_PROGRESS',
        stage,
        stageIndex,
        totalStages: TOTAL_STAGES,
        label,
        ...extra
      });
    };

    const heartbeatTimer = setInterval(() => {
      if (!cancelRequested && activeRunId === runId) {
        postMsg({ type: 'HEARTBEAT', ts: Date.now() });
      }
    }, 10000);

    const checkAbort = () => {
      if (cancelRequested || runId !== activeRunId) {
        const err = new Error('CANCELLED');
        err.isCancelled = true;
        throw err;
      }
    };

    const sectionStatuses = [];
    const errors = [];
    const recordSection = (section, label, endpoint, res, recordCount = 0) => {
      const ok = Boolean(res?.ok);
      const status = res?.status ?? 0;
      const errMsg = ok ? '' : res?.error || `HTTP ${status}`;
      sectionStatuses.push({ section, label, endpoint, ok, status, recordCount, error: errMsg });
      if (!ok) {
        errors.push({ section, label, endpoint, status, error: errMsg });
      }
    };

    try {
      // Stage 1: Session, XSRF token, year discovery & Profile
      emitProgress('profil', 1, 'Oturum, yıl aralığı ve profil bilgileri alınıyor...');

      let xsrfToken = document.querySelector('input[name="__RequestVerificationToken"]')?.value || '';
      let visitsStartYear = options.startYear && options.startYear !== 'auto' ? String(options.startYear) : '';
      let visitsEndYear = options.endYear && options.endYear !== 'auto' ? String(options.endYear) : '';

      const ziyPage = await safeFetchText('/Home/Ziyaretlerim');
      if (ziyPage.sessionExpired) {
        postMsg({ type: 'EXPORT_ERROR', sessionExpired: true });
        return;
      }
      checkAbort();

      const ziyPageDoc = ziyPage.ok ? htmlToDoc(ziyPage.text) : document;
      if (!xsrfToken) {
        xsrfToken = ziyPageDoc.querySelector('input[name="__RequestVerificationToken"]')?.value || '';
      }

      const startOpts = Array.from(ziyPageDoc.querySelectorAll('#baslangicyilSelect option'))
        .map((o) => o.value)
        .filter((v) => /^\d{4}$/.test(v));
      const endOpts = Array.from(ziyPageDoc.querySelectorAll('#bitisyilSelect option'))
        .map((o) => o.value)
        .filter((v) => /^\d{4}$/.test(v));

      if (!visitsStartYear) {
        visitsStartYear = startOpts.length ? String(Math.min(...startOpts.map(Number))) : '2015';
      }
      if (!visitsEndYear) {
        visitsEndYear = endOpts.length ? String(Math.max(...endOpts.map(Number))) : currentYearStr;
      }

      const wideStartYear = String(Math.min(Number(visitsStartYear), 2017));

      const profRes = await safeFetchText('/Home/ProfilBilgilerim');
      if (profRes.sessionExpired) {
        postMsg({ type: 'EXPORT_ERROR', sessionExpired: true });
        return;
      }
      checkAbort();
      const profil = profRes.ok
        ? P.parseProfilFromDoc(htmlToDoc(profRes.text), detectHeaderName())
        : { adSoyad: detectHeaderName() };
      recordSection('profil', 'Profil Bilgilerim', '/Home/ProfilBilgilerim', profRes, profRes.ok ? 1 : 0);

      // Stage 2: Visits list
      emitProgress('ziyaret_liste', 2, `Ziyaret listesi çekiliyor (${visitsStartYear}–${visitsEndYear})...`);

      const ziyListRes = await postForm(
        '/Ziyaret/Index',
        { baslangicYil: visitsStartYear, bitisYil: visitsEndYear },
        xsrfToken
      );
      if (ziyListRes.sessionExpired) {
        postMsg({ type: 'EXPORT_ERROR', sessionExpired: true });
        return;
      }
      checkAbort();

      let visits = ziyListRes.ok ? P.parseVisitCardsFromDoc(htmlToDoc(ziyListRes.text)) : [];
      if (visits.length === 0) visits = P.parseVisitCardsFromDoc(ziyPageDoc);
      if (visits.length === 0 && location.pathname.includes('/Home/Ziyaretlerim')) {
        visits = P.parseVisitCardsFromDoc(document);
      }
      recordSection('ziyaretler_liste', 'Ziyaret Listesi', '/Ziyaret/Index', ziyListRes, visits.length);

      const exportData = {
        metadata: {
          patientName: profil.adSoyad || detectHeaderName(),
          exportedAt: new Date().toISOString(),
          sourceUrl: location.href,
          dateRange: { start: visitsStartYear, end: visitsEndYear },
          domVisitCount: visits.length
        },
        profil,
        visits,
        hastaliklarim: { headers: [], rows: [], status: null },
        radyoloji: [],
        raporlar: { headers: [], raporlar: [], basvurular: [], status: null },
        epikrizler: { headers: [], rows: [], status: null },
        patolojiler: { headers: [], rows: [], status: null },
        tahlillerim: { panels: [], covid19: { headers: [], rows: [] }, status: null, covidStatus: null, pdfTargets: [] },
        ilaclarim: { headers: [], rows: [], status: null },
        recetelerimOzet: { totalRows: 0, ekstraReceteler: [], optik: null, tibbiCihaz: null },
        asiTakvimi: { tables: [], status: null },
        alerjilerim: { tables: [], status: null },
        hastalikTakip: { tables: [], status: null },
        hastalikTakipDetay: [],
        randevularim: { tables: [], status: null },
        taramalar: { tables: [], status: null },
        malzemeVeCihazlarim: { tables: {}, status: null },
        malzemeDetaylari: [],
        sigortalarim: { count: 0, rows: [], headers: [], status: null },
        acilDurumNotlarim: { text: '', tables: [], status: null },
        dokumanlarim: { tables: [], status: null },
        sectionStatuses,
        errors
      };

      // Stage 3: Visit details (4 concurrent)
      emitProgress(
        'ziyaret_detay',
        3,
        `Ziyaret detayları ve reçeteler çekiliyor (0/${visits.length})...`,
        { current: 0, total: visits.length }
      );

      const knownPaneIds = new Set([
        'pills-ziyaretlerimTani',
        'pills-ziyaretlerimOnTani',
        'pills-ziyaretlerimEkTani',
        'pills-ziyaretlerimIslemler',
        'pills-ziyaretlerimReceteler',
        'pills-ziyaretlerimRapor',
        'pills-ziyaretlerimDoktorMesaji',
        'pills-ziyaretlerimGozlukRecetesi',
        'pills-ziyaretlerimTahliller'
      ]);

      async function processVisit(v) {
        if (!v.detayUrl) {
          v.detayStatus = 0;
          v.detayError = 'detayUrl yok';
          return;
        }
        const r = await safeFetchText(v.detayUrl);
        if (r.sessionExpired) {
          const e = new Error('SESSION_EXPIRED');
          e.sessionExpired = true;
          throw e;
        }
        v.detayStatus = r.status;
        if (!r.ok) {
          v.detayError = r.error || `HTTP ${r.status}`;
          errors.push({ section: 'ziyaret_detay', label: `Ziyaret #${v.index} (${v.tarih})`, endpoint: v.detayUrl, status: r.status, error: v.detayError });
          return;
        }
        const doc = htmlToDoc(r.text);
        const getRows = (sel, mapFn) =>
          Array.from(doc.querySelectorAll(`${sel} tbody tr`))
            .map((tr) => mapFn(tr, Array.from(tr.querySelectorAll('td'))))
            .filter(Boolean);

        const tani = getRows('#tblZiyaretlerimTani', (_tr, tds) =>
          tds.length >= 4
            ? { tarih: P.cleanText(tds[0]), tani: P.cleanText(tds[1]), hekim: P.cleanText(tds[2]), klinik: P.cleanText(tds[3]) }
            : null
        );
        const onTani = getRows('#tblZiyaretlerimOnTani', (_tr, tds) =>
          tds.length >= 4
            ? { tarih: P.cleanText(tds[0]), onTani: P.cleanText(tds[1]), hekim: P.cleanText(tds[2]), klinik: P.cleanText(tds[3]) }
            : null
        );
        const ekTani = getRows('#tblZiyaretlerimEkTani', (_tr, tds) =>
          tds.length >= 4
            ? { tarih: P.cleanText(tds[0]), ekTani: P.cleanText(tds[1]), hekim: P.cleanText(tds[2]), klinik: P.cleanText(tds[3]) }
            : null
        );
        const islemler = getRows('#tblZiyaretlerimIslemler', (tr, tds) => {
          if (tds.length < 4) return null;
          const oc = tr.querySelector('[onclick]')?.getAttribute('onclick') || '';
          const km = oc.match(/IslemKodu=([^&']+)/);
          return {
            islemZamani: P.cleanText(tds[0]),
            randevuZamani: P.cleanText(tds[1]),
            adet: P.cleanText(tds[2]),
            islemAdi: P.cleanText(tds[3]),
            islemKodu: km ? decodeURIComponent(km[1]).trim() : ''
          };
        });
        const receteler = getRows('#tblZiyaretlerimReceteler', (tr, tds) => {
          if (tds.length < 3) return null;
          const oc = tr.querySelector('[onclick]')?.getAttribute('onclick') || '';
          const um = oc.match(/url:\s*'([^']+)'/);
          return {
            receteTarihi: P.cleanText(tds[0]),
            receteNo: P.cleanText(tds[1]),
            receteTuru: P.cleanText(tds[2]),
            detayUrl: um ? um[1] : null,
            ilaclar: null
          };
        });

        for (const rec of receteler) {
          if (!rec.detayUrl) continue;
          await sleep(80);
          const rr = await safeFetchText(rec.detayUrl);
          if (rr.ok) {
            rec.ilaclar = { status: rr.status, ...P.parsePrescriptionTables(htmlToDoc(rr.text)) };
          } else {
            errors.push({ section: 'recete_detay', label: `Reçete ${rec.receteNo}`, endpoint: rec.detayUrl, status: rr.status, error: rr.error || `HTTP ${rr.status}` });
          }
        }

        const tahliller = getRows('#tblZiyaretlerimTahliller', (tr, tds) => {
          if (tds.length < 5) return null;
          const cls = `${tr.className || ''} ${tds.map((td) => td.className || '').join(' ')}`;
          const isOutOfRange =
            /kirmizi|danger|high|low|abnormal/i.test(cls) ||
            Boolean(tr.querySelector('.text-danger, .kirmizitd, .fa-arrow-up, .fa-arrow-down'));
          return {
            ttId: tr.getAttribute('data-tt-id') || null,
            parentId: tr.getAttribute('data-tt-parent-id') || null,
            tarih: P.cleanText(tds[0]),
            islemAdi: P.cleanText(tds[1]),
            sonuc: P.cleanText(tds[2]),
            birim: P.cleanText(tds[3]),
            referans: P.cleanText(tds[4]),
            isOutOfRange
          };
        });

        const rapor = P.parseGenericPane(doc.querySelector('#pills-ziyaretlerimRapor'));
        const doktorMesaji = P.parseGenericPane(doc.querySelector('#pills-ziyaretlerimDoktorMesaji'));
        const gozlukRecetesi = P.parseGenericPane(doc.querySelector('#pills-ziyaretlerimGozlukRecetesi'));
        const ekSekmeler = [];
        for (const p of doc.querySelectorAll('.tab-pane')) {
          if (!knownPaneIds.has(p.id)) {
            const parsed = P.parseGenericPane(p);
            if (parsed) ekSekmeler.push({ id: p.id, ...parsed });
          }
        }

        v.detay = { tani, onTani, ekTani, islemler, receteler, tahliller, rapor, doktorMesaji, gozlukRecetesi, ekSekmeler };
      }

      for (let i = 0; i < visits.length; i += 4) {
        checkAbort();
        await Promise.all(visits.slice(i, i + 4).map(processVisit));
        const done = Math.min(i + 4, visits.length);
        emitProgress(
          'ziyaret_detay',
          3,
          `Ziyaret detayları ve reçeteler çekiliyor (${done}/${visits.length})...`,
          { current: done, total: visits.length }
        );
        await sleep(currentDelayMs);
      }

      // Stage 4: Hastaliklarim + Ilaclarim + Recetelerim cross-check
      emitProgress('tanilar_ilaclar', 4, 'Hastalıklarım ve İlaç/Reçete geçmişi çekiliyor...');
      checkAbort();

      const hasRes = await postForm(
        '/Hastalik/Index',
        { baslangicYili: wideStartYear, bitisYili: visitsEndYear },
        xsrfToken
      );
      if (hasRes.sessionExpired) {
        postMsg({ type: 'EXPORT_ERROR', sessionExpired: true });
        return;
      }
      exportData.hastaliklarim.status = hasRes.status;
      if (hasRes.ok) {
        const parsedHas = P.parseHastalikRows(htmlToDoc(hasRes.text));
        exportData.hastaliklarim.headers = parsedHas.headers;
        exportData.hastaliklarim.rows = parsedHas.rows;
        if (parsedHas.missingHeaders.length > 0) {
          errors.push({ section: 'hastaliklarim', label: 'Hastalıklarım sütun uyarısı', endpoint: '/Hastalik/Index', status: hasRes.status, error: `Eşleşmeyen sütunlar: ${parsedHas.missingHeaders.join(', ')}` });
        }
      }
      recordSection('hastaliklarim', 'Hastalıklarım', '/Hastalik/Index', hasRes, exportData.hastaliklarim.rows.length);

      await sleep(currentDelayMs);
      checkAbort();

      const ilacRes = await postForm('/Ilac/Index', { baslangicYil: wideStartYear, bitisYil: visitsEndYear }, xsrfToken);
      exportData.ilaclarim.status = ilacRes.status;
      if (ilacRes.ok) {
        const pt = P.parseTable(htmlToDoc(ilacRes.text).querySelector('table'));
        exportData.ilaclarim.headers = pt.headers;
        exportData.ilaclarim.rows = pt.rows;
      }
      recordSection('ilaclarim', 'İlaçlarım', '/Ilac/Index', ilacRes, exportData.ilaclarim.rows.length);

      const existingRecNos = new Set();
      for (const v of visits) {
        for (const r of v.detay?.receteler || []) {
          if (r.receteNo) existingRecNos.add(r.receteNo.trim());
        }
      }
      const recCheckRes = await postForm('/Recete/Index', { baslangicYil: wideStartYear, bitisYil: visitsEndYear }, xsrfToken);
      if (recCheckRes.ok) {
        const rdoc = htmlToDoc(recCheckRes.text);
        const pt = P.parseTable(rdoc.querySelector('#tbl-recetelerim') || rdoc.querySelector('table'));
        exportData.recetelerimOzet.totalRows = pt.rows.length;
        for (const row of pt.rows) {
          const recNo = (row.cells[1] || '').trim();
          if (recNo && !existingRecNos.has(recNo)) {
            const detOc = row.onclicks.find((o) => o.onclick.includes('ReceteDetayGoster'))?.onclick || '';
            const args = [...detOc.matchAll(/'([^']*)'/g)].map((m) => m[1]);
            const sysTakipNo = args[0] || '';
            let ilaclar = null;
            if (sysTakipNo) {
              await sleep(currentDelayMs);
              const rr = await safeFetchText(
                `/Ziyaret/GetReceteDetay?sysTakipNo=${encodeURIComponent(sysTakipNo)}&receteNo=${encodeURIComponent(recNo)}`
              );
              if (rr.ok) ilaclar = { status: rr.status, ...P.parsePrescriptionTables(htmlToDoc(rr.text)) };
            }
            exportData.recetelerimOzet.ekstraReceteler.push({
              tarih: row.cells[0] || '',
              receteNo,
              receteTuru: row.cells[2] || '',
              hekim: row.cells[3] || '',
              sysTakipNo,
              ilaclar
            });
          }
        }
      }
      recordSection('recetelerim', 'Reçetelerim', '/Recete/Index', recCheckRes, exportData.recetelerimOzet.totalRows);

      const optRes = await postForm('/Recete/GetOptikReceteler', { baslangicYil: wideStartYear, bitisYil: visitsEndYear }, xsrfToken);
      if (optRes.ok) exportData.recetelerimOzet.optik = P.parseTable(htmlToDoc(optRes.text).querySelector('table'));
      recordSection('optik', 'Optik Reçeteleri', '/Recete/GetOptikReceteler', optRes, exportData.recetelerimOzet.optik?.rows?.length || 0);

      const tibRes = await postForm('/Recete/GetTibbiCihazReceteler', { baslangicYil: wideStartYear, bitisYil: visitsEndYear }, xsrfToken);
      if (tibRes.ok) exportData.recetelerimOzet.tibbiCihaz = P.parseTable(htmlToDoc(tibRes.text).querySelector('table'));
      recordSection('tibbi_cihaz', 'Tıbbi Cihaz Reçeteleri', '/Recete/GetTibbiCihazReceteler', tibRes, exportData.recetelerimOzet.tibbiCihaz?.rows?.length || 0);

      // Stage 5: Tahlillerim + COVID-19 + Lab PDFs
      emitProgress('tahliller', 5, 'Tahlil panelleri çekiliyor...');
      checkAbort();

      const tah0Res = await postForm(
        '/Tahlil/Index',
        { baslangicTarihi: wideStartYear, bitisTarihi: visitsEndYear, activeTab: '0' },
        xsrfToken
      );
      if (tah0Res.sessionExpired) {
        postMsg({ type: 'EXPORT_ERROR', sessionExpired: true });
        return;
      }
      exportData.tahlillerim.status = tah0Res.status;
      if (tah0Res.ok) {
        const parsedTah = P.parseTahlilPanels(htmlToDoc(tah0Res.text));
        exportData.tahlillerim.panels = parsedTah.panels;
        exportData.tahlillerim.pdfTargets = parsedTah.pdfTargets;
      }
      recordSection('tahlillerim', 'Tahlillerim', '/Tahlil/Index', tah0Res, exportData.tahlillerim.panels.length);

      const tah1Res = await postForm(
        '/Tahlil/Index',
        { baslangicTarihi: wideStartYear, bitisTarihi: visitsEndYear, activeTab: '1' },
        xsrfToken
      );
      exportData.tahlillerim.covidStatus = tah1Res.status;
      if (tah1Res.ok) {
        const cdoc = htmlToDoc(tah1Res.text);
        exportData.tahlillerim.covid19 = P.parseTable(cdoc.querySelector('#tblTahlilCovid19') || cdoc.querySelector('table'));
      }
      recordSection('covid19', 'COVID-19 Testleri', '/Tahlil/Index (Tab 1)', tah1Res, exportData.tahlillerim.covid19?.rows?.length || 0);

      if (fetchLabPdfs && exportData.tahlillerim.pdfTargets.length > 0) {
        const targets = exportData.tahlillerim.pdfTargets;
        for (let i = 0; i < targets.length; i += 3) {
          checkAbort();
          const batch = targets.slice(i, i + 3);
          await Promise.all(
            batch.map(async (t) => {
              const qs = new URLSearchParams({
                baslangicYil: wideStartYear,
                bitisYil: visitsEndYear,
                cardTarih: t.cardTarih,
                kurumKodu: t.kurumKodu,
                dil: t.dil || 'tr-TR',
                sonucTuru: ''
              });
              const br = await safeFetchBuffer(`/Tahlil/TahlillerPdf?${qs.toString()}`);
              if (br.ok && br.buffer && hasPdfMagic(br.buffer)) {
                const dtMatch = (t.cardTarih || t.tarih || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
                const iso = dtMatch ? `${dtMatch[3]}-${dtMatch[2]}-${dtMatch[1]}` : 'tarihsiz';
                const filename = `${iso}_${t.kurumKodu}.pdf`;
                exportData.tahlillerim.panels[t.panelIndex].pdf = {
                  filename,
                  relativePath: `tahliller_pdf/${filename}`,
                  kurumKodu: t.kurumKodu,
                  byteLength: br.buffer.byteLength
                };
                postMsg({
                  type: 'EXPORT_PDF_BLOB',
                  kind: 'lab',
                  panelIndex: t.panelIndex,
                  filename,
                  relativePath: `tahliller_pdf/${filename}`,
                  base64: arrayBufferToBase64(br.buffer)
                });
              }
            })
          );
          const done = Math.min(i + 3, targets.length);
          emitProgress(
            'tahliller',
            5,
            `Tahlil PDF saatleri alınıyor (${done}/${targets.length})...`,
            { current: done, total: targets.length }
          );
          await sleep(currentDelayMs);
        }
      }

      // Stage 6: Radyoloji
      emitProgress('radyoloji', 6, 'Radyolojik görüntüler ve raporlar çekiliyor...');
      checkAbort();

      const radRes = await postForm('/RadyolojikGoruntu', { startYear: wideStartYear, endYear: visitsEndYear }, xsrfToken);
      if (radRes.sessionExpired) {
        postMsg({ type: 'EXPORT_ERROR', sessionExpired: true });
        return;
      }
      if (radRes.ok) {
        const radDoc = htmlToDoc(radRes.text);
        const cards = Array.from(radDoc.querySelectorAll('.radyolojiCardListe'));
        for (let idx = 0; idx < cards.length; idx++) {
          checkAbort();
          const c = cards[idx];
          const hastane = P.cleanText(c.querySelector('.RhastaneAdi'));
          const tarih = P.cleanText(c.querySelector('.Rtarih span'));
          const aciklama = P.cleanText(c.querySelector('.Raciklama')).replace(/^Açıklama\s*:\s*/i, '').trim();
          const onclicks = Array.from(c.querySelectorAll('[onclick]')).map((el) => el.getAttribute('onclick') || '');
          let orderId = null;
          let accession = null;
          for (const oc of onclicks) {
            const m1 = oc.match(/showHtmlReport\('([^']+)'\)/);
            if (m1) orderId = m1[1];
            const m2 = oc.match(/openImageLink\('([^']+)'\)/);
            if (m2) accession = m2[1];
          }
          let rapor = '';
          let raporHtml = '';
          let raporStatus = null;
          let pdfMeta = null;
          if (orderId) {
            await sleep(currentDelayMs);
            let rr = await safeFetchText(`/RadyolojikGoruntu/GetRaporByOrder?orderId=${orderId}`, {
              headers: { 'X-Requested-With': 'XMLHttpRequest', 'XSRF-TOKEN': xsrfToken, 'RequestVerificationToken': xsrfToken }
            });
            if (!rr.ok) {
              rr = await postForm('/RadyolojikGoruntu/GetRaporByOrder', { orderId: decodeURIComponent(orderId) }, xsrfToken);
            }
            raporStatus = rr.status;
            if (rr.ok) {
              try {
                const j = JSON.parse(rr.text);
                raporHtml = j.rapor || '';
                if (raporHtml) {
                  const d = htmlToDoc(raporHtml);
                  rapor = d.body?.innerText ? d.body.innerText.trim() : P.cleanText(d.body);
                }
              } catch {
                raporHtml = rr.text;
                rapor = rr.text;
              }
            }

            if (fetchReportPdfs) {
              await sleep(100);
              let pr = await postForm('/RadyolojikGoruntu/GetRaporPdfByOrder', { orderId: decodeURIComponent(orderId) }, xsrfToken);
              let b64 = null;
              try { b64 = JSON.parse(pr.text).rapor || null; } catch {}
              if (!b64) {
                pr = await postForm('/RadyolojikGoruntu/GetRaporPdfByOrder', { orderId }, xsrfToken);
                try { b64 = JSON.parse(pr.text).rapor || null; } catch {}
              }
              if (b64 && b64.startsWith('JVBERi0')) {
                const dtMatch = tarih.match(/(\d{2})\.(\d{2})\.(\d{4})/);
                const iso = dtMatch ? `${dtMatch[3]}-${dtMatch[2]}-${dtMatch[1]}` : 'tarihsiz';
                const trMap = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'C', Ğ: 'G', İ: 'I', Ö: 'O', Ş: 'S', Ü: 'U' };
                const slug = aciklama.replace(/[çğıöşüÇĞİÖŞÜ]/g, (ch) => trMap[ch] || ch).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'radyoloji';
                const filename = `${iso}_${idx + 1}_${slug}.pdf`;
                const radIdx = exportData.radyoloji.length;
                pdfMeta = { filename, relativePath: `radyoloji_pdf/${filename}` };
                postMsg({
                  type: 'EXPORT_PDF_BLOB',
                  kind: 'radyoloji',
                  radIndex: radIdx,
                  filename,
                  relativePath: pdfMeta.relativePath,
                  base64: b64
                });
              }
            }
          }
          exportData.radyoloji.push({
            hastane,
            tarih,
            aciklama,
            orderId,
            accession,
            raporStatus,
            rapor,
            raporHtml,
            ...(pdfMeta ? { pdf: pdfMeta } : {})
          });
        }
      }
      recordSection('radyoloji', 'Radyoloji', '/RadyolojikGoruntu', radRes, exportData.radyoloji.length);

      // Stage 7: Raporlarim & Official PDFs
      emitProgress('raporlar', 7, 'Sağlık raporları ve resmi PDF dosyaları çekiliyor...');
      checkAbort();

      const rapRes = await postForm('/Rapor/Index', { startYear: wideStartYear, endYear: visitsEndYear }, xsrfToken);
      if (rapRes.sessionExpired) {
        postMsg({ type: 'EXPORT_ERROR', sessionExpired: true });
        return;
      }
      exportData.raporlar.status = rapRes.status;
      if (rapRes.ok) {
        const parsedRap = P.parseRaporRows(htmlToDoc(rapRes.text));
        exportData.raporlar.headers = parsedRap.headers;
        exportData.raporlar.raporlar = parsedRap.raporlar;
        exportData.raporlar.basvurular = parsedRap.basvurular;
        if (parsedRap.missingHeaders.length > 0) {
          errors.push({ section: 'raporlar', label: 'Raporlarım sütun uyarısı', endpoint: '/Rapor/Index', status: rapRes.status, error: `Eşleşmeyen sütunlar: ${parsedRap.missingHeaders.join(', ')}` });
        }
      }
      recordSection('raporlar', 'Sağlık Raporları', '/Rapor/Index', rapRes, exportData.raporlar.raporlar.length);

      if (fetchReportPdfs) {
        const pdfTargets = exportData.raporlar.raporlar
          .map((rp, idx) => ({ rp, idx }))
          .filter((x) => x.rp.pdfTakipNo);
        for (let i = 0; i < pdfTargets.length; i++) {
          checkAbort();
          const { rp, idx } = pdfTargets[i];
          await sleep(currentDelayMs);
          const br = await safeFetchBuffer(`/Rapor/RaporPdf?raporTakipNo=${encodeURIComponent(rp.pdfTakipNo)}`);
          if (br.ok && br.buffer && hasPdfMagic(br.buffer)) {
            const dtMatch = (rp.tarih || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
            const iso = dtMatch ? `${dtMatch[3]}-${dtMatch[2]}-${dtMatch[1]}` : 'tarihsiz';
            const filename = `${iso}_${rp.raporNo || rp.pdfTakipNo}.pdf`;
            rp.pdf = {
              filename,
              relativePath: `raporlar_pdf/${filename}`,
              byteLength: br.buffer.byteLength,
              status: br.status
            };
            postMsg({
              type: 'EXPORT_PDF_BLOB',
              kind: 'rapor',
              raporIndex: idx,
              filename,
              relativePath: rp.pdf.relativePath,
              base64: arrayBufferToBase64(br.buffer)
            });
          } else {
            errors.push({ section: 'rapor_pdf', label: `Rapor PDF (${rp.raporNo})`, endpoint: '/Rapor/RaporPdf', status: br.status, error: br.error || `HTTP ${br.status}` });
          }
          emitProgress(
            'raporlar',
            7,
            `Resmi rapor PDF'leri indiriliyor (${i + 1}/${pdfTargets.length})...`,
            { current: i + 1, total: pdfTargets.length }
          );
        }
      }

      // Stage 8: Asi, Kronik Takip, Randevular, Malzemeler & Other sections
      emitProgress('ek_bolumler', 8, 'Aşı, kronik takip, randevu ve tıbbi malzemeler çekiliyor...');
      checkAbort();

      const asiRes = await safeFetchText('/Home/AsiTakvimi');
      if (asiRes.ok) {
        const d = htmlToDoc(asiRes.text);
        const main = d.querySelector('main') || d.body;
        exportData.asiTakvimi = {
          status: asiRes.status,
          tables: Array.from(main.querySelectorAll('table')).map((t) => ({ id: t.id || '', ...P.parseTable(t) }))
        };
      }
      recordSection('asi', 'Aşı Takvimi', '/Home/AsiTakvimi', asiRes, exportData.asiTakvimi.tables.reduce((a, t) => a + t.rows.length, 0));

      const htPage = await safeFetchText('/Home/HastalikTakip');
      if (htPage.ok) {
        const htd = htmlToDoc(htPage.text);
        const tbl = P.parseTable(htd.querySelector('#tblHastalikTakip') || htd.querySelector('table'));
        exportData.hastalikTakip = { status: htPage.status, tables: [{ id: 'tblHastalikTakip', ...tbl }] };
        for (const r of tbl.rows) {
          const oc = r.onclicks[0]?.onclick || '';
          const m = oc.match(/HastalikTakipDetayGoster\('([^']+)'\)/);
          if (!m) continue;
          await sleep(currentDelayMs);
          const det = await postForm(`/HastalikTakip/detay?systakipNo=${encodeURIComponent(m[1])}`, {}, xsrfToken);
          let parsedDet = null;
          if (det.ok) {
            const dd = htmlToDoc(det.text);
            parsedDet = {
              tables: Array.from(dd.querySelectorAll('table')).map((t) => P.parseTable(t)),
              text: P.cleanText(dd.body)
            };
          }
          exportData.hastalikTakipDetay.push({
            takipTipi: r.cells[0] || '',
            kronikHastalik: r.cells[1] || '',
            takipTarihi: r.cells[2] || '',
            planlananTarih: r.cells[3] || '',
            gerceklestiMi: r.cells[4] || '',
            status: det.status,
            detay: parsedDet
          });
        }
      }
      recordSection('hastalik_takip', 'Kronik Takip', '/Home/HastalikTakip', htPage, exportData.hastalikTakipDetay.length);

      const ranRes = await safeFetchText('/Home/Randevularim');
      if (ranRes.ok) {
        const rd = htmlToDoc(ranRes.text);
        exportData.randevularim = {
          status: ranRes.status,
          tables: Array.from(rd.querySelectorAll('main table')).map((t) => ({ id: t.id || '', ...P.parseTable(t) }))
        };
      }
      recordSection('randevularim', 'Randevularım', '/Home/Randevularim', ranRes, exportData.randevularim.tables.reduce((a, t) => a + t.rows.length, 0));

      const malzRes = await safeFetchText('/Home/MalzemeveCihazlarim');
      if (malzRes.ok) {
        const md = htmlToDoc(malzRes.text);
        exportData.malzemeVeCihazlarim.status = malzRes.status;
        for (const tbl of md.querySelectorAll('main table')) {
          exportData.malzemeVeCihazlarim.tables[tbl.id || 'malzeme'] = P.parseTable(tbl);
        }
        for (const tr of md.querySelectorAll('main table tbody tr')) {
          const tds = Array.from(tr.querySelectorAll('td')).map((td) => P.cleanText(td));
          if (tds.length === 0 || (tds.length === 1 && /kayıt|bulunmamaktadır/i.test(tds[0]))) continue;
          const oc = tr.querySelector('[onclick]')?.getAttribute('onclick') || '';
          const um = oc.match(/url:\s*'([^']+)'/);
          if (um) {
            try {
              const u = new URL(um[1], location.origin);
              exportData.malzemeDetaylari.push({
                islemTarihi: tds[0] || '',
                marka: tds[1] || '',
                rafOmru: tds[2] || '',
                urunTanimi: tds[3] || u.searchParams.get('UrunTanimi') || '',
                urunNumarasi: u.searchParams.get('UrunNumarasi') || '',
                kurumKodu: u.searchParams.get('KurumKodu') || '',
                seriNumarasi: u.searchParams.get('SeriNumarasi') || '',
                lotBatchNumarasi: u.searchParams.get('LotBatchNumarasi') || '',
                bildirenKurum: u.searchParams.get('BildirenKurumUnvan') || ''
              });
              continue;
            } catch {}
          }
          if (tds.length >= 2) {
            exportData.malzemeDetaylari.push({
              islemTarihi: tds[0] || '',
              marka: tds[1] || '',
              rafOmru: tds[2] || '',
              urunTanimi: tds[3] || '',
              urunNumarasi: '',
              kurumKodu: '',
              seriNumarasi: '',
              lotBatchNumarasi: '',
              bildirenKurum: ''
            });
          }
        }
      }
      recordSection('malzemeler', 'Tıbbi Malzemeler', '/Home/MalzemeveCihazlarim', malzRes, exportData.malzemeDetaylari.length);

      const alerjiRes = await safeFetchText('/Home/Alerjilerim');
      if (alerjiRes.ok) {
        const d = htmlToDoc(alerjiRes.text);
        exportData.alerjilerim = {
          status: alerjiRes.status,
          tables: Array.from((d.querySelector('main') || d.body).querySelectorAll('table')).map((t) => ({ id: t.id || '', ...P.parseTable(t) }))
        };
      }
      recordSection('alerjilerim', 'Alerjilerim', '/Home/Alerjilerim', alerjiRes, exportData.alerjilerim.tables.reduce((a, t) => a + t.rows.length, 0));

      const epiRes = await postForm('/Epikriz/Index', { baslangicYil: wideStartYear, bitisYil: visitsEndYear }, xsrfToken);
      if (epiRes.ok) {
        const d = htmlToDoc(epiRes.text);
        exportData.epikrizler = { status: epiRes.status, ...P.parseTable(d.querySelector('#tblEpikriz') || d.querySelector('table')) };
      }
      recordSection('epikrizler', 'Epikrizlerim', '/Epikriz/Index', epiRes, exportData.epikrizler.rows.length);

      const patRes = await postForm('/Patoloji/Index', { baslangicYili: wideStartYear, bitisYili: visitsEndYear }, xsrfToken);
      if (patRes.ok) {
        const d = htmlToDoc(patRes.text);
        exportData.patolojiler = { status: patRes.status, ...P.parseTable(d.querySelector('#tblPatoloji') || d.querySelector('table')) };
      }
      recordSection('patolojiler', 'Patolojilerim', '/Patoloji/Index', patRes, exportData.patolojiler.rows.length);

      const tarRes = await postForm('/Tarama/Index', { baslangicYili: wideStartYear, bitisYili: visitsEndYear }, xsrfToken);
      if (tarRes.ok) {
        const d = htmlToDoc(tarRes.text);
        exportData.taramalar = {
          status: tarRes.status,
          tables: Array.from(d.querySelectorAll('table')).map((t) => ({ id: t.id || '', ...P.parseTable(t) }))
        };
      }
      recordSection('taramalar', 'Kanser Taramaları', '/Tarama/Index', tarRes, exportData.taramalar.tables.reduce((a, t) => a + t.rows.length, 0));

      const sigRes = await safeFetchText('/Home/Sigortalarim');
      if (sigRes.ok) {
        const d = htmlToDoc(sigRes.text);
        const pt = P.parseTable(d.querySelector('#tblSigorta') || d.querySelector('main table'));
        exportData.sigortalarim = { status: sigRes.status, count: pt.rows.length, ...pt };
      }
      recordSection('sigortalarim', 'Sigortalarım', '/Home/Sigortalarim', sigRes, exportData.sigortalarim.rows.length);

      const acilRes = await safeFetchText('/Home/AcilDurumNotlarim');
      if (acilRes.ok) {
        const d = htmlToDoc(acilRes.text);
        const main = d.querySelector('main') || d.body;
        const tables = Array.from(main.querySelectorAll('table')).map((t) => ({ id: t.id || '', ...P.parseTable(t) }));
        const notes = Array.from(main.querySelectorAll('.card-body, .note, textarea'))
          .map((el) => P.cleanText(el))
          .filter((t) => t && !/kayıtlı bilginiz bulunmamaktadır/i.test(t));
        exportData.acilDurumNotlarim = { status: acilRes.status, tables, text: notes.join(' | ').slice(0, 4000) };
      }
      recordSection('acil_notlar', 'Acil Durum Notlarım', '/Home/AcilDurumNotlarim', acilRes, exportData.acilDurumNotlarim.tables.reduce((a, t) => a + t.rows.length, 0));

      const dokRes = await safeFetchText('/Home/Dokumanlarim');
      if (dokRes.ok) {
        const d = htmlToDoc(dokRes.text);
        exportData.dokumanlarim = {
          status: dokRes.status,
          tables: Array.from((d.querySelector('main') || d.body).querySelectorAll('table')).map((t) => ({ id: t.id || '', ...P.parseTable(t) }))
        };
      }
      recordSection('dokumanlarim', 'Dokümanlarım', '/Home/Dokumanlarim', dokRes, exportData.dokumanlarim.tables.reduce((a, t) => a + t.rows.length, 0));

      postMsg({ type: 'EXPORT_COMPLETE', data: exportData });
    } catch (err) {
      if (err?.isCancelled) {
        postMsg({ type: 'EXPORT_ERROR', cancelled: true });
      } else if (err?.sessionExpired) {
        postMsg({ type: 'EXPORT_ERROR', sessionExpired: true });
      } else {
        postMsg({ type: 'EXPORT_ERROR', error: err?.message || String(err) });
      }
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'enabiz-export') return;
    let portRunId = null;

    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'START_EXPORT') {
        portRunId = msg.runId || Date.now();
        runExportOnPort(port, portRunId, msg.options || {});
      } else if (msg.type === 'CANCEL_EXPORT') {
        if (!msg.runId || msg.runId === activeRunId) {
          cancelRequested = true;
        }
      }
    });

    port.onDisconnect.addListener(() => {
      if (portRunId && portRunId === activeRunId) {
        cancelRequested = true;
      }
    });
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.type === 'PING_ENABIZ') {
      const startOpts = Array.from(document.querySelectorAll('#baslangicyilSelect option'))
        .map((o) => o.value)
        .filter((v) => /^\d{4}$/.test(v));
      const endOpts = Array.from(document.querySelectorAll('#bitisyilSelect option'))
        .map((o) => o.value)
        .filter((v) => /^\d{4}$/.test(v));
      sendResponse({
        ok: true,
        url: location.href,
        loggedIn: isLoggedInDocument(),
        patientName: detectHeaderName(),
        yearRange: {
          min: startOpts.length ? String(Math.min(...startOpts.map(Number))) : null,
          max: endOpts.length ? String(Math.max(...endOpts.map(Number))) : null
        }
      });
      return false;
    }
    if (msg.type === 'CANCEL_EXPORT') {
      cancelRequested = true;
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();
