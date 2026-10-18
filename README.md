# 🌱 AquaSmart IoT - Web Monitoring & Kontrol Penyiraman Otomatis

Aplikasi web dashboard canggih untuk memantau data sensor secara *real-time* dan mengendalikan aktuator penyiraman air serta fertigasi pupuk cair berbasis Internet of Things (IoT).

![AquaSmart IoT Preview](public/preview.png)

---

## 🌟 Fitur Utama

1. **Monitoring Sensor Real-Time (Live Telemetri)**:
   - **Suhu Lingkungan & Tanah (°C)**: Tampilan angka neon dinamis, indikator kenyamanan tanaman, bar thermometer, dan grafik garis real-time.
   - **Kelembapan Tanah (%)**: Gauge melingkar (*circular progress*), status ambang batas siram otomatis, dan visualisasi grafik temporal.
   - **pH Tanah**: Nilai derajat keasaman dengan pita spektrum warna (1–14) beserta pointer live, status netral/asam/basa, dan grafik garis real-time.
   - **Level Tangki & Akumulasi**: Indikator persentase volume tangki air dan tangki pupuk cair, serta total volume terpakai hari ini.

2. **Kendali Aktuator Lengkap**:
   - **Tombol Penyiraman Air**: Sakelar ON/OFF interaktif dengan animasi gelombang aliran pipa dan semprotan air, serta opsi siram cepat (*Quick Burst*: +10 detik, +30 detik, +1 menit) dilengkapi penghitung waktu mundur (*countdown*).
   - **Tombol Penyiraman Pupuk (Fertigasi Cair)**: Sakelar kendali pompa dosis pupuk cair dengan opsi dosis presisi (10 ml, 25 ml, 50 ml).
   - **Tombol Mode (AUTO vs MANUAL)**:
     - **Mode AUTO**: Logika cerdas otomatis menyalakan pompa air ketika kelembapan tanah &lt; batas minimum (default: 40%) dan berhenti setelah target tercapai atau batas durasi selesai.
     - **Mode MANUAL**: Operator memegang kendali penuh tanpa intervensi otomatis.
   - **Tombol Stop Darurat**: Tombol penghentian instan untuk keselamatan seluruh pompa.

3. **Grafik Real-Time Multi-Sensor**:
   - 3 grafik interaktif terpisah (*Chart.js*) dengan area gradien halus.
   - Dilengkapi tombol *Pause / Resume Live Stream* dan tombol *Reset Grafik*.

4. **Log Aktivitas & Riwayat Real-Time**:
   - Pencatatan otomatis setiap trigger sensor, pergantian mode, atau aksi pompa dengan stempel waktu dan badge kategori.
   - Fitur ekspor riwayat aktivitas ke file **CSV**.

5. **Audio Feedback (Synthesizer)**:
   - Efek suara taktil saat relay aktif/mati atau mode berganti (dapat dimatikan/diaktifkan melalui tombol speaker di navbar).

6. **Dukungan Hardware ESP32 & Simulator Terintegrasi**:
   - Dilengkapi simulator fluktuasi data alami (bekerja langsung tanpa perlu alat terhubung).
   - Jika ESP32 / ESP8266 dihubungkan, sistem secara otomatis beralih menerima data fisik dari sensor.
   - Sketsa program Arduino siap pakai disertakan di folder `esp32_firmware/esp32_penyiraman.ino`.

7. **Halaman Database & Arsip Historis Keseluruhan (`database.html`)**:
   - **Database SQLite Persisten**: Menggunakan database SQLite lokal (`data/aquasmart.db`) bawaan Node.js tanpa perlu instalasi database server luar.
   - **Dual-View Data**: Tab terpisah untuk **Database Telemetri Sensor** dan **Database Riwayat Penyiraman & Fertigasi Pupuk**.
   - **Statistik & Metrik**: Menampilkan rata-rata suhu, kelembapan, pH, total volume air (Liter), total dosis pupuk (ml), dan frekuensi penyiraman.
   - **Filter & Pencarian Lengkap**: Filter rentang waktu (24 Jam, Hari Ini, 7 Hari, Semua), pencarian instan, filter mode (AUTO/MANUAL), filter jenis (Air/Pupuk), dan pagination dinamis.
   - **Ekspor Data**: Mendukung ekspor ke format **CSV (Excel)** dan **JSON**.
   - **Grafik Tren Historis**: Visualisasi tren sensor jangka panjang dengan Chart.js.

