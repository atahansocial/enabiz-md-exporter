# e-Nabız Markdown Arşivleyici (Chrome / Chromium Eklentisi)

Tüm e-Nabız sağlık geçmişinizi **%100 yerel olarak** kendi tarayıcınız içinde temiz, düzenli ve yapay zeka dostu **Markdown (`enabiz-md-arsiv/`)** klasör yapısına dönüştürüp tek tıkla **ZIP** veya **klasör** olarak indirmenizi sağlayan açık kaynaklı Manifest V3 yan panel eklentisidir.

## Gizlilik ve Güvenlik Garantisi

- **Sunucusuz ve Sıfır Telemetri:** Hiçbir sağlık verisi üçüncü parti bir sunucuya gönderilmez, analiz edilmez veya dışarı aktarılmaz. Tüm kod salt HTML/JS/CSS olarak denetlenebilir.
- **Salt Okunur (Read-Only):** Yalnızca kendi aktif `https://enabiz.gov.tr` oturumunuz üzerinden mevcut verileri okur; e-Nabız hesabınızda hiçbir kayıt eklemez, değiştirmez veya silmez.
- **Çevrimdışı PDF Çözümleme:** Resmi sağlık raporlarınızın PDF metinleri, eklenti içine gömülü Mozilla `pdfjs-dist` (v6.5.438) ile doğrudan tarayıcınızda çözümlenir.

---

## Çıktı Klasör Yapısı (`enabiz-md-arsiv/`)

```text
enabiz-md-arsiv/
├── README.md                    # Kişisel profil, genel özet ve yıl dosya linkleri
├── 01-tanilar.md                # ICD-10 tanı sıklıkları + Hastalıklarım tam listesi
├── 02-tahliller.md              # Referans dışı sonuçlar + tüm tahlil panelleri
├── 03-radyoloji.md              # Radyolojik incelemeler ve temizlenmiş tam rapor metinleri
├── 04-raporlar.md               # Sağlık raporları listesi + resmi PDF'lerin klinik özeti
├── 05-ilaclar-ve-receteler.md   # Reçete detayları (yazılan/alınan) + İlaçlarım kronolojisi
├── 06-asi-takip-malzeme.md      # Aşılar, kronik taramalar, randevular, malzemeler ve diğer bölümler
└── ziyaretler/
    ├── 2026.md                  # Yıllara göre tüm ziyaret, tanı, işlem, tahlil ve reçeteler
    ├── 2025.md
    └── ...
```

*(İsteğe bağlı ayarlardan orijinal PDF dosyalarını ve ham JSON yedeğini de arşive dahil edebilirsiniz.)*

---

## Kurulum (Chrome / Edge / Brave / Arc)

1. Bu repoyu indirin:
   - Git ile: `git clone https://github.com/atahansocial/enabiz-md-exporter.git`
   - Veya GitHub sağ üstteki **Code → Download ZIP** ile indirip klasöre çıkarın.
2. Tarayıcınızda **`chrome://extensions`** adresini açın ve sağ üstten **Geliştirici modu (Developer mode)** anahtarını açın.
3. **Paketlenmemiş öğe yükle (Load unpacked)** butonuna tıklayıp `enabiz-md-exporter` klasörünü seçin.
4. Tarayıcıda [`https://enabiz.gov.tr`](https://enabiz.gov.tr) adresine gidip e-Devlet veya şifrenizle giriş yapın.
5. Eklenti simgesine tıklayarak yan paneli açın ve **"Sağlık Arşivimi Çek"** butonuna basın.

---

## Yapay Zeka ile Sağlık Özeti Çıkarma

Arşiv indirildikten sonra yan paneldeki **"Yapay Zeka Analiz Prompt'u Kopyala"** butonuna tıklayıp, `enabiz-md-arsiv/` klasöründeki `.md` dosyalarıyla birlikte tercih ettiğiniz asistana vererek korelasyon, çelişki ve risk haritası analizi alabilirsiniz.

---

## Geliştirme ve Testler

Herhangi bir `npm install` adımı gerekmez (`pdfjs-dist` v6.5.438 `vendor/` altında paketlidir). Sentetik doğrulama testlerini çalıştırmak için:

```bash
node tests/verify-builder.mjs
```

---

## Lisans

[MIT License](LICENSE)
