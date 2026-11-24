/**
 * Pure Markdown Archive Builder — exact JS port of build_md_archive.py.
 * Generates the exact folder structure and Markdown format of enabiz-md-arsiv/.
 */

import { cleanOfficialReportText, extractLabTimesFromPdfText } from './pdf-extractor.js';

const HTML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' '
};

export function decodeHtmlEntities(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/gi, (m) => HTML_ENTITIES[m.toLowerCase()] || m)
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}

export function cleanStr(val) {
  if (val == null) return '';
  return decodeHtmlEntities(val).replace(/[ \t]+/g, ' ').trim();
}

export function mdEsc(val) {
  return cleanStr(val).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function parseTrFloat(val) {
  if (!val) return null;
  const s = String(val).trim().replace(/\s+/g, '');
  if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(s)) return null;
  const num = Number(s.replace(',', '.'));
  return Number.isFinite(num) ? num : null;
}

/**
 * Classify numeric lab results against standard reference strings (`lo - hi`, `<hi`, `<=hi`, `>lo`, `>=lo`).
 * Note: Parenthesized or operator-prefixed result values (e.g. `(4-10)` or `>1000`) cannot be parsed as a
 * single float and safely fall back to the portal's `apiFlagged` indicator (`OUT`).
 */
export function classifyLabValue(sonuc, referans, apiFlagged = false) {
  const val = parseTrFloat(sonuc);
  const ref = cleanStr(referans);
  if (val !== null && ref) {
    const mRange = ref.match(/^([+-]?\d+(?:[.,]\d+)?)\s*[-–—~]\s*([+-]?\d+(?:[.,]\d+)?)/);
    if (mRange) {
      const lo = parseTrFloat(mRange[1]);
      const hi = parseTrFloat(mRange[2]);
      if (lo !== null && hi !== null && lo <= hi) {
        if (val > hi) return 'HIGH';
        if (val < lo) return 'LOW';
        return '';
      }
    }
    const mLt = ref.match(/^(<=|<)\s*([+-]?\d+(?:[.,]\d+)?)$/);
    if (mLt) {
      const bound = parseTrFloat(mLt[2]);
      if (bound !== null) {
        if ((mLt[1] === '<' && val >= bound) || (mLt[1] === '<=' && val > bound)) return 'HIGH';
        return '';
      }
    }
    const mGt = ref.match(/^(>=|>)\s*([+-]?\d+(?:[.,]\d+)?)$/);
    if (mGt) {
      const bound = parseTrFloat(mGt[2]);
      if (bound !== null) {
        if ((mGt[1] === '>' && val <= bound) || (mGt[1] === '>=' && val < bound)) return 'LOW';
        return '';
      }
    }
  }
  return apiFlagged ? 'OUT' : '';
}

export function statusLabel(flag) {
  if (flag === 'HIGH') return 'Yüksek ↑';
  if (flag === 'LOW') return 'Düşük ↓';
  if (flag === 'OUT') return 'Referans Dışı';
  return 'Normal';
}

export function dateSortKey(dateStr) {
  const s = dateStr || '';
  const mTr = s.match(/(\d{2})[-.](\d{2})[-.](\d{4})(?:[T\s]+(\d{2}):(\d{2}))?/);
  if (mTr) {
    return (
      Number(mTr[3]) * 1e8 +
      Number(mTr[2]) * 1e6 +
      Number(mTr[1]) * 1e4 +
      Number(mTr[4] || 0) * 100 +
      Number(mTr[5] || 0)
    );
  }
  const mIso = s.match(/(\d{4})-(\d{2})-(\d{2})(?:[T\s]+(\d{2}):(\d{2}))?/);
  if (mIso) {
    return (
      Number(mIso[1]) * 1e8 +
      Number(mIso[2]) * 1e6 +
      Number(mIso[3]) * 1e4 +
      Number(mIso[4] || 0) * 100 +
      Number(mIso[5] || 0)
    );
  }
  return 0;
}

export function safeCodeFence(text, lang = 'text') {
  const body = String(text || '');
  const matches = body.match(/`+/g) || [];
  const maxRun = matches.reduce((mx, m) => Math.max(mx, m.length), 0);
  const fence = '`'.repeat(Math.max(3, maxRun + 1));
  return `${fence}${lang}\n${body}\n${fence}`;
}

export function cleanRadiologyBody(raporHtml, pdfText) {
  let raw = '';
  if (raporHtml) {
    let s = String(raporHtml);
    s = s.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    s = s.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/(p|div|tr|li|h[1-6]|section|header)>/gi, '\n');
    s = s.replace(/<td[^>]*>/gi, ' ');
    s = s.replace(/<[^>]+>/g, '');
    raw = decodeHtmlEntities(s);
  } else {
    raw = decodeHtmlEntities(pdfText || '');
  }

  const lines = raw.split(/\r?\n/).map((ln) => ln.replace(/[ \t\u00a0]+/g, ' ').trim());
  const meta = {};
  const bodyLines = [];
  const skipExact = new Set([
    'T.C. Sağlık Bakanlığı Teleradyoloji Sistemi',
    'Radyoloji Sonuç Raporu',
    'Rapor',
    'T.C.',
    'SAĞLIK BAKANLIĞI'
  ]);

  for (const ln of lines) {
    if (!ln || skipExact.has(ln)) {
      if (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] !== '') bodyLines.push('');
      continue;
    }
    if (
      ['tele-pacs.net', '5070 sayılı', 'elektronik imza', 'Evrakın elektronik imzalı', 'Teleradyoloji/Dogrulama'].some(
        (pat) => ln.includes(pat)
      )
    ) {
      continue;
    }
    if (/^(Hastanın Adı Soyadı|Hasta Adı\s*:|Cinsiyeti\s+|Doğum Tarihi\s+)/.test(ln)) {
      continue;
    }
    if (ln.startsWith('Çekim Tarihi')) {
      const val = ln.replace('Çekim Tarihi', '').trim();
      if (val && val !== '-') meta.cekimTarihi = val;
      continue;
    }
    if (ln.startsWith('LOINC Kodu')) {
      const ml = ln.match(/LOINC Kodu\s*(.*?)\s*Erişim Numarası\s*(.*)/);
      if (ml) {
        if (ml[1].trim()) meta.loinc = ml[1].trim();
        if (ml[2].trim()) meta.erisimNo = ml[2].trim();
      }
      continue;
    }
    if (ln.includes('Protokol Numarası')) {
      const mp = ln.match(/Protokol Numarası\s*(\S+)/);
      if (mp) meta.protokol = mp[1].trim();
      continue;
    }
    if (ln.startsWith('Klinik')) {
      const val = ln.replace(/^Klinik\s*:?\s*/, '').trim();
      if (val && val !== '-') meta.klinik = val;
      continue;
    }
    if (ln.startsWith('Dosya No:')) {
      meta.dosyaNo = ln.replace('Dosya No:', '').trim();
      continue;
    }
    bodyLines.push(ln);
  }

  const cleaned = [];
  for (const ln of bodyLines) {
    if (!ln) {
      if (cleaned.length > 0 && cleaned[cleaned.length - 1] !== '') cleaned.push('');
    } else {
      cleaned.push(ln);
    }
  }
  while (cleaned.length > 0 && cleaned[cleaned.length - 1] === '') cleaned.pop();

  const headingSet = new Set(['Bulgular', 'Bulgular:', 'Sonuç ve Öneriler', 'SONUÇ VE YORUM :', 'SONUÇ VE YORUM:']);
  const formatted = cleaned.map((ln) => (headingSet.has(ln) ? `**${ln.replace(/:$/, '')}:**` : ln));

  return {
    cekimTarihi: meta.cekimTarihi || '',
    protokol: meta.protokol || '',
    erisimNo: meta.erisimNo || '',
    loinc: meta.loinc || '',
    klinik: meta.klinik || '',
    dosyaNo: meta.dosyaNo || '',
    text: formatted.join('\n').trim()
  };
}

