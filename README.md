# Vektor — batch vectorizer di browser

Ubah gambar raster (PNG/JPG/WEBP) menjadi **SVG** dan **EPS 10** sekaligus banyak file.
Semua proses berjalan di browser (Web Worker); tidak ada file yang diunggah ke server,
jadi bisa di-host gratis di GitHub Pages.

## Fitur

- **Batch**: seret banyak gambar sekaligus (atau tempel dari clipboard). Diproses paralel.
- **Mode Warna, Siluet, atau Gradien**
  - *Warna*: palet otomatis (atau dibatasi), cocok untuk ilustrasi flat. **Rapikan** (bawaan aktif, mendekati cara vectorizer.ai): grain/derau JPEG diratakan tanpa menyentuh tepi; dua warna mirip tetap dipisah bila memang dua bidang datar (ada "lembah" di histogram, mis. butir nasi putih di atas nasi) dan dilebur bila hanya derau/peralihan; bintik dan pinggiran antialias dibuang; batas antar warna mirip dihaluskan lebih kuat (lebih sedikit titik). Pada gambar kaya warna (≥ 24 warna) garis tipis ditambahkan sebagai stroke rata. **Haluskan tepi kasar** (bawaan 2 px, 0–4): tepi bergerigi bergaya kuas kering beserta bercak warna di sepanjang tepinya dihaluskan menjadi kurva mulus; sudut yang tegas tetap tajam. Turunkan bila ada garis setipis ≤ 2 px yang hilang. **Luruskan garis panjang** (bawaan aktif): tepi yang bergerigi tetapi bila ditarik garis panjang (≥ 18 px) memang lurus dijadikan satu garis lurus — simpangan boleh hingga 2,5 % panjangnya (maks. 2 px) asal tersebar di kedua sisi; busur dan lengkung-S tetap lengkung.
  - *Gradien*: untuk gambar penuh gradasi/cahaya (ilustrasi digital, adegan malam). Palet besar (bawaan 64 warna, 16–128) tanpa peleburan agresif; pita peralihan tipis di tepi garis dipindahkan ke sisi yang benar dan batas antar tingkat warna dirapikan (filter mayoritas), sehingga outline tidak berhalo. **Garis tipis → garis vektor** (bawaan aktif): garis ≤ ~3 px dikenali, dihapus dari isian, lalu digambar ulang sebagai stroke bertebal seragam (potongan yang searah disambung, warna garis yang mirip diseragamkan).
  - *Siluet*: untuk stensil, emblem, siluet. Nada **Hitam + abu-abu** (tingkat abu-abu dipertahankan dengan rona aslinya) atau **Hitam saja** (ambang gelap/terang bisa diatur). Dengan latar putih, rongga di dalam siluet bisa **Luar**, **Pintar**, **Semua** (transparan), atau **Isi**.
- **Upscale sebelum tracing** (default 4×) agar batas warna jatuh di posisi sub-piksel.
- **Warna latar: Tanpa / Putih / Magenta**. *Tanpa*: tidak ada warna yang dihapus — semua warna (termasuk putih dan magenta) divectorisasi.
- **Latar magenta (disarankan)**: buat gambar dengan latar #FF00FF, pilih *Warna latar: Magenta*. Semua warna dalam toleransi (0–50 %, bawaan 30 %) dari magenta menjadi transparan; putih di mana pun tetap putih. Pinggiran keunguan akibat antialias/JPEG dibersihkan otomatis. Berlaku untuk mode Warna dan Siluet.
- **Latar putih → transparan**
  - *Luar*: hanya putih yang tersambung ke tepi gambar (dengan penutup celah garis, jadi tidak bocor ke dalam objek).
  - *Luar* (bawaan): hanya putih yang tersambung ke tepi; putih di dalam ditandai garis putus-putus untuk diklik.
  - *AI*: putih luar + putih di dalam yang dinilai latar oleh model ISNet ilustrasi (44 MB, diunduh sekali, ±10 detik/gambar, khusus mode Warna). Lihat `THIRD_PARTY.md`.
  - *Pintar* (eksperimental): putih luar + putih terkurung yang termasuk latar (antara kaki, rangka kursi, dsb.). Putih milik objek tetap.
  - *Semua*: semua area putih.
  - Klik bentuk mana pun di pratinjau untuk menghapus/mengembalikannya, **langsung tanpa proses ulang** (bentuk disorot saat kursor di atasnya). Urungkan/ulangi: Ctrl+Z / Ctrl+Shift+Z.
