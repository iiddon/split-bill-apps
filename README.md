# Split Bill Struk – panduan pasang sebagai web app

Aplikasi ini di-host gratis di **GitHub Pages**, bisa di-install di HP seperti aplikasi biasa, dan membaca struk memakai **Claude** lewat server kecil milikmu sendiri di **Cloudflare Workers**.

```
HP (web app) ──foto struk──▶ Cloudflare Worker (simpan API key) ──▶ Claude (Anthropic)
     ▲                                                                  │
     └────────────── daftar item, pajak, diskon ◀───────────────────────┘
```

API key disimpan rahasia di Cloudflare, tidak pernah ada di HP atau di kode web app. Siapa pun yang membuka web app tetap butuh **kode akses** buatanmu untuk memakai server.

**Yang dibutuhkan:** akun GitHub, akun Cloudflare (gratis), akun Anthropic Console + kartu untuk isi saldo. Waktu sekitar 30–45 menit. Setup paling nyaman dilakukan dari laptop.

**Isi folder ini**

| File | Gunanya |
|---|---|
| `index.html` | Aplikasinya |
| `manifest.json`, `sw.js`, `icons/` | Supaya bisa di-install dan tetap terbuka saat offline |
| `server/worker.js` | Kode server pembaca struk untuk Cloudflare |
| `README.md` | Panduan ini |

Nama menu di GitHub, Cloudflare, dan Anthropic Console bisa sedikit berbeda dari panduan ini kalau tampilan mereka berubah.

---

## Langkah 1 — Upload ke GitHub dan aktifkan GitHub Pages

1. Masuk ke **github.com**, klik **New repository**.
2. Isi nama `split-bill-apps`, pilih **Public** (GitHub Pages gratis untuk repo publik), lalu **Create repository**.
3. Klik tautan **uploading an existing file**, lalu seret **semua isi folder ini** (termasuk folder `icons` dan `server`) ke halaman itu. Klik **Commit changes**.
4. Buka **Settings → Pages**. Di **Build and deployment**, pilih **Deploy from a branch**, branch **main**, folder **/ (root)**, lalu **Save**.
5. Tunggu 1–2 menit. Alamat aplikasimu: `https://USERNAME.github.io/split-bill-apps/`

Catat juga **origin**-nya, yaitu alamat tanpa nama repo: `https://USERNAME.github.io`. Ini dipakai di Langkah 3.

> Repo publik berarti kodenya bisa dilihat orang. Itu aman, karena tidak ada rahasia di dalamnya. API key hanya disimpan di Cloudflare.

## Langkah 2 — Buat API key Anthropic

1. Buka **console.anthropic.com**, daftar atau masuk.
2. Di menu **Billing**, isi saldo (credits). $5 sudah cukup untuk ratusan struk.
3. **Sangat disarankan:** pasang batas pengeluaran bulanan (spend limit) di menu Billing/Limits, supaya biaya tidak bisa membengkak.
4. Buka **API Keys → Create Key**, beri nama `splitbill`, lalu **salin key-nya**. Key hanya ditampilkan sekali. Jangan kirim ke siapa pun.

## Langkah 3 — Pasang server di Cloudflare Workers

1. Buka **dash.cloudflare.com** dan daftar akun gratis.
2. Masuk ke **Workers & Pages → Create → Create Worker** (template "Hello World"). Beri nama `splitbill`, lalu **Deploy**.
3. Klik **Edit code**. Hapus semua isinya, tempel seluruh isi file `server/worker.js`, lalu klik **Deploy**.
4. Buka **Settings → Variables and Secrets** di Worker itu, lalu tambahkan:

   | Nama | Tipe | Isi |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | Secret | API key dari Langkah 2 |
   | `ACCESS_CODE` | Secret | Kode akses buatanmu, minimal 8 karakter, mis. `kopisusu-0811` |
   | `ALLOWED_ORIGIN` | Text | `https://USERNAME.github.io` (tanpa `/split-bill-apps` dan tanpa garis miring di akhir) |
   | `DAILY_LIMIT` | Text | Opsional. Batas scan per hari, default `50` |

   Lalu klik **Deploy**.
5. **Opsional tapi disarankan, untuk batas harian:** buka **Storage & Databases → KV → Create namespace** dengan nama `splitbill-limits`. Kembali ke Worker, lalu **Settings → Bindings → Add → KV namespace**, isi *Variable name* `LIMITS`, pilih namespace tadi, dan **Deploy**. Tanpa langkah ini, server tetap jalan tapi tidak ada batas jumlah scan per hari.
6. Catat alamat Worker kamu, bentuknya `https://splitbill.NAMAKAMU.workers.dev`.

## Langkah 4 — Sambungkan aplikasi ke server

