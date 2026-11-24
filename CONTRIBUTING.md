# Katkıda Bulunma Rehberi (Contributing Guide)

**e-Nabız Markdown Arşivleyici**'ye katkıda bulunmak istediğiniz için teşekkürler! Bu proje tamamen açık kaynaklıdır ve tüm geliştiricilerin, araştırmacıların ve kullanıcıların katkılarına açıktır.

> **English Summary:** Contributions are very welcome! No build step is required (`pdfjs-dist` is pre-bundled in `vendor/`). Load the folder via `chrome://extensions` → **Load unpacked** (Chrome 119+), run `npm test` (requires Node 20+) before opening a PR, and **never** commit or paste any real patient/health/TCKN data into issues or pull requests.

---

## 1. Gizlilik Kuralı (En Önemli Kural)

- Issue, Pull Request, ekran görüntüsü veya test dosyalarında **asla** gerçek T.C. Kimlik Numarası, hasta adı, hastane/doktor bilgisi, gerçek PDF dosyası veya kişisel sağlık verisi paylaşmayın.
- Tüm yeni testler yalnızca **sentetik / anonim** örnek verilerle (`tests/verify-builder.mjs`) yazılmalıdır.
- Eklenti her zaman **%100 yerel ve salt okunur (read-only)** kalmalıdır: dış sunucu çağrısı veya e-Nabız üzerinde yazma/silme isteği (`POST` ekleme, gizleme vb.) ekleyen PR'lar kabul edilmez.

---

## 2. Geliştirme Ortamı Kurulumu

Proje sıfır derleme (zero-build) yapısındadır; `npm install` veya bundler gerekmez:

1. Repoyu forklayın ve klonlayın:
   ```bash
   git clone https://github.com/atahansocial/enabiz-md-exporter.git
   cd enabiz-md-exporter
   ```
2. Chrome / Edge / Brave / Arc tarayıcısında **`chrome://extensions`** adresini açın.
3. Sağ üstten **Geliştirici modu**nu aktif edin ve **Paketlenmemiş öğe yükle (Load unpacked)** ile repo klasörünü seçin.
4. Kodda yaptığınız değişiklikten sonra uzantılar sayfasından **Yenile (Reload)** ikonuna basmanız yeterlidir.

---

## 3. Testleri Çalıştırma

Değişikliklerinizi göndermeden önce aşağıdaki komutların hatasız geçtiğinden emin olun:

```bash
# Sözdizimi kontrolleri
node --check src/background.js
node --check src/lib/dom-parsers.js
node --check src/content.js
node --check src/sidepanel.js
node --check src/lib/pdf-extractor.js
node --check src/lib/markdown-builder.js
node --check src/lib/zip.js
node --check tests/verify-builder.mjs
node --check tests/verify-parsers.mjs

# Sentetik arşiv, DOM ayrıştırıcı & ZIP bütünlük testleri
npm test
```

---

## 4. e-Nabız Arayüz / Endpoint Değişikliklerini Bildirme

e-Nabız tarafında bir sayfa veya tablo yapısı değişirse:
1. İlgili sayfanın HTML yapısından **tüm kişisel bilgilerinizi silerek** yalnızca etiket/sınıf (`class`, `id`, `table`, `onclick` imza örneği) yapısını paylaşın.
2. Tarayıcı konsolundaki (DevTools Console) hata mesajını kişisel bilgi içermeyecek şekilde [Hata Bildirimi](.github/ISSUE_TEMPLATE/bug_report.md) şablonuyla açın.

---

## 5. Commit ve Pull Request Kuralları

- Anlamlı, kısa commit mesajları kullanın (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`):
  - Örnek: `fix: handle updated tahlil accordion selector`
  - Örnek: `feat: add support for dental procedures section`
- Mümkünse tek bir PR'da tek bir konuya odaklanın ve PR şablonundaki kontrol listesini doldurun.