export function parseChronicDetail(ht) {
  const txt = cleanStr(ht?.detay?.text);
  if (!txt) return [];
  const labels = [
    'Genel Takip Bilgileri',
    'Takip Tipi',
    'Hastalık Bilgisi',
    'Tamamlanma Durumu',
    'Takip Tarihi',
    'Sonraki Değerlendirme',
    'Sigara Kullanımı',
    'Bulgular',
    'Sistolik Kan Basıncı',
    'Diastolik Kan Basıncı',
    'Beden Kitle İndeksi (BKİ)',
    'Boy',
    'Ağırlık',
    'Nabız',
    'Aktiviteler',
    'Eğitim',
    'Durumu'
  ].sort((a, b) => b.length - a.length);

  let marked = txt;
  for (const lbl of labels) {
    marked = marked.split(lbl).join(`\n@@${lbl}@@ `);
  }
  const pairs = [];
  for (const chunkRaw of marked.split(/\r?\n/)) {
    const chunk = chunkRaw.trim();
    if (!chunk) continue;
    const m = chunk.match(/^@@(.+?)@@\s*(.*)$/);
    if (m) {
      const k = m[1].trim();
      const v = m[2].trim();
      if ((k === 'Genel Takip Bilgileri' || k === 'Bulgular') && !v) continue;
      if (v) pairs.push([k, v]);
    } else {
      pairs.push(['Kurum', chunk]);
    }
  }
  return pairs;
}

export function formatHastalikRow(row) {
  if ('tarih' in row) {
    let tani = cleanStr(row.tani);
    const klinik = cleanStr(row.klinik);
    const hekim = cleanStr(row.hekim);
    const normExisting = [tani, klinik, hekim].join(' ').toLocaleLowerCase('tr-TR');
    const args = (row.detayArgs || [])
      .map((x) => cleanStr(x))
      .filter((x) => x && !normExisting.includes(x.toLocaleLowerCase('tr-TR')));
    if (args.length > 0) {
      const combined = args.join(', ');
      if (!tani) tani = combined;
      else tani = `${tani} (${combined})`;
    }
    return [cleanStr(row.tarih), tani, klinik, hekim, cleanStr(row.sysTakipNo)];
  }
  const c = row.cells || [];
  return [cleanStr(c[0] || ''), cleanStr(c[1] || ''), cleanStr(c[2] || ''), cleanStr(c[3] || ''), ''];
}

function buildTanilar(data, stats) {
  const lines = [
    '# Tanılar ve Hastalık Geçmişi',
    '',
    `## 1. Ziyaret İçi ICD-10 Tanı Özeti (${stats.uniqueDiagnosesCount} Benzersiz Tanı)`,
    '',
    '| Tanı (ICD-10) | Tekrar | Tür | İlk Tarih | Son Tarih |',
    '|---|---|---|---|---|'
  ];
  for (const d of stats.diagnoses) {
    lines.push(
      `| ${mdEsc(d.tani)} | ${d.count} | ${mdEsc(d.turler.join(', '))} | ${mdEsc(d.ilkTarih)} | ${mdEsc(d.sonTarih)} |`
    );
  }
  lines.push(
    '',
    `## 2. Hastalıklarım Tam Kaydı (${stats.hastaliklarimCount} Satır)`,
    '',
    '| Tarih | Tanı / Ön Tanı | Klinik | Hekim | SYS Takip No |',
    '|---|---|---|---|---|'
  );
  for (const row of data.hastaliklarim?.rows || []) {
    const [dt, nm, kl, hk, sysNo] = formatHastalikRow(row);
    lines.push(`| ${mdEsc(dt)} | ${mdEsc(nm)} | ${mdEsc(kl)} | ${mdEsc(hk)} | \`${mdEsc(sysNo)}\` |`);
  }
  lines.push('');
  return lines.join('\n');
}