1. Buka alamat aplikasi dari Langkah 1.
2. Tap ikon **Pengaturan** di kanan atas Beranda.
3. Isi **Alamat server** (alamat Worker) dan **Kode akses** (sama dengan `ACCESS_CODE`).
4. Tap **Tes koneksi**. Kalau muncul "Tersambung", tap **Simpan**.
5. Label di Beranda berubah dari "Mode OCR" menjadi **"Dibaca Claude"**.

## Langkah 5 — Install di HP

- **Android (Chrome):** buka alamat aplikasi, tap menu **⋮**, lalu **Instal aplikasi** atau **Tambahkan ke layar utama**.
- **iPhone (Safari):** buka alamat aplikasi, tap **Bagikan**, lalu **Tambah ke Layar Utama**.

Setelah ter-install, aplikasi punya ikon sendiri dan terbuka tanpa address bar. Isi Pengaturan (Langkah 4) di HP itu juga, karena tiap HP menyimpan pengaturannya sendiri.

## Langkah 6 (opsional) — Pindahkan data dari versi di Claude

1. Di aplikasi versi Claude (artifact): **Pengaturan → Unduh cadangan**. Centang "Sertakan foto struk" kalau perlu.
2. Di web app: **Pengaturan → Pulihkan dari file**, lalu pilih file cadangan tadi.

---

## Biaya

| Bagian | Biaya |
|---|---|
| Claude (Anthropic API) | Sekitar **Rp150 per struk** dengan Claude Sonnet 5.5 ($2 per juta token input, $10 per juta token output; satu struk kira-kira 2.000 token masuk dan 500 token keluar). Ini perkiraan; cek harga terbaru di halaman pricing Anthropic. |
| Cloudflare Workers | Gratis. Paket gratis memberi 100.000 request per hari. |
| GitHub Pages | Gratis |

Mau lebih hemat? Tambahkan variabel `MODEL` dengan isi `claude-haiku-5-5` di Cloudflare. Biayanya jauh lebih murah, tapi bacaannya bisa kurang teliti untuk struk yang sulit.

## Keamanan

- API key hanya ada di Cloudflare. Kalau bocor, hapus key itu di Anthropic Console dan buat yang baru.
- Siapa pun yang tahu **alamat aplikasi + kode akses** bisa scan struk memakai saldomu. Bagikan kode hanya ke teman yang kamu izinkan. Kode bisa diganti kapan saja di Cloudflare (`ACCESS_CODE`).
- Server hanya mau membaca struk (perintahnya dikunci di server), jadi tidak bisa dipakai orang untuk keperluan lain.
- Batas harian (`DAILY_LIMIT` + KV) dan spend limit di Anthropic menjadi rem kalau ada penyalahgunaan.

## Data dan privasi

- Tagihan, grup, acara, pengaturan, dan foto struk tersimpan di **browser HP masing-masing**, tidak di server.
- Foto struk dikirim ke Claude lewat server hanya untuk dibaca. Server tidak menyimpannya.
- Kalau data browser atau cache dihapus, data aplikasi ikut hilang. **Unduh cadangan secara berkala** lewat Pengaturan.

## Kalau ada masalah

| Pesan / gejala | Penyebab dan solusinya |
|---|---|
| "Alamat web app ini belum diizinkan" | `ALLOWED_ORIGIN` harus persis `https://USERNAME.github.io`, tanpa `/split-bill-apps` dan tanpa `/` di akhir. |
| "Kode akses salah" | Samakan kode di Pengaturan aplikasi dengan `ACCESS_CODE` di Cloudflare. Perhatikan huruf besar/kecil. |
| "Server belum lengkap" | `ANTHROPIC_API_KEY` atau `ACCESS_CODE` belum diisi, atau Worker belum di-Deploy ulang setelah diisi. |
| "API key Anthropic tidak valid" | Key salah salin atau sudah dihapus. Buat key baru dan ganti di Cloudflare. |
| "Saldo API Anthropic habis" | Isi ulang saldo di console.anthropic.com. |
| "Batas scan hari ini sudah habis" | Naikkan `DAILY_LIMIT` di Cloudflare, atau tunggu besok (reset pukul 07.00 WIB). |
| Tes koneksi: "Tidak bisa terhubung" | Cek alamat Worker (harus diawali `https://`) dan pastikan Worker sudah di-Deploy. |
| Menu "Instal aplikasi" tidak muncul | Pastikan dibuka lewat alamat GitHub Pages (`https://`) di Chrome, bukan dari file yang diunduh. |
| Versi baru tidak muncul setelah upload ulang | Tutup aplikasi lalu buka lagi, kalau perlu dua kali. |

## Memperbarui aplikasi

Upload file baru ke repo yang sama (timpa file lama). GitHub Pages memperbarui alamatnya dalam 1–2 menit, dan aplikasi yang sudah ter-install ikut terbarui saat dibuka berikutnya.
