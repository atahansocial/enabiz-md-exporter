/**
 * Teleradyoloji sayfasında çalışan (chrome.scripting.executeScript ile enjekte
 * edilen) bağımsız fonksiyonlar.
 *
 * ÖNEMLİ: Bu fonksiyonlar hedef sekmeye kendi kaynak kodlarıyla enjekte edilir.
 * Bu yüzden dış kapsamdaki değişkenleri, import'ları veya yardımcıları
 * KULLANAMAZLAR. Yalnızca tarayıcı global'leri ve `cfg`/argümanlar mevcuttur.
 */

/**
 * OTAC -> kısa ömürlü erişim anahtarı -> çalışma (WorkItem) bilgisi.
 * @param {{base: string, otac: string}} cfg
 */
export async function radiologyPageAuth(cfg) {
  const base = cfg.base;
  const ctl = (ms) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return { controller, timer };
  };
  async function requestJson(url, options) {
    const { controller, timer } = ctl(25000);
    try {
      const res = await fetch(url, { ...options, credentials: 'include', signal: controller.signal, referrer: 'https://teleradyoloji.saglik.gov.tr/viewer/' });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { ok: res.ok, status: res.status, json, text };
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    const otacRes = await requestJson(
      `${base}CheckOTAC?otac=${encodeURIComponent(cfg.otac)}`,
      {
        method: 'POST',
        headers: { Accept: 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest' }
      }
    );
    if (!otacRes.ok) {
      return { ok: false, status: otacRes.status, error: `OTAC doğrulama isteği başarısız (HTTP ${otacRes.status})` };
    }
    const otacJson = otacRes.json;
    if (!otacJson || !otacJson.Status) {
      return {
        ok: false,
        status: otacRes.status,
        error: (otacJson && (otacJson.Message || otacJson.message)) || 'OTAC doğrulanamadı (görüntüleme bağlantısının süresi dolmuş olabilir).'
      };
    }
    const rv = otacJson.ResponseValue || otacJson.responseValue || {};
    let token = String(rv.AccessToken || rv.accessToken || otacJson.AccessToken || '');
    if (token && !/^Bearer\s/i.test(token)) token = `Bearer ${token}`;
    const secondOtac = rv.SecondOTAC || rv.SecondOtac || rv.secondOtac || otacJson.SecondOTAC || cfg.otac;

    const workRes = await requestJson(
      `${base}LoadWorkItemForENabiz?otac=${encodeURIComponent(secondOtac)}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json, text/plain, */*',
          'X-Requested-With': 'XMLHttpRequest',
          Authorization: token
        }
      }
    );
    if (!workRes.ok) {
      return { ok: false, status: workRes.status, token, error: `Çalışma bilgisi alınamadı (HTTP ${workRes.status})` };
    }
    const workJson = workRes.json;
    const workItem = workJson?.WorkItem || workJson?.workItem || workJson?.ResponseValue?.WorkItem || workJson?.ResponseValue?.workItem;
    if (!workJson || !workJson.Status || !workItem) {
      return {
        ok: false,
        status: workRes.status,
        token,
        error: (workJson && (workJson.Message || workJson.message)) || 'Çalışma bilgisi boş döndü.'
      };
    }
    return { ok: true, status: 200, token, workItem };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err && err.name === 'AbortError' ? 'Teleradyoloji isteği zaman aşımına uğradı.' : String((err && err.message) || err)
    };
  }
}

/**
 * WADO karelerini indirir; her görüntüyü yan panele mesajla aktarır.
 * @param {{runId:number, jobId:string, items:Array<{url:string,path:string}>, token:string,
 *          concurrency?:number, delayMs?:number}} cfg
 */
export async function radiologyPageDownload(cfg) {
  const { runId, jobId, items, token, concurrency = 3, delayMs = 60 } = cfg;
  const total = items.length;
  let cancelled = false;
  let done = 0;
  let failed = 0;
  let bytes = 0;
  let cursor = 0;
  let lastReport = 0;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const onMessage = (msg) => {
    if (msg && msg.type === 'RAD_IMG_CANCEL' && (msg.jobId == null || msg.jobId === jobId)) {
      cancelled = true;
    }
  };
  try { chrome.runtime.onMessage.addListener(onMessage); } catch {}

  const send = (payload) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(payload, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          resolve(false);
          return;
        }
        resolve(!response || response.ok !== false);
      });
    } catch {
      resolve(false);
    }
  });

  const toBase64 = (buffer) => {
    const view = new Uint8Array(buffer);
    const chunk = 0x8000;
    let binary = '';
    for (let i = 0; i < view.length; i += chunk) {
      binary += String.fromCharCode.apply(null, view.subarray(i, i + chunk));
    }
    return btoa(binary);
  };

  async function downloadOne(item) {
    let attempt = 0;
    let lastStatus = 0;
    let lastError = '';
    while (attempt < 3 && !cancelled) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const res = await fetch(item.url, {
          method: 'GET',
          credentials: 'include',
          referrer: 'https://teleradyoloji.saglik.gov.tr/viewer/',
          headers: {
            Accept: 'image/*,application/dicom;q=0.8,*/*;q=0.5',
            Authorization: token
          },
          signal: controller.signal
        });
        lastStatus = res.status;
        if (res.ok) {
          const buffer = await res.arrayBuffer();
          clearTimeout(timer);
          const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase();
          if (contentType && !contentType.startsWith('image/') && !contentType.includes('application/dicom')) {
            lastError = `Beklenmeyen içerik türü: ${contentType}`;
            break;
          }
          if (buffer && buffer.byteLength > 0) {
            return { ok: true, buffer, contentType };
          }
          lastError = 'Boş görüntü yanıtı';
        } else {
          clearTimeout(timer);
          lastError = `HTTP ${res.status}`;
          if (res.status === 401 || res.status === 403 || res.status === 404) break;
        }
      } catch (err) {
        clearTimeout(timer);
        lastError = err && err.name === 'AbortError' ? 'Zaman aşımı' : String((err && err.message) || err);
      }
      attempt += 1;
      if (attempt < 3 && !cancelled) await sleep(900 + Math.random() * 500);
    }
    return { ok: false, status: lastStatus, error: lastError };
  }

  async function worker() {
    while (!cancelled) {
      const index = cursor;
      cursor += 1;
      if (index >= total) return;
      const item = items[index];
      const result = await downloadOne(item);
      if (cancelled) return;

      if (result.ok) {
        bytes += result.buffer.byteLength;
        const base64 = toBase64(result.buffer);
        const isDicom = /application\/dicom/i.test(result.contentType || '');
        const filePath = isDicom ? item.path.replace(/\.jpg$/i, '.dcm') : item.path;
        const chunkSize = 4 * 1024 * 1024;
        let accepted = true;
        if (base64.length <= chunkSize) {
          accepted = await send({
            type: 'RAD_IMG_FILE', runId, jobId, path: filePath, base64, done: done + 1, total, bytes
          });
        } else {
          const chunkCount = Math.ceil(base64.length / chunkSize);
          for (let c = 0; c < chunkCount && accepted; c += 1) {
            accepted = await send({
              type: 'RAD_IMG_CHUNK',
              runId,
              jobId,
              path: filePath,
              chunkIndex: c,
              chunkCount,
              data: base64.slice(c * chunkSize, (c + 1) * chunkSize),
              done: done + 1,
              total,
              bytes
            });
          }
        }
        if (!accepted) {
          cancelled = true;
          return;
        }
        done += 1;
      } else {
        failed += 1;
        const accepted = await send({
          type: 'RAD_IMG_ERROR',
          runId,
          jobId,
          path: item.path,
          status: result.status,
          error: result.error,
          done,
          total
        });
        if (!accepted) {
          cancelled = true;
          return;
        }
      }

      const now = Date.now();
      if (now - lastReport > 250 || done + failed === total) {
        lastReport = now;
        await send({
          type: 'RAD_IMG_PROGRESS',
          runId,
          jobId,
          done,
          failed,
          total,
          bytes,
          label: `Radyoloji görüntüleri: ${done + failed}/${total} kesit · ${(bytes / 1048576).toFixed(1)} MB`
        });
      }
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  } finally {
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch {}
  }
  return { ok: true, done, failed, bytes, cancelled };
}

/**
 * e-Nabız sekmesinde çalışır: erişim numarasından taze görüntüleyici
 * bağlantısını üretir.
 */
export async function enabizFetchViewerLink(accession) {
  async function readToken() {
    const domToken = document.querySelector('input[name="__RequestVerificationToken"]')?.value || '';
    if (domToken) return domToken;
    try {
      const res = await fetch('/Home/Ziyaretlerim', { credentials: 'include' });
      const html = await res.text();
      return new DOMParser()
        .parseFromString(html, 'text/html')
        .querySelector('input[name="__RequestVerificationToken"]')?.value || '';
    } catch {
      return '';
    }
  }

  const token = await readToken();
  if (!token) return { ok: false, status: 0, error: 'e-Nabız XSRF anahtarı bulunamadı.' };
  try {
    const res = await fetch('/RadyolojikGoruntu/GetGoruntuLinkByOrder', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'XSRF-TOKEN': token,
        'RequestVerificationToken': token
      },
      body: new URLSearchParams({ AccessionNumber: accession }).toString()
    });
    const raw = (await res.text()).trim();
    if (res.redirected && /^https?:\/\//i.test(res.url) && !/^https?:\/\//i.test(raw)) {
      return { ok: true, status: res.status, link: res.url };
    }
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    if (raw.length > 2000) return { ok: false, status: res.status, error: 'Beklenmeyen yanıt (URL değil).' };

    let link = raw;
    if (/^\{/.test(raw)) {
      try {
        const json = JSON.parse(raw);
        link = String(json.link || json.url || json.Link || json.Url || json.redirectUrl || json.viewerUrl || '');
      } catch {}
    }
    if (!/^https?:\/\//i.test(link)) {
      const embedded = raw.match(/https?:\/\/[^\s"'<>]+/);
      link = embedded ? embedded[0] : '';
    }
    if (!link) {
      return { ok: false, status: res.status, error: raw ? 'Görüntüleyici bağlantısı döndürmedi.' : 'Bu çalışma için görüntü yok.' };
    }
    return { ok: true, status: res.status, link };
  } catch (err) {
    return { ok: false, status: 0, error: String((err && err.message) || err) };
  }
}
