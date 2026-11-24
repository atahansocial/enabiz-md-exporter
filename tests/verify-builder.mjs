import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildMarkdownArchive,
  classifyLabValue,
  cleanRadiologyBody,
  dateSortKey,
  formatHastalikRow,
  safeCodeFence
} from '../src/lib/markdown-builder.js';
import {
  cleanOfficialReportText,
  extractLabTimesFromPdfText
} from '../src/lib/pdf-extractor.js';
import { createZipBytes } from '../src/lib/zip.js';

const TEST_ZIP_PATH = path.join(os.tmpdir(), `test-enabiz-export-${process.pid}.zip`);

function buildSyntheticFixture() {
  return {
    metadata: {
      patientName: 'ÖRNEK HASTA',
      exportedAt: '2026-11-24T12:00:00.000Z',
      sourceUrl: 'https://enabiz.gov.tr/Home/Ziyaretlerim',
      dateRange: { start: '2016', end: '2026' },
      domVisitCount: 3
    },
    profil: {
      adSoyad: 'ÖRNEK HASTA',
      dogumTarihi: '01.01.1995',
      dogumYeri: 'ANKARA',
      kanGrubu: '0 Rh +',
      boyCm: '175',
      kiloKg: '70',
      vki: '22.9',
      aileHekimiBirimi: 'ÖRNEK 1 NOLU AİLE HEKİMLİĞİ BİRİMİ',
      yasadigiSehir: 'ANKARA',
      yasadigiUlke: 'TÜRKİYE'
    },
    visits: [
      {
        index: 1,
        tarih: '15.05.2026',
        tarihSaat: '15.05.2026 10:30:00',
        hastane: 'ÖRNEK DEVLET HASTANESİ',
        sysTakipNo: 'SYS-2026-001',
        brans: 'İÇ HASTALIKLARI',
        hekim: 'DR. AYŞE YILMAZ',
        detay: {
          tani: [{ tarih: '15.05.2026 10:30', tani: 'J06.9 - AKUT ÜST SOLUNUM YOLU ENFEKSİYONU', hekim: 'DR. AYŞE YILMAZ', klinik: 'İÇ HASTALIKLARI' }],
          onTani: [],
          ekTani: [],
          islemler: [
            { islemZamani: '15.05.2026 10:30', randevuZamani: '', adet: '1', islemAdi: 'Poliklinik Muayenesi', islemKodu: '520030' }
          ],
          receteler: [
            {
              receteTarihi: '15.05.2026 10:35',
              receteNo: 'RX202601',
              receteTuru: 'NORMAL',
              ilaclar: {
                yazilanIlaclar: [
                  { barkod: '8690000000001', ilacAdi: 'ÖRNEK AĞRI KESİCİ 500 MG', aciklama: 'Tok karnına', doz: '1', periyot: '1 GÜN', kullanimSekli: 'AĞIZDAN', kullanimSayisi: '2', kutuAdedi: '1' }
                ],
                satilanIlaclar: [
                  { barkod: '8690000000001', ilacAdi: 'ÖRNEK AĞRI KESİCİ 500 MG', kutuAdedi: '1' }
                ]
              }
            }
          ],
          tahliller: [
            { ttId: '1', parentId: null, tarih: '15.05.2026 10:40', islemAdi: 'Hemogram', sonuc: '', birim: '', referans: '', isOutOfRange: false },
            { ttId: '2', parentId: '1', tarih: '15.05.2026 10:40', islemAdi: 'WBC', sonuc: '12,4', birim: '10^3/uL', referans: '4,0 - 10,5', isOutOfRange: true }
          ],
          rapor: null,
          doktorMesaji: null,
          gozlukRecetesi: null
        }
      },
      {
        index: 2,
        tarih: '10.08.2023',
        tarihSaat: '10.08.2023 14:15:00',
        hastane: 'ÖRNEK ŞEHİR HASTANESİ',
        sysTakipNo: 'SYS-2023-002',
        brans: 'GÖZ HASTALIKLARI',
        hekim: 'DR. MEHMET KAYA',
        detay: {
          tani: [{ tarih: '10.08.2023 14:15', tani: 'H52.1 - MİYOPİ', hekim: 'DR. MEHMET KAYA', klinik: 'GÖZ HASTALIKLARI' }],
          onTani: [],
          ekTani: [],
          islemler: [{ islemZamani: '10.08.2023 14:15', randevuZamani: '', adet: '1', islemAdi: 'Göz Muayenesi', islemKodu: 'P520030' }],
          receteler: [],
          tahliller: [],
          rapor: null,
          doktorMesaji: null,
          gozlukRecetesi: null
        }
      },
      {
        index: 3,
        tarih: '04.04.2016',
        tarihSaat: '04.04.2016 09:00:00',
        hastane: 'ÖRNEK AİLE SAĞLIĞI MERKEZİ',
        sysTakipNo: 'SYS-2016-003',
        brans: 'AİLE HEKİMLİĞİ',
        hekim: 'DR. ALİ DEMİR',
        detay: {
          tani: [{ tarih: '04.04.2016 09:00', tani: 'Z00.0 - GENEL TIBBİ MUAYENE', hekim: 'DR. ALİ DEMİR', klinik: 'AİLE HEKİMLİĞİ' }],
          onTani: [],
          ekTani: [],
          islemler: [{ islemZamani: '04.04.2016 09:00', randevuZamani: '', adet: '1', islemAdi: '1. Basamak Muayene', islemKodu: '520080' }],
          receteler: [],
          tahliller: [],
          rapor: null,
          doktorMesaji: null,
          gozlukRecetesi: null
        }
      }
    ],
    hastaliklarim: {
      rows: [
        { tarih: '15.05.2026 10:30', tani: 'J06.9 - AKUT ÜST SOLUNUM YOLU ENFEKSİYONU', klinik: 'İÇ HASTALIKLARI', hekim: 'DR. AYŞE YILMAZ', detayArgs: [], sysTakipNo: 'SYS-2026-001' }
      ]
    },
    tahlillerim: {
      panels: [
        {
          tarih: '15.05.2026',
          hastane: 'ÖRNEK DEVLET HASTANESİ',
          normalSayisi: '2 Normal',
          refDisiSayisi: '2 Referans Dışı',
          pdf: { filename: '2026-05-15_1001.pdf' },
          groups: [
            {
              grupAdi: 'Tam Kan',
              sysTakipNo: 'SYS-2026-001',
              rows: [
                { islemAdi: 'WBC', sonuc: '12,4', birim: '10^3/uL', referans: '4,0 - 10,5', isOutOfRange: true },
                { islemAdi: 'Demir', sonuc: '45', birim: 'ug/dL', referans: '60 - 160', isOutOfRange: true },
                { islemAdi: 'Glukoz', sonuc: '92', birim: 'mg/dL', referans: '74 - 106', isOutOfRange: false }
              ]
            },
            {
              grupAdi: 'Tekil Tetkikler',
              sysTakipNo: 'SYS-2026-001',
              rows: [
                { islemAdi: 'CRP', sonuc: '1,2', birim: 'mg/L', referans: '<5', isOutOfRange: false }
              ]
            }
          ]
        }
      ]
    },
    radyoloji: [
      {
        hastane: 'ÖRNEK DEVLET HASTANESİ',
        tarih: '15.05.2026',
        aciklama: 'Akciğer Grafisi',
        accession: 'ACC-001',
        raporHtml: '<p>T.C. Sağlık Bakanlığı Teleradyoloji Sistemi</p><p>Bulgular:</p><p>Her iki akciğer alanı doğaldır.</p><p>5070 sayılı elektronik imza kanunu gereği imzalanmıştır.</p>'
      },
      {
        hastane: 'ÖRNEK DEVLET HASTANESİ',
        tarih: '15.05.2026',
        aciklama: 'Akciğer Grafisi (Tekrar)',
        accession: 'ACC-002',
        raporHtml: '<p>Bulgular:</p><p>Her iki akciğer alanı doğaldır.</p>'
      }
    ],
    raporlar: {
      raporlar: [
        {
          tarih: '15.05.2026',
          raporNo: 'RPT-2026-001',
          raporTuru: 'İSTİRAHAT RAPORU',
          baslangicTarihi: '15.05.2026',
          bitisTarihi: '17.05.2026',
          tani: 'J06.9',
          pdf: {
            filename: '2026-05-15_RPT-2026-001.pdf',
            extractedText: [
              'ÖRNEK HASTA',
              'T.C. Kimlik No: 11111111111',
              'Tanı: J06.9 - Akut Üst Solunum Yolu Enfeksiyonu',
              'Karar: 3 gün istirahat uygundur.',
              'Bu belge 5070 sayılı elektronik imza kanununa göre imzalanmıştır.',
              'Doğrulama kodu: ABC-123'
            ].join('\n')
          }
        }
      ]
    },
    ilaclarim: {
      rows: [
        { cells: ['15.05.2026', '8690000000001', 'RX202601', 'ÖRNEK AĞRI KESİCİ 500 MG', '1', '1 GÜN', 'AĞIZDAN', '2', '1', 'ÖRNEK DEVLET HASTANESİ', 'İÇ HASTALIKLARI'] }
      ]
    },
    asiTakvimi: {
      tables: [
        { headers: ['Tarih', 'Aşı', 'Doz'], rows: [{ cells: ['01.06.2021', 'Örnek Aşı', '1'] }] }
      ]
    },
    hastalikTakipDetay: [],
    randevularim: { tables: [] },
    malzemeDetaylari: [],
    alerjilerim: { tables: [] },
    epikrizler: { rows: [] },
    patolojiler: { rows: [] },
    taramalar: { tables: [] },
    sigortalarim: { rows: [] },
    acilDurumNotlarim: { text: '', tables: [] },
    dokumanlarim: { tables: [] }
  };
}