function buildTahliller(data, labPdfTexts, oorList) {
  const panels = data.tahlillerim?.panels || [];
  const totalRows = panels.reduce(
    (sum, p) => sum + (p.groups || []).reduce((gSum, g) => gSum + (g.rows || []).length, 0),
    0
  );
  const lines = [
    '# Tahlil Sonuçları (Tam Arşiv)',
    '',
    `- **Kapsam:** ${panels.length} panel, toplam **${totalRows}** parametre (**${oorList.length}** referans dışı / dikkat çeken sonuç).`,
    '',
    `## 1. Referans Dışı / Dikkat Çeken Sonuçlar (${oorList.length})`,
    '',
    '| Tarih | Hastane | Grup | Test Adı | Sonuç | Birim | Referans | Durum |',
    '|---|---|---|---|---|---|---|---|'
  ];
  for (const item of oorList) {
    lines.push(
      `| ${mdEsc(item.tarih)} | ${mdEsc(item.hastane)} | ${mdEsc(item.grup)} | ${mdEsc(item.islemAdi)} | **${mdEsc(item.sonuc)}** | ${mdEsc(item.birim)} | ${mdEsc(item.referans)} | ${statusLabel(item.flag)} |`
    );
  }

  lines.push('', `## 2. Tüm Tahlil Panelleri (${panels.length} Panel)`, '');
  panels.forEach((p, i) => {
    const fname = p.pdf?.filename || '';
    const pdfTxt = (fname && labPdfTexts[fname]) || p.pdf?.extractedText || '';
    const times = extractLabTimesFromPdfText(pdfTxt);
    const timeStr = times.length ? ` (${times.join(', ')})` : '';
    const counts = [cleanStr(p.normalSayisi), cleanStr(p.refDisiSayisi)].filter(Boolean).join(', ');
    lines.push(`### ${i + 1}. ${cleanStr(p.tarih)}${timeStr} — ${cleanStr(p.hastane)} [${counts}]`);
    lines.push('');
    for (const g of p.groups || []) {
      const sysNo = cleanStr(g.sysTakipNo);
      const sysPart = sysNo ? ` (\`${sysNo}\`)` : '';
      lines.push(`**${cleanStr(g.grupAdi)}**${sysPart}`);
      lines.push('');
      lines.push('| Test Adı | Sonuç | Birim | Referans | Durum |');
      lines.push('|---|---|---|---|---|');
      for (const row of g.rows || []) {
        const fl = row.flag || '';
        const resS = fl ? `**${mdEsc(row.sonuc)}**` : mdEsc(row.sonuc);
        lines.push(
          `| ${mdEsc(row.islemAdi)} | ${resS} | ${mdEsc(row.birim)} | ${mdEsc(row.referans)} | ${statusLabel(fl)} |`
        );
      }
      lines.push('');
    }
  });
  return lines.join('\n');
}

function buildRadyoloji(data) {
  const rads = data.radyoloji || [];
  const lines = [
    '# Radyolojik Görüntüler ve Raporlar',
    '',
    `Toplam **${rads.length}** radyolojik çalışma (sistemde yazılı raporu bulunanların tamamı aşağıda temizlenmiş olarak yer almaktadır).`,
    ''
  ];
  const seenTexts = new Map();
  let repCount = 0;

  rads.forEach((r, idx) => {
    const tarih = cleanStr(r.tarih);
    const aciklama = cleanStr(r.aciklama);
    const hastane = cleanStr(r.hastane);
    const acc = cleanStr(r.accession);
    const pdfTxt = r.pdf?.extractedText || '';
    const cleaned = cleanRadiologyBody(r.raporHtml || r.rapor || '', pdfTxt);
    const body = cleaned.text;

    lines.push(`## ${idx + 1}. ${tarih} — ${aciklama}`);
    lines.push(`- **Kurum:** ${hastane}`);
    if (cleaned.cekimTarihi) lines.push(`- **Çekim Tarihi:** ${cleaned.cekimTarihi}`);
    if (cleaned.klinik) lines.push(`- **Klinik:** ${cleaned.klinik}`);
    if (cleaned.loinc) lines.push(`- **LOINC:** ${cleaned.loinc}`);
    const proto = cleaned.protokol || cleaned.erisimNo || acc;
    if (proto) lines.push(`- **Protokol / Erişim No:** \`${proto}\``);
    if (cleaned.dosyaNo) lines.push(`- **Dosya No:** \`${cleaned.dosyaNo}\``);

    if (body) {
      repCount += 1;
      const normKey = body.replace(/\s+/g, ' ').trim();
      if (seenTexts.has(normKey)) {
        const [prevDt, prevDesc] = seenTexts.get(normKey);
        lines.push(
          `- **Rapor Metni:** _${prevDt} tarihli **${prevDesc}** raporu ile birebir aynıdır._`
        );
      } else {
        seenTexts.set(normKey, [tarih, aciklama]);
        lines.push('');
        lines.push(body);
      }
    } else {
      lines.push('- **Rapor:** _Sistemde yazılı radyoloji raporu bulunmamaktadır._');
    }
    lines.push('');
  });

  return { markdown: lines.join('\n'), repCount };
}

function buildRaporlar(data) {
  const raporlar = data.raporlar?.raporlar || [];
  const patientName = cleanStr(data.profil?.adSoyad || data.metadata?.patientName);
  const pdfCount = raporlar.filter((r) => r.pdf).length;

  const lines = [
    '# Sağlık Raporları (`Raporlarım`)',
    '',
    `Toplam **${raporlar.length}** rapor kaydı (resmi PDF'i bulunan **${pdfCount}** raporun temizlenmiş tüm tıbbi içerikleri aşağıdaki bölümlerde yer almaktadır; yasal doğrulama altbilgileri, imza yer tutucuları, form doldurma yönergeleri ve tekrarlayan kimlik blokları çıkarılmıştır).`,
    '',
    '## 1. Rapor Listesi',
    '',
    '| Tarih | Rapor No | Rapor Türü | Başlangıç | Bitiş | Tanı | PDF |',
    '|---|---|---|---|---|---|---|'
  ];
  for (const rp of raporlar) {
    const hasPdf = rp.pdf ? 'Var' : 'Yok';
    lines.push(
      `| ${mdEsc(rp.tarih)} | \`${mdEsc(rp.raporNo)}\` | ${mdEsc(rp.raporTuru)} | ${mdEsc(rp.baslangicTarihi)} | ${mdEsc(rp.bitisTarihi)} | ${mdEsc(rp.tani)} | ${hasPdf} |`
    );
  }

  const pdfReports = raporlar.filter((r) => r.pdf?.extractedText);
  if (pdfReports.length > 0) {
    lines.push('', `## 2. Resmi Raporların Klinik İçerikleri (${pdfReports.length} Rapor)`, '');
    for (const rp of pdfReports) {
      const rNo = cleanStr(rp.raporNo || rp.pdfTakipNo);
      const rTur = cleanStr(rp.raporTuru);
      const rDt = cleanStr(rp.tarih);
      lines.push(`### ${rDt} — ${rTur} (\`${rNo}\`)`);
      if (cleanStr(rp.tani)) lines.push(`- **Tanı:** ${cleanStr(rp.tani)}`);
      if (cleanStr(rp.baslangicTarihi) || cleanStr(rp.bitisTarihi)) {
        lines.push(`- **Geçerlilik / Süre:** ${cleanStr(rp.baslangicTarihi)} – ${cleanStr(rp.bitisTarihi)}`);
      }
      const cleanedBody = cleanOfficialReportText(rp.pdf.extractedText, { patientName });
      if (cleanedBody) {
        lines.push('');
        lines.push(safeCodeFence(cleanedBody, 'text'));
      }
      lines.push('');
    }
  } else if (pdfCount > 0) {
    lines.push(
      '',
      '## 2. Resmi Raporların Klinik İçerikleri',
      '',
      '_Resmi PDF dosyaları için metin çözümlemesi devre dışı bırakılmış veya metin çıkarılamamıştır._',
      ''
    );
  }

  return lines.join('\n');
}

