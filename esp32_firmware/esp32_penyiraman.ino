/*
 * ======================================================================================
 * PROYEK: SISTEM MONITORING & KONTROL PENYIRAMAN OTOMATIS BERBASIS IoT & FUZZY TSUKAMOTO (ESP32)
 * KONEKSI: Web Dashboard AquaSmart IoT (REST API / JSON via WiFi)
 * ======================================================================================
 * 
 * SENSOR & AKTUATOR (SESUAI RANGKAIAN HARDWARE):
 * 1. Sensor Suhu & Kelembapan Udara : DHT22 (Pin Data -> GPIO 16)
 * 2. Sensor Kelembapan Tanah        : Capacitive Soil Moisture (Analog -> GPIO 35)
 * 3. Sensor pH Tanah                : Sensor pH Analog (Analog -> GPIO 34, Digital -> GPIO 13)
 * 4. Relay 1 (Pompa Penyiraman Air) : Digital Output -> GPIO 26
 * 5. Relay 2 (Pompa Pupuk Cair)     : Digital Output -> GPIO 27
 * 
 * FITUR UTAMA:
 * - Edge AI / Computing: Logika Fuzzy Tsukamoto dieksekusi langsung di mikrokontroler ESP32
 * - Fuzzifikasi Suhu Udara, Kelembapan Tanah, dan Derajat Keasaman (pH)
 * - Inferensi Aturan Tsukamoto dengan konsekuen monoton (Maksimum Air: 30s, Pupuk: 5s)
 * - Mesin Status Non-Blocking: Pengoperasian berurutan (Pompa Air -> Jeda 2 detik -> Pompa Pupuk)
 * - Mode Ganda: AUTO (Fuzzy Tsukamoto Otonom) & MANUAL (Kendali Penuh Web Dashboard)
 * - Failsafe Offline: Sistem tetap menyiram secara cerdas meski WiFi / Server tidak terhubung
 * - Sinkronisasi Telemetri Real-time ke Server Dashboard AquaSmart IoT
 * 
 * DEPENDENSI LIBRARY ARDUINO:
 * - WiFi.h & HTTPClient.h (Bawaan ESP32 Core)
 * - WiFiClientSecure.h (Bawaan ESP32 Core, untuk endpoint HTTPS)
 * - ArduinoJson (v6.x oleh Benoit Blanchon)
 * - DHT sensor library (oleh Adafruit)
 * ======================================================================================
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <DHT.h>

// ==================================================
// 1. KONFIGURASI JARINGAN & SERVER
// ==================================================
const char* WIFI_SSID     = "Aguss";
const char* WIFI_PASSWORD = "PASSWORD_WIFI_ANDA"; // Ganti dengan password WiFi Aguss Anda

// URL Server Backend Dashboard:
// - Cloud Render: "https://aquasmart-iot.onrender.com/api/telemetry"
// - Lokal: "http://192.168.1.100:3000/api/telemetry" (Jika menguji di jaringan lokal)
const char* SERVER_TELEMETRY_URL = "https://aquasmart-iot.onrender.com/api/telemetry";
const char* DEVICE_ID            = "ESP32-Greenhouse-1";

// ==================================================
// 2. PIN ESP32 - SESUAI RANGKAIAN FISIK ANDA
// ==================================================
#define PH_ANALOG_PIN   34
#define PH_DIGITAL_PIN  13
#define SOIL_PIN        35
#define DHT_PIN         16
#define RELAY1_PIN      26  // Pompa air
#define RELAY2_PIN      27  // Pompa pupuk cair

#define DHT_TYPE        DHT22

// Polaritas Relay (Sesuaikan dengan jenis modul relay Anda)
// - Active HIGH : RELAY_ON = HIGH, RELAY_OFF = LOW
// - Active LOW  : RELAY_ON = LOW,  RELAY_OFF = HIGH (Paling umum untuk modul relay biru Arduino)
#define RELAY_ON  HIGH
#define RELAY_OFF LOW

DHT dht(DHT_PIN, DHT_TYPE);

// ==================================================
// 3. KONFIGURASI KALIBRASI & FUZZY TSUKAMOTO
// ==================================================

// Kalibrasi Kelembapan Tanah (ADC 12-bit: 0 - 4095)
// SOIL_ADC_DRY: Nilai ADC di udara kering
// SOIL_ADC_WET: Nilai ADC di air basah
const int SOIL_ADC_DRY = 3500;
const int SOIL_ADC_WET = 1500;

// Rentang ADC Sensor pH (0 - 4095 pada ADC ESP32)
const int PH_ADC_MIN = 0;
const int PH_ADC_MAX = 4095;

// Target pH Ideal Tanaman
const float PH_TARGET_MIN = 5.5;
const float PH_TARGET_MAX = 7.0;

// Durasi Maksimum Output Fuzzy (detik)
const float MAX_AIR_SEC   = 30.0;
const float MAX_PUPUK_SEC = 5.0;

// Interval Waktu Sistem (milidetik)
const unsigned long INTERVAL_EVALUASI  = 30000; // Evaluasi fuzzy tiap 30 detik
const unsigned long INTERVAL_DHT       = 2000;  // Baca sensor DHT22 tiap 2 detik
const unsigned long INTERVAL_TELEMETRI = 3000;  // Kirim data ke web dashboard tiap 3 detik
const unsigned long INTERVAL_RECONNECT = 10000; // Coba sambung ulang WiFi tiap 10 detik jika putus

// ==================================================
// 4. VARIABEL GLOBAL SISTEM
// ==================================================
unsigned long waktuEvaluasi       = 0;
unsigned long waktuBacaDHT        = 0;
unsigned long waktuKirimTelemetri = 0;
unsigned long waktuLastReconnect  = 0;

float suhuUdara       = NAN;
float kelembapanUdara = NAN;
float kelembapanTanah = 0.0;
float phTanah         = 7.0;

// Mesin Status Siklus Pompa (Non-blocking)
// 0 = Idle, 1 = Pompa Air Nyala, 2 = Jeda Antarpompa, 3 = Pompa Pupuk Nyala
bool prosesAktif      = false;
int tahapPompa        = 0;
unsigned long waktuTahap   = 0;
unsigned long durasiAirMs   = 0;
unsigned long durasiPupukMs = 0;
float lastDurasiAirSec      = 0.0;
float lastDurasiPupukSec    = 0.0;

// Mode Operasi
// "auto"   : Dikendalikan oleh Logika Fuzzy Tsukamoto ESP32
// "manual" : Dikendalikan secara langsung oleh tombol Web Dashboard
String modeSistem     = "auto";
bool manualPompaAir   = false;
bool manualPompaPupuk = false;

// ==================================================
// 5. FUNGSI KEANGGOTAAN FUZZY (MEMBERSHIP FUNCTIONS)
// ==================================================

// Fungsi keanggotaan Segitiga
float segitiga(float x, float a, float b, float c) {
  if (x <= a || x >= c) return 0.0;
  if (x == b) return 1.0;
  if (x < b) return (x - a) / (b - a);
  return (c - x) / (c - b);
}

// Fungsi keanggotaan Trapesium
float trapesium(float x, float a, float b, float c, float d) {
  if (x < a || x > d) return 0.0;
  if (x >= b && x <= c) return 1.0;
  if (x < b) {
    if (b == a) return 1.0;
    return (x - a) / (b - a);
  }
  if (d == c) return 1.0;
  return (d - x) / (d - c);
}

// Batasi nilai dalam rentang min - max
float batasi(float x, float minimum, float maksimum) {
  if (x < minimum) return minimum;
  if (x > maksimum) return maksimum;
  return x;
}

// --- FUZZIFIKASI KELEMBAPAN TANAH (0 - 100%) ---
float tanahKering(float x) {
  return trapesium(x, 0, 0, 30, 50);
}

float tanahLembap(float x) {
  return segitiga(x, 30, 50, 70);
}

float tanahBasah(float x) {
  return trapesium(x, 50, 70, 100, 100);
}

// --- FUZZIFIKASI SUHU UDARA (°C) ---
float suhuDingin(float x) {
  return trapesium(x, 0, 0, 20, 25);
}

float suhuNormal(float x) {
  return segitiga(x, 20, 27, 34);
}

float suhuPanas(float x) {
  return trapesium(x, 30, 35, 50, 50);
}

// --- FUZZIFIKASI pH TANAH (Skala 0 - 14) ---
float phAsam(float x) {
  return trapesium(x, 0, 0, 5.5, 6.5);
}

float phNetral(float x) {
  return segitiga(x, 5.5, 6.5, 7.5);
}

float phBasa(float x) {
  return trapesium(x, 6.5, 7.5, 14, 14);
}

// ==================================================
// 6. INFERENSI & DEFUZZIFIKASI TSUKAMOTO
// ==================================================
void tambahAturan(float alpha, bool outputOn, float maksimum,
                  float &jumlahZ, float &jumlahAlpha) {
  if (alpha <= 0.0) return;

  float z;
  if (outputOn) {
    z = maksimum * alpha;
  } else {
    z = maksimum * (1.0 - alpha);
  }

  jumlahZ += alpha * z;
  jumlahAlpha += alpha;
}

float hasilTsukamoto(float jumlahZ, float jumlahAlpha, float maksimum) {
  if (jumlahAlpha <= 0.0) return 0.0;
  return batasi(jumlahZ / jumlahAlpha, 0.0, maksimum);
}

// --- LOGIKA OUTPUT FUZZY: POMPA AIR ---
// Aturan:
// 1. Tanah Kering -> Pompa Air ON
// 2. Tanah Lembap DAN Suhu Panas -> Pompa Air ON
// 3. Tanah Lembap DAN Suhu TIDAK Panas -> Pompa Air OFF
// 4. Tanah Basah -> Pompa Air OFF
float fuzzyPompaAir(float kelembapan, float suhu) {
  float kering = tanahKering(kelembapan);
  float lembap = tanahLembap(kelembapan);
  float basah  = tanahBasah(kelembapan);
  float panas  = suhuPanas(suhu);

  float sumZ = 0.0;
  float sumAlpha = 0.0;

  // Aturan 1: Tanah kering -> ON
  tambahAturan(kering, true, MAX_AIR_SEC, sumZ, sumAlpha);

  // Aturan 2: Tanah lembap DAN suhu panas -> ON
  tambahAturan(min(lembap, panas), true, MAX_AIR_SEC, sumZ, sumAlpha);

  // Aturan 3: Tanah lembap DAN suhu tidak panas -> OFF
  float tidakPanas = 1.0 - panas;
  tambahAturan(min(lembap, tidakPanas), false, MAX_AIR_SEC, sumZ, sumAlpha);

  // Aturan 4: Tanah basah -> OFF
  tambahAturan(basah, false, MAX_AIR_SEC, sumZ, sumAlpha);

  return hasilTsukamoto(sumZ, sumAlpha, MAX_AIR_SEC);
}

// --- LOGIKA OUTPUT FUZZY: POMPA PUPUK (FERTIGASI) ---
// Aturan:
// 1. Tanah Kering DAN pH Netral -> Pompa Pupuk ON
// 2. Tanah Lembap DAN pH Netral -> Pompa Pupuk ON
// 3. Tanah Basah -> Pompa Pupuk OFF
// 4. pH Asam atau Basa -> Pompa Pupuk OFF
float fuzzyPompaPupuk(float kelembapan, float ph) {
  float kering = tanahKering(kelembapan);
  float lembap = tanahLembap(kelembapan);
  float basah  = tanahBasah(kelembapan);

  float asam   = phAsam(ph);
  float netral = phNetral(ph);
  float basa   = phBasa(ph);

  float sumZ = 0.0;
  float sumAlpha = 0.0;

  // Aturan 1: Tanah kering & pH netral -> ON
  tambahAturan(min(kering, netral), true, MAX_PUPUK_SEC, sumZ, sumAlpha);

  // Aturan 2: Tanah lembap & pH netral -> ON
  tambahAturan(min(lembap, netral), true, MAX_PUPUK_SEC, sumZ, sumAlpha);

  // Aturan 3: Tanah basah -> OFF
  tambahAturan(basah, false, MAX_PUPUK_SEC, sumZ, sumAlpha);

  // Aturan 4 & 5: pH asam atau basa -> OFF
  tambahAturan(asam, false, MAX_PUPUK_SEC, sumZ, sumAlpha);
  tambahAturan(basa, false, MAX_PUPUK_SEC, sumZ, sumAlpha);

  return hasilTsukamoto(sumZ, sumAlpha, MAX_PUPUK_SEC);
}

// ==================================================
// 7. FUNGSI PEMBACAAN SENSOR & KONTROL RELAY
// ==================================================
float bacaKelembapanTanah() {
  int adc = analogRead(SOIL_PIN);
  float persen = 100.0 * (SOIL_ADC_DRY - adc) / (float)(SOIL_ADC_DRY - SOIL_ADC_WET);
  return batasi(persen, 0.0, 100.0);
}

float bacaPH() {
  int adc = analogRead(PH_ANALOG_PIN);
  // Persamaan konversi ADC ESP32 (0-4095) ke skala pH (0-14)
  // Ganti atau sesuaikan konstanta ini setelah kalibrasi dengan cairan buffer pH 4.01 / 6.86
  float ph = 14.0 * adc / 4095.0;
  return batasi(ph, 0.0, 14.0);
}

void matikanPompa() {
  digitalWrite(RELAY1_PIN, RELAY_OFF);
  digitalWrite(RELAY2_PIN, RELAY_OFF);
}

// Pengendali Manual dari Web Dashboard
void eksekusiKontrolManual() {
  if (prosesAktif) {
    // Batalkan siklus otomatis jika berpindah ke mode manual
    prosesAktif = false;
    tahapPompa = 0;
  }
  digitalWrite(RELAY1_PIN, manualPompaAir ? RELAY_ON : RELAY_OFF);
  digitalWrite(RELAY2_PIN, manualPompaPupuk ? RELAY_ON : RELAY_OFF);
}

// ==================================================
// 8. MESIN STATUS PENGENDALIAN POMPA (NON-BLOCKING)
// ==================================================
void kelolaSiklusPompa(unsigned long sekarang) {
  if (!prosesAktif) return;

  // Tahap 1: Pompa Air Aktif sampai batas waktu selesai
  if (tahapPompa == 1 && sekarang - waktuTahap >= durasiAirMs) {
    digitalWrite(RELAY1_PIN, RELAY_OFF);
    tahapPompa = 2;
    waktuTahap = sekarang;
    Serial.println("[POMPA] Pompa air MATI. Memasuki jeda aman antarpompa (2 detik)...");
  }

  // Tahap 2: Jeda 2 detik agar kedua pompa tidak bentrok bersamaan
  else if (tahapPompa == 2 && sekarang - waktuTahap >= 2000) {
    if (durasiPupukMs > 0) {
      digitalWrite(RELAY2_PIN, RELAY_ON);
      tahapPompa = 3;
      waktuTahap = sekarang;
      Serial.printf("[POMPA] Pompa pupuk AKTIF selama %lu ms (%.2f detik).\n", durasiPupukMs, lastDurasiPupukSec);
    } else {
      prosesAktif = false;
      tahapPompa = 0;
      Serial.println("[POMPA] Siklus penyiraman selesai.");
    }
  }

  // Tahap 3: Pompa Pupuk Aktif sampai batas waktu selesai
  else if (tahapPompa == 3 && sekarang - waktuTahap >= durasiPupukMs) {
    digitalWrite(RELAY2_PIN, RELAY_OFF);
    prosesAktif = false;
    tahapPompa = 0;
    Serial.println("[POMPA] Pompa pupuk MATI. Seluruh siklus penyiraman & fertigasi selesai.");
  }
}

// ==================================================
// 9. EVALUASI FUZZY TSUKAMOTO (MODE AUTO)
// ==================================================
void evaluasiFuzzyTsukamoto(unsigned long sekarang) {
  if (modeSistem != "auto") return;
  if (prosesAktif) return; // Tunggu siklus pompa yang sedang berjalan selesai

  if (sekarang - waktuEvaluasi >= INTERVAL_EVALUASI) {
    waktuEvaluasi = sekarang;

    if (isnan(suhuUdara)) {
      Serial.println("[FUZZY] ⚠️ Pembacaan sensor DHT22 belum valid; evaluasi ditunda.");
      return;
    }

    kelembapanTanah = bacaKelembapanTanah();
    phTanah         = bacaPH();

    float durasiAir   = fuzzyPompaAir(kelembapanTanah, suhuUdara);
    float durasiPupuk = fuzzyPompaPupuk(kelembapanTanah, phTanah);

    lastDurasiAirSec   = durasiAir;
    lastDurasiPupukSec = durasiPupuk;
    durasiAirMs   = (unsigned long)(durasiAir * 1000.0);
    durasiPupukMs = (unsigned long)(durasiPupuk * 1000.0);

    Serial.println("\n╔════════════════════════════════════════════════════════════╗");
    Serial.println("║            HASIL EVALUASI FUZZY TSUKAMOTO ESP32            ║");
    Serial.println("╠════════════════════════════════════════════════════════════╣");
    Serial.printf("║ Suhu Lingkungan  : %6.1f °C                               ║\n", suhuUdara);
    Serial.printf("║ Kelembapan Udara : %6.1f %%                                ║\n", isnan(kelembapanUdara) ? 0.0 : kelembapanUdara);
    Serial.printf("║ Kelembapan Tanah : %6.1f %%                                ║\n", kelembapanTanah);
    Serial.printf("║ pH Tanah         : %6.2f                                  ║\n", phTanah);
    Serial.println("╠────────────────────────────────────────────────────────────╣");
    Serial.printf("║ Rekomendasi Siram Air : %5.2f detik (%5lu ms)               ║\n", durasiAir, durasiAirMs);
    Serial.printf("║ Rekomendasi Pupuk     : %5.2f detik (%5lu ms)               ║\n", durasiPupuk, durasiPupukMs);
    Serial.println("╚════════════════════════════════════════════════════════════╝");

    // Jalankan siklus pompa jika ada output fuzzy > 0
    if (durasiAirMs > 0 || durasiPupukMs > 0) {
      prosesAktif = true;

      if (durasiAirMs > 0) {
        digitalWrite(RELAY1_PIN, RELAY_ON);
        tahapPompa = 1;
        waktuTahap = millis();
        Serial.printf("[POMPA] Pompa air AKTIF selama %lu ms (%.2f detik)!\n", durasiAirMs, durasiAir);
      } else {
        // Jika hanya pupuk yang perlu menyala
        tahapPompa = 2;
        waktuTahap = millis();
      }
    } else {
      matikanPompa();
      Serial.println("[POMPA] Kondisi tanaman optimal. Tidak ada pompa yang diaktifkan.");
    }
  }
}

// ==================================================
// 10. KOMUNIKASI IoT REST API DENGAN SERVER WEB
// ==================================================
void jagaKoneksiWiFi(unsigned long sekarang) {
  if (WiFi.status() != WL_CONNECTED) {
    if (sekarang - waktuLastReconnect >= INTERVAL_RECONNECT) {
      waktuLastReconnect = sekarang;
      Serial.println("[WiFi] ⚠️ Koneksi WiFi terputus. Mencoba menghubungkan kembali...");
      WiFi.reconnect();
    }
  }
}

void kirimTelemetriKeServer() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  // Dapatkan nilai sensor terkini
  kelembapanTanah = bacaKelembapanTanah();
  phTanah         = bacaPH();

  // Susun payload JSON telemetri
  StaticJsonDocument<384> doc;
  doc["suhu"]       = isnan(suhuUdara) ? 28.0 : suhuUdara;
  doc["kelembapan"] = kelembapanTanah;
  doc["ph"]         = phTanah;
  doc["deviceId"]   = DEVICE_ID;

  // Status riil pompa dan hasil fuzzy
  bool statusAir   = (digitalRead(RELAY1_PIN) == RELAY_ON);
  bool statusPupuk = (digitalRead(RELAY2_PIN) == RELAY_ON);
  doc["pompaAir"]    = statusAir;
  doc["pompaPupuk"]  = statusPupuk;
  doc["durasiAir"]   = lastDurasiAirSec;
  doc["durasiPupuk"] = lastDurasiPupukSec;
  doc["tahapPompa"]  = tahapPompa;
  doc["modeFuzzy"]   = "Tsukamoto";

  String requestBody;
  serializeJson(doc, requestBody);

  bool isHttps = String(SERVER_TELEMETRY_URL).startsWith("https://");

  if (isHttps) {
    // Alokasi dinamis di heap untuk menghindari stack overflow pada ESP32
    WiFiClientSecure *secureClient = new WiFiClientSecure;
    if (!secureClient) {
      Serial.println("[HTTP] ❌ Memori heap tidak mencukupi untuk koneksi SSL!");
      return;
    }
    secureClient->setInsecure(); // Mengabaikan verifikasi SSL CA agar fleksibel dengan Cloud Render
    secureClient->setTimeout(8); // Timeout socket SSL 8 detik

    {
      // Lingkup blok agar objek 'http' di-destruct secara aman sebelum secureClient dihapus
      HTTPClient http;
      http.setTimeout(8000);
      http.setReuse(false);

      if (http.begin(*secureClient, SERVER_TELEMETRY_URL)) {
        http.addHeader("Content-Type", "application/json");
        Serial.println("[HTTP] 📡 Mengirim data telemetri ke server Cloud Render...");
        int httpCode = http.POST(requestBody);

        if (httpCode > 0) {
          String response = http.getString();
          Serial.printf("[HTTP] ✅ Berhasil! HTTP Code: %d\n", httpCode);

          StaticJsonDocument<384> resDoc;
          DeserializationError error = deserializeJson(resDoc, response);

          if (!error && resDoc["success"] == true) {
            String serverMode = resDoc["controls"]["mode"] | "auto";
            bool sPompaAir    = resDoc["controls"]["pompaAir"] | false;
            bool sPompaPupuk  = resDoc["controls"]["pompaPupuk"] | false;

            // Jika mode dari dashboard berubah
            if (serverMode != modeSistem) {
              modeSistem = serverMode;
              Serial.printf("[SISTEM] Mode operasional berganti ke: %s\n", modeSistem.c_str());
              if (modeSistem == "manual") {
                manualPompaAir   = sPompaAir;
                manualPompaPupuk = sPompaPupuk;
                eksekusiKontrolManual();
              } else {
                matikanPompa();
              }
            }

            // Jika dalam mode manual, ikuti perintah kontrol dari dashboard
            if (modeSistem == "manual") {
              manualPompaAir   = sPompaAir;
              manualPompaPupuk = sPompaPupuk;
              eksekusiKontrolManual();
            }
          }
        } else {
          Serial.printf("[HTTP] ❌ Gagal kirim POST telemetri, error: %s (Code: %d)\n", http.errorToString(httpCode).c_str(), httpCode);
          if (httpCode == -1) {
            Serial.println("       Tip: Pastikan URL server benar dan internet aktif pada ESP32.");
          }
        }
        http.end();
      } else {
        Serial.println("[HTTP] ❌ Gagal inisialisasi koneksi HTTPS.");
      }
    } // 'http' selesai di-destruct di sini secara aman

    delete secureClient; // Bebaskan memori SSL
  } else {
    WiFiClient plainClient;
    {
      HTTPClient http;
      http.setTimeout(5000);
      http.setReuse(false);

      if (http.begin(plainClient, SERVER_TELEMETRY_URL)) {
        http.addHeader("Content-Type", "application/json");
        Serial.println("[HTTP] 📡 Mengirim data telemetri ke server lokal...");
        int httpCode = http.POST(requestBody);

        if (httpCode > 0) {
          String response = http.getString();
          Serial.printf("[HTTP] ✅ Berhasil! HTTP Code: %d\n", httpCode);

          StaticJsonDocument<384> resDoc;
          DeserializationError error = deserializeJson(resDoc, response);

          if (!error && resDoc["success"] == true) {
            String serverMode = resDoc["controls"]["mode"] | "auto";
            bool sPompaAir    = resDoc["controls"]["pompaAir"] | false;
            bool sPompaPupuk  = resDoc["controls"]["pompaPupuk"] | false;

            if (serverMode != modeSistem) {
              modeSistem = serverMode;
              Serial.printf("[SISTEM] Mode operasional berganti ke: %s\n", modeSistem.c_str());
              if (modeSistem == "manual") {
                manualPompaAir   = sPompaAir;
                manualPompaPupuk = sPompaPupuk;
                eksekusiKontrolManual();
              } else {
                matikanPompa();
              }
            }

            if (modeSistem == "manual") {
              manualPompaAir   = sPompaAir;
              manualPompaPupuk = sPompaPupuk;
              eksekusiKontrolManual();
            }
          }
        } else {
          Serial.printf("[HTTP] ❌ Gagal kirim POST telemetri, error: %s (Code: %d)\n", http.errorToString(httpCode).c_str(), httpCode);
        }
        http.end();
      }
    }
  }
}

// ==================================================
// 11. SETUP
// ==================================================
void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println();
  Serial.println("=============================================================");
  Serial.println("🌱 ESP32 FUZZY TSUKAMOTO SMART IRRIGATION & FERTIGATION");
  Serial.println("📡 Dashboard AquaSmart IoT Connected Firmware");
  Serial.println("=============================================================");

  // Resolusi ADC 12-bit (0 - 4095)
  analogReadResolution(12);

  // Inisialisasi pin hardware
  pinMode(PH_DIGITAL_PIN, INPUT);
  pinMode(RELAY1_PIN, OUTPUT);
  pinMode(RELAY2_PIN, OUTPUT);

  // Pastikan pompa dalam keadaan mati saat startup
  matikanPompa();

  // Inisialisasi sensor DHT22
  dht.begin();

  // Pengecekan Kredensial WiFi Default
  if (String(WIFI_SSID) == "NAMA_WIFI_ANDA") {
    Serial.println("\n⚠️ [PERINGATAN UTAMA] SSID WiFi masih bernilai default 'NAMA_WIFI_ANDA'!");
    Serial.println("   Silakan ganti WIFI_SSID dan WIFI_PASSWORD pada baris 40-41.");
    Serial.println("   Gunakan jaringan WiFi 2.4 GHz (ESP32 tidak mendukung 5 GHz).\n");
  }

  // Koneksi WiFi ke Router / Hotspot
  Serial.print("Menghubungkan ke WiFi: ");
  Serial.println(WIFI_SSID);

  WiFi.disconnect(true);
  delay(100);
  WiFi.mode(WIFI_STA); // Pastikan ESP32 berada di mode Station murni
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ WiFi Berhasil Terhubung!");
    Serial.print("   SSID       : "); Serial.println(WiFi.SSID());
    Serial.print("   Alamat IP  : "); Serial.println(WiFi.localIP());
    Serial.print("   Kekuatan   : "); Serial.print(WiFi.RSSI()); Serial.println(" dBm");
  } else {
    Serial.println("\n❌ WiFi Belum Terhubung!");
    Serial.printf("   Status Code: %d (1=SSID Tidak Ditemukan, 4=Password Salah/Gagal, 6=Terputus)\n", WiFi.status());
    Serial.println("   Periksa nama SSID & Password di baris 40-41.");
    Serial.println("   Sistem tetap menjalankan penyiraman otomatis Fuzzy Tsukamoto secara offline (Failsafe Mode).");
  }

  // Inisialisasi patokan waktu agar sensor sempat membaca data awal sebelum telemetri pertama
  waktuKirimTelemetri = millis();
  waktuEvaluasi       = millis();
  waktuBacaDHT        = millis();

  Serial.println("Sistem Fuzzy Tsukamoto ESP32 Aktif & Siap Beroperasi.\n");
}

// ==================================================
// 12. LOOP UTAMA
// ==================================================
void loop() {
  unsigned long sekarang = millis();

  // 1. Baca Sensor Suhu & Kelembapan Udara DHT22 tiap 2 detik
  if (sekarang - waktuBacaDHT >= INTERVAL_DHT) {
    waktuBacaDHT = sekarang;
    float t = dht.readTemperature();
    float h = dht.readHumidity();

    if (!isnan(t) && !isnan(h)) {
      suhuUdara       = t;
      kelembapanUdara = h;
    }
  }

  // 2. Jika Mode AUTO: Jalankan siklus pompa dan evaluasi Fuzzy Tsukamoto
  if (modeSistem == "auto") {
    kelolaSiklusPompa(sekarang);
    evaluasiFuzzyTsukamoto(sekarang);
  }

  // 3. Jaga koneksi WiFi tetap aktif secara berkala tanpa memblokir sistem
  jagaKoneksiWiFi(sekarang);

  // 4. Kirim data telemetri ke server web dashboard tiap INTERVAL_TELEMETRI
  if (sekarang - waktuKirimTelemetri >= INTERVAL_TELEMETRI) {
    waktuKirimTelemetri = sekarang;
    kirimTelemetriKeServer();
  }
}
