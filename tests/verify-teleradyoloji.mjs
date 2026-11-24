import assert from 'node:assert/strict';
import {
  TELERADYOLOJI_ORIGIN,
  RAD_IMAGE_ROOT,
  slugifyTr,
  isoDateFromTr,
  extractOtac,
  normalizeWadoBase,
  buildWadoUrl,
  enumerateWorkItem
} from '../src/lib/teleradyoloji.js';
import {
  radiologyPageAuth,
  radiologyPageDownload,
  enabizFetchViewerLink
} from '../src/lib/teleradyoloji-page.js';

function frame(url) {
  const u = new URL(url);
  return Object.fromEntries(u.searchParams.entries());
}

// --- slug / tarih ---
assert.equal(slugifyTr('BEYİN SEKMANS CT (Adult)'), 'BEYIN_SEKMANS_CT_Adult');
assert.equal(slugifyTr('çğıöşü ÇĞİÖŞÜ'), 'cgiosu_CGIOSU');
assert.equal(slugifyTr('   '), 'kayit');
assert.equal(isoDateFromTr('02.05.2016 21:53'), '2016-05-02');
assert.equal(isoDateFromTr('2016-05-02'), '2016-05-02');
assert.equal(isoDateFromTr('tarih yok'), 'tarihsiz');

// --- OTAC ---
assert.equal(
  extractOtac('https://teleradyoloji.saglik.gov.tr/viewer/#/viewpatient?otac=AbC123%2Fxyz'),
  'AbC123/xyz'
);
assert.equal(extractOtac('https://x/viewer?otac=abc&foo=1'), 'abc');
assert.equal(extractOtac('https://x/viewer&otac=abc'), 'abc');
assert.equal(extractOtac('https://x/viewer'), '');

// --- WADO adresi ---
assert.equal(
  normalizeWadoBase('/viewerbackend/wado?'),
  `${TELERADYOLOJI_ORIGIN}/viewerbackend/wado?`
);
assert.equal(
  normalizeWadoBase('viewerbackend/wado'),
  `${TELERADYOLOJI_ORIGIN}/viewerbackend/wado`
);
assert.equal(normalizeWadoBase('https://pacs.example/wado?'), 'https://pacs.example/wado?');
assert.equal(normalizeWadoBase(''), '');

const q1 = frame(buildWadoUrl({
  base: 'https://teleradyoloji.saglik.gov.tr/viewerbackend/wado?',
  studyUid: '1.2.3',
  seriesUid: '4.5.6',
  objectUid: '7.8.9',
  frameNumber: 14
}));
assert.equal(q1.requestType, 'WADO');
assert.equal(q1.studyUID, '1.2.3');
assert.equal(q1.seriesUID, '4.5.6');
assert.equal(q1.objectUID, '7.8.9');
assert.equal(q1.frameNumber, '14');
assert.equal(q1.contentType, 'image/jpeg');

const noSlash = buildWadoUrl({
  base: 'https://pacs.example/wado',
  studyUid: 's',
  seriesUid: 'se',
  objectUid: 'o',
  frameNumber: 1
});
assert.match(noSlash, /\/wado\?requestType=WADO&/);

const withAmp = buildWadoUrl({
  base: 'https://pacs.example/wado?token=x&',
  studyUid: 's',
  seriesUid: 'se',
  objectUid: 'o',
  frameNumber: 1
});
assert.match(withAmp, /&requestType=WADO&/);

// --- WorkItem normalizasyonu ---
const workItem = {
  Patient: {
    Studies: [
      {
        StudyInstanceUid: '1.2.840.study',
        WadoAddress: '/viewerbackend/wado?',
        Description: 'BEYİN SEKMANS CT',
        Series: [
          {
            SeriesInstanceUid: '1.2.840.series.1',
            SeriesNumber: 1,
            Description: 'AXIAL',
            Instances: [
              { SopInstanceUID: '1.2.840.inst.1', FrameCount: 1 },
              { SopInstanceUID: '1.2.840.inst.2', FrameCount: 1 },
              { SopInstanceUID: '1.2.840.inst.3', FrameCount: 1 }
            ]
          },
          {
            SeriesInstanceUID: '1.2.840.series.2',
            SeriesNumber: 2,
            Modality: 'CT',
            Instances: [
              { SOPInstanceUID: '1.2.840.inst.4', FrameCount: 36 }
            ]
          }
        ]
      }
    ]
  }
};

