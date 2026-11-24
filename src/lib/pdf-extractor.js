/**
 * Offline PDF text extractor (powered by bundled Mozilla pdfjs-dist)
 * and universal Turkish medical report boilerplate cleaner.
 */

let pdfjsLibPromise = null;

async function getPdfJs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import('../../vendor/pdf.min.mjs').then((mod) => {
      if (mod?.GlobalWorkerOptions) {
        mod.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdf.worker.min.mjs', import.meta.url).href;
      }
      return mod;
    });
  }
  return pdfjsLibPromise;
}

export function base64ToUint8Array(base64) {
  if (!base64) return new Uint8Array(0);
  if (typeof atob === 'function') {
    const bin = atob(base64);
    const len = bin.length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

export function cleanMultiline(val) {
  if (val == null) return '';
  const lines = String(val)
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n/)
    .map((ln) => ln.replace(/[ \t]+/g, ' ').trim());
  const out = [];
  let prevBlank = false;
  for (const ln of lines) {
    if (!ln) {
      if (!prevBlank && out.length > 0) out.push('');
      prevBlank = true;
    } else {
      out.push(ln);
      prevBlank = false;
    }
  }
  return out.join('\n').trim();
}

/**
 * Extract UTF-8 text from a PDF Uint8Array while reconstructing logical lines by Y/X coordinates.
 */
export async function extractPdfText(uint8OrBase64) {
  const data = typeof uint8OrBase64 === 'string' ? base64ToUint8Array(uint8OrBase64) : uint8OrBase64;
  if (!data || data.byteLength === 0) return { pageCount: 0, text: '' };

  const pdfjs = await getPdfJs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data),
    useWorkerFetch: false,
    isEvalSupported: false,
    verbosity: 0
  });
  const doc = await loadingTask.promise;
  const pages = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const lines = [];
    let currentY = null;
    let currentItems = [];

    const flushLine = () => {
      if (!currentItems.length) return;
      currentItems.sort((a, b) => a.x - b.x);
      let lineStr = '';
      let prevEnd = null;
      for (const it of currentItems) {
        if (prevEnd !== null && it.x - prevEnd > 2.5 && !lineStr.endsWith(' ') && !it.str.startsWith(' ')) {
          lineStr += ' ';
        }
        lineStr += it.str;
        prevEnd = it.x + it.w;
      }
      const trimmed = lineStr.replace(/[ \t]+/g, ' ').trim();
      if (trimmed) lines.push(trimmed);
      currentItems = [];
    };

    for (const item of tc.items || []) {
      if (!item || typeof item.str !== 'string') continue;
      const str = item.str;
      const tr = item.transform || [1, 0, 0, 1, 0, 0];
      const x = tr[4];
      const y = tr[5];
      const w = item.width || 0;

      if (currentY !== null && Math.abs(y - currentY) > 2.8) {
        flushLine();
      }
      if (currentY === null || Math.abs(y - currentY) > 2.8) {
        currentY = y;
      }
      if (str.length > 0) {
        currentItems.push({ x, w, str });
      }
      if (item.hasEOL) {
        flushLine();
        currentY = null;
      }
    }
    flushLine();
    pages.push(lines.join('\n'));
  }

  await doc.cleanup?.();
  await loadingTask.destroy?.();
  return {
    pageCount: doc.numPages,
    text: cleanMultiline(pages.join('\n--- Sayfa ---\n'))
  };
}

/**
 * Extract unique HH:MM timestamps from an e-Nabız Lab PDF text.
 */
export function extractLabTimesFromPdfText(pdfText) {
  if (!pdfText) return [];
  const matches = new Set();
  const re = /\d{2}\.\d{2}\.\d{4}[\s\n]+(\d{2}:\d{2})/g;
  let m;
  while ((m = re.exec(pdfText)) !== null) {
    matches.add(m[1]);
  }
  return Array.from(matches).sort();
}

/**
 * Universal cleaner for official Turkish e-Nabız medical report PDFs (İstirahat, EK-5, EK-7, Sağlık Kurulu, İlaç Raporu, etc.).
 * Strips repetitive identity blocks, legal disclaimers, e-imza verification URLs, and form instructions while keeping all medical facts.
 */
export function cleanOfficialReportText(rawText, reportMeta = {}) {
  if (!rawText) return '';
  const patientName = (reportMeta.patientName || '').trim().toUpperCase();
  const lines = rawText.split(/\r?\n/).map((l) => l.trim());
  const out = [];
  let skipFormInstructions = false;

  for (const ln of lines) {
    if (!ln) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      continue;
    }

    if (ln === '--- Sayfa ---') {
      skipFormInstructions = false;
      continue;
    }

    // Stop or skip boilerplate form filling directions (commonly at bottom of EK-5 / EK-7)
    if (/^(FORM DOLDURMA YÖNERGESİ|AÇIKLAMALAR\s*:?\s*$|NOT\s*:\s*Bu form)/i.test(ln)) {
      skipFormInstructions = true;
      continue;
    }
    if (skipFormInstructions) {
      if (/^(Karar|Sonuç|ICD|Tanı|Hekim|Kurul)/i.test(ln)) {
        skipFormInstructions = false;
      } else {
        continue;
      }
    }

    // Strip e-signature, legal & verification boilerplate
    if (
      /5070 sayılı|elektronik imza|e-imza|imzalanmıştır|turkiye\.gov\.tr|doğrulama kodu|barkod no|karekod|belge doğrulama|e-nabız üzerinden|ssl|güvenli elektronik|sayfa \d+\s*\/\s*\d+/i.test(
        ln
      )
    ) {
      continue;
    }

    // Strip placeholder signature lines
    if (/^(İmza|Kaşe|Mühür|Onaylayan|Düzenleyen Hekim İmza)\s*:?$/i.test(ln)) {
      continue;
    }

    // Strip repeated identity headers
    if (/^(T\.C\.?\s*Kimlik\s*No|TCKN|Baba Adı|Anne Adı|Doğum Tarihi|Doğum Yeri|Cinsiyeti|Adres|Telefon)\s*:/i.test(ln)) {
      continue;
    }
    if (patientName && ln.toUpperCase() === patientName) {
      continue;
    }

    out.push(ln);
  }

  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n').trim();
}
