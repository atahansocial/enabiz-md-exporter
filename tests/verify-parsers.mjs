import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARSER_PATH = path.resolve(__dirname, '../src/lib/dom-parsers.js');

function loadParsers() {
  const code = fs.readFileSync(PARSER_PATH, 'utf8');
  const ctx = { globalThis: {} };
  ctx.globalThis = ctx;
  vm.runInNewContext(code, ctx, { filename: 'dom-parsers.js' });
  return ctx.__enabizDomParsers;
}

/**
 * Lightweight zero-dependency DOM node mock supporting tag/id/class/attr selectors,
 * descendant + direct-child combinators, cloneNode, remove, and textContent.
 */
class MockEl {
  constructor(tag, attrs = {}, children = [], text = '') {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parent = null;
    this._text = text;
    this.value = attrs.value ?? '';
    this.selectedOptions = attrs.selectedOptions ?? [];
    for (const ch of children) {
      if (typeof ch === 'string') {
        this.children.push(new MockEl('#TEXT', {}, [], ch));
      } else if (ch) {
        ch.parent = this;
        this.children.push(ch);
      }
    }
  }

  get id() {
    return this.attrs.id || '';
  }

  get className() {
    return this.attrs.class || '';
  }

  get classList() {
    const tokens = new Set(String(this.attrs.class || '').split(/\s+/).filter(Boolean));
    return { contains: (c) => tokens.has(c) };
  }

