/**
 * Teleradyoloji (e-Nabız görüntüleyici) yardımcıları.
 *
 * e-Nabız "Radyolojik Görüntülerim" kartındaki `openImageLink('<accession>')`
 * değeri POST `/RadyolojikGoruntu/GetGoruntuLinkByOrder` ile
 * `https://teleradyoloji.saglik.gov.tr/viewer/#/viewpatient?otac=...` benzeri
 * bir bağlantıya dönüşür. Görüntüleyici bu OTAC'ı `CheckOTAC` ile kısa ömürlü
 * bir erişim anahtarına çevirir; görüntüler WADO istekleriyle JPEG olarak gelir.
 *
 * Bu modül ağa çıkmaz; yalnızca URL/klasör üretimi ve yanıt şekli normalizasyonu
 * yapar. Böylece Node testlerinde doğrulanabilir.
 */

export const TELERADYOLOJI_ORIGIN = 'https://teleradyoloji.saglik.gov.tr';
export const TELERADYOLOJI_API_BASE = `${TELERADYOLOJI_ORIGIN}/viewerbackend/viewerapi/`;
export const RAD_IMAGE_ROOT = 'radyoloji_goruntuleri';

const TR_MAP = {
  ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u',
  Ç: 'C', Ğ: 'G', İ: 'I', Ö: 'O', Ş: 'S', Ü: 'U'
};

const first = (...values) => {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return '';
};

export function slugifyTr(input, maxLen = 48) {
  const cleaned = String(input == null ? '' : input)
    .replace(/[çğıöşüÇĞİÖŞÜ]/g, (ch) => TR_MAP[ch] || ch)
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.slice(0, maxLen).replace(/_+$/g, '') || 'kayit';
}

export function isoDateFromTr(input) {
  const text = String(input == null ? '' : input);
  const tr = text.match(/(\d{2})[.\/-](\d{2})[.\/-](\d{4})/);
  if (tr) return `${tr[3]}-${tr[2]}-${tr[1]}`;
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[0] : 'tarihsiz';
}

