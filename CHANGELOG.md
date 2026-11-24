# Değişiklik Günlüğü (Changelog)

Bu proje [SemVer](https://semver.org/) sürümleme kurallarını takip eder.

## [1.3.1] - 2026-11-24

### Düzeltmeler & İyileştirmeler
- **Radyoloji İndirmesi Varsayılan Kapalı (`src/sidepanel.html`)**: "Radyoloji görüntülerini de indir" seçeneği artık varsayılan olarak kapalıdır; yalnızca kullanıcı istediğinde GB seviyesinde görsel indirimi başlatılır.
- **Sıkıştırılmış Dosyalarda ZIP Hız Optimizasyonu (`src/lib/zip.js`)**: `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.zip`, `.gz` ve `.pdf` dosyaları gereksiz deflate denemesi yapılmadan doğrudan `STORE` (yöntem `0`) ile paketlenir.
- **WADO Origin & Çoklu Çalışma Klasörleri (`src/lib/teleradyoloji.js`, `src/sidepanel.js`, `src/lib/markdown-builder.js`)**: `buildWadoUrl` özel `origin` parametresini iletecek şekilde düzeltildi; tek kayıttan birden fazla çalışma klasörü oluştuğunda hepsi `03-radyoloji.md` ve `00-dizin.md` içinde listelenir.
- **Güvenilirlik, Magic-Byte & Backoff (`src/lib/teleradyoloji-page.js`)**:
  - `enabizFetchViewerLink` çağrılarına `AbortController` zaman aşımı (15 sn / 25 sn) eklendi.
  - WADO yanıtlarında `Content-Type` yanında JPEG/PNG/GIF/WebP ve DICOM (`DICM`) magic-byte doğrulaması uygulanır; HTML hata sayfaları reddedilir, `application/octet-stream` altındaki geçerli görüntüler kabul edilir.
  - `Retry-After` başlığı + gerçek üstel artan bekleme (backoff) eklendi; paralel worker ilerleme sayacı yarışı giderildi.
- **Hız Seçici & Port Yarışı Düzeltmesi (`src/sidepanel.js`)**: "Hızlı / Dengeli / Yavaş" hız seçimi artık radyoloji görüntü indirme eşzamanlılığına ve gecikmesine yansır; görüntü indirme boyunca watchdog canlı tutulur ve `EXPORT_COMPLETE` sonrası `port.onDisconnect` yarışı önlendi.

## [1.3.0] - 2026-11-24

### Yeni Özellik
- **Radyoloji Görüntüleri (tüm seriler/kesitler)**: Ayarlara "Radyoloji görüntülerini de indir" seçeneği eklendi. e-Nabız'daki her radyoloji çalışması için taze bir Teleradyoloji görüntüleme bağlantısı (OTAC) alınır; `CheckOTAC` ile kısa ömürlü erişim anahtarına çevrilir ve WADO servisinden **tüm serilerin tüm kesitleri orijinal çözünürlükte JPEG** olarak indirilir.
- **Görüntü Arşivi Düzeni**: Kesitler `radyoloji_goruntuleri/<tarih>_<açıklama>_<sıra>/seri-XX_<seri>/001.jpg` biçiminde kaydedilir. `00-dizin.md` çalışma/seri/kesit sayılarını ve boyutları listeler; `03-radyoloji.md` her çalışmanın altına görüntü klasörünü bağlar.
- **Arka Plan Görüntüleyici Sekmesi**: İndirme, e-Nabız oturumundan bağımsız çalışan geçici bir Teleradyoloji sekmesinde yapılır; iş bitince sekme otomatik kapatılır. İptal (Durdur) görüntü indirmeyi de durdurur.
- **Dayanıklılık**: Kesitler 3 eşzamanlı istek, 30 sn zaman aşımı ve 429/5xx'te artan bekleme ile indirilir; büyük görüntüler parçalı aktarılır. Başarısız kesitler arşiv uyarılarında raporlanır, indirme kalan bölümlerle devam eder.
- **UI**: Sonuç ekranına "Radyo. Kesiti" istatistiği eklendi; binlerce JPEG dosya ağacı yerine tek satırlık `radyoloji_goruntuleri/ (N görüntü)` özeti gösterilir ve dizin dosyası önizlenebilir.

### Notlar
- Bu özellik varsayılan olarak açıktır. İstenmeyen durumlarda ayarlardan kapatılabilir; kapatıldığında davranış v1.2.1 ile aynıdır.
- Görüntü indirme sırasında sekme kapatılmamalıdır; yan panel açık kalmalıdır. Büyük arşivlerde ZIP oluşturma süresi ve bellek kullanımı artar.

## [1.2.1] - 2026-11-24

### Arayüz
- **Uygulama ikonu yenilendi**: 16/48/128 px simgeler artık Google Material Design Icons setindeki `health_and_safety` ikonundan üretiliyor (marka kırmızısı zemin + beyaz glif). Kaynak ve lisans bilgisi `icons/README.txt` içinde.
- **Ayarlar açılır oku**: Metin karakteri (`▾`) yerine Material Design `expand_more` SVG ikonu kullanılıyor; açık/kapalı durumda 180 derece dönüyor.

## [1.2.0] - 2026-11-24

### Yeni Özellik
- **İstek Hızı Seçici**: Yan panel ayarlarına "Hızlı (120 ms) / Dengeli (200 ms, varsayılan) / Yavaş (350 ms)" seçeneği eklendi. Seçim `paceRequest()` üzerinden tüm isteklerin temposunu belirler; "Yavaş" mod 429, sunucu hatası ve oturum düşmesi riskini azaltır.
- **Taban Gecikme Korunumu**: Uyarlanabilir hız artık kullanıcının seçtiği taban değerin altına inmiyor (`relaxDelay`), sunucu hatasında üst sınır 1000 ms'ye çıkarıldı.

## [1.1.2] - 2026-11-24

### Güvenilirlik
- **Küresel İstek Temposu (`paceRequest`)**: Eşzamanlı toplu istekler (ziyaret detayları 4'lü, tahlil PDF'leri 3'lü) artık tek bir slot kuyruğuna giriyor. Her istek arasında `currentDelayMs` (120 ms) + rastgele 0–60 ms jitter bekleniyor; böylece sunucuya aynı anda 4 istek birden patlamıyor. `currentDelayMs` 429/5xx'te otomatik yükseldiği için tempo sunucu baskı altındayken kendiliğinden yavaşlıyor.
- **`Retry-After` Desteği**: 429/5xx yanıtlarında retry beklemesi sabit 600 ms yerine `Retry-After` başlığına (saniye veya HTTP tarihi) uyuyor; başlık yoksa 700 ms + jitter kullanılıyor (üst sınır 15 sn).
- **Tutarlı Reçete Detay Gecikmesi**: Reçete detay isteklerindeki sabit `sleep(80)` kaldırıldı; tempo artık merkezî `paceRequest()` üzerinden yönetiliyor.

## [1.1.1] - 2026-11-24

### Hata Düzeltmeleri
- **`ReferenceError: receteNo is not defined` (`src/content.js`)**: Reçetelerim çapraz kontrolünde ekstra reçete kaydı oluşturulurken kullanılan nesne kısaltması (`receteNo,`) tanımsız bir değişkene işaret ediyordu; doğru değişken `recNo` ile eşlendi (`receteNo: recNo`). Bu hata, ziyaret detaylarında bulunmayan en az bir reçete olduğunda dışa aktarımı 4. aşamada durduruyor ve sonraki tüm bölümlerin (tahliller, radyoloji, raporlar, PDF'ler, aşılar) kaybolmasına neden oluyordu.

## [1.1.0] - 2026-11-24

### Güvenilirlik & Mimari (İyileştirmeler)
- **Kalıcı Port Akışı & `runId` İzolasyonu (`src/sidepanel.js`, `src/content.js`)**: Kısa ömürlü `sendMessage` yerine `chrome.tabs.connect('enabiz-export')` uzun ömürlü portu kullanıldı. Tüm ilerleme, PDF parçaları ve sonuç mesajları `runId` ile doğrulanır; iptal/yeniden başlatma yarış koşulları engellendi.
- **Zaman Aşımı, Watchdog & Uyarlanabilir Hız**: Her HTTP isteğinde 25 saniyelik `AbortController` zaman aşımı, yan panelde 60 saniyelik hareketsizlik watchdog'u (10 saniyede bir `HEARTBEAT`), sekmeyi kapatmaya karşı `beforeunload` uyarısı ve hata/429 durumlarında uyarlanabilir gecikme (`120ms`–`700ms`) eklendi.
- **Kısmi Başarı Uyarıları (`README.md`, Yan Panel)**: Hiçbir bölüm hatası artık sessizce yutulmuyor. Her bölümün HTTP durumu ve kayıt sayısı `README.md` içindeki `## Dışa Aktarım Doğrulama Özeti` tablosuna işlenir; hata varsa hem `> [!WARNING]` bloğu hem yan panelde uyarı rozeti gösterilir.
- **Aşamalı PDF İşleme (Bellek Optimizasyonu)**: Rapor ve tahlil PDF'leri indirme sonunda topluca bellekte tutulmak yerine geldikçe sırayla işlenir ve `base64` tamponları hemen serbest bırakılır.
- **Bağımsız PDF Ayarı**: `Orijinal PDF'leri ekle` seçeneği artık `PDF içeriğini çıkar` seçeneğinden bağımsız çalışır.
- **Birleştirilmiş İlerleme Sayacı**: İçerik betiği ve yan panel tek `TOTAL_STAGES = 10` sabiti üzerinde senkronize edildi.

### Veri & Ayrıştırma Doğruluğu
- **Paylaşılan Başlık Eşlemeli DOM Ayrıştırıcı (`src/lib/dom-parsers.js`)**: Ziyaretler, reçeteler (7 ve 8 sütunlu satırlar dahil), tahlil panelleri, raporlar, hastalıklar ve profil ayrıştırması bağımsız, test edilebilir modüle çıkarıldı. İlaç, rapor ve hastalık tabloları sabit sütun indeksleri yerine Türkçe başlık eşlemesi (`mapHeaderIndices`) kullanır.
- **Güvenli Markdown Çitleri & Kronolojik Sıralama**: `04-raporlar.md` içinde üçlü backtick (```` ``` ````) içeren rapor metinleri `safeCodeFence` ile korunur; `dateSortKey` ISO `yyyy-mm-dd` tarihlerini destekler; `oldestVisit`/`newestVisit` ziyaretler sırasız gelse bile doğru hesaplanır.
- **Temizlik & İstatistik Doğruluğu**: `formatHastalikRow` içindeki tekrarlı `detayArgs` gürültüsü ayıklandı; `cleanOfficialReportText` ilaç prospektüsü/barkod prose satırlarını koruyacak şekilde sıkılaştırıldı; `raporPdfExtractedCount` gerçekten metin çıkarılabilen PDF'leri sayar.

### Erişilebilirlik, Arayüz & Testler
- **Yan Panel Erişilebilirliği & Koyu Tema**: Dosya ağacı satırları klavyeyle gezilebilir `<button>` elemanlarına dönüştürüldü, modalda `Escape` + odak geri yükleme eklendi, `prefers-color-scheme: dark` desteği ve dinamik yıl açılır listeleri eklendi. Dinamik HTML basımında `innerHTML` tamamen kaldırıldı.
- **Manifest & Altyapı**: `minimum_chrome_version: "119"` tanımlandı, `package.json` (`npm test`) eklendi, `tests/verify-builder.mjs` genişletildi ve `tests/verify-parsers.mjs` eklendi.

## [1.0.0] - 2026-11-24

- İlk açık kaynaklı sürüm: %100 yerel e-Nabız Markdown arşivleyici (Manifest V3 yan panel, gömülü `pdfjs-dist`, bağımlılıksız UTF-8/Deflate ZIP üretici ve sentetik doğrulama testleri).