const plan = enumerateWorkItem(workItem, {
  tarih: '02.05.2016 21:53:54',
  aciklama: 'BEYİN SEKMANS CT (Adult)',
  index: 2
});
assert.equal(plan.warnings.length, 0, plan.warnings.join(' | '));
assert.equal(plan.studies.length, 1);
assert.equal(plan.frames.length, 39);
assert.equal(plan.studies[0].seriesCount, 2);
assert.equal(plan.studies[0].frameCount, 39);
assert.equal(plan.studies[0].folder, `${RAD_IMAGE_ROOT}/2016-05-02_BEYIN_SEKMANS_CT_Adult_03`);
assert.equal(plan.frames[0].path, `${plan.studies[0].folder}/seri-01_AXIAL/001.jpg`);
assert.equal(plan.frames[3].path, `${plan.studies[0].folder}/seri-02_CT/001.jpg`);
assert.equal(plan.frames[38].path, `${plan.studies[0].folder}/seri-02_CT/036.jpg`);
assert.equal(plan.frames[3].frameNumber, 1);
assert.equal(plan.frames[38].frameNumber, 36);
const last = frame(plan.frames[38].url);
assert.equal(last.studyUID, '1.2.840.study');
assert.equal(last.seriesUID, '1.2.840.series.2');
assert.equal(last.objectUID, '1.2.840.inst.4');
assert.equal(last.frameNumber, '36');
assert.equal(frame(plan.frames[0].url).frameNumber, undefined);
assert.equal(new Set(plan.frames.map((f) => f.path)).size, plan.frames.length);

// Çok kareli ama 10+ instance: görüntüleyici gibi tek kare say.
const manyInstances = {
  Patient: {
    Studies: [{
      StudyInstanceUID: 'st',
      WadoAddress: 'https://pacs.example/wado?',
      Series: [{
        SeriesInstanceUID: 'se',
        SeriesNumber: 1,
        Instances: Array.from({ length: 10 }, (_, i) => ({
          SOPInstanceUID: `obj-${i}`,
          FrameCount: 20
        }))
      }]
    }]
  }
};
const manyPlan = enumerateWorkItem(manyInstances, { tarih: '01.01.2020', aciklama: 'MR', index: 0 });
assert.equal(manyPlan.frames.length, 10);
assert.equal(manyPlan.frames[0].frameNumber, 1);

// Birden fazla çalışma aynı klasöre düşmemeli.
const multiStudy = {
  Patient: {
    Studies: [
      { StudyInstanceUID: 's1', WadoAddress: '/wado?', Date: '01.01.2020', Series: [{ SeriesInstanceUID: 'a', Instances: [{ SOPInstanceUID: 'a1' }] }] },
      { StudyInstanceUID: 's2', WadoAddress: '/wado?', Date: '01.01.2020', Series: [{ SeriesInstanceUID: 'b', Instances: [{ SOPInstanceUID: 'b1' }] }] }
    ]
  }
};
const multiPlan = enumerateWorkItem(multiStudy, { tarih: '01.01.2020', aciklama: 'CT', index: 0 });
assert.equal(multiPlan.frames.length, 2);
assert.equal(multiPlan.studies.length, 2);
assert.notEqual(multiPlan.studies[0].folder, multiPlan.studies[1].folder);
assert.match(multiPlan.studies[1].folder, /_calisma-02$/);