/** `#/viewpatient?otac=...`, `?otac=...&x=1` ve `&otac=...` biçimlerini destekler. */
export function extractOtac(link) {
  const text = String(link == null ? '' : link);
  const match = text.match(/[?&#]otac=([^&\s#]+)/i);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** WADO adresi göreli gelirse görüntüleyici origin'ine bağlar. */
export function normalizeWadoBase(address, origin = TELERADYOLOJI_ORIGIN) {
  const raw = String(address == null ? '' : address).trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${origin.replace(/\/+$/, '')}/${raw.replace(/^\/+/, '')}`;
}

export function buildWadoUrl(
  {
    base,
    studyUid,
    seriesUid,
    objectUid,
    frameNumber = null,
    contentType = 'image/jpeg',
    origin = TELERADYOLOJI_ORIGIN
  },
  originOverride
) {
  const normalized = normalizeWadoBase(base, originOverride || origin);
  if (!normalized) return '';
  const sep = /[?&]$/.test(normalized) ? '' : normalized.includes('?') ? '&' : '?';
  const parts = [
    'requestType=WADO',
    `studyUID=${encodeURIComponent(studyUid)}`,
    `seriesUID=${encodeURIComponent(seriesUid)}`,
    `objectUID=${encodeURIComponent(objectUid)}`,
    `contentType=${contentType}`
  ];
  // Görüntüleyici tek kareli instance'larda frameNumber parametresini hiç göndermiyor.
  if (frameNumber != null) parts.push(`frameNumber=${encodeURIComponent(String(frameNumber))}`);
  return `${normalized}${sep}${parts.join('&')}`;
}

function normalizeWorkItem(workItem) {
  const root = workItem || {};
  const patient = root.Patient || root.patient || {};
  const rawStudies = patient.Studies || patient.studies || root.Studies || root.studies || [];
  if (!Array.isArray(rawStudies)) return [];
  // LoadWorkItemForENabiz tüm geçmiş çalışmaları da Patient.Studies içinde döndürebilir;
  // yalnızca geçerli isteme ait ("CURRENT") çalışmaları seç (yoksa tümünü koru).
  const currentOnly = rawStudies.filter(
    (s) => String(s?.PrimaryOrderRelation || s?.primaryOrderRelation || '').toUpperCase() === 'CURRENT'
  );
  return currentOnly.length > 0 ? currentOnly : rawStudies;
}

function uniqueName(base, used) {
  let name = base;
  let counter = 2;
  while (used.has(name)) {
    name = `${base}_${counter}`;
    counter += 1;
  }
  used.add(name);
  return name;
}

/**
 * Görüntüleyicinin çalışma (WorkItem) yanıtını indirilebilir karelere çevirir.
 *
 * Klasör düzeni:
 *   radyoloji_goruntuleri/<tarih>_<açıklama>_<sıra>/<seri>/{001.jpg, 002.jpg...}
 *
 * @returns {{frames: Array<object>, studies: Array<object>, warnings: string[]}}
 */
export function enumerateWorkItem(workItem, meta = {}, origin = TELERADYOLOJI_ORIGIN) {
  const studies = normalizeWorkItem(workItem);
  const warnings = [];
  const frames = [];
  const studySummaries = [];
  const studyFolders = new Set();

  const recordDate = isoDateFromTr(meta.tarih);
  const recordSlug = slugifyTr(meta.aciklama || meta.description || 'radyoloji', 44);
  const recordOrdinal = meta.index != null ? String(Number(meta.index) + 1).padStart(2, '0') : '01';

  studies.forEach((study, studyIndex) => {
    const studyUid = String(first(
      study.StudyInstanceUID,
      study.StudyInstanceUid,
      study.studyInstanceUid,
      study.StudyUID,
      study.StudyUid
    ));
    const wadoBase = String(first(study.WadoAddress, study.WadoAdress, study.wadoAddress));
    const studyDate = isoDateFromTr(first(study.StudyDate, study.Date, study.StudyDateAsString, meta.tarih));
    const studyDesc = first(study.Description, study.StudyDescription, meta.aciklama, 'radyoloji');
    const datePart = recordDate !== 'tarihsiz' ? recordDate : studyDate;
    const descPart = recordSlug !== 'kayit' ? recordSlug : slugifyTr(studyDesc, 44);
    const suffix = studies.length > 1 ? `_calisma-${String(studyIndex + 1).padStart(2, '0')}` : '';
    const studyFolder = uniqueName(
      `${RAD_IMAGE_ROOT}/${datePart}_${descPart}_${recordOrdinal}${suffix}`,
      studyFolders
    );

    if (!studyUid) {
      warnings.push(`${studyDesc}: çalışma kimliği (StudyInstanceUID) yok, görüntüler atlandı.`);
      return;
    }
    if (meta.seenStudyUids instanceof Set && meta.seenStudyUids.has(studyUid)) {
      return;
    }
    if (!wadoBase) {
      warnings.push(`${studyDesc}: WADO adresi yok, görüntüler atlandı.`);
      return;
    }

    const seriesList = Array.isArray(study.Series) ? study.Series : [];
    const seriesFolders = new Set();
    let studyFrameCount = 0;
    let studySeriesCount = 0;

    seriesList.forEach((series, seriesIndex) => {
      const seriesUid = String(first(
        series.SeriesInstanceUID,
        series.SeriesInstanceUid,
        series.seriesInstanceUid,
        series.SeriesUID,
        series.SeriesUid
      ));
      const seriesNumber = first(series.SeriesNumber, series.SeriesNo, series.Number, seriesIndex + 1);
      const seriesDesc = first(series.Description, series.SeriesDescription, series.Modality, 'seri');
      const seriesNumberLabel = slugifyTr(String(seriesNumber), 10).padStart(2, '0');
      const seriesFolder = uniqueName(
        `${studyFolder}/seri-${seriesNumberLabel}_${slugifyTr(seriesDesc, 40)}`,
        seriesFolders
      );

      if (!seriesUid) {
        warnings.push(`${studyDesc} / ${seriesDesc}: seri kimliği yok, atlandı.`);
        return;
      }

      const instances = Array.isArray(series.Instances) ? series.Instances : [];
      const sopClassUid = String(first(series.SopClassUid, series.SOPClassUID, series.sopClassUid));
      const forceDicom = sopClassUid === '1.2.840.10008.5.1.4.1.1.104.1';
      // Görüntüleyici, çok kareli (multiframe) serileri yalnızca az sayıda
      // instance varsa ve kare sayısı 500'ün altındaysa açıyor; aynı davranış.
      const expandMultiframe = instances.length < 10 && !forceDicom;
      let seriesFrameCount = 0;

      instances.forEach((instance) => {
        const objectUid = String(first(
          instance.SOPInstanceUID,
          instance.SopInstanceUID,
          instance.sopInstanceUid,
          instance.SOPInstanceUid,
          instance.ObjectUID,
          instance.ObjectUid
        ));
        if (!objectUid) {
          warnings.push(`${studyDesc} / ${seriesDesc}: kesit kimliği yok, atlandı.`);
          return;
        }
        const rawFrameCount = Number(first(instance.FrameCount, instance.FrameCountValue, 1)) || 1;
        const framesInInstance =
          expandMultiframe && rawFrameCount > 1 && rawFrameCount < 500 ? rawFrameCount : 1;
        for (let f = 0; f < framesInInstance; f += 1) {
          seriesFrameCount += 1;
          studyFrameCount += 1;
          const frameNumber = f + 1;
          const ext = forceDicom ? 'dcm' : 'jpg';
          frames.push({
            path: `${seriesFolder}/${String(seriesFrameCount).padStart(3, '0')}.${ext}`,
            url: buildWadoUrl({
              base: wadoBase,
              studyUid,
              seriesUid,
              objectUid,
              frameNumber: framesInInstance > 1 ? frameNumber : null,
              contentType: forceDicom ? 'application/dicom' : 'image/jpeg'
            }, origin),
            studyIndex,
            seriesIndex,
            seriesNumber: Number(seriesNumber) || seriesIndex + 1,
            seriesLabel: String(seriesDesc),
            studyUid,
            seriesUid,
            objectUid,
            frameNumber,
            sequence: frames.length + 1
          });
        }
      });

      if (seriesFrameCount === 0) {
        warnings.push(`${studyDesc} / ${seriesDesc}: indirilecek kesit bulunamadı.`);
        return;
      }
      studySeriesCount += 1;
    });

    if (studyFrameCount === 0) {
      warnings.push(`${studyDesc}: indirilecek görüntü bulunamadı.`);
      return;
    }

    studySummaries.push({
      folder: studyFolder,
      studyUid,
      seriesCount: studySeriesCount,
      frameCount: studyFrameCount,
      description: String(studyDesc)
    });
  });

  return { frames, studies: studySummaries, warnings };
}