function buildIlaclar(data) {
  const visits = data.visits || [];
  const ilacRows = data.ilaclarim?.rows || [];
  const extraRecs = data.recetelerimOzet?.ekstraReceteler || [];

  const allVisitRecs = [];
  for (const v of visits) {
    for (const r of v.detay?.receteler || []) {
      allVisitRecs.push({
        tarih: cleanStr(r.receteTarihi || v.tarih),
        receteNo: cleanStr(r.receteNo),
        receteTuru: cleanStr(r.receteTuru),
        hastane: cleanStr(v.hastane),
        brans: cleanStr(v.brans),
        hekim: cleanStr(v.hekim),
        sysTakipNo: cleanStr(v.sysTakipNo),
        ilaclar: r.ilaclar || {}
      });
    }
  }
  for (const r of extraRecs) {
    allVisitRecs.push({
      tarih: cleanStr(r.tarih),
      receteNo: cleanStr(r.receteNo),
      receteTuru: cleanStr(r.receteTuru),
      hastane: '',
      brans: '',
      hekim: cleanStr(r.hekim),
      sysTakipNo: cleanStr(r.sysTakipNo),
      ilaclar: r.ilaclar || {}
    });
  }

  const lines = [
    '# İlaç ve Reçete Geçmişi',
    '',
    `## 1. Ziyaret Bazlı Reçete Detayları (${allVisitRecs.length} Reçete)`,
    ''
  ];

  for (const r of allVisitRecs) {
    lines.push(`### ${r.tarih} — Reçete \`${r.receteNo}\` (${r.receteTuru})`);
    const kurParts = [r.hastane, r.brans, r.hekim].filter(Boolean).join(' · ');
    const sysPart = r.sysTakipNo ? ` (\`${r.sysTakipNo}\`)` : '';
    lines.push(`- **Kurum / Klinik / Hekim:** ${kurParts}${sysPart}`);
    const yazilan = r.ilaclar?.yazilanIlaclar || [];
    const satilan = r.ilaclar?.satilanIlaclar || [];
    if (yazilan.length > 0) {
      lines.push('');
      lines.push('| Barkod | İlaç Adı | Açıklama | Doz | Periyot | Kullanım | Kutu |');
      lines.push('|---|---|---|---|---|---|---|');
      for (const il of yazilan) {
        lines.push(
          `| \`${mdEsc(il.barkod)}\` | ${mdEsc(il.ilacAdi)} | ${mdEsc(il.aciklama)} | ${mdEsc(il.doz)} | ${mdEsc(il.periyot)} | ${mdEsc(il.kullanimSekli)} (${mdEsc(il.kullanimSayisi)}x) | ${mdEsc(il.kutuAdedi)} |`
        );
      }
    }
    if (satilan.length > 0) {
      const disp = satilan.map((s) => `${cleanStr(s.ilacAdi)} (${cleanStr(s.kutuAdedi)} kutu)`).join(', ');
      lines.push(`- **Eczaneden Alınan:** ${disp}`);
    }
    lines.push('');
  }

  const ilacHeaders = (data.ilaclarim?.headers || []).map((h) => cleanStr(h).toLocaleLowerCase('tr-TR'));
  const findCol = (patterns, fallback) => {
    if (!ilacHeaders.length) return fallback;
    const idx = ilacHeaders.findIndex((h) => patterns.some((p) => h.includes(p)));
    return idx >= 0 ? idx : fallback;
  };
  const colIdx = {
    tarih: findCol(['tarih'], 0),
    barkod: findCol(['barkod'], 1),
    receteNo: findCol(['reçete no', 'recete no', 'reçete'], 2),
    ilacAdi: findCol(['ilaç adı', 'ilac adi', 'ilaç'], 3),
    doz: findCol(['doz'], 4),
    periyot: findCol(['periyot'], 5),
    kullanim: findCol(['kullanım şekli', 'kullanim sekli', 'kullanım'], 6),
    kullanimSayisi: findCol(['kullanım sayısı', 'kullanim sayisi', 'sayısı'], 7),
    kutu: findCol(['kutu', 'adet'], 8),
    hastane: findCol(['hastane', 'kurum'], 9),
    klinik: findCol(['klinik', 'branş', 'brans'], 10)
  };

  lines.push(
    `## 2. \`İlaçlarım\` Tam Kronolojik Liste (${ilacRows.length} Satır)`,
    '',
    '| Tarih | Reçete No | İlaç Adı | Barkod | Doz / Periyot | Kullanım | Kutu | Hastane | Klinik |',
    '|---|---|---|---|---|---|---|---|---|'
  );
  for (const row of ilacRows) {
    const c = row.cells || [];
    const get = (i) => (i >= 0 && i < c.length ? c[i] : '');
    lines.push(
      `| ${mdEsc(get(colIdx.tarih))} | \`${mdEsc(get(colIdx.receteNo))}\` | ${mdEsc(get(colIdx.ilacAdi))} | \`${mdEsc(get(colIdx.barkod))}\` | ${mdEsc(get(colIdx.doz))} / ${mdEsc(get(colIdx.periyot))} | ${mdEsc(get(colIdx.kullanim))} (${mdEsc(get(colIdx.kullanimSayisi))}x) | ${mdEsc(get(colIdx.kutu))} | ${mdEsc(get(colIdx.hastane))} | ${mdEsc(get(colIdx.klinik))} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

function appendGenericTables(lines, tables) {
  for (const t of tables || []) {
    if (!t?.rows?.length) continue;
    const headers = t.headers?.length ? t.headers : t.rows[0].cells.map((_, i) => `Sütun ${i + 1}`);
    lines.push('| ' + headers.map((h) => mdEsc(h)).join(' | ') + ' |');
    lines.push('|' + headers.map(() => '---').join('|') + '|');
    for (const r of t.rows) {
      const cells = r.cells || r;
      lines.push('| ' + headers.map((_, i) => mdEsc(cells[i] || '')).join(' | ') + ' |');
    }
    lines.push('');
  }
}

function buildAsiTakipMalzeme(data) {
  const lines = ['# Aşılar, Kronik Takipler, Randevular ve Tıbbi Malzemeler', '', '## 1. Aşı Takvimi', ''];
  const asiTables = data.asiTakvimi?.tables || [];
  if (asiTables.some((t) => t.rows?.length)) {
    appendGenericTables(lines, asiTables);
  } else {
    lines.push('_Kayıt bulunmamaktadır._', '');
  }

  lines.push('## 2. Kronik Hastalık Tarama ve Takiplerim', '');
  const takips = data.hastalikTakipDetay || [];
  if (takips.length > 0) {
    for (const ht of takips) {
      lines.push(
        `### ${cleanStr(ht.takipTipi)} — ${cleanStr(ht.kronikHastalik)} (${cleanStr(ht.takipTarihi)})`
      );
      for (const [k, v] of parseChronicDetail(ht)) {
        lines.push(`- **${k}:** ${v}`);
      }
      lines.push('');
    }
  } else {
    lines.push('_Kayıt bulunmamaktadır._', '');
  }

  lines.push('## 3. Randevularım', '');
  const ranTables = (data.randevularim?.tables || []).map((t) => {
    if (!t.rows?.length) return t;
    const hdrs =
      t.headers && ['Işlem', 'İşlem', ''].includes(t.headers[t.headers.length - 1])
        ? t.headers.slice(0, -1)
        : t.headers;
    return {
      headers: hdrs,
      rows: t.rows.map((r) => ({ cells: (r.cells || []).slice(0, hdrs.length) }))
    };
  });
  if (ranTables.some((t) => t.rows?.length)) {
    appendGenericTables(lines, ranTables);
  } else {
    lines.push('_Kayıt bulunmamaktadır._', '');
  }

  lines.push('## 4. Tıbbi Malzeme ve Cihazlarım', '');
  if (data.malzemeDetaylari?.length) {
    lines.push('| Tarih | Marka | Raf Ömrü | Ürün Tanımı | Ürün No | Lot / Batch | Bildiren Kurum |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const m of data.malzemeDetaylari) {
      lines.push(
        `| ${mdEsc(m.islemTarihi)} | ${mdEsc(m.marka)} | ${mdEsc(m.rafOmru)} | ${mdEsc(m.urunTanimi)} | \`${mdEsc(m.urunNumarasi)}\` | \`${mdEsc(m.lotBatchNumarasi)}\` | ${mdEsc(m.bildirenKurum)} |`
      );
    }
    lines.push('');
  } else {
    lines.push('_Kayıt bulunmamaktadır._', '');
  }

  // Dynamic optional sections (render only if user has records, else add to "0 Kayıt" list)
  const emptySections = [];
  let secIdx = 5;

  const optionalChecks = [
    {
      label: 'Alerjilerim',
      hasData: () => (data.alerjilerim?.tables || []).some((t) => t.rows?.length),
      render: () => appendGenericTables(lines, data.alerjilerim.tables)
    },
    {
      label: 'Epikriz Bilgilerim',
      hasData: () => Boolean(data.epikrizler?.rows?.length),
      render: () => appendGenericTables(lines, [data.epikrizler])
    },
    {
      label: 'Patoloji Bilgilerim',
      hasData: () => Boolean(data.patolojiler?.rows?.length),
      render: () => appendGenericTables(lines, [data.patolojiler])
    },
    {
      label: 'Optik/Tıbbi Cihaz Reçeteleri',
      hasData: () => Boolean(data.recetelerimOzet?.optik?.rows?.length || data.recetelerimOzet?.tibbiCihaz?.rows?.length),
      render: () => {
        if (data.recetelerimOzet?.optik?.rows?.length) {
          lines.push('### Optik Reçeteleri', '');
          appendGenericTables(lines, [data.recetelerimOzet.optik]);
        }
        if (data.recetelerimOzet?.tibbiCihaz?.rows?.length) {
          lines.push('### Tıbbi Cihaz Reçeteleri', '');
          appendGenericTables(lines, [data.recetelerimOzet.tibbiCihaz]);
        }
      }
    },
    {
      label: 'Sigortalarım',
      hasData: () => Boolean(data.sigortalarim?.rows?.length),
      render: () => appendGenericTables(lines, [data.sigortalarim])
    },
    {
      label: 'Acil Durum Notlarım',
      hasData: () =>
        Boolean(cleanStr(data.acilDurumNotlarim?.text) || (data.acilDurumNotlarim?.tables || []).some((t) => t.rows?.length)),
      render: () => {
        if (cleanStr(data.acilDurumNotlarim?.text)) lines.push(cleanStr(data.acilDurumNotlarim.text), '');
        appendGenericTables(lines, data.acilDurumNotlarim?.tables || []);
      }
    },
    {
      label: 'Dokümanlarım',
      hasData: () => (data.dokumanlarim?.tables || []).some((t) => t.rows?.length),
      render: () => appendGenericTables(lines, data.dokumanlarim.tables)
    },
    {
      label: 'Kanser Taramaları',
      hasData: () => (data.taramalar?.tables || []).some((t) => t.rows?.length),
      render: () => appendGenericTables(lines, data.taramalar.tables)
    }
  ];

  for (const item of optionalChecks) {
    if (item.hasData()) {
      lines.push(`## ${secIdx}. ${item.label}`, '');
      item.render();
      secIdx += 1;
    } else {
      emptySections.push(item.label);
    }
  }

  if (emptySections.length > 0) {
    lines.push(`## ${secIdx}. Kaydı Bulunmayan Bölümler (\`0\` Kayıt)`, '', `${emptySections.join(' · ')}.`, '');
  }

  return lines.join('\n');
}

