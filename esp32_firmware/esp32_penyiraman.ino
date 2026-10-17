/*
 * ======================================================================================
 * PROYEK: SISTEM MONITORING & KONTROL PENYIRAMAN OTOMATIS BERBASIS IoT (ESP32)
 * KONEKSI: Web Dashboard AquaSmart IoT (REST API / JSON)
 * ======================================================================================
 * 
 * SENSOR & AKTUATOR:
 * 1. Sensor Suhu & Kelembapan Udara : DHT22 / DHT11 (Data Pin -> GPIO 4)
 * 2. Sensor Kelembapan Tanah        : Capacitive Soil Moisture v1.2 (Analog -> GPIO 34)
 * 3. Sensor pH Tanah                : Analog pH Sensor 4502C / SEN0161 (Analog -> GPIO 35)
 * 4. Relay 1 (Pompa Penyiraman Air) : Digital Output -> GPIO 26
 * 5. Relay 2 (Pompa Pupuk Cair NPK) : Digital Output -> GPIO 27
 * 
 * DEPENDENSI LIBRARY ARDUINO:
 * - WiFi.h (Bawaan ESP32 Core)
 * - HTTPClient.h (Bawaan ESP32 Core)
 * - ArduinoJson (v6.x oleh Benoit Blanchon)
 * - DHT sensor library (oleh Adafruit)
 * ======================================================================================
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "DHT.h"

// --- 1. KONFIGURASI JARINGAN & SERVER ---
const char* WIFI_SSID     = "NAMA_WIFI_ANDA";
const char* WIFI_PASSWORD = "PASSWORD_WIFI_ANDA";

// URL Server Backend Dashboard:
// - Lokal: "http://192.168.1.100:3000/api/telemetry"
// - Cloud (Render / Railway / Tunnel): "https://nama-aplikasi-anda.onrender.com/api/telemetry"
const char* SERVER_TELEMETRY_URL = "https://nama-aplikasi-anda.onrender.com/api/telemetry";

// --- 2. DEFINISI PIN HARDWARE ---
#define DHTPIN       4
#define DHTTYPE      DHT22   // Ganti DHT11 jika menggunakan tipe sensor DHT11
#define PIN_SOIL     34      // ADC1 CH6
#define PIN_PH       35      // ADC1 CH7
#define RELAY_AIR    26      // Aktif LOW (Relay Module umum)
#define RELAY_PUPUK  27      // Aktif LOW

DHT dht(DHTPIN, DHTTYPE);

// Kalibrasi Nilai ADC Capacitive Moisture Sensor
// Nilai di udara kering (Air Raw) sekitar 3200, di dalam air penuh (Water Raw) sekitar 1400
const int SOIL_AIR_VALUE   = 3200; 
const int SOIL_WATER_VALUE = 1400;

// Kalibrasi Sensor pH (Tegangan Netral pH 7 = ~2.5V -> ADC ~2048 pada 3.3V)
const float PH_SLOPE = 0.0035; 

// Interval Pengiriman Data Telemetri (ms)
unsigned long lastSendTime = 0;
const unsigned long SEND_INTERVAL = 3000; // Kirim data tiap 3 detik

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n==============================================");
  Serial.println("🌱 Menginisialisasi ESP32 Automatic Irrigation");
  Serial.println("==============================================");

  // Inisialisasi Relay (Default MATI / HIGH untuk relay active low)
  pinMode(RELAY_AIR, OUTPUT);
  pinMode(RELAY_PUPUK, OUTPUT);
  digitalWrite(RELAY_AIR, HIGH);
  digitalWrite(RELAY_PUPUK, HIGH);

  // Inisialisasi Sensor DHT
  dht.begin();

  // Koneksi WiFi
  Serial.print("Menghubungkan ke WiFi: ");
  Serial.println(WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ WiFi Terhubung!");
    Serial.print("IP ESP32: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\n❌ Gagal koneksi WiFi, akan mencoba lagi di background...");
  }
}

void loop() {
  // Pastikan koneksi WiFi tetap aktif
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
    delay(1000);
    return;
  }

  // Kirim data setiap interval yang ditentukan
  if (millis() - lastSendTime >= SEND_INTERVAL) {
    lastSendTime = millis();
    kirimDataSensorDanAmbilPerintah();
  }
}

void kirimDataSensorDanAmbilPerintah() {
  // 1. Baca Sensor Suhu
  float suhu = dht.readTemperature();
  if (isnan(suhu)) {
    Serial.println("⚠️ Gagal membaca sensor DHT! Menggunakan fallback...");
    suhu = 28.0;
  }

  // 2. Baca Sensor Kelembapan Tanah (ADC 0 - 4095)
  int soilRaw = analogRead(PIN_SOIL);
  // Konversi nilai mentah ADC ke persentase 0 - 100%
  float kelembapan = map(soilRaw, SOIL_AIR_VALUE, SOIL_WATER_VALUE, 0, 100);
  kelembapan = constrain(kelembapan, 0.0, 100.0);

  // 3. Baca Sensor pH Tanah (ADC Pin 35)
  int phRaw = analogRead(PIN_PH);
  // Perhitungan estimasi pH
  float ph = 7.0 + ((2048 - phRaw) * PH_SLOPE);
  ph = constrain(ph, 0.0, 14.0);

  Serial.println("\n--- [PEMBACAAN SENSOR] ---");
  Serial.printf("Suhu: %.1f °C | Kelembapan Tanah: %.1f %% | pH Tanah: %.2f\n", suhu, kelembapan, ph);

  // 4. Siapkan JSON Payload
  StaticJsonDocument<256> doc;
  doc["suhu"] = suhu;
  doc["kelembapan"] = kelembapan;
  doc["ph"] = ph;
  doc["deviceId"] = "ESP32-Greenhouse-1";

  String requestBody;
  serializeJson(doc, requestBody);

  // 5. Kirim HTTP POST ke Server Dashboard (Mendukung HTTP Lokal & HTTPS Cloud)
  HTTPClient http;
  if (String(SERVER_TELEMETRY_URL).startsWith("https://")) {
    WiFiClientSecure secureClient;
    secureClient.setInsecure(); // Mengabaikan validasi SSL fingerprint untuk kemudahan koneksi Cloud
    http.begin(secureClient, SERVER_TELEMETRY_URL);
  } else {
    WiFiClient plainClient;
    http.begin(plainClient, SERVER_TELEMETRY_URL);
  }
  http.addHeader("Content-Type", "application/json");

  int httpCode = http.POST(requestBody);

  if (httpCode > 0) {
    String response = http.getString();
    Serial.printf("HTTP Code: %d\n", httpCode);

    // 6. Parsing Respons Balasan dari Server untuk Mengendalikan Relay
    StaticJsonDocument<384> resDoc;
    DeserializationError error = deserializeJson(resDoc, response);

    if (!error && resDoc["success"] == true) {
      bool statusPompaAir   = resDoc["controls"]["pompaAir"];
      bool statusPompaPupuk = resDoc["controls"]["pompaPupuk"];

      // Eksekusi Relay (Active LOW: LOW = Nyala, HIGH = Mati)
      digitalWrite(RELAY_AIR, statusPompaAir ? LOW : HIGH);
      digitalWrite(RELAY_PUPUK, statusPompaPupuk ? LOW : HIGH);

      Serial.printf("⚡ Status Relay -> Air: %s | Pupuk: %s\n", 
        statusPompaAir ? "MENYALAKAN (ON)" : "MATI (OFF)",
        statusPompaPupuk ? "MENYALAKAN (ON)" : "MATI (OFF)"
      );
    }
  } else {
    Serial.printf("❌ Gagal mengirim HTTP POST, error: %s\n", http.errorToString(httpCode).c_str());
  }

  http.end();
}