- **Alat sunting** (bilah palet, langsung tanpa proses ulang, bisa diurungkan):
  - *Hapus* (H): hapus/kembalikan bentuk.
  - *Gabung* (G): lebur bentuk ke tetangga dengan batas bersama terpanjang (ditandai garis putus-putus biru saat kursor di atasnya). Bentuk yang terkurung sepenuhnya oleh tetangganya tidak lagi digambar (mode Tumpuk), jadi file lebih ringkas.
  - *Warnai* (W): beri satu bentuk warna sendiri; Alt+klik mengambil warna bentuk.
  - Suntingan disimpan sebagai titik, jadi tetap berlaku setelah gambar diproses ulang.
- **Belajar dari hasil akhir**: saat mengunduh, keadaan akhir tiap area putih (dihapus/tidak) dicatat bersama sidiknya (ukuran, kontak garis/latar, objek di seberang garis, bentuk). Gambar berikutnya dengan gaya serupa otomatis mengikuti (k-tetangga terdekat; koreksi Anda berbobot lebih). Klik coba-coba tidak dihitung. Tersimpan di browser ini saja; bisa dihapus dengan tombol *Lupakan*.
- **Tombol Proses**: unggah dan ubah pengaturan tidak langsung memproses; klik *Proses* setelah selesai mengatur.
- **Ukuran output microstock**: 15 / 20 / 25 / 30 MP, kustom (≥15 MP), atau asli. Artboard dan koordinat kurva diskalakan.
- **Kode nama file**: `[kode]_[urutan]_[nama_awal]`, mis. `011_1_600_01_stencil_voids_emblem.svg`.
- **Format unduhan**: SVG + EPS (`SVG/` dan `EPS/` dalam satu ZIP), hanya SVG, atau hanya EPS.
- **Palet per gambar**: ganti warna atau jadikan transparan.
- **Tema terang/gelap**: tombol di kanan atas (otomatis → terang → gelap), tersimpan di browser.
- **Bantuan (?)**: arahkan kursor ke ikon tanda tanya di samping pengaturan untuk penjelasan nilai kecil vs besar.
- **Default**: tombol di atas panel mengembalikan semua pengaturan ke nilai bawaan (kode nama file dan nomor mulai tidak diubah).
- **Kode nama file** ada di urutan pertama panel agar tidak lupa diganti.
- **Penampil**: Bandingkan (geser pembatas), **Berdampingan** (keduanya tanpa penanda oranye agar hasil terlihat apa adanya) (asli kiri, vektor kanan; zoom dan geser bersamaan, tanda silang menunjukkan titik yang sama di panel seberang; tombol **S**), Vektor, Garis (outline), zoom, 1:1, lensa piksel, latar pratinjau gelap/terang (tombol atau tombol keyboard **B**; hanya tampilan, tidak memproses ulang).
- **Susunan**: Tumpuk (bentuk bersarang tanpa retak) atau Potong (tanpa tumpang tindih), plus pengisi celah: tiap bentuk mendapat garis sewarna yang meluas ke bawah bentuk yang digambar sesudahnya, jadi tidak ada retakan saat dilihat diperkecil dan tidak ada bentuk yang menebal.

- **Kurva hemat titik** (bawaan aktif, mode Warna & Siluet): tepi dihitung sub-piksel dari gambar asli (titik 50 % antara dua warna / alpha 50 %), lalu tiap batas dijadikan poligon dengan sisi sesedikit mungkin (pemrograman dinamis, gaya Potrace), titik sudutnya digeser ke perpotongan garis kuadrat-terkecil, belokan tajam menjadi sudut runcing dan sisanya kurva halus; kurva searah digabung selama simpangannya kecil. Bentuk bulat tanpa sudut menjadi elips utuh. Pada 11 gambar uji: 10–25 % lebih sedikit titik dan tepi lebih akurat di 8 dari 11.