// Eksik bilgiler uyarı üretmeli, çökmemeli.
const broken = enumerateWorkItem({
  Patient: {
    Studies: [
      { WadoAddress: '/wado?', Series: [] },
      { StudyInstanceUID: 'ok', Series: [{ SeriesInstanceUID: 'se', Instances: [{ SOPInstanceUID: 'o' }] }] }
    ]
  }
}, { index: 0 });
assert.ok(broken.warnings.length >= 2);
assert.equal(broken.frames.length, 0);

// Aynı seri adları çakışmamalı.
const duplicateSeries = {
  Patient: {
    Studies: [{
      StudyInstanceUID: 'st',
      WadoAddress: '/wado?',
      Series: [
        { SeriesInstanceUID: 'a', SeriesNumber: 1, Description: 'AXIAL', Instances: [{ SOPInstanceUID: 'a1' }] },
        { SeriesInstanceUID: 'b', SeriesNumber: 1, Description: 'AXIAL', Instances: [{ SOPInstanceUID: 'b1' }] }
      ]
    }]
  }
};
const dupPlan = enumerateWorkItem(duplicateSeries, { index: 0 });
assert.equal(dupPlan.frames.length, 2);
assert.notEqual(dupPlan.frames[0].path, dupPlan.frames[1].path);

// Özel origin parametresi görev URL'sine aktarılmalı.
const customOriginPlan = enumerateWorkItem(
  multiStudy,
  { tarih: '01.01.2020', aciklama: 'CT', index: 0 },
  'https://custom-pacs.example'
);
assert.ok(customOriginPlan.frames[0].url.startsWith('https://custom-pacs.example/wado?'));

// PrimaryOrderRelation === "CURRENT" filtresi + seenStudyUids tekilleştirmesi.
const seenUids = new Set();
const withHistory = {
  Patient: {
    Studies: [
      { StudyInstanceUID: 'old-study', PrimaryOrderRelation: 'PRIOR', WadoAddress: '/w?', Series: [{ SeriesInstanceUID: 's0', Instances: [{ SOPInstanceUID: 'o0' }] }] },
      { StudyInstanceUID: 'cur-study', PrimaryOrderRelation: 'CURRENT', WadoAddress: '/w?', Series: [{ SeriesInstanceUID: 's1', Instances: [{ SOPInstanceUID: 'o1' }] }] }
    ]
  }
};
const currentPlan = enumerateWorkItem(withHistory, { index: 0, seenStudyUids: seenUids });
assert.equal(currentPlan.studies.length, 1);
assert.equal(currentPlan.studies[0].studyUid, 'cur-study');
assert.equal(seenUids.has('cur-study'), false); // enumerateWorkItem does not mutate seenStudyUids before download succeeds
seenUids.add(currentPlan.studies[0].studyUid);
const dupStudyPlan = enumerateWorkItem(withHistory, { index: 1, seenStudyUids: seenUids });
assert.equal(dupStudyPlan.studies.length, 0);

console.log('✓ Teleradyoloji OTAC, WADO ve klasör planı kontrolleri geçti');