  get textContent() {
    if (this.tagName === '#TEXT') return this._text;
    const childText = this.children.map((c) => c.textContent).join(' ');
    return [this._text, childText].filter(Boolean).join(' ');
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  cloneNode(deep = false) {
    const copy = new MockEl(
      this.tagName === '#TEXT' ? '#TEXT' : this.tagName.toLowerCase(),
      { ...this.attrs },
      [],
      this._text
    );
    copy.value = this.value;
    copy.selectedOptions = [...this.selectedOptions];
    if (deep) {
      for (const ch of this.children) {
        const clonedChild = ch.cloneNode(true);
        clonedChild.parent = copy;
        copy.children.push(clonedChild);
      }
    }
    return copy;
  }

  querySelectorAll(selector) {
    const groups = selector.split(',').map((s) => s.trim()).filter(Boolean);
    const out = [];
    const seen = new Set();

    const walk = (node) => {
      for (const ch of node.children) {
        if (ch.tagName !== '#TEXT') {
          if (groups.some((g) => matchChain(ch, g, this)) && !seen.has(ch)) {
            seen.add(ch);
            out.push(ch);
          }
          walk(ch);
        }
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function matchSimple(el, sel) {
  if (!el || el.tagName === '#TEXT') return false;
  let rest = sel;

  const tagMatch = rest.match(/^[a-zA-Z0-9_-]+/);
  if (tagMatch) {
    if (el.tagName !== tagMatch[0].toUpperCase()) return false;
    rest = rest.slice(tagMatch[0].length);
  }

  while (rest.length > 0) {
    if (rest[0] === '#') {
      const m = rest.match(/^#([a-zA-Z0-9_-]+)/);
      if (!m || el.id !== m[1]) return false;
      rest = rest.slice(m[0].length);
    } else if (rest[0] === '.') {
      const m = rest.match(/^\.([a-zA-Z0-9_-]+)/);
      if (!m || !el.classList.contains(m[1])) return false;
      rest = rest.slice(m[0].length);
    } else if (rest[0] === '[') {
      const m = rest.match(/^\[([a-zA-Z0-9_-]+)(?:(\*?=)"([^"]*)")?\]/);
      if (!m) return false;
      const val = el.getAttribute(m[1]);
      if (val === null) return false;
      if (m[2] === '=' && val !== m[3]) return false;
      if (m[2] === '*=' && !val.includes(m[3])) return false;
      rest = rest.slice(m[0].length);
    } else {
      return false;
    }
  }
  return true;
}

function matchChain(el, chain, rootScope) {
  const tokens = chain.replace(/\s*>\s*/g, ' > ').trim().split(/\s+/);
  let idx = tokens.length - 1;
  if (!matchSimple(el, tokens[idx])) return false;
  idx--;
  let cur = el;
  while (idx >= 0) {
    if (tokens[idx] === '>') {
      idx--;
      cur = cur.parent;
      if (!cur || cur === rootScope?.parent || !matchSimple(cur, tokens[idx])) return false;
      idx--;
    } else {
      let anc = cur.parent;
      let matched = null;
      while (anc && anc !== rootScope?.parent) {
        if (matchSimple(anc, tokens[idx])) {
          matched = anc;
          break;
        }
        anc = anc.parent;
      }
      if (!matched) return false;
      cur = matched;
      idx--;
    }
  }
  return true;
}

const el = (tag, attrsOrChildren, maybeChildren) => {
  if (Array.isArray(attrsOrChildren) || typeof attrsOrChildren === 'string') {
    const arr = Array.isArray(attrsOrChildren) ? attrsOrChildren : [attrsOrChildren];
    return new MockEl(tag, {}, arr);
  }
  const arr = Array.isArray(maybeChildren)
    ? maybeChildren
    : typeof maybeChildren === 'string'
      ? [maybeChildren]
      : [];
  return new MockEl(tag, attrsOrChildren || {}, arr);
};

function makeDoc(children) {
  const body = el('body', children);
  return {
    body,
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel)
  };
}

function main() {
  const p = loadParsers();

  // 1. Visit card parsing
  const visitDoc = makeDoc([
    el('div', { class: 'ziyaretCardList' }, [
      el('div', { class: 'zTarihS' }, '15.05.2026'),
      el('div', { class: 'rating', onclick: "Degerlendir('15.05.2026 10:30:00')" }),
      el('div', { class: 'card-text' }, 'ÖRNEK DEVLET HASTANESİ'),
      el('div', { class: 'hastaneTakipNo' }, 'Hastane Takip No: SYS-2026-001'),
      el('div', { class: 'drBrans' }, 'İÇ HASTALIKLARI'),
      el('div', { class: 'drAdi' }, 'DR. AYŞE YILMAZ'),
      el('a', { class: 'card-red-link', onclick: "Detay({ url: '/Home/ZiyaretDetay?id=42' })" }, 'Detay')
    ])
  ]);
  const visits = p.parseVisitCardsFromDoc(visitDoc);
  assert.equal(visits.length, 1);
  assert.equal(visits[0].tarihSaat, '15.05.2026 10:30:00');
  assert.equal(visits[0].sysTakipNo, 'SYS-2026-001');
  assert.equal(visits[0].detayUrl, '/Home/ZiyaretDetay?id=42');
  console.log('✓ parseVisitCardsFromDoc check passed');

  // 2. Prescription tables: 7-cell row AND reordered header mapping
  const rxDoc = makeDoc([
    el('table', { id: 'tblYazanIlaclar' }, [
      el('thead', [
        el('tr', [
          el('th', 'İlaç Adı'),
          el('th', 'Barkod'),
          el('th', 'Açıklama'),
          el('th', 'Doz'),
          el('th', 'Periyot'),
          el('th', 'Kullanım Şekli'),
          el('th', 'Kutu Adedi')
        ])
      ]),
      el('tbody', [
        // 7-cell row with swapped Barkod / İlaç Adı
        el('tr', [
          el('td', 'ÖRNEK ŞURUP 200 ML'),
          el('td', '8690000000099'),
          el('td', 'Yemek sonrası'),
          el('td', '2'),
          el('td', '1 GÜN'),
          el('td', 'AĞIZDAN'),
          el('td', '1')
        ])
      ])
    ]),
    el('table', { id: 'tblSatilanIlaclar' }, [
      el('thead', [
        el('tr', [el('th', 'Barkod'), el('th', 'İlaç Adı'), el('th', 'Kutu Adedi')])
      ]),
      el('tbody', [
        el('tr', [el('td', '8690000000099'), el('td', 'ÖRNEK ŞURUP 200 ML'), el('td', '1')])
      ])
    ])
  ]);
  const rx = p.parsePrescriptionTables(rxDoc);
  assert.equal(rx.yazilanIlaclar.length, 1);
  assert.equal(rx.yazilanIlaclar[0].barkod, '8690000000099');
  assert.equal(rx.yazilanIlaclar[0].ilacAdi, 'ÖRNEK ŞURUP 200 ML');
  assert.equal(rx.yazilanIlaclar[0].kutuAdedi, '1');
  assert.equal(rx.satilanIlaclar.length, 1);
  assert.equal(rx.satilanIlaclar[0].kutuAdedi, '1');
  console.log('✓ parsePrescriptionTables 7-cell & header-mapped check passed');

  // 3. Tahlil panels: multi-row panel + Tekil Tetkikler + TahlillerPdfIndir
  const tahlilDoc = makeDoc([
    el('div', { id: 'accordionTahlilListe' }, [
      el('div', { class: 'accordion-item' }, [
        el('div', { class: 'zTarihS' }, '15.05.2026'),
        el('div', { class: 'hastaneAdi' }, 'ÖRNEK DEVLET HASTANESİ'),
        el('div', { class: 'refNormal' }, '1 Normal'),
        el('div', { class: 'refDisi' }, '1 Referans Dışı'),
        el('a', { onclick: "TahlillerPdfIndir('tr-TR', '15.05.2026', '1001')" }, 'PDF'),
        el('div', { class: 'tahlilList' }, [
          el('a', { class: 'islemBtn', onclick: "IslemRedModalGoster('1','SYS-2026-001')" }),
          el('div', { class: 'tahlilGroup', islemadi: 'Hemogram' }, 'Hemogram'),
          el('div', { class: 'rowContainer', subdurumkontrol: '0' }, [
            el('div', { class: 'columnContainer' }, [el('span', 'Tetkik:'), 'WBC']),
            el('div', { class: 'columnContainer' }, [el('span', 'Sonuç:'), '12,4']),
            el('div', { class: 'columnContainer' }, [el('span', 'Birim:'), '10^3/uL']),
            el('div', { class: 'columnContainer' }, [el('span', 'Ref:'), '4,0 - 10,5']),
            el('div', { class: 'columnContainer refDisi' }, 'Yüksek')
          ])
        ]),
        el('div', { class: 'tahlilList' }, [
          el('a', { class: 'islemBtn', onclick: "IslemRedModalGoster('1','SYS-2026-001')" }),
          el('div', { class: 'tahlilHeader' }, [
            el('div', { id: 'islemAdi', islemadi: 'CRP' }, 'CRP'),
            el('div', { class: 'degerDurumBox refNormal' })
          ]),
          el('div', { class: 'tahlilBody' }, [
            el('div', { class: 'columnContainer' }, 'Normal'),
            el('div', { class: 'columnContainer' }, [el('span', 'Sonuç:'), '1,2']),
            el('div', { class: 'columnContainer' }, [el('span', 'Birim:'), 'mg/L']),
            el('div', { class: 'columnContainer' }, [el('span', 'Ref:'), '<5'])
          ])
        ])
      ])
    ])
  ]);
  const tahlil = p.parseTahlilPanels(tahlilDoc);
  assert.equal(tahlil.panels.length, 1);
  assert.equal(tahlil.pdfTargets.length, 1);
  assert.equal(tahlil.pdfTargets[0].kurumKodu, '1001');
  assert.equal(tahlil.panels[0].groups.length, 2);
  assert.equal(tahlil.panels[0].groups[0].rows[0].islemAdi, 'WBC');
  assert.equal(tahlil.panels[0].groups[0].rows[0].isOutOfRange, true);
  assert.equal(tahlil.panels[0].groups[1].grupAdi, 'Tekil Tetkikler');
  assert.equal(tahlil.panels[0].groups[1].rows[0].islemAdi, 'CRP');
  assert.equal(tahlil.panels[0].groups[1].rows[0].isOutOfRange, false);
  console.log('✓ parseTahlilPanels multi-row & Tekil Tetkikler checks passed');

  // 4. Raporlar & Hastaliklar header-shifted parsing
  const raporDoc = makeDoc([
    el('table', { id: 'tblRaporlarim' }, [
      el('thead', [
        el('tr', [
          el('th', 'Tanı'),
          el('th', 'Rapor Türü'),
          el('th', 'Rapor No'),
          el('th', 'Tarih')
        ])
      ]),
      el('tbody', [
        el('tr', [
          el('td', 'J06.9'),
          el('td', 'İSTİRAHAT RAPORU'),
          el('td', 'RPT-99'),
          el('td', '15.05.2026'),
          el('a', { onclick: "RaporPdf('TKP-99')" }, 'PDF')
        ])
      ])
    ]),
    el('table', { id: 'tblHastaliklarim' }, [
      el('thead', [
        el('tr', [el('th', 'Hekim'), el('th', 'Tanı'), el('th', 'Tarih'), el('th', 'Klinik')])
      ]),
      el('tbody', [
        el('tr', [
          el('td', 'DR. AYŞE YILMAZ'),
          el('td', 'J06.9 - AKUT ÜST SOLUNUM'),
          el('td', '15.05.2026 10:30'),
          el('td', 'İÇ HASTALIKLARI'),
          el('a', { onclick: "Detay('15.05.2026','EK BİLGİ','J06.9 - AKUT ÜST SOLUNUM','','','','SYS-77')" }, 'Detay')
        ])
      ])
    ])
  ]);
  const raps = p.parseRaporRows(raporDoc);
  assert.equal(raps.raporlar[0].raporNo, 'RPT-99');
  assert.equal(raps.raporlar[0].tarih, '15.05.2026');
  assert.equal(raps.raporlar[0].tani, 'J06.9');
  assert.equal(raps.raporlar[0].pdfTakipNo, 'TKP-99');

  const hasts = p.parseHastalikRows(raporDoc);
  assert.equal(hasts.rows[0].tarih, '15.05.2026 10:30');
  assert.equal(hasts.rows[0].hekim, 'DR. AYŞE YILMAZ');
  assert.equal(hasts.rows[0].sysTakipNo, 'SYS-77');
  console.log('✓ parseRaporRows & parseHastalikRows header-shifted checks passed');

  // 5. Profil parsing
  const profilDoc = makeDoc([
    el('main', [
      'Profillerim ÖRNEK HASTA 11111111111 01.01.1995 ANKARA Kimlik Aile Hekimi Bilgileriniz ÖRNEK 1 NOLU ASM Boy Kilo',
      el('input', { id: 'boy', value: '180' }),
      el('input', { id: 'kilo', value: '81' }),
      el('select', { id: 'kanGrubuSelect', selectedOptions: [{ textContent: 'A Rh +' }] }),
      el('select', { id: 'yasadigiUlkeSelect', selectedOptions: [{ textContent: 'TÜRKİYE' }] }),
      el('select', { id: 'yasadigiSehirSelect', selectedOptions: [{ textContent: 'İZMİR' }] })
    ])
  ]);
  const prof = p.parseProfilFromDoc(profilDoc);
  assert.equal(prof.adSoyad, 'ÖRNEK HASTA');
  assert.equal(prof.dogumTarihi, '01.01.1995');
  assert.equal(prof.dogumYeri, 'ANKARA');
  assert.equal(prof.kanGrubu, 'A Rh +');
  assert.equal(prof.vki, '25.0');
  assert.equal(prof.yasadigiSehir, 'İZMİR');
  console.log('✓ parseProfilFromDoc check passed');
}

main();
