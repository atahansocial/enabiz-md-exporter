/**
 * e-Nabız Markdown Arşivleyici — Salt Okunur (Read-Only) İçerik Betiği
 * Yalnızca kullanıcının kendi aktif https://enabiz.gov.tr oturumu üzerinden
 * salt-okunur isteklerle sağlık verilerini toplar; hiçbir kayıt eklemez veya değiştirmez.
 */
(() => {
  if (window.__enabizMdExporterLoaded) return;
  window.__enabizMdExporterLoaded = true;

  let activeRunId = 0;
  let cancelRequested = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cleanText = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
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
    const txt = cleanText(el);
    if (txt && txt.length >= 4 && !/çıkış|menü|profil/i.test(txt)) return txt;
    const candidate = Array.from(document.querySelectorAll('header a'))
      .map((a) => cleanText(a))
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

  function parseTable(tbl) {
    if (!tbl) return { headers: [], rows: [] };
    const headers = Array.from(tbl.querySelectorAll('thead th')).map((th) => cleanText(th));
    const rows = Array.from(tbl.querySelectorAll('tbody tr'))
      .map((tr) => ({
        cells: Array.from(tr.querySelectorAll('td')).map((td) => cleanText(td)),
        onclicks: Array.from(tr.querySelectorAll('[onclick]')).map((el) => ({
          text: cleanText(el),
          onclick: el.getAttribute('onclick') || ''
        }))
      }))
      .filter(
        (r) =>
          r.cells.length > 0 &&
          !(r.cells.length === 1 && /kayıt|bulunmamaktadır|veri yok|bulunamadı|listelenecek/i.test(r.cells[0]))
      );
    return { headers, rows };
  }

  function parseGenericPane(paneEl) {
    if (!paneEl) return null;
    const tbl = paneEl.querySelector('table');
    if (tbl) {
      const headers = Array.from(tbl.querySelectorAll('thead th')).map((th) => cleanText(th));
      const rows = Array.from(tbl.querySelectorAll('tbody tr'))
        .map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => cleanText(td)))
        .filter(
          (r) =>
            r.length > 0 &&
            !(r.length === 1 && /kayıt|bulunmamaktadır|veri yok|bulunamadı/i.test(r[0]))
        );
      if (rows.length === 0) return null;
      return { headers, rows };
    }
    const txt = cleanText(paneEl);
    if (!txt || /^Kayıtlı bilginiz bulunmamaktadır\.?$/i.test(txt)) return null;
    return { text: txt };
  }

  async function safeFetchText(url, opts = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (cancelRequested) return { ok: false, cancelled: true, status: 0, text: '' };
      try {
        const res = await fetch(url, { credentials: 'include', ...opts });
        const text = await res.text();
        if (isSessionExpiredResponse(res, text)) {
          return { ok: false, sessionExpired: true, status: res.status, url: res.url, text: '' };
        }
        if ((res.status === 429 || res.status >= 500) && attempt === 0) {
          await sleep(600);
          continue;
        }
        return { ok: res.ok, status: res.status, url: res.url, text };
      } catch (err) {
        if (attempt === 0) {
          await sleep(500);
          continue;
        }
        return { ok: false, status: 0, error: String(err), text: '' };
      }
    }
    return { ok: false, status: 0, text: '' };
  }

  async function safeFetchBuffer(url, opts = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (cancelRequested) return { ok: false, cancelled: true, status: 0, buffer: null };
      try {
        const res = await fetch(url, { credentials: 'include', ...opts });
        if (isSessionExpiredResponse(res, '')) {
          return { ok: false, sessionExpired: true, status: res.status, buffer: null };
        }
        const buffer = await res.arrayBuffer();
        if ((res.status === 429 || res.status >= 500) && attempt === 0) {
          await sleep(600);
          continue;
        }
        return {
          ok: res.ok,
          status: res.status,
          contentType: res.headers.get('content-type') || '',
          buffer
        };
      } catch (err) {
        if (attempt === 0) {
          await sleep(500);
          continue;
        }
        return { ok: false, status: 0, error: String(err), buffer: null };
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

  function emitProgress(runId, payload) {
    try {
      chrome.runtime.sendMessage({ type: 'EXPORT_PROGRESS', runId, ...payload }).catch(() => {});
    } catch {
      // Ignore if sidepanel was closed temporarily
    }
  }

  function emitPdfBlob(runId, blobPayload) {
    try {
      chrome.runtime.sendMessage({ type: 'EXPORT_PDF_BLOB', runId, ...blobPayload }).catch(() => {});
    } catch {
      // Ignore
    }
  }

  function parseVisitCardsFromDoc(doc) {
    return Array.from(doc.querySelectorAll('.ziyaretCardList')).map((card, idx) => {
      const tarih = cleanText(card.querySelector('.zTarihS'));
      const degerOnclick = card.querySelector('.rating')?.getAttribute('onclick') || '';
      const dtMatch = degerOnclick.match(/'(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2})'/);
      const tarihSaat = dtMatch ? dtMatch[1] : tarih;
      const hastane = cleanText(card.querySelector('.card-text'));
      const sysRaw = cleanText(card.querySelector('.hastaneTakipNo'));
      const sysTakipNo = sysRaw.replace(/^Hastane Takip No:\s*/i, '').trim();
      const brans = cleanText(card.querySelector('.drBrans'));
      const hekim = cleanText(card.querySelector('.drAdi'));
      const detayOnclick = card.querySelector('a.card-red-link')?.getAttribute('onclick') || '';
      const urlMatch = detayOnclick.match(/url:\s*'([^']+)'/);
      return {
        index: idx + 1,
        tarih,
        tarihSaat,
        hastane,
        sysTakipNo,
        brans,
        hekim,
        detayUrl: urlMatch ? urlMatch[1] : null,
        detayStatus: null,
        detayError: null,
        detay: null
      };
    });
  }

  function parsePrescriptionTables(doc) {
    const yazanTbl = doc.querySelector('table[id*="Yazan"], table[id*="yazan"]');
    const satilanTbl = doc.querySelector('table[id*="Satilan"], table[id*="satilan"], table[id*="Satılan"]');
    const yazilanIlaclar = yazanTbl
      ? Array.from(yazanTbl.querySelectorAll('tbody tr'))
          .map((tr) => {
            const tds = tr.querySelectorAll('td');
            if (tds.length < 7) return null;
            return {
              barkod: cleanText(tds[0]),
              ilacAdi: cleanText(tds[1]),
              aciklama: cleanText(tds[2]),
              doz: cleanText(tds[3]),
              periyot: cleanText(tds[4]),
              kullanimSekli: cleanText(tds[5]),
              kullanimSayisi: cleanText(tds[6]),
              kutuAdedi: cleanText(tds[7])
            };
          })
          .filter(Boolean)
      : [];
    const satilanIlaclar = satilanTbl
      ? Array.from(satilanTbl.querySelectorAll('tbody tr'))
          .map((tr) => {
            const tds = tr.querySelectorAll('td');
            if (tds.length < 2) return null;
            return {
              barkod: cleanText(tds[0]),
              ilacAdi: cleanText(tds[1]),
              kutuAdedi: cleanText(tds[2])
            };
          })
          .filter(Boolean)
      : [];
    return { yazilanIlaclar, satilanIlaclar };
  }

  function parseTahlilPanels(doc) {
    const stripLabel = (el) => {
      if (!el) return '';
      const clone = el.cloneNode(true);
      clone.querySelectorAll('span').forEach((s) => s.remove());
      return clone.textContent.replace(/\s+/g, ' ').trim();
    };

    const accItems = Array.from(doc.querySelectorAll('#accordionTahlilListe .accordion-item'));
    const panels = [];
    const pdfTargets = [];

    accItems.forEach((item, panelIdx) => {
      const tarih = cleanText(item.querySelector('.zTarihS'));
      const hastane = cleanText(item.querySelector('.hastaneAdi'));
      const normalSayisi = cleanText(item.querySelector('.refNormal'));
      const refDisiSayisi = cleanText(item.querySelector('.refDisi'));

      const btn = item.querySelector('a[onclick*="TahlillerPdfIndir"]');
      const oc = btn ? btn.getAttribute('onclick') || '' : '';
      const pm = oc.match(/TahlillerPdfIndir\('([^']*)',\s*'([^']*)',\s*'([^']*)'/);
      if (pm && pm[3]) {
        pdfTargets.push({
          panelIndex: panelIdx,
          tarih,
          hastane,
          dil: pm[1] || 'tr-TR',
          cardTarih: pm[2] || tarih,
          kurumKodu: pm[3]
        });
      }

      const groups = [];
      const singleRows = [];
      let singleSys = null;

      for (const tl of item.querySelectorAll('.tahlilList')) {
        const redOc = tl.querySelector('a.islemBtn, a.kirmiziBtn')?.getAttribute('onclick') || '';
        const sysMatch = redOc.match(/IslemRedModalGoster\('[^']*','([^']*)'/);
        const sysTakipNo = sysMatch ? sysMatch[1] : null;
        const rcs = Array.from(tl.querySelectorAll('.rowContainer'));

        if (rcs.length > 0) {
          const grpEl = tl.querySelector('.tahlilGroup');
          const grpName = grpEl ? (grpEl.getAttribute('islemadi') || cleanText(grpEl)).trim() : 'Panel';
          const rows = rcs
            .map((rc) => {
              const cols = Array.from(rc.querySelectorAll('.columnContainer'));
              const statusCol = cols[cols.length - 1];
              const statusClass = statusCol ? statusCol.className : '';
              const isOutOfRange =
                rc.getAttribute('subdurumkontrol') === '0' ||
                (statusClass && !statusClass.includes('durumNormal') && /disi|kirmizi|danger|high|low/i.test(statusClass));
              return {
                islemAdi: stripLabel(cols[0]),
                sonuc: stripLabel(cols[1]),
                birim: stripLabel(cols[2]),
                referans: stripLabel(cols[3]),
                statusClass,
                isOutOfRange
              };
            })
            .filter((r) => r.islemAdi);
          groups.push({ grupAdi: grpName, sysTakipNo, rows });
        } else {
          const nameEl = tl.querySelector('.tahlilHeader #islemAdi, .tahlilHeader [islemadi]');
          const islemAdi = nameEl
            ? (nameEl.getAttribute('islemadi') || cleanText(nameEl)).trim()
            : cleanText(tl.querySelector('.tahlilHeader'));
          const cols = Array.from(tl.querySelectorAll('.tahlilBody > .columnContainer'));
          const statusTxt = cleanText(cols[0]);
          const sonuc = stripLabel(cols[1]);
          const birim = stripLabel(cols[2]);
          const referans = stripLabel(cols[3]);
          const boxEl = tl.querySelector('.tahlilHeader .degerDurumBox');
          const isOutOfRange =
            tl.getAttribute('subdurumkontrol') === '0' ||
            (boxEl && boxEl.classList.contains('refDisi')) ||
            /Referans Dışı/i.test(statusTxt);
          if (sysTakipNo && !singleSys) singleSys = sysTakipNo;
          if (islemAdi) {
            singleRows.push({
              islemAdi,
              sonuc,
              birim,
              referans,
              statusClass: isOutOfRange ? 'refDisi' : 'refNormal',
              isOutOfRange
            });
          }
        }
      }

      if (singleRows.length > 0) {
        groups.push({ grupAdi: 'Tekil Tetkikler', sysTakipNo: singleSys, rows: singleRows });
      }
      panels.push({ tarih, hastane, normalSayisi, refDisiSayisi, groups });
    });

    return { panels, pdfTargets };
  }

  async function runExport(options = {}) {
    const runId = ++activeRunId;
    cancelRequested = false;

    const totalStages = 9;
    const includeReportPdfs = options.includeReportPdfs !== false;
    const includeLabPdfTimes = options.includeLabPdfTimes !== false;
    const currentYearStr = String(new Date().getFullYear());

    const checkAbort = () => {
      if (cancelRequested || runId !== activeRunId) {
        const err = new Error('CANCELLED');
        err.isCancelled = true;
        throw err;
      }
    };

    try {
      // Stage 1: Session, XSRF token & year discovery + Profile
      emitProgress(runId, {
        stage: 'profil',
        stageIndex: 1,
        totalStages,
        label: 'Oturum, yıl aralığı ve profil bilgileri alınıyor...'
      });

      let xsrfToken = document.querySelector('input[name="__RequestVerificationToken"]')?.value || '';
      let visitsStartYear = options.startYear && options.startYear !== 'auto' ? String(options.startYear) : '';
      let visitsEndYear = options.endYear && options.endYear !== 'auto' ? String(options.endYear) : '';

      const ziyPage = await safeFetchText('/Home/Ziyaretlerim');
      if (ziyPage.sessionExpired) return { ok: false, sessionExpired: true };
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

      // Some e-Nabız secondary endpoints use 2017 or earliest option as start year
      const minYearNum = Number(visitsStartYear);
      const wideStartYear = String(Math.min(minYearNum, 2017));

      // Profile
      const profil = {};
      const profRes = await safeFetchText('/Home/ProfilBilgilerim');
      if (profRes.sessionExpired) return { ok: false, sessionExpired: true };
      checkAbort();
      if (profRes.ok) {
        const pd = htmlToDoc(profRes.text);
        const main = pd.querySelector('main') || pd.body;
        const text = cleanText(main);
        const boy = pd.querySelector('#boy')?.value || '';
        const kilo = pd.querySelector('#kilo')?.value || '';
        const kanGrubu = pd.querySelector('#kanGrubuSelect')?.selectedOptions?.[0]?.textContent?.trim() || '';
        const yasadigiUlke = pd.querySelector('#yasadigiUlkeSelect')?.selectedOptions?.[0]?.textContent?.trim() || '';
        const yasadigiSehir = pd.querySelector('#yasadigiSehirSelect')?.selectedOptions?.[0]?.textContent?.trim() || '';
        const nameMatch = text.match(
          /Profillerim\s+([A-ZÇĞİÖŞÜ\s]+?)\s+\d{11}\s+(\d{2}\.\d{2}\.\d{4})\s+([A-ZÇĞİÖŞÜa-zçğıöşü\s]+?)\s+Kimlik/
        );
        const asmMatch = text.match(/Aile Hekimi Bilgileriniz\s+(.+?)\s+Boy\s+Kilo/);
        let vki = '';
        const bNum = parseFloat(boy);
        const kNum = parseFloat(kilo);
        if (bNum > 0 && kNum > 0) vki = (kNum / (bNum / 100) ** 2).toFixed(1);

        Object.assign(profil, {
          adSoyad: nameMatch ? nameMatch[1].trim() : detectHeaderName(),
          dogumTarihi: nameMatch ? nameMatch[2] : '',
          dogumYeri: nameMatch ? nameMatch[3].trim() : '',
          kanGrubu,
          boyCm: boy,
          kiloKg: kilo,
          vki,
          aileHekimiBirimi: asmMatch ? asmMatch[1].trim() : '',
          yasadigiUlke,
          yasadigiSehir
        });
      }

      // Stage 2: Visits list
      emitProgress(runId, {
        stage: 'ziyaret_liste',
        stageIndex: 2,
        totalStages,
        label: `Ziyaret listesi çekiliyor (${visitsStartYear}–${visitsEndYear})...`
      });

      const ziyListRes = await postForm(
        '/Ziyaret/Index',
        { baslangicYil: visitsStartYear, bitisYil: visitsEndYear },
        xsrfToken
      );
      if (ziyListRes.sessionExpired) return { ok: false, sessionExpired: true };
      checkAbort();

      let visits = ziyListRes.ok ? parseVisitCardsFromDoc(htmlToDoc(ziyListRes.text)) : [];
      if (visits.length === 0) {
        visits = parseVisitCardsFromDoc(ziyPageDoc);
      }
      if (visits.length === 0 && location.pathname.includes('/Home/Ziyaretlerim')) {
        visits = parseVisitCardsFromDoc(document);
      }

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
        errors: []
      };

      // Stage 3: Visit details (4 concurrent)
      emitProgress(runId, {
        stage: 'ziyaret_detay',
        stageIndex: 3,
        totalStages,
        label: `Ziyaret detayları ve reçeteler çekiliyor (0/${visits.length})...`,
        current: 0,
        total: visits.length
      });

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
          return;
        }
        const doc = htmlToDoc(r.text);
        const getRows = (sel, mapFn) =>
          Array.from(doc.querySelectorAll(`${sel} tbody tr`))
            .map((tr) => mapFn(tr, Array.from(tr.querySelectorAll('td'))))
            .filter(Boolean);

        const tani = getRows('#tblZiyaretlerimTani', (_tr, tds) =>
          tds.length >= 4
            ? { tarih: cleanText(tds[0]), tani: cleanText(tds[1]), hekim: cleanText(tds[2]), klinik: cleanText(tds[3]) }
            : null
        );
        const onTani = getRows('#tblZiyaretlerimOnTani', (_tr, tds) =>
          tds.length >= 4
            ? { tarih: cleanText(tds[0]), onTani: cleanText(tds[1]), hekim: cleanText(tds[2]), klinik: cleanText(tds[3]) }
            : null
        );
        const ekTani = getRows('#tblZiyaretlerimEkTani', (_tr, tds) =>
          tds.length >= 4
            ? { tarih: cleanText(tds[0]), ekTani: cleanText(tds[1]), hekim: cleanText(tds[2]), klinik: cleanText(tds[3]) }
            : null
        );
        const islemler = getRows('#tblZiyaretlerimIslemler', (tr, tds) => {
          if (tds.length < 4) return null;
          const oc = tr.querySelector('[onclick]')?.getAttribute('onclick') || '';
          const km = oc.match(/IslemKodu=([^&']+)/);
          return {
            islemZamani: cleanText(tds[0]),
            randevuZamani: cleanText(tds[1]),
            adet: cleanText(tds[2]),
            islemAdi: cleanText(tds[3]),
            islemKodu: km ? decodeURIComponent(km[1]).trim() : ''
          };
        });
        const receteler = getRows('#tblZiyaretlerimReceteler', (tr, tds) => {
          if (tds.length < 3) return null;
          const oc = tr.querySelector('[onclick]')?.getAttribute('onclick') || '';
          const um = oc.match(/url:\s*'([^']+)'/);
          return {
            receteTarihi: cleanText(tds[0]),
            receteNo: cleanText(tds[1]),
            receteTuru: cleanText(tds[2]),
            detayUrl: um ? um[1] : null,
            ilaclar: null
          };
        });

        for (const rec of receteler) {
          if (!rec.detayUrl) continue;
          await sleep(80);
          const rr = await safeFetchText(rec.detayUrl);
          if (rr.ok) {
            rec.ilaclar = { status: rr.status, ...parsePrescriptionTables(htmlToDoc(rr.text)) };
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
            tarih: cleanText(tds[0]),
            islemAdi: cleanText(tds[1]),
            sonuc: cleanText(tds[2]),
            birim: cleanText(tds[3]),
            referans: cleanText(tds[4]),
            isOutOfRange
          };
        });

        const rapor = parseGenericPane(doc.querySelector('#pills-ziyaretlerimRapor'));
        const doktorMesaji = parseGenericPane(doc.querySelector('#pills-ziyaretlerimDoktorMesaji'));
        const gozlukRecetesi = parseGenericPane(doc.querySelector('#pills-ziyaretlerimGozlukRecetesi'));
        const ekSekmeler = [];
        for (const p of doc.querySelectorAll('.tab-pane')) {
          if (!knownPaneIds.has(p.id)) {
            const parsed = parseGenericPane(p);
            if (parsed) ekSekmeler.push({ id: p.id, ...parsed });
          }
        }

        v.detay = {
          tani,
          onTani,
          ekTani,
          islemler,
          receteler,
          tahliller,
          rapor,
          doktorMesaji,
          gozlukRecetesi,
          ekSekmeler
        };
      }

      for (let i = 0; i < visits.length; i += 4) {
        checkAbort();
        await Promise.all(visits.slice(i, i + 4).map(processVisit));
        const done = Math.min(i + 4, visits.length);
        emitProgress(runId, {
          stage: 'ziyaret_detay',
          stageIndex: 3,
          totalStages,
          label: `Ziyaret detayları ve reçeteler çekiliyor (${done}/${visits.length})...`,
          current: done,
          total: visits.length
        });
        await sleep(120);
      }

      // Stage 4: Hastaliklarim + Ilaclarim + Recetelerim cross-check
      emitProgress(runId, {
        stage: 'tanilar_ilaclar',
        stageIndex: 4,
        totalStages,
        label: 'Hastalıklarım ve İlaç/Reçete geçmişi çekiliyor...'
      });
      checkAbort();

      const hasRes = await postForm(
        '/Hastalik/Index',
        { baslangicYili: wideStartYear, bitisYili: visitsEndYear },
        xsrfToken
      );
      if (hasRes.sessionExpired) return { ok: false, sessionExpired: true };
      exportData.hastaliklarim.status = hasRes.status;
      if (hasRes.ok) {
        const hd = htmlToDoc(hasRes.text);
        const pt = parseTable(hd.querySelector('#tblHastaliklarim') || hd.querySelector('table'));
        exportData.hastaliklarim.headers = pt.headers;
        exportData.hastaliklarim.rows = pt.rows.map((r) => {
          const oc = r.onclicks[0]?.onclick || '';
          const args = [...oc.matchAll(/'([^']*)'/g)].map((m) => m[1]);
          return {
            tarih: r.cells[0] || args[0] || '',
            tani: r.cells[1] || '',
            klinik: r.cells[2] || '',
            hekim: r.cells[3] || '',
            detayArgs: args.slice(1, 6).filter(Boolean),
            sysTakipNo: args[6] || ''
          };
        });
      }

      await sleep(120);
      checkAbort();

      const ilacRes = await postForm(
        '/Ilac/Index',
        { baslangicYil: wideStartYear, bitisYil: visitsEndYear },
        xsrfToken
      );
      exportData.ilaclarim.status = ilacRes.status;
      if (ilacRes.ok) {
        const idoc = htmlToDoc(ilacRes.text);
        const pt = parseTable(idoc.querySelector('table'));
        exportData.ilaclarim.headers = pt.headers;
        exportData.ilaclarim.rows = pt.rows;
      }

      // Cross-check Recetelerim + Optik + Tibbi Cihaz
      const existingRecNos = new Set();
      for (const v of visits) {
        for (const r of v.detay?.receteler || []) {
          if (r.receteNo) existingRecNos.add(r.receteNo.trim());
        }
      }
      const recCheckRes = await postForm(
        '/Recete/Index',
        { baslangicYil: wideStartYear, bitisYil: visitsEndYear },
        xsrfToken
      );
      if (recCheckRes.ok) {
        const rdoc = htmlToDoc(recCheckRes.text);
        const pt = parseTable(rdoc.querySelector('#tbl-recetelerim') || rdoc.querySelector('table'));
        exportData.recetelerimOzet.totalRows = pt.rows.length;
        for (const row of pt.rows) {
          const recNo = (row.cells[1] || '').trim();
          if (recNo && !existingRecNos.has(recNo)) {
            const detOc = row.onclicks.find((o) => o.onclick.includes('ReceteDetayGoster'))?.onclick || '';
            const args = [...detOc.matchAll(/'([^']*)'/g)].map((m) => m[1]);
            const sysTakipNo = args[0] || '';
            let ilaclar = null;
            if (sysTakipNo) {
              await sleep(120);
              const rr = await safeFetchText(
                `/Ziyaret/GetReceteDetay?sysTakipNo=${encodeURIComponent(sysTakipNo)}&receteNo=${encodeURIComponent(recNo)}`
              );
              if (rr.ok) ilaclar = { status: rr.status, ...parsePrescriptionTables(htmlToDoc(rr.text)) };
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

      const optRes = await postForm('/Recete/GetOptikReceteler', { baslangicYil: wideStartYear, bitisYil: visitsEndYear }, xsrfToken);
      if (optRes.ok) exportData.recetelerimOzet.optik = parseTable(htmlToDoc(optRes.text).querySelector('table'));
      const tibRes = await postForm('/Recete/GetTibbiCihazReceteler', { baslangicYil: wideStartYear, bitisYil: visitsEndYear }, xsrfToken);
      if (tibRes.ok) exportData.recetelerimOzet.tibbiCihaz = parseTable(htmlToDoc(tibRes.text).querySelector('table'));

      // Stage 5: Tahlillerim + COVID-19 + optional Lab PDFs
      emitProgress(runId, {
        stage: 'tahliller',
        stageIndex: 5,
        totalStages,
        label: 'Tahlil panelleri çekiliyor...'
      });
      checkAbort();

      const tah0Res = await postForm(
        '/Tahlil/Index',
        { baslangicTarihi: wideStartYear, bitisTarihi: visitsEndYear, activeTab: '0' },
        xsrfToken
      );
      if (tah0Res.sessionExpired) return { ok: false, sessionExpired: true };
      exportData.tahlillerim.status = tah0Res.status;
      if (tah0Res.ok) {
        const parsedTah = parseTahlilPanels(htmlToDoc(tah0Res.text));
        exportData.tahlillerim.panels = parsedTah.panels;
        exportData.tahlillerim.pdfTargets = parsedTah.pdfTargets;
      }

      const tah1Res = await postForm(
        '/Tahlil/Index',
        { baslangicTarihi: wideStartYear, bitisTarihi: visitsEndYear, activeTab: '1' },
        xsrfToken
      );
      exportData.tahlillerim.covidStatus = tah1Res.status;
      if (tah1Res.ok) {
        const cdoc = htmlToDoc(tah1Res.text);
        exportData.tahlillerim.covid19 = parseTable(cdoc.querySelector('#tblTahlilCovid19') || cdoc.querySelector('table'));
      }

      if (includeLabPdfTimes && exportData.tahlillerim.pdfTargets.length > 0) {
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
                emitPdfBlob(runId, {
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
          emitProgress(runId, {
            stage: 'tahliller',
            stageIndex: 5,
            totalStages,
            label: `Tahlil PDF saatleri alınıyor (${done}/${targets.length})...`,
            current: done,
            total: targets.length
          });
          await sleep(120);
        }
      }

      // Stage 6: Radyoloji
      emitProgress(runId, {
        stage: 'radyoloji',
        stageIndex: 6,
        totalStages,
        label: 'Radyolojik görüntüler ve raporlar çekiliyor...'
      });
      checkAbort();

      const radRes = await postForm(
        '/RadyolojikGoruntu',
        { startYear: wideStartYear, endYear: visitsEndYear },
        xsrfToken
      );
      if (radRes.sessionExpired) return { ok: false, sessionExpired: true };
      if (radRes.ok) {
        const radDoc = htmlToDoc(radRes.text);
        const cards = Array.from(radDoc.querySelectorAll('.radyolojiCardListe'));
        for (let idx = 0; idx < cards.length; idx++) {
          checkAbort();
          const c = cards[idx];
          const hastane = cleanText(c.querySelector('.RhastaneAdi'));
          const tarih = cleanText(c.querySelector('.Rtarih span'));
          const aciklama = cleanText(c.querySelector('.Raciklama')).replace(/^Açıklama\s*:\s*/i, '').trim();
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
          if (orderId) {
            await sleep(120);
            let rr = await safeFetchText(`/RadyolojikGoruntu/GetRaporByOrder?orderId=${orderId}`, {
              headers: {
                'X-Requested-With': 'XMLHttpRequest',
                'XSRF-TOKEN': xsrfToken,
                'RequestVerificationToken': xsrfToken
              }
            });
            if (!rr.ok) {
              rr = await postForm(
                '/RadyolojikGoruntu/GetRaporByOrder',
                { orderId: decodeURIComponent(orderId) },
                xsrfToken
              );
            }
            raporStatus = rr.status;
            if (rr.ok) {
              try {
                const j = JSON.parse(rr.text);
                raporHtml = j.rapor || '';
                if (raporHtml) {
                  const d = htmlToDoc(raporHtml);
                  rapor = d.body?.innerText ? d.body.innerText.trim() : cleanText(d.body);
                }
              } catch {
                raporHtml = rr.text;
                rapor = rr.text;
              }
            }

            if (includeReportPdfs) {
              await sleep(100);
              let pr = await postForm(
                '/RadyolojikGoruntu/GetRaporPdfByOrder',
                { orderId: decodeURIComponent(orderId) },
                xsrfToken
              );
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
                emitPdfBlob(runId, {
                  kind: 'radyoloji',
                  radIndex: radIdx,
                  filename,
                  relativePath: `radyoloji_pdf/${filename}`,
                  base64: b64
                });
                exportData.radyoloji.push({
                  hastane,
                  tarih,
                  aciklama,
                  orderId,
                  accession,
                  raporStatus,
                  rapor,
                  raporHtml,
                  pdf: { filename, relativePath: `radyoloji_pdf/${filename}` }
                });
                continue;
              }
            }
          }
          exportData.radyoloji.push({ hastane, tarih, aciklama, orderId, accession, raporStatus, rapor, raporHtml });
        }
      }

      // Stage 7: Raporlarim & Official PDFs
      emitProgress(runId, {
        stage: 'raporlar',
        stageIndex: 7,
        totalStages,
        label: 'Sağlık raporları ve resmi PDF dosyaları çekiliyor...'
      });
      checkAbort();

      const rapRes = await postForm('/Rapor/Index', { startYear: wideStartYear, endYear: visitsEndYear }, xsrfToken);
      if (rapRes.sessionExpired) return { ok: false, sessionExpired: true };
      exportData.raporlar.status = rapRes.status;
      if (rapRes.ok) {
        const rapDoc = htmlToDoc(rapRes.text);
        const t1 = parseTable(rapDoc.querySelector('#tblRaporlarim'));
        exportData.raporlar.headers = t1.headers;
        exportData.raporlar.raporlar = t1.rows.map((r) => {
          const pdfOc = r.onclicks.find((o) => o.onclick.includes('RaporPdf'));
          const m = pdfOc ? pdfOc.onclick.match(/RaporPdf\('([^']+)'\)/) : null;
          return {
            tarih: r.cells[0] || '',
            raporNo: r.cells[1] || '',
            raporTakipNo: r.cells[2] || '',
            raporTuru: r.cells[3] || '',
            baslangicTarihi: r.cells[4] || '',
            bitisTarihi: r.cells[5] || '',
            tani: r.cells[6] || '',
            pdfTakipNo: m ? m[1] : null
          };
        });
        exportData.raporlar.basvurular = parseTable(rapDoc.querySelector('#tblRaporBasvurularim')).rows;
      }

      if (includeReportPdfs) {
        const pdfTargets = exportData.raporlar.raporlar
          .map((rp, idx) => ({ rp, idx }))
          .filter((x) => x.rp.pdfTakipNo);
        for (let i = 0; i < pdfTargets.length; i++) {
          checkAbort();
          const { rp, idx } = pdfTargets[i];
          await sleep(120);
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
            emitPdfBlob(runId, {
              kind: 'rapor',
              raporIndex: idx,
              filename,
              relativePath: `raporlar_pdf/${filename}`,
              base64: arrayBufferToBase64(br.buffer)
            });
          }
          emitProgress(runId, {
            stage: 'raporlar',
            stageIndex: 7,
            totalStages,
            label: `Resmi rapor PDF'leri indiriliyor (${i + 1}/${pdfTargets.length})...`,
            current: i + 1,
            total: pdfTargets.length
          });
        }
      }

      // Stage 8: Asi, Kronik Takip, Randevular, Malzemeler & Other sections
      emitProgress(runId, {
        stage: 'ek_bolumler',
        stageIndex: 8,
        totalStages,
        label: 'Aşı, kronik takip, randevu ve tıbbi malzemeler çekiliyor...'
      });
      checkAbort();

      const asiRes = await safeFetchText('/Home/AsiTakvimi');
      if (asiRes.ok) {
        const d = htmlToDoc(asiRes.text);
        const main = d.querySelector('main') || d.body;
        exportData.asiTakvimi = {
          status: asiRes.status,
          tables: Array.from(main.querySelectorAll('table')).map((t) => ({ id: t.id || '', ...parseTable(t) }))
        };
      }

      const htPage = await safeFetchText('/Home/HastalikTakip');
      if (htPage.ok) {
        const htd = htmlToDoc(htPage.text);
        const tbl = parseTable(htd.querySelector('#tblHastalikTakip') || htd.querySelector('table'));
        exportData.hastalikTakip = { status: htPage.status, tables: [{ id: 'tblHastalikTakip', ...tbl }] };
        for (const r of tbl.rows) {
          const oc = r.onclicks[0]?.onclick || '';
          const m = oc.match(/HastalikTakipDetayGoster\('([^']+)'\)/);
          if (!m) continue;
          await sleep(120);
          const det = await postForm(`/HastalikTakip/detay?systakipNo=${encodeURIComponent(m[1])}`, {}, xsrfToken);
          let parsedDet = null;
          if (det.ok) {
            const dd = htmlToDoc(det.text);
            parsedDet = {
              tables: Array.from(dd.querySelectorAll('table')).map((t) => parseTable(t)),
              text: cleanText(dd.body)
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

      const ranRes = await safeFetchText('/Home/Randevularim');
      if (ranRes.ok) {
        const rd = htmlToDoc(ranRes.text);
        exportData.randevularim = {
          status: ranRes.status,
          tables: Array.from(rd.querySelectorAll('main table')).map((t) => ({ id: t.id || '', ...parseTable(t) }))
        };
      }

      const malzRes = await safeFetchText('/Home/MalzemeveCihazlarim');
      if (malzRes.ok) {
        const md = htmlToDoc(malzRes.text);
        exportData.malzemeVeCihazlarim.status = malzRes.status;
        for (const tbl of md.querySelectorAll('main table')) {
          exportData.malzemeVeCihazlarim.tables[tbl.id || 'malzeme'] = parseTable(tbl);
        }
        for (const tr of md.querySelectorAll('main table tbody tr')) {
          const tds = Array.from(tr.querySelectorAll('td')).map((td) => cleanText(td));
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

      // Secondary sections (Alerjilerim, Epikrizlerim, Patolojilerim, Taramalar, Sigortalarim, AcilDurumNotlarim, Dokumanlarim)
      const alerjiRes = await safeFetchText('/Home/Alerjilerim');
      if (alerjiRes.ok) {
        const d = htmlToDoc(alerjiRes.text);
        exportData.alerjilerim = {
          status: alerjiRes.status,
          tables: Array.from((d.querySelector('main') || d.body).querySelectorAll('table')).map((t) => ({ id: t.id || '', ...parseTable(t) }))
        };
      }

      const epiRes = await postForm('/Epikriz/Index', { baslangicYil: wideStartYear, bitisYil: visitsEndYear }, xsrfToken);
      if (epiRes.ok) {
        const d = htmlToDoc(epiRes.text);
        const pt = parseTable(d.querySelector('#tblEpikriz') || d.querySelector('table'));
        exportData.epikrizler = { status: epiRes.status, ...pt };
      }

      const patRes = await postForm('/Patoloji/Index', { baslangicYili: wideStartYear, bitisYili: visitsEndYear }, xsrfToken);
      if (patRes.ok) {
        const d = htmlToDoc(patRes.text);
        const pt = parseTable(d.querySelector('#tblPatoloji') || d.querySelector('table'));
        exportData.patolojiler = { status: patRes.status, ...pt };
      }

      const tarRes = await postForm('/Tarama/Index', { baslangicYili: wideStartYear, bitisYili: visitsEndYear }, xsrfToken);
      if (tarRes.ok) {
        const d = htmlToDoc(tarRes.text);
        exportData.taramalar = {
          status: tarRes.status,
          tables: Array.from(d.querySelectorAll('table')).map((t) => ({ id: t.id || '', ...parseTable(t) }))
        };
      }

      const sigRes = await safeFetchText('/Home/Sigortalarim');
      if (sigRes.ok) {
        const d = htmlToDoc(sigRes.text);
        const pt = parseTable(d.querySelector('#tblSigorta') || d.querySelector('main table'));
        exportData.sigortalarim = { status: sigRes.status, count: pt.rows.length, ...pt };
      }

      const acilRes = await safeFetchText('/Home/AcilDurumNotlarim');
      if (acilRes.ok) {
        const d = htmlToDoc(acilRes.text);
        const main = d.querySelector('main') || d.body;
        const tables = Array.from(main.querySelectorAll('table')).map((t) => ({ id: t.id || '', ...parseTable(t) }));
        const notes = Array.from(main.querySelectorAll('.card-body, .note, textarea'))
          .map((el) => cleanText(el))
          .filter((t) => t && !/kayıtlı bilginiz bulunmamaktadır/i.test(t));
        exportData.acilDurumNotlarim = { status: acilRes.status, tables, text: notes.join(' | ').slice(0, 4000) };
      }

      const dokRes = await safeFetchText('/Home/Dokumanlarim');
      if (dokRes.ok) {
        const d = htmlToDoc(dokRes.text);
        exportData.dokumanlarim = {
          status: dokRes.status,
          tables: Array.from((d.querySelector('main') || d.body).querySelectorAll('table')).map((t) => ({ id: t.id || '', ...parseTable(t) }))
        };
      }

      emitProgress(runId, {
        stage: 'tamamlandi_fetch',
        stageIndex: 9,
        totalStages,
        label: 'Veri toplama tamamlandı, PDF ve Markdown derleniyor...'
      });

      return { ok: true, runId, data: exportData };
    } catch (err) {
      if (err?.isCancelled) {
        return { ok: false, cancelled: true };
      }
      if (err?.sessionExpired) {
        return { ok: false, sessionExpired: true };
      }
      return { ok: false, error: err?.message || String(err) };
    }
  }

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
    if (msg.type === 'START_EXPORT') {
      runExport(msg.options || {})
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true; // keep channel open for async response
    }
    return false;
  });
})();
