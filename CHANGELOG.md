# Değişiklik Günlüğü (Changelog)

Bu proje [SemVer](https://semver.org/) sürümleme kurallarını takip eder.

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