async function main() {
  // 1. Unit tests for lab classification
  assert.equal(classifyLabValue('12,4', '4,0 - 10,5', true), 'HIGH');
  assert.equal(classifyLabValue('45', '60 - 160', true), 'LOW');
  assert.equal(classifyLabValue('Pozitif', '', true), 'OUT');
  assert.equal(classifyLabValue('92', '74 - 106', false), '');
  assert.equal(classifyLabValue('6,2', '<5', false), 'HIGH');
  console.log('✓ classifyLabValue checks passed');

  // 2. Unit tests for radiology cleaner & report cleaner & lab timestamp extraction
  const radClean = cleanRadiologyBody(
    '<p>T.C. Sağlık Bakanlığı Teleradyoloji Sistemi</p><p>Bulgular:</p><p>Normal inceleme.</p><p>Evrakın elektronik imzalı suretidir.</p>',
    ''
  );
  assert.ok(!radClean.text.includes('Teleradyoloji Sistemi'));
  assert.ok(!radClean.text.includes('elektronik imzalı'));
  assert.ok(radClean.text.includes('**Bulgular:**'));
  assert.ok(radClean.text.includes('Normal inceleme.'));

  const cleanedReport = cleanOfficialReportText(
    'ÖRNEK HASTA\nT.C. Kimlik No: 12345678901\nKarar: Sağlıklıdır.\n5070 sayılı elektronik imza kanunu gereği imzalanmıştır.',
    { patientName: 'ÖRNEK HASTA' }
  );
  assert.ok(!cleanedReport.includes('12345678901'));
  assert.ok(!cleanedReport.includes('5070 sayılı'));
  assert.ok(cleanedReport.includes('Karar: Sağlıklıdır.'));

  const times = extractLabTimesFromPdfText('15.05.2026 10:40\n15.05.2026\n11:05\n15.05.2026 10:40');
  assert.deepEqual(times, ['10:40', '11:05']);
  console.log('✓ Cleaner & timestamp parser checks passed');

  // 3. Full Markdown archive build on synthetic fixture
  const fixture = buildSyntheticFixture();
  const labPdfTexts = { '2026-05-15_1001.pdf': '15.05.2026 10:40\n15.05.2026 10:45' };
  const { files, stats } = buildMarkdownArchive(fixture, { labPdfTexts });

  assert.equal(stats.totalVisits, 3);
  assert.equal(stats.totalIslemRows, 3);
  assert.equal(stats.uniqueDiagnosesCount, 3);
  assert.equal(stats.panelCount, 1);
  assert.equal(stats.labRowsCount, 4);
  assert.equal(stats.oorCount, 2);
  assert.equal(stats.radCount, 2);
  assert.equal(stats.radReportCount, 2);
  assert.equal(stats.raporCount, 1);
  assert.equal(stats.raporPdfCount, 1);
  assert.equal(stats.receteCount, 1);
  assert.equal(stats.ilaclarimCount, 1);
  assert.equal(stats.asiCount, 1);

  const expectedFiles = [
    'README.md',
    '01-tanilar.md',
    '02-tahliller.md',
    '03-radyoloji.md',
    '04-raporlar.md',
    '05-ilaclar-ve-receteler.md',
    '06-asi-takip-malzeme.md',
    'ziyaretler/2026.md',
    'ziyaretler/2023.md',
    'ziyaretler/2016-2017.md'
  ].sort();
  assert.deepEqual(Array.from(files.keys()).sort(), expectedFiles);

  assert.ok(files.get('02-tahliller.md').includes('(10:40, 10:45)'));
  assert.ok(files.get('03-radyoloji.md').includes('raporu ile birebir aynıdır'));
  assert.ok(files.get('04-raporlar.md').includes('3 gün istirahat uygundur.'));
  assert.ok(!files.get('04-raporlar.md').includes('11111111111'));
  console.log('✓ Full synthetic Markdown archive build passed (10 files, exact structure)');

  // 4. ZIP creation & unzip integrity verification (including STORE skip on pre-compressed .jpg)
  const zipInput = new Map(files);
  const compressibleDummyJpg = new Uint8Array(256);
  compressibleDummyJpg[0] = 0xff;
  compressibleDummyJpg[1] = 0xd8;
  compressibleDummyJpg[2] = 0xff;
  zipInput.set('radyoloji_goruntuleri/test/001.jpg', compressibleDummyJpg);

  const zipBytes = await createZipBytes(zipInput, { rootFolder: 'enabiz-md-arsiv' });
  // Check local file header compression method for the .jpg entry is STORE (0)
  const jpgMarker = Buffer.from('enabiz-md-arsiv/radyoloji_goruntuleri/test/001.jpg', 'utf8');
  const nameOffset = Buffer.from(zipBytes).indexOf(jpgMarker);
  assert.ok(nameOffset >= 30, 'JPG entry header not found in ZIP');
  const method = new DataView(zipBytes.buffer, zipBytes.byteOffset).getUint16(nameOffset - 22, true);
  assert.equal(method, 0, 'Pre-compressed .jpg entry should use ZIP method 0 (STORE)');

  fs.writeFileSync(TEST_ZIP_PATH, zipBytes);
  try {
    execFileSync('unzip', ['-t', TEST_ZIP_PATH], { stdio: 'pipe' });
    console.log(`✓ ZIP archive verified cleanly with unzip -t & JPG STORE method (${zipBytes.byteLength} bytes)`);
  } finally {
    fs.rmSync(TEST_ZIP_PATH, { force: true });
  }

  // 5. v1.1.0 hardening checks: ISO dateSortKey, unsorted visits oldest/newest,
  //    safeCodeFence for embedded triple backticks, header-shifted Ilaclarim,
  //    formatHastalikRow dedup, and partial-failure sectionStatuses warnings
  assert.equal(dateSortKey('2026-05-15 10:30'), dateSortKey('15.05.2026 10:30'));
  assert.ok(dateSortKey('2026-05-15 10:30') > dateSortKey('2026-05-15 09:00'));
  assert.ok(dateSortKey('15-05-2026') > 0);

  const fenced = safeCodeFence('Satır 1\n```js\nalert(1)\n```\nSatır 2', 'text');
  assert.ok(fenced.startsWith('````text\n') && fenced.endsWith('\n````'));

  const deduped = formatHastalikRow({
    tarih: '15.05.2026 10:30',
    tani: 'J06.9 - AKUT ÜST SOLUNUM',
    klinik: 'İÇ HASTALIKLARI',
    hekim: 'DR. AYŞE YILMAZ',
    detayArgs: ['J06.9 - AKUT ÜST SOLUNUM', 'İÇ HASTALIKLARI', 'Poliklinik Kaydı'],
    sysTakipNo: 'SYS-1'
  });
  assert.equal(deduped[1], 'J06.9 - AKUT ÜST SOLUNUM (Poliklinik Kaydı)');

  const hardenedInput = buildSyntheticFixture();
  hardenedInput.visits = [...hardenedInput.visits].reverse(); // oldest first -> test chronological fix
  hardenedInput.raporlar.raporlar[0].pdf.extractedText += '\n```\nörnek kod bloğu\n```';
  hardenedInput.ilaclarim = {
    headers: ['Reçete No', 'Barkod', 'İlaç Adı', 'Tarih', 'Kutu Adedi', 'Hastane', 'Klinik'],
    rows: [
      { cells: ['RX-SHIFTED', '8690000000777', 'ÖRNEK ŞURUP 100 ML', '15.05.2026', '2', 'ÖRNEK MERKEZ', 'KBB'] }
    ]
  };
  hardenedInput.sectionStatuses = [
    { key: 'ziyaretler', label: 'Ziyaretler', ok: true, status: 200, recordCount: 3, error: null },
    { key: 'hastaliklar', label: 'Hastalıklarım', ok: false, status: 500, recordCount: 0, error: 'HTTP 500' }
  ];

  const hardened = buildMarkdownArchive(hardenedInput);
  assert.equal(hardened.stats.oldestVisit, '04.04.2016');
  assert.equal(hardened.stats.newestVisit, '15.05.2026');
  assert.equal(hardened.stats.raporPdfExtractedCount, 1);
  assert.equal(hardened.stats.failedSections.length, 1);
  assert.ok(hardened.files.get('04-raporlar.md').includes('````text\n'));
  assert.ok(hardened.files.get('05-ilaclar-ve-receteler.md').includes('`RX-SHIFTED` | ÖRNEK ŞURUP 100 ML | `8690000000777`'));
  const readmeWarn = hardened.files.get('README.md');
  assert.ok(readmeWarn.includes('> [!WARNING]'));
  assert.ok(readmeWarn.includes('## Dışa Aktarım Doğrulama Özeti'));
  assert.ok(readmeWarn.includes('Hastalıklarım') && readmeWarn.includes('HTTP 500'));
  console.log('✓ v1.1.0 hardening checks passed (ISO dates, sort order, safeCodeFence, header map, dedup, partial-failure report)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
