# Güvenlik Politikası (Security Policy)

## Mimari ve Gizlilik İlkeleri

**e-Nabız Markdown Arşivleyici**, hassas kişisel sağlık verileriyle çalıştığı için şu katı güvenlik sınırları üzerine kuruludur:

1. **Sıfır Sunucu / Sıfır Telemetri:** Herhangi bir harici API, analitik servisi veya üçüncü parti sunucu bağlantısı yoktur. `manifest.json` içindeki `host_permissions` yalnızca iki resmî alan adıyla sınırlıdır: `https://enabiz.gov.tr/*` ve `https://teleradyoloji.saglik.gov.tr/*`. Radyoloji görüntüleri yalnızca kullanıcının kendi e-Nabız görüntüleme bağlantısı (OTAC) ile Sağlık Bakanlığı Teleradyoloji sisteminden indirilir; hiçbir veri dışarıya yüklenmez.
2. **Salt Okunur (Read-Only) Erişim:** İçerik betiği (`src/content.js`) yalnızca kullanıcının kendi aktif oturumu üzerinden mevcut sağlık kayıtlarını okur; e-Nabız üzerinde hiçbir veri oluşturmaz, değiştirmez veya gizlemez.
3. **Çevrimdışı PDF Çözümleme:** PDF metin çıkarımı eklenti içine gömülü (`vendor/pdf.min.mjs` + `vendor/pdf.worker.min.mjs`) Mozilla `pdfjs-dist` ile tamamen tarayıcı belleğinde gerçekleşir.
4. **Kalıcı Depolama Yok:** Çekilen sağlık verileri `chrome.storage` veya `localStorage` içine kaydedilmez; yalnızca işlem süresince bellekte tutulur ve kullanıcı ZIP/klasör olarak indirdikten sonra sekme/panel kapandığında bellekten silinir.

---

## Manifest İzinleri Şeffaflığı

| İzin | Neden Gerekli? |
|---|---|
| `sidePanel` | Eklenti arayüzünü tarayıcının yan panelinde açmak için |
| `tabs` | Açık olan aktif sekmenin `https://enabiz.gov.tr` olup olmadığını kontrol etmek için |
| `scripting` | Eklenti yüklenmeden önce zaten açık olan e-Nabız sekmesine kullanıcı tetiklediğinde `src/content.js` bağlamak için |
| `downloads` | Oluşturulan `enabiz-md-arsiv.zip` dosyasını kullanıcının bilgisayarına indirmek için |
| `https://enabiz.gov.tr/*` | Yalnızca e-Nabız sayfaları ve aynı kökenli veri uç noktalarından okuma yapmak için |
| `https://teleradyoloji.saglik.gov.tr/*` | Yalnızca kullanıcının kendi OTAC bağlantısıyla radyoloji kesitlerini (WADO) indirmek için; görüntü yüklemesi veya üçüncü parti paylaşımı yapılmaz |

---

## Güvenlik Açığı Bildirimi

Bir güvenlik açığı tespit ederseniz, lütfen herkese açık Issue açmak yerine:
- GitHub deposundaki **Security → Advisories → Report a vulnerability** sekmesini kullanın veya doğrudan depo sahibiyle iletişime geçin.
- Bildirimlerinizde **asla** gerçek kişisel sağlık verisi veya kimlik numarası paylaşmayın.