function buildVisitsByYear(data) {
  const visits = data.visits || [];
  const legacyYears = [];
  for (const v of visits) {
    const yrStr = v.tarih && v.tarih.includes('.') ? v.tarih.split('.').pop() : '';
    const yrNum = Number(yrStr);
    if (Number.isFinite(yrNum) && yrNum > 0 && yrNum < 2018) legacyYears.push(yrNum);
  }
  const minLegacyYear = legacyYears.length ? Math.min(...legacyYears) : 2015;
  const legacyBucket = minLegacyYear < 2017 ? `${minLegacyYear}-2017` : '2017';

  const groups = new Map();
  for (const v of visits) {
    const yr = v.tarih && v.tarih.includes('.') ? v.tarih.split('.').pop() : 'diger';
    const yrNum = Number(yr);
    const bucket = Number.isFinite(yrNum) && yrNum >= 2018 ? yr : Number.isFinite(yrNum) ? legacyBucket : 'diger';
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(v);
  }

  const orderedKeys = Array.from(groups.keys())
    .filter((k) => k !== legacyBucket && k !== 'diger')
    .sort((a, b) => Number(b) - Number(a));
  if (groups.has(legacyBucket)) orderedKeys.push(legacyBucket);
  if (groups.has('diger')) orderedKeys.push('diger');

  const summary = [];
  const files = new Map();

  for (const key of orderedKeys) {
    const vlist = groups.get(key);
    const procCnt = vlist.reduce((sum, v) => sum + ((v.detay?.islemler || []).length), 0);
    const fname = `${key}.md`;
    const label =
      key === legacyBucket && legacyBucket.includes('-')
        ? `${legacyBucket.replace('-', '–')} Yılları Ziyaretleri`
        : `${key} Yılı Ziyaretleri`;
    summary.push({ label, fname, visitCount: vlist.length, procCount: procCnt });

    const md = [`# ${label} (${vlist.length} Ziyaret, ${procCnt} İşlem)`, ''];
    for (const v of vlist) {
      const det = v.detay || {};
      md.push(`## #${v.index} — ${cleanStr(v.tarihSaat || v.tarih)} | ${cleanStr(v.hastane)}`);
      md.push(`- **Klinik:** ${cleanStr(v.brans)} | **Hekim:** ${cleanStr(v.hekim)} | **SYS Takip No:** \`${cleanStr(v.sysTakipNo)}\``);

      for (const t of det.tani || []) md.push(`- **Tanı:** ${cleanStr(t.tani)}`);
      for (const t of det.onTani || []) md.push(`- **Ön Tanı:** ${cleanStr(t.onTani)}`);
      for (const t of det.ekTani || []) md.push(`- **Ek Tanı:** ${cleanStr(t.ekTani)}`);

      const recs = det.receteler || [];
      if (recs.length > 0) {
        md.push('', '**Reçeteler:**');
        for (const r of recs) {
          const ilObj = r.ilaclar || {};
          const yazilan = ilObj.yazilanIlaclar || [];
          const satilan = ilObj.satilanIlaclar || [];
          md.push(`- \`${cleanStr(r.receteNo)}\` (${cleanStr(r.receteTuru)}, ${cleanStr(r.receteTarihi)}):`);
          for (const il of yazilan) {
            md.push(
              `  - ${cleanStr(il.ilacAdi)} [\`${cleanStr(il.barkod)}\`] — ${cleanStr(il.aciklama)} | Doz: ${cleanStr(il.doz)} / ${cleanStr(il.periyot)} | ${cleanStr(il.kullanimSekli)} (${cleanStr(il.kullanimSayisi)}x), ${cleanStr(il.kutuAdedi)} kutu`
            );
          }
          if (satilan.length > 0) {
            const disp = satilan.map((s) => `${cleanStr(s.ilacAdi)} (${cleanStr(s.kutuAdedi)} kutu)`).join(', ');
            md.push(`  - *Alınan:* ${disp}`);
          }
        }
      }

      const tahliller = det.tahliller || [];
      if (tahliller.length > 0) {
        md.push('', '**Tahliller:**', '', '| Tarih | Test | Sonuç | Birim | Referans | Durum |', '|---|---|---|---|---|---|');
        for (const t of tahliller) {
          const isGroup = Boolean(t.ttId && !t.parentId && !cleanStr(t.sonuc));
          const nm = isGroup
            ? `**${mdEsc(t.islemAdi)}**`
            : t.parentId
              ? `↳ ${mdEsc(t.islemAdi)}`
              : mdEsc(t.islemAdi);
          const fl = t.flag || '';
          const resS = fl ? `**${mdEsc(t.sonuc)}**` : mdEsc(t.sonuc);
          const st = isGroup ? '' : cleanStr(t.sonuc) ? statusLabel(fl) : '';
          md.push(`| ${mdEsc(t.tarih)} | ${nm} | ${resS} | ${mdEsc(t.birim)} | ${mdEsc(t.referans)} | ${st} |`);
        }
      }

      const islemler = det.islemler || [];
      if (islemler.length > 0) {
        md.push('', '**İşlemler:**', '', '| Zaman | Kod | İşlem Adı | Adet |', '|---|---|---|---|');
        for (const isl of islemler) {
          md.push(
            `| ${mdEsc(isl.islemZamani)} | \`${mdEsc(isl.islemKodu)}\` | ${mdEsc(isl.islemAdi)} | ${mdEsc(isl.adet)} |`
          );
        }
      }

      for (const [labelSec, secKey] of [
        ['Ziyaret Raporu', 'rapor'],
        ['Doktor Mesajı', 'doktorMesaji'],
        ['Gözlük Reçetesi', 'gozlukRecetesi']
      ]) {
        const val = det[secKey];
        if (!val) continue;
        md.push('', `**${labelSec}:**`);
        if (Array.isArray(val.rows) && val.rows.length > 0) {
          const hdrs = val.headers?.length ? val.headers : val.rows[0].map((_, i) => `Sütun ${i + 1}`);
          md.push('| ' + hdrs.map((h) => mdEsc(h)).join(' | ') + ' |');
          md.push('|' + hdrs.map(() => '---').join('|') + '|');
          for (const r of val.rows) {
            md.push('| ' + r.map((c) => mdEsc(c)).join(' | ') + ' |');
          }
        } else if (val.text) {
          md.push(`- ${cleanStr(val.text)}`);
        }
      }

      md.push('');
    }

    files.set(`ziyaretler/${fname}`, md.join('\n'));
  }

  return { summary, files };
}