// --- Markdown arşivine entegrasyon ---
const { buildMarkdownArchive } = await import('../src/lib/markdown-builder.js');
const archive = buildMarkdownArchive({
  metadata: { exportedAt: '24.11.2026 20:00', patientName: 'Test Hasta' },
  profil: { adSoyad: 'Test Hasta' },
  visits: [],
  radyoloji: [{
    tarih: '02.05.2016 21:53',
    aciklama: 'BEYİN SEKMANS CT',
    hastane: 'Test Hastanesi',
    accession: 'ACC1',
    rapor: 'Normal.',
    images: {
      folder: 'radyoloji_goruntuleri/2016-05-02_BEYIN_SEKMANS_CT_01',
      folders: [
        'radyoloji_goruntuleri/2016-05-02_BEYIN_SEKMANS_CT_01',
        'radyoloji_goruntuleri/2016-05-02_BEYIN_SEKMANS_CT_01_calisma-02'
      ],
      count: 36,
      seriesCount: 4,
      bytes: 2 * 1024 * 1024,
      failed: 0
    }
  }],
  radyolojiImages: { studyCount: 1, seriesCount: 4, frameCount: 36, bytes: 2 * 1024 * 1024, failedFrames: 0, errors: [] }
});
assert.equal(archive.stats.radImageCount, 36);
assert.ok(archive.files.has('radyoloji_goruntuleri/00-dizin.md'));
assert.match(archive.files.get('03-radyoloji.md'), /36 kesit/);
assert.match(archive.files.get('03-radyoloji.md'), /_calisma-02\//);
assert.match(archive.files.get('radyoloji_goruntuleri/00-dizin.md'), /2016-05-02_BEYIN_SEKMANS_CT_01/);
assert.match(archive.files.get('radyoloji_goruntuleri/00-dizin.md'), /_calisma-02\//);
assert.match(archive.files.get('README.md'), /radyoloji_goruntuleri\/00-dizin\.md/);
console.log('✓ Radyoloji görüntü dizini Markdown arşivine işlendi');

// --- Enjekte edilen sayfa fonksiyonları (ağsız mock) ---
const realFetch = globalThis.fetch;
const realChrome = globalThis.chrome;
const realDocument = globalThis.document;
const realBtoa = globalThis.btoa;

try {
  const authCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    authCalls.push({ url: String(url), options });
    const u = String(url);
    if (u.includes('CheckOTAC')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          Status: true,
          ResponseValue: { AccessToken: 'TOK', SecondOTAC: 'SECOND' }
        })
      };
    }
    if (u.includes('LoadWorkItemForENabiz')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          Status: true,
          WorkItem: { Patient: { Studies: [{ StudyInstanceUID: 's1', WadoAddress: '/w?', Series: [] }] } }
        })
      };
    }
    throw new Error(`Beklenmeyen URL: ${u}`);
  };

  const auth = await radiologyPageAuth({ base: 'https://tr.example/api/', otac: 'OTAC1' });
  assert.equal(auth.ok, true);
  assert.equal(auth.token, 'Bearer TOK');
  assert.equal(auth.workItem.Patient.Studies.length, 1);
  assert.match(authCalls[0].url, /CheckOTAC\?otac=OTAC1/);
  assert.match(authCalls[1].url, /LoadWorkItemForENabiz\?otac=SECOND/);
  assert.equal(authCalls[1].options.headers.Authorization, 'Bearer TOK');

  // OTAC reddedilirse ok=false ve mesaj dönmeli.
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ Status: false, Message: 'Otac bulunamadı.' })
  });
  const badAuth = await radiologyPageAuth({ base: 'https://tr.example/api/', otac: 'X' });
  assert.equal(badAuth.ok, false);
  assert.match(badAuth.error, /Otac bulunamadı/);

  // --- WADO indirme + mesaj akışı ---
  const messages = [];
  globalThis.chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage(payload, callback) {
        messages.push(payload);
        callback({ ok: true });
      }
    }
  };
  globalThis.btoa = (binary) => Buffer.from(binary, 'binary').toString('base64');
  const jpegBytes = (len = 8) => {
    const u8 = new Uint8Array(len);
    u8[0] = 0xff;
    u8[1] = 0xd8;
    u8[2] = 0xff;
    u8[3] = 0xe0;
    return u8;
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer
  });

  const dl = await radiologyPageDownload({
    runId: 7,
    jobId: 'job-1',
    items: [{ url: 'https://tr.example/wado?...', path: 'radyoloji_goruntuleri/a/001.jpg' }],
    token: 'Bearer TOK',
    concurrency: 1,
    delayMs: 0
  });
  assert.equal(dl.done, 1);
  assert.equal(dl.failed, 0);
  const fileMsg = messages.find((m) => m.type === 'RAD_IMG_FILE');
  assert.ok(fileMsg);
  assert.equal(fileMsg.path, 'radyoloji_goruntuleri/a/001.jpg');
  assert.equal(fileMsg.base64, '/9j/');
  assert.equal(fileMsg.runId, 7);
  assert.ok(messages.some((m) => m.type === 'RAD_IMG_PROGRESS'));

  // 4 MB üzeri görüntü parçalı gönderilmeli.
  messages.length = 0;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => jpegBytes(3_200_000).buffer
  });
  const big = await radiologyPageDownload({
    runId: 7,
    jobId: 'job-2',
    items: [{ url: 'https://tr.example/wado?...', path: 'radyoloji_goruntuleri/a/002.jpg' }],
    token: 'Bearer TOK',
    concurrency: 1,
    delayMs: 0
  });
  assert.equal(big.done, 1);
  const chunks = messages.filter((m) => m.type === 'RAD_IMG_CHUNK');
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].chunkCount, chunks.length);
  assert.equal(chunks.map((c) => c.data).join('').length > 4 * 1024 * 1024, true);

  // HTTP 200 HTML hata sayfası (veya geçersiz imza) reddedilmeli.
  messages.length = 0;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    arrayBuffer: async () => Buffer.from('<html><body>Hata</body></html>').buffer
  });
  const htmlReject = await radiologyPageDownload({
    runId: 7,
    jobId: 'job-html',
    items: [{ url: 'https://tr.example/wado?...', path: 'radyoloji_goruntuleri/a/bad.jpg' }],
    token: 'Bearer TOK',
    concurrency: 1,
    delayMs: 0
  });
  assert.equal(htmlReject.done, 0);
  assert.equal(htmlReject.failed, 1);
  assert.ok(messages.some((m) => m.type === 'RAD_IMG_ERROR'));

  // octet-stream + JPEG ve DICM magic-byte algılama (.jpg / .dcm uzantısı).
  messages.length = 0;
  const dicomBuf = new Uint8Array(140);
  dicomBuf[128] = 0x44; dicomBuf[129] = 0x49; dicomBuf[130] = 0x43; dicomBuf[131] = 0x4d; // DICM
  let octetCall = 0;
  globalThis.fetch = async () => {
    octetCall += 1;
    const data = octetCall === 1 ? jpegBytes(16) : dicomBuf;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/octet-stream' },
      arrayBuffer: async () => data.buffer
    };
  };
  const magicDl = await radiologyPageDownload({
    runId: 7,
    jobId: 'job-magic',
    items: [
      { url: 'https://tr.example/wado?1', path: 'radyoloji_goruntuleri/a/001.jpg' },
      { url: 'https://tr.example/wado?2', path: 'radyoloji_goruntuleri/a/002.jpg' }
    ],
    token: 'Bearer TOK',
    concurrency: 1,
    delayMs: 0
  });
  assert.equal(magicDl.done, 2);
  const magicPaths = messages.filter((m) => m.type === 'RAD_IMG_FILE').map((m) => m.path);
  assert.deepEqual(magicPaths, ['radyoloji_goruntuleri/a/001.jpg', 'radyoloji_goruntuleri/a/002.dcm']);

  // HTTP 429 + Retry-After sonrası ikinci denemede kurtarma.
  messages.length = 0;
  let retryCount = 0;
  globalThis.fetch = async () => {
    retryCount += 1;
    if (retryCount === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '0' : null) },
        arrayBuffer: async () => new ArrayBuffer(0)
      };
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => jpegBytes(12).buffer
    };
  };
  const retryDl = await radiologyPageDownload({
    runId: 7,
    jobId: 'job-retry',
    items: [{ url: 'https://tr.example/wado?retry', path: 'radyoloji_goruntuleri/a/004.jpg' }],
    token: 'Bearer TOK',
    concurrency: 1,
    delayMs: 0,
    retryBaseMs: 5
  });
  assert.equal(retryCount, 2);
  assert.equal(retryDl.done, 1);
  assert.equal(retryDl.failed, 0);

  // Hata durumunda RAD_IMG_ERROR üretilmeli ve credentials === 'same-origin' olmalı.
  messages.length = 0;
  let capturedCreds = '';
  globalThis.fetch = async (_u, opts) => {
    capturedCreds = opts.credentials;
    return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const failedDl = await radiologyPageDownload({
    runId: 7,
    jobId: 'job-3',
    items: [{ url: 'https://tr.example/wado?...', path: 'radyoloji_goruntuleri/a/003.jpg' }],
    token: 'Bearer TOK',
    concurrency: 1,
    delayMs: 0
  });
  assert.equal(capturedCreds, 'same-origin');
  assert.equal(failedDl.failed, 1);
  assert.ok(messages.some((m) => m.type === 'RAD_IMG_ERROR' && m.status === 404));

  // JPEG 406 dönerse otomatik application/dicom yedeği denenmeli.
  messages.length = 0;
  globalThis.fetch = async (u) => {
    if (String(u).includes('contentType=image/jpeg')) {
      return { ok: false, status: 406, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/dicom' },
      arrayBuffer: async () => dicomBuf.buffer
    };
  };
  const fallbackDl = await radiologyPageDownload({
    runId: 7,
    jobId: 'job-dicom-fb',
    items: [{ url: 'https://tr.example/wado?requestType=WADO&contentType=image/jpeg', path: 'radyoloji_goruntuleri/a/005.jpg' }],
    token: 'Bearer TOK',
    concurrency: 1,
    delayMs: 0
  });
  assert.equal(fallbackDl.done, 1);
  assert.equal(messages.find((m) => m.type === 'RAD_IMG_FILE').path, 'radyoloji_goruntuleri/a/005.dcm');

  // Erken devre kesici (fail-fast): 0 başarılı + 6 ardışık hatada 50 kesitin kalanını denememeli.
  messages.length = 0;
  let totalCalls = 0;
  globalThis.fetch = async () => {
    totalCalls += 1;
    return { ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const fiftyItems = Array.from({ length: 50 }, (_, idx) => ({
    url: `https://tr.example/wado?i=${idx}`,
    path: `radyoloji_goruntuleri/a/${idx}.jpg`
  }));
  const circuitDl = await radiologyPageDownload({
    runId: 7,
    jobId: 'job-circuit',
    items: fiftyItems,
    token: 'Bearer TOK',
    concurrency: 1,
    delayMs: 0,
    retryBaseMs: 1
  });
  assert.equal(circuitDl.abortedEarly, true);
  assert.equal(circuitDl.failed, 6);
  assert.equal(totalCalls, 6);

  // --- e-Nabız görüntüleme bağlantısı ---
  globalThis.document = { querySelector: () => ({ value: 'XSRF' }) };
  let postedBody = '';
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(String(url), '/RadyolojikGoruntu/GetGoruntuLinkByOrder');
    postedBody = options.body;
    return {
      ok: true,
      status: 200,
      text: async () => 'https://teleradyoloji.saglik.gov.tr/viewer/#/viewpatient?otac=ABC123'
    };
  };
  const linkRes = await enabizFetchViewerLink('ACC 1');
  assert.equal(linkRes.ok, true);
  assert.match(linkRes.link, /otac=ABC123/);
  assert.match(postedBody, /AccessionNumber=ACC(\+|%20)1/);

  // JSON gövdesinde link dönerse de kabul edilmeli.
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ link: 'https://teleradyoloji.saglik.gov.tr/viewer/#/viewpatient?otac=JSON1' })
  });
  const jsonLink = await enabizFetchViewerLink('ACC2');
  assert.equal(jsonLink.ok, true);
  assert.match(jsonLink.link, /otac=JSON1/);
} finally {
  globalThis.fetch = realFetch;
  globalThis.chrome = realChrome;
  globalThis.document = realDocument;
  globalThis.btoa = realBtoa;
}

console.log('✓ Teleradyoloji sayfa fonksiyonları (OTAC, WADO, mesaj akışı) geçti');