- **Sederhanakan bayangan** (mode Warna: Mati / Ringan / Kuat, bawaan Mati): bercak warna yang batasnya lemah di gambar asli (bayangan lembut, gradasi berpita) dilebur ke tetangganya; outline dan batas kontras tidak disentuh. Ruang kerja (Ringan): 5.047 → 3.982 bentuk, 23.997 → 18.573 titik, dengan sebagian nuansa bayangan hilang.

## Uji kualitas (tools/)

`tools/bench.cjs` + `tools/bench.html` mengukur tiap gambar uji: selisih warna hasil vs asli (seluruh gambar dan di tepi), jumlah bentuk & titik, serta kerataan kurva (belokan dan titik balik per 100 px). Taruh gambar di `test-images/`, sajikan folder ini (`python3 -m http.server 8767`), lalu `node tools/bench.cjs 8767 hasil.json`.

## Cara kerja tracing

1. **Penghalusan searah garis**: arah tiap tepi dihitung (tensor struktur), lalu warna dirata-ratakan sepanjang garis — getaran tepi akibat kompresi hilang tanpa menipiskan garis.
2. **Palet** dibangun dari piksel "rata". Piksel transisi/antialias diabaikan, lalu varian minor (mis. tepi garis yang lebih gelap karena kompresi) dilebur.
3. **Upscale** dengan interpolasi halus.
4. **Benih + region growing**: piksel yang jelas cocok dengan palet dan tidak berada di lereng gradien menjadi benih. Piksel transisi diberikan ke warna tetangga terdekat, sehingga batas jatuh di titik 50%.
5. **Garis ala siluet** (mode warna): batas antara warna garis (palet paling gelap) dan isian terang di sebelahnya ditentukan oleh ambang kecerahan di titik tengah keduanya — tepi garis rata dan tebalnya konsisten, warna tetap.
6. **Pembersihan**: bintik kecil dilebur ke tetangga yang warnanya paling mirip.
7. **Tracing pada kisi sudut piksel**: batas antar dua region dipecah menjadi rantai di titik pertemuan ≥3 region. Tiap rantai di-fit **sekali** dan dipakai kedua sisinya, jadi tidak ada celah atau tumpang tindih.
8. **Fitting**: deteksi sudut, garis lurus, Bézier kubik (Schneider), dan elips utuh.

## Menjalankan lokal

Tidak perlu build. Cukup sajikan folder ini dengan server statis apa pun:

```sh
python3 -m http.server 8000
# buka http://localhost:8000/
```

(Membuka `index.html` langsung via `file://` tidak bisa karena Web Worker dan ES module.)

## Versi file (cache)

`index.html` dan `app.js` memuat file lain dengan `?v=<versi>` agar browser tidak memakai
JavaScript lama dari cache GitHub Pages. Saat mengubah file, perbarui angka versinya
(cari `?v=`) di `index.html` dan `app.js`.

## Deploy ke GitHub Pages

1. Repo → **Settings → Pages**.
2. *Source*: **Deploy from a branch**. Pilih branch ini, folder **/ (root)**, lalu **Save**.
3. Situs akan aktif di `https://<user>.github.io/<nama-repo>/`.

## Struktur

| File | Isi |
| --- | --- |
| `index.html` | Markup antarmuka |
| `styles.css` | Gaya (terang/gelap otomatis) |
| `app.js` | Antrean, worker pool, penampil, panel pengaturan, unduhan |
| `worker.js` | Mesin tracing (palet, upscale, label, tracing, fitting) |
| `export.js` | Penyusun SVG/EPS dan penulis ZIP (tanpa dependensi) |
| `ai-worker.js` | Penilai objek/latar AI (onnxruntime-web + model di `models/`) |

Browser yang didukung: Chrome/Edge 103+, Firefox 113+, Safari 16.4+.