function buildReadme(data, stats) {
  const prof = data.profil || {};
  const meta = data.metadata || {};
  const name = cleanStr(prof.adSoyad || meta.patientName || 'Hasta');
  const lines = [`# e-Nabız Tam Sağlık Arşivi — ${name}`, ''];

  if (stats.warnings?.length > 0) {
    lines.push('> [!WARNING]');
    lines.push('> **Kısmi Arşiv Uyarısı:** Bu dışa aktarım sırasında bazı bölümler veya ziyaret detayları alınamadı:');
    for (const w of stats.warnings) {
      lines.push(`> - ${w}`);
    }
    lines.push('');
  }

  lines.push(
    `- **Kapsam:** ${stats.oldestVisit} – ${stats.newestVisit} (\`${stats.totalVisits}\` ziyaret, \`${stats.totalIslemRows}\` tıbbi işlem)`,
    `- **Dışa Aktarım:** ${cleanStr(meta.exportedAt)}`,
    '- **Format Notu:** Tüm tıbbi veriler, resmi PDF içerikleri ve kronolojik ziyaret/işlem kayıtları korunmuş; yasal uyarılar, e-imza doğrulama altbilgileri, form doldurma yönergeleri ve tekrarlayan kimlik üstbilgileri çıkarılmıştır.',
    '',
    '## Kişisel Sağlık Profili',
    '',
    '| Alan | Bilgi |',
    '|---|---|',
    `| Ad Soyad | ${mdEsc(prof.adSoyad || name)} |`,
    `| Doğum Tarihi / Yeri | ${mdEsc(prof.dogumTarihi)} / ${mdEsc(prof.dogumYeri)} |`,
    `| Kan Grubu | **${mdEsc(prof.kanGrubu)}** |`,
    `| Boy / Kilo / VKİ | ${mdEsc(prof.boyCm)} cm / ${mdEsc(prof.kiloKg)} kg (VKİ: ${mdEsc(prof.vki)}) |`,
    `| Aile Hekimi Birimi | ${mdEsc(prof.aileHekimiBirimi)} |`,
    `| Şehir / Ülke | ${mdEsc(prof.yasadigiSehir)} / ${mdEsc(prof.yasadigiUlke)} |`,
    '',
    '## Arşiv İçeriği',
    '',
    '| Dosya | İçerik | Kayıt Sayısı |',
    '|---|---|---|',
    `| [01-tanilar.md](01-tanilar.md) | ICD-10 tanı sıklığı + Hastalıklarım tam listesi | ${stats.uniqueDiagnosesCount} benzersiz tanı · ${stats.hastaliklarimCount} hastalık satırı |`,
    `| [02-tahliller.md](02-tahliller.md) | Referans dışı tahliller + tüm ${stats.panelCount} tahlil paneli | ${stats.labRowsCount} parametre (${stats.oorCount} referans dışı) |`,
    `| [03-radyoloji.md](03-radyoloji.md) | Radyolojik incelemeler ve temizlenmiş tam rapor metinleri | ${stats.radCount} inceleme (${stats.radReportCount} yazılı rapor) |`,
    `| [04-raporlar.md](04-raporlar.md) | Sağlık raporları listesi + ${stats.raporPdfExtractedCount} resmi PDF'in temizlenmiş klinik özeti | ${stats.raporCount} rapor (${stats.raporPdfExtractedCount} tam içerik) |`,
    `| [05-ilaclar-ve-receteler.md](05-ilaclar-ve-receteler.md) | Reçete detayları (yazılan/alınan) + İlaçlarım geçmişi | ${stats.receteCount} reçete · ${stats.ilaclarimCount} ilaç satırı |`,
    `| [06-asi-takip-malzeme.md](06-asi-takip-malzeme.md) | Aşı takvimi, kronik tarama bulguları, randevu, tıbbi malzemeler | ${stats.asiCount} aşı · ${stats.takipCount} takip · ${stats.malzemeCount} malzeme |`,
    `| \`ziyaretler/\` | Yıllara göre tüm ziyaret ve işlem detayları | ${stats.totalVisits} ziyaret · ${stats.totalIslemRows} işlem |`,
    '',
    '### Yıllara Göre Ziyaret Dosyaları',
    ''
  );
  for (const yf of stats.yearFiles) {
    lines.push(`- [${yf.label}](ziyaretler/${yf.fname}) — ${yf.visitCount} ziyaret, ${yf.procCount} işlem`);
  }

  if (data.sectionStatuses?.length > 0) {
    lines.push(
      '',
      '## Dışa Aktarım Doğrulama Özeti',
      '',
      '| Bölüm | HTTP Durumu | Kayıt Sayısı | Sonuç |',
      '|---|---:|---:|---|'
    );
    for (const s of data.sectionStatuses) {
      const badge = s.ok ? 'Tamam' : `Hata (${mdEsc(s.error)})`;
      lines.push(`| ${mdEsc(s.label)} | \`${s.status}\` | ${s.recordCount} | ${badge} |`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Main archive builder.
 * @param {object} rawData - Exported JSON data object from e-Nabız content script.
 * @param {object} [opts] - { labPdfTexts?: Record<string, string> }
 * @returns {{ files: Map<string, string>, stats: object }}
 */
export function buildMarkdownArchive(rawData, opts = {}) {
  const data = structuredClone(rawData || {});
  const labPdfTexts = opts.labPdfTexts || {};

  // 1. Classify lab panel rows and build out-of-range summary
  const oorList = [];
  const seenOor = new Set();
  const panels = data.tahlillerim?.panels || [];
  const panelFlagLookup = new Map();
  const dateFlagLookup = new Map();

  for (const p of panels) {
    const pDate = cleanStr(p.tarih);
    const pHosp = cleanStr(p.hastane);
    for (const g of p.groups || []) {
      const gName = cleanStr(g.grupAdi);
      const sysNo = cleanStr(g.sysTakipNo);
      for (const row of g.rows || []) {
        const nameL = cleanStr(row.islemAdi).toLowerCase();
        const valS = cleanStr(row.sonuc);
        const fl = classifyLabValue(row.sonuc || '', row.referans || '', Boolean(row.isOutOfRange));
        row.flag = fl;
        if (sysNo) panelFlagLookup.set(`${sysNo}|${nameL}|${valS}`, Boolean(row.isOutOfRange));
        if (pDate) dateFlagLookup.set(`${pDate}|${nameL}|${valS}`, Boolean(row.isOutOfRange));
        if (fl) {
          const sig = `${pDate}|${pHosp}|${cleanStr(row.islemAdi)}|${valS}`;
          if (!seenOor.has(sig)) {
            seenOor.add(sig);
            oorList.push({
              tarih: pDate,
              hastane: pHosp,
              grup: gName,
              islemAdi: cleanStr(row.islemAdi),
              sonuc: valS,
              birim: cleanStr(row.birim),
              referans: cleanStr(row.referans),
              flag: fl
            });
          }
        }
      }
    }
  }
  oorList.sort((a, b) => dateSortKey(b.tarih) - dateSortKey(a.tarih));

  // Also classify visit-embedded lab rows
  for (const v of data.visits || []) {
    const sysNo = cleanStr(v.sysTakipNo);
    const vDate = cleanStr(v.tarih);
    for (const t of v.detay?.tahliller || []) {
      const nameL = cleanStr(t.islemAdi).toLowerCase();
      const valS = cleanStr(t.sonuc);
      const matchedApi =
        Boolean(t.isOutOfRange) ||
        panelFlagLookup.get(`${sysNo}|${nameL}|${valS}`) ||
        dateFlagLookup.get(`${vDate}|${nameL}|${valS}`) ||
        false;
      t.isOutOfRange = matchedApi;
      t.flag = classifyLabValue(t.sonuc || '', t.referans || '', matchedApi);
    }
  }

  // 2. Compute diagnosis frequencies
  const diagCounter = new Map();
  const diagMeta = new Map();
  for (const v of data.visits || []) {
    const det = v.detay || {};
    for (const [kind, key] of [
      ['Tanı', 'tani'],
      ['Ön Tanı', 'onTani'],
      ['Ek Tanı', 'ekTani']
    ]) {
      for (const row of det[key] || []) {
        const codeName = cleanStr(key in row ? row[key] : row.tani);
        if (!codeName) continue;
        diagCounter.set(codeName, (diagCounter.get(codeName) || 0) + 1);
        if (!diagMeta.has(codeName)) diagMeta.set(codeName, { turler: new Set(), tarihler: [] });
        const m = diagMeta.get(codeName);
        m.turler.add(kind);
        m.tarihler.push(cleanStr(row.tarih) || cleanStr(v.tarih));
      }
    }
  }

  const diagnoses = Array.from(diagCounter.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'tr'))
    .map(([name, count]) => {
      const m = diagMeta.get(name);
      const sd = [...m.tarihler].sort((a, b) => dateSortKey(a) - dateSortKey(b));
      return {
        tani: name,
        count,
        turler: Array.from(m.turler).sort(),
        ilkTarih: sd[0] || '',
        sonTarih: sd[sd.length - 1] || ''
      };
    });

  // 3. Build files
  const { summary: yearFiles, files: visitFiles } = buildVisitsByYear(data);
  const { markdown: radMd, repCount: radReportCount } = buildRadyoloji(data);

  const visits = data.visits || [];
  const raporlar = data.raporlar?.raporlar || [];
  const totalVisitRecs = visits.reduce((sum, v) => sum + ((v.detay?.receteler || []).length), 0);
  const extraRecsCount = (data.recetelerimOzet?.ekstraReceteler || []).length;

  const sortedVisitDates = visits
    .map((v) => cleanStr(v.tarih))
    .filter(Boolean)
    .sort((a, b) => dateSortKey(a) - dateSortKey(b));

  const failedSections = (data.sectionStatuses || []).filter((s) => !s.ok);
  const failedVisitDetails = visits.filter((v) => v.detayUrl && v.detayStatus && v.detayStatus !== 200);
  const warnings = [];
  if (visits.length === 0) {
    warnings.push('Hiç ziyaret kaydı bulunamadı (`0` ziyaret). Oturum veya seçili yıl aralığını kontrol edin.');
  }
  for (const fs of failedSections) {
    warnings.push(`${fs.label} (${fs.endpoint}) alınamadı: ${fs.error}`);
  }
  if (failedVisitDetails.length > 0) {
    warnings.push(`${failedVisitDetails.length} ziyaretin detayı çekilemedi.`);
  }

  const stats = {
    totalVisits: visits.length,
    newestVisit: sortedVisitDates[sortedVisitDates.length - 1] || '',
    oldestVisit: sortedVisitDates[0] || '',
    totalIslemRows: visits.reduce((sum, v) => sum + ((v.detay?.islemler || []).length), 0),
    uniqueDiagnosesCount: diagnoses.length,
    diagnoses,
    hastaliklarimCount: (data.hastaliklarim?.rows || []).length,
    panelCount: panels.length,
    labRowsCount: panels.reduce(
      (sum, p) => sum + (p.groups || []).reduce((gSum, g) => gSum + (g.rows || []).length, 0),
      0
    ),
    oorCount: oorList.length,
    radCount: (data.radyoloji || []).length,
    radReportCount,
    raporCount: raporlar.length,
    raporPdfCount: raporlar.filter((r) => Boolean(r.pdf)).length,
    raporPdfExtractedCount: raporlar.filter((r) => Boolean(r.pdf?.extractedText)).length,
    receteCount: totalVisitRecs + extraRecsCount,
    ilaclarimCount: (data.ilaclarim?.rows || []).length,
    asiCount: (data.asiTakvimi?.tables || []).reduce((sum, t) => sum + (t.rows || []).length, 0),
    takipCount:
      (data.hastalikTakipDetay || []).length ||
      (data.hastalikTakip?.tables || []).reduce((sum, t) => sum + (t.rows || []).length, 0),
    malzemeCount:
      (data.malzemeDetaylari || []).length ||
      Object.values(data.malzemeVeCihazlarim?.tables || {}).reduce((sum, t) => sum + (t.rows || []).length, 0),
    yearFiles,
    failedSections,
    failedVisitDetailsCount: failedVisitDetails.length,
    warnings
  };

  const files = new Map();
  files.set('README.md', buildReadme(data, stats));
  files.set('01-tanilar.md', buildTanilar(data, stats));
  files.set('02-tahliller.md', buildTahliller(data, labPdfTexts, oorList));
  files.set('03-radyoloji.md', radMd);
  files.set('04-raporlar.md', buildRaporlar(data));
  files.set('05-ilaclar-ve-receteler.md', buildIlaclar(data));
  files.set('06-asi-takip-malzeme.md', buildAsiTakipMalzeme(data));
  for (const [relPath, content] of visitFiles.entries()) {
    files.set(relPath, content);
  }

  return { files, stats };
}
