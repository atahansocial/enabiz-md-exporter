/**
 * Shared e-Nabız DOM parsers (classic script attaching to globalThis.__enabizDomParsers).
 * Loaded in the browser before src/content.js and testable in Node via vm without a bundler.
 */
((root) => {
  function cleanText(el) {
    return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  function normalizeTr(str) {
    return String(str || '')
      .toLocaleLowerCase('tr-TR')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Resolve column indices dynamically by normalized Turkish header keywords.
   * Falls back to provided default indices when headers are missing or unmatched,
   * while reporting any unexpected/missing headers for diagnostics.
   */
  function mapHeaderIndices(headers, spec) {
    const normHeaders = (headers || []).map(normalizeTr);
    const indices = {};
    const used = new Set();
    const missingHeaders = [];

    for (const [key, cfg] of Object.entries(spec)) {
      const patterns = cfg.patterns || [];
      let found = -1;
      for (let i = 0; i < normHeaders.length; i++) {
        if (used.has(i)) continue;
        const h = normHeaders[i];
        if (patterns.some((pat) => (pat instanceof RegExp ? pat.test(h) : h.includes(pat)))) {
          found = i;
          break;
        }
      }
      if (found >= 0) {
        indices[key] = found;
        used.add(found);
      } else {
        if (normHeaders.length > 0 && cfg.required !== false) {
          missingHeaders.push(key);
        }
        indices[key] = cfg.fallback ?? -1;
      }
    }
    return { indices, missingHeaders };
  }

  function cellAt(cells, idx) {
    if (idx < 0 || idx >= (cells?.length || 0)) return '';
    return cleanText(cells[idx]);
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
          !(
            r.cells.length === 1 &&
            /kayıt|bulunmamaktadır|veri yok|bulunamadı|listelenecek/i.test(r.cells[0])
          )
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

  function parseVisitCardsFromDoc(doc) {
    if (!doc) return [];
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
    const satilanTbl = doc.querySelector(
      'table[id*="Satilan"], table[id*="satilan"], table[id*="Satılan"]'
    );

    let yazilanIlaclar = [];
    if (yazanTbl) {
      const hdrs = Array.from(yazanTbl.querySelectorAll('thead th')).map((th) => cleanText(th));
      const { indices } = mapHeaderIndices(hdrs, {
        barkod: { patterns: ['barkod'], fallback: 0 },
        ilacAdi: { patterns: ['ilaç', 'ilac'], fallback: 1 },
        aciklama: { patterns: ['açıklama', 'aciklama'], fallback: 2, required: false },
        doz: { patterns: ['doz'], fallback: 3 },
        periyot: { patterns: ['periyot'], fallback: 4 },
        kullanimSekli: { patterns: ['kullanım şekli', 'kullanim sekli', 'şekli'], fallback: 5 },
        kullanimSayisi: { patterns: ['kullanım sayısı', 'kullanim sayisi', 'sayısı'], fallback: 6, required: false },
        kutuAdedi: { patterns: ['kutu', 'adet'], fallback: 7, required: false }
      });

      yazilanIlaclar = Array.from(yazanTbl.querySelectorAll('tbody tr'))
        .map((tr) => {
          const tds = Array.from(tr.querySelectorAll('td'));
          if (tds.length < 6) return null;
          // Support both 7-cell and 8-cell rows safely without silent drops
          return {
            barkod: cellAt(tds, indices.barkod),
            ilacAdi: cellAt(tds, indices.ilacAdi),
            aciklama: cellAt(tds, indices.aciklama),
            doz: cellAt(tds, indices.doz),
            periyot: cellAt(tds, indices.periyot),
            kullanimSekli: cellAt(tds, indices.kullanimSekli),
            kullanimSayisi: indices.kullanimSayisi < tds.length ? cellAt(tds, indices.kullanimSayisi) : '',
            kutuAdedi: indices.kutuAdedi < tds.length ? cellAt(tds, indices.kutuAdedi) : ''
          };
        })
        .filter((x) => x && (x.ilacAdi || x.barkod));
    }

    let satilanIlaclar = [];
    if (satilanTbl) {
      const hdrs = Array.from(satilanTbl.querySelectorAll('thead th')).map((th) => cleanText(th));
      const { indices } = mapHeaderIndices(hdrs, {
        barkod: { patterns: ['barkod'], fallback: 0 },
        ilacAdi: { patterns: ['ilaç', 'ilac'], fallback: 1 },
        kutuAdedi: { patterns: ['kutu', 'adet'], fallback: 2, required: false }
      });

      satilanIlaclar = Array.from(satilanTbl.querySelectorAll('tbody tr'))
        .map((tr) => {
          const tds = Array.from(tr.querySelectorAll('td'));
          if (tds.length < 2) return null;
          return {
            barkod: cellAt(tds, indices.barkod),
            ilacAdi: cellAt(tds, indices.ilacAdi),
            kutuAdedi: indices.kutuAdedi < tds.length ? cellAt(tds, indices.kutuAdedi) : ''
          };
        })
        .filter((x) => x && (x.ilacAdi || x.barkod));
    }

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
                (statusClass &&
                  !statusClass.includes('durumNormal') &&
                  /disi|kirmizi|danger|high|low/i.test(statusClass));
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

  function parseRaporRows(doc) {
    const tbl1 = doc.querySelector('#tblRaporlarim');
    const t1 = parseTable(tbl1);
    const { indices, missingHeaders } = mapHeaderIndices(t1.headers, {
      tarih: { patterns: ['tarih'], fallback: 0 },
      raporNo: { patterns: ['rapor no', 'numara'], fallback: 1 },
      raporTakipNo: { patterns: ['takip'], fallback: 2, required: false },
      raporTuru: { patterns: ['tür', 'tur', 'tip'], fallback: 3 },
      baslangicTarihi: { patterns: ['başlangıç', 'baslangic'], fallback: 4, required: false },
      bitisTarihi: { patterns: ['bitiş', 'bitis'], fallback: 5, required: false },
      tani: { patterns: ['tanı', 'tani'], fallback: 6, required: false }
    });

    const raporlar = t1.rows.map((r) => {
      const pdfOc = r.onclicks.find((o) => o.onclick.includes('RaporPdf'));
      const m = pdfOc ? pdfOc.onclick.match(/RaporPdf\('([^']+)'\)/) : null;
      const getC = (idx) => (idx >= 0 && idx < r.cells.length ? r.cells[idx] : '');
      return {
        tarih: getC(indices.tarih),
        raporNo: getC(indices.raporNo),
        raporTakipNo: getC(indices.raporTakipNo),
        raporTuru: getC(indices.raporTuru),
        baslangicTarihi: getC(indices.baslangicTarihi),
        bitisTarihi: getC(indices.bitisTarihi),
        tani: getC(indices.tani),
        pdfTakipNo: m ? m[1] : null
      };
    });

    const t2 = parseTable(doc.querySelector('#tblRaporBasvurularim'));
    return {
      headers: t1.headers,
      raporlar,
      basvurular: t2.rows,
      missingHeaders
    };
  }

  function parseHastalikRows(doc) {
    const tbl = doc.querySelector('#tblHastaliklarim') || doc.querySelector('table');
    const pt = parseTable(tbl);
    const { indices, missingHeaders } = mapHeaderIndices(pt.headers, {
      tarih: { patterns: ['tarih'], fallback: 0 },
      tani: { patterns: ['tanı', 'tani', 'hastalık', 'hastalik'], fallback: 1 },
      klinik: { patterns: ['klinik', 'branş', 'brans'], fallback: 2, required: false },
      hekim: { patterns: ['hekim', 'doktor'], fallback: 3, required: false }
    });

    const rows = pt.rows.map((r) => {
      const oc = r.onclicks[0]?.onclick || '';
      const args = [...oc.matchAll(/'([^']*)'/g)].map((m) => m[1]);
      const getC = (idx) => (idx >= 0 && idx < r.cells.length ? r.cells[idx] : '');
      return {
        tarih: getC(indices.tarih) || args[0] || '',
        tani: getC(indices.tani),
        klinik: getC(indices.klinik),
        hekim: getC(indices.hekim),
        detayArgs: args.slice(1, 6).filter(Boolean),
        sysTakipNo: args[6] || ''
      };
    });

    return { headers: pt.headers, rows, missingHeaders };
  }

  function parseProfilFromDoc(doc, fallbackName = '') {
    const main = doc.querySelector('main') || doc.body;
    const text = cleanText(main);
    const boy = doc.querySelector('#boy')?.value || '';
    const kilo = doc.querySelector('#kilo')?.value || '';
    const kanGrubu = doc.querySelector('#kanGrubuSelect')?.selectedOptions?.[0]?.textContent?.trim() || '';
    const yasadigiUlke = doc.querySelector('#yasadigiUlkeSelect')?.selectedOptions?.[0]?.textContent?.trim() || '';
    const yasadigiSehir = doc.querySelector('#yasadigiSehirSelect')?.selectedOptions?.[0]?.textContent?.trim() || '';
    const nameMatch = text.match(
      /Profillerim\s+([A-ZÇĞİÖŞÜ\s]+?)\s+\d{11}\s+(\d{2}\.\d{2}\.\d{4})\s+([A-ZÇĞİÖŞÜa-zçğıöşü\s]+?)\s+Kimlik/
    );
    const asmMatch = text.match(/Aile Hekimi Bilgileriniz\s+(.+?)\s+Boy\s+Kilo/);
    let vki = '';
    const bNum = parseFloat(boy);
    const kNum = parseFloat(kilo);
    if (bNum > 0 && kNum > 0) vki = (kNum / (bNum / 100) ** 2).toFixed(1);

    return {
      adSoyad: nameMatch ? nameMatch[1].trim() : fallbackName,
      dogumTarihi: nameMatch ? nameMatch[2] : '',
      dogumYeri: nameMatch ? nameMatch[3].trim() : '',
      kanGrubu,
      boyCm: boy,
      kiloKg: kilo,
      vki,
      aileHekimiBirimi: asmMatch ? asmMatch[1].trim() : '',
      yasadigiUlke,
      yasadigiSehir
    };
  }

  root.__enabizDomParsers = {
    cleanText,
    normalizeTr,
    mapHeaderIndices,
    parseTable,
    parseGenericPane,
    parseVisitCardsFromDoc,
    parsePrescriptionTables,
    parseTahlilPanels,
    parseRaporRows,
    parseHastalikRows,
    parseProfilFromDoc
  };
})(globalThis);