---

## 🚀 Cara Menjalankan Aplikasi

Pastikan **Node.js** telah terpasang di komputer Anda.

1. Buka terminal di folder proyek (`d:\Web_Penyiraman_Otomatis`).
2. Jalankan perintah:
   ```bash
   npm start
   ```
   *(atau bisa juga: `node server.js`)*
3. Buka browser dan akses alamat:
   - **Dashboard Real-time**: `http://localhost:3000`
   - **Database Keseluruhan**: `http://localhost:3000/database.html`

---

## 📡 Integrasi Hardware ESP32

### Skema Pinout:
| Komponen | Tipe | Pin ESP32 | Keterangan |
| :--- | :--- | :--- | :--- |
| **DHT22** (Suhu & Kelembapan Udara) | Digital Data | `GPIO 16` | Pin data DHT22 (resistor pull-up 4.7k-10k) |
| **Capacitive Soil Moisture Sensor v1.2** | Analog ADC | `GPIO 35` | Pembacaan kelembapan tanah (ADC1_CH7) |
| **Sensor pH Analog (PH-4502C / sejenis)** | Analog ADC | `GPIO 34` | Pembacaan tegangan analog pH (ADC1_CH6) |
| **Sensor pH Digital (DO)** | Digital Input | `GPIO 13` | Digital threshold / alarm pH |
| **Relay 1** (Pompa Penyiraman Air) | Digital Output | `GPIO 26` | Kendali katup/pompa siram utama |
| **Relay 2** (Pompa Pupuk Cair NPK) | Digital Output | `GPIO 27` | Kendali fertigasi nutrisi cair |

### Endpoint API untuk ESP32:
- **Kirim Telemetri & Dapatkan Perintah Relay**:
  - **Method**: `POST`
  - **URL Cloud (Render)**: `https://aquasmart-iot.onrender.com/api/telemetry`
  - **URL Lokal**: `http://<IP_KOMPUTER>:3000/api/telemetry`
  - **Header**: `Content-Type: application/json`
  - **Payload Body**:
    ```json
    {
      "suhu": 28.5,
      "kelembapan": 42.0,
      "ph": 6.75,
      "deviceId": "ESP32-Greenhouse-1"
    }
    ```
  - **Respons Server**:
    ```json
    {
      "success": true,
      "controls": {
        "mode": "auto",
        "pompaAir": true,
        "pompaPupuk": false
      }
    }
    ```

---

## ⚙️ Struktur Folder

```text
d:\Web_Penyiraman_Otomatis\
├── package.json
├── server.js                # Backend Express & WebSocket server
├── database.js              # Modul SQLite (persistensi data sensor & penyiraman)
├── data\
│   └── aquasmart.db         # Database SQLite lokal (otomatis dibuat)
├── public\
│   ├── index.html           # Antarmuka Dashboard utama (Live Monitoring)
│   ├── database.html        # Halaman Database & Arsip Historis Keseluruhan
│   ├── css\
│   │   └── style.css        # Design System & Styling (Vanilla CSS Modern)
│   └── js\
│       ├── app.js           # Kontroler Dashboard, WebSocket & Chart.js
│       ├── database.js      # Kontroler Halaman Database, Filter & Ekspor
│       └── chart.min.js     # Library Chart.js (offline ready)
├── esp32_firmware\
│   └── esp32_penyiraman.ino  # Source code Arduino ESP32
└── README.md
```
