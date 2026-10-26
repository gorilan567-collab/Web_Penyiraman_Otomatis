const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Tracking session penyiraman untuk pencatatan database
let activeWateringSession = null;
let activePupukSession = null;
let simCycleCounter = 0;

// ==========================================
// SYSTEM STATE & CONFIGURATION
// ==========================================
let systemState = {
  telemetry: {
    suhu: 28.4,            // Celsius
    kelembapan: 45.0,        // % (Soil moisture)
    ph: 6.8,               // pH value
    timestamp: new Date().toISOString()
  },
  controls: {
    mode: 'auto',          // 'auto' | 'manual'
    pompaAir: false,       // true: Nyala, false: Mati
    pompaPupuk: false      // true: Nyala, false: Mati
  },
  settings: {
    thresholdKelembapanMin: 40,   // % -> Trigger penyiraman jika < 40%
    thresholdKelembapanMax: 65,   // % -> Berhenti menyiram jika >= 65%
    durasiSiramOtomatisDetik: 60,  // Detik durasi siram per siklus di mode auto (default 1 menit)
    dosisPupukMl: 25,             // Takaran dosis pupuk per penyiraman
    databaseIntervalMenit: 10,    // Interval input database: 10, 15, 30, atau 60 menit
    simulationActive: true        // Simulasi otomatis jika belum ada hardware riil
  },
  statusPerangkat: {
    online: true,
    tipe: 'Gateway Terhubung',
    terakhirSinkron: new Date().toLocaleTimeString('id-ID'),
    ipKlien: '127.0.0.1'
  },
  tangkiAir: 85,          // % kapasitas tangki air
  tangkiPupuk: 92,        // % kapasitas tangki pupuk cair
  totalAirHariIni: 4.5,   // Liter
  totalPupukHariIni: 75   // ml
};

// Histori data untuk grafik awal (20 data poin)
let historyData = [];
const initTime = Date.now();
for (let i = 19; i >= 0; i--) {
  const time = new Date(initTime - i * 3000);
  historyData.push({
    suhu: Number((27.8 + Math.sin(i * 0.4) * 1.2).toFixed(1)),
    kelembapan: Number((48 - (i * 0.25) + (Math.random() * 2 - 1)).toFixed(1)),
    ph: Number((6.7 + Math.sin(i * 0.2) * 0.15).toFixed(2)),
    pompaAir: false,
    pompaPupuk: false,
    timestamp: time.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  });
}

// Log aktivitas
let activityLogs = [
  {
    id: 1,
    waktu: new Date().toLocaleTimeString('id-ID'),
    kategori: 'SISTEM',
    tipe: 'info',
    pesan: 'Sistem Monitoring & Kontrol Penyiraman Otomatis berhasil diinisialisasi.'
  },
  {
    id: 2,
    waktu: new Date().toLocaleTimeString('id-ID'),
    kategori: 'MODE',
    tipe: 'success',
    pesan: 'Mode AUTO aktif. Pemantauan kelembapan otomatis berjalan.'
  }
];

function addLog(kategori, pesan, tipe = 'info') {
  const log = {
    id: Date.now(),
    waktu: new Date().toLocaleTimeString('id-ID'),
    kategori,
    tipe,
    pesan
  };
  activityLogs.unshift(log);
  if (activityLogs.length > 50) activityLogs.pop();
  return log;
}

// Broadcast pesan ke seluruh browser yang terhubung melalui WebSocket
function broadcast(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// ==========================================
// LOGIKA TIMERS, OTOMASI & PENCATATAN DATABASE
// ==========================================
let timerAutoSiram = null;

function onWateringStarted(mode, durasiExpected) {
  if (!activeWateringSession) {
    activeWateringSession = {
      startTime: Date.now(),
      mode: mode || systemState.controls.mode,
      kelembapanAwal: systemState.telemetry.kelembapan,
      durasiExpected: durasiExpected || systemState.settings.durasiSiramOtomatisDetik
    };
  }
}

function onWateringStopped(keteranganCustom) {
  if (activeWateringSession) {
    const elapsedSec = Math.max(1, Math.round((Date.now() - activeWateringSession.startTime) / 1000));
    const durasiDetik = Math.min(elapsedSec, 3600);
    // Estimasi debit penyiraman rata-rata 0.083 Liter / detik (~5 Liter / menit)
    const volumeEstimasi = Number((durasiDetik * 0.083).toFixed(2));
    const kelembapanAkhir = systemState.telemetry.kelembapan;
    const keterangan = keteranganCustom || (activeWateringSession.mode === 'auto'
      ? `Penyiraman otomatis selesai (Kelembapan awal: ${activeWateringSession.kelembapanAwal}%, akhir: ${kelembapanAkhir}%)`
      : `Penyiraman manual selesai (Durasi: ${durasiDetik} detik)`);

    db.logWateringEvent({
      tipe: 'AIR',
      mode: activeWateringSession.mode,
      durasi_detik: durasiDetik,
      volume_estimasi: volumeEstimasi,
      kelembapan_sebelum: activeWateringSession.kelembapanAwal,
      kelembapan_sesudah: kelembapanAkhir,
      keterangan
    });
    activeWateringSession = null;
  }
}

function onPupukStarted(mode, durasiExpected) {
  if (!activePupukSession) {
    activePupukSession = {
      startTime: Date.now(),
      mode: mode || systemState.controls.mode,
      kelembapanAwal: systemState.telemetry.kelembapan,
      durasiExpected: durasiExpected || 10
    };
  }
}

function onPupukStopped(keteranganCustom) {
  if (activePupukSession) {
    const elapsedSec = Math.max(1, Math.round((Date.now() - activePupukSession.startTime) / 1000));
    const durasiDetik = Math.min(elapsedSec, 3600);
    const volumeEstimasi = Number((durasiDetik * 0.05).toFixed(2));
    const kelembapanAkhir = systemState.telemetry.kelembapan;
    const keterangan = keteranganCustom || `Penyiraman pupuk cair selesai dialirkan (${durasiDetik} detik)`;

    db.logWateringEvent({
      tipe: 'PUPUK',
      mode: activePupukSession.mode,
      durasi_detik: durasiDetik,
      volume_estimasi: volumeEstimasi,
      kelembapan_sebelum: activePupukSession.kelembapanAwal,
      kelembapan_sesudah: kelembapanAkhir,
      keterangan
    });
    activePupukSession = null;
  }
}

function startAutoWateringTimer() {
  if (timerAutoSiram) clearTimeout(timerAutoSiram);

  const durasiMs = systemState.settings.durasiSiramOtomatisDetik * 1000;
  timerAutoSiram = setTimeout(() => {
    if (systemState.controls.pompaAir && systemState.controls.mode === 'auto') {
      systemState.controls.pompaAir = false;
      onWateringStopped(`Penyiraman otomatis selesai setelah ${systemState.settings.durasiSiramOtomatisDetik} detik.`);
      addLog('AUTO', `Penyiraman otomatis selesai setelah ${systemState.settings.durasiSiramOtomatisDetik} detik.`, 'info');
      broadcast({
        type: 'CONTROLS_UPDATE',
        controls: systemState.controls,
        log: activityLogs[0]
      });
    }
  }, durasiMs);
}

// Evaluasi sensor pada mode otomatis
function checkAutoRules() {
  if (systemState.controls.mode !== 'auto') return;

  const moisture = systemState.telemetry.kelembapan;
  const thresholdMin = systemState.settings.thresholdKelembapanMin;
  const thresholdMax = systemState.settings.thresholdKelembapanMax;

  // Jika kelembapan tanah di bawah batas minimal dan pompa belum menyala
  if (moisture < thresholdMin && !systemState.controls.pompaAir) {
    systemState.controls.pompaAir = true;
    onWateringStarted('auto', systemState.settings.durasiSiramOtomatisDetik);
    addLog('AUTO', `Kelembapan tanah rendah (${moisture}% < ${thresholdMin}%). Pompa air otomatis dinyalakan!`, 'warning');
    startAutoWateringTimer();
    broadcast({
      type: 'CONTROLS_UPDATE',
      controls: systemState.controls,
      log: activityLogs[0]
    });
  }
  // Jika kelembapan sudah mencapai target maksimal saat menyiram
  else if (moisture >= thresholdMax && systemState.controls.pompaAir) {
    systemState.controls.pompaAir = false;
    if (timerAutoSiram) clearTimeout(timerAutoSiram);
    onWateringStopped(`Target kelembapan maksimal tercapai (${moisture}% >= ${thresholdMax}%).`);
    addLog('AUTO', `Target kelembapan tercapai (${moisture}% >= ${thresholdMax}%). Pompa air dimatikan.`, 'success');
    broadcast({
      type: 'CONTROLS_UPDATE',
      controls: systemState.controls,
      log: activityLogs[0]
    });
  }
}

// ==========================================
// SIMULATOR REALISTIS (JIKA BELUM ADA HARDWARE)
// ==========================================
let lastDbLogTime = Date.now();

setInterval(() => {
  if (!systemState.settings.simulationActive) return;

  // 1. Suhu: Fluktuasi natural lingkungan (26.5°C - 31.5°C)
  const suhuDelta = (Math.random() - 0.48) * 0.15;
  let newSuhu = Number((systemState.telemetry.suhu + suhuDelta).toFixed(1));
  if (newSuhu < 25.0) newSuhu = 25.1;
  if (newSuhu > 34.0) newSuhu = 33.9;
  systemState.telemetry.suhu = newSuhu;

  // 2. Kelembapan Tanah: 
  // Jika pompa air menyala -> kelembapan naik cepat (+1.8% / cycle)
  // Jika pompa air mati -> kelembapan berkurang perlahan karena evaporasi & serapan akar (-0.3% / cycle)
  let moistureDelta = 0;
  if (systemState.controls.pompaAir) {
    moistureDelta = 1.6 + Math.random() * 0.6;
    systemState.tangkiAir = Math.max(5, Number((systemState.tangkiAir - 0.15).toFixed(1)));
    systemState.totalAirHariIni = Number((systemState.totalAirHariIni + 0.05).toFixed(2));
  } else {
    // Pengurangan lebih cepat jika suhu tinggi
    const evapFactor = systemState.telemetry.suhu > 30 ? 0.35 : 0.2;
    moistureDelta = -(evapFactor + Math.random() * 0.1);
  }

  let newMoisture = Number((systemState.telemetry.kelembapan + moistureDelta).toFixed(1));
  if (newMoisture < 15) newMoisture = 15.0;
  if (newMoisture > 92) newMoisture = 92.0;
  systemState.telemetry.kelembapan = newMoisture;

  // 3. pH Tanah: Fluktuasi lambat (6.2 - 7.2)
  // Jika pompa pupuk aktif -> ada sedikit efek penyesuaian pH
  let phDelta = (Math.random() - 0.5) * 0.03;
  if (systemState.controls.pompaPupuk) {
    phDelta += 0.04;
    systemState.tangkiPupuk = Math.max(5, Number((systemState.tangkiPupuk - 0.2).toFixed(1)));
    systemState.totalPupukHariIni = Math.round(systemState.totalPupukHariIni + 1);
  }
  let newPh = Number((systemState.telemetry.ph + phDelta).toFixed(2));
  if (newPh < 5.5) newPh = 5.6;
  if (newPh > 8.0) newPh = 7.9;
  systemState.telemetry.ph = newPh;

  systemState.telemetry.timestamp = new Date().toISOString();
  systemState.statusPerangkat.terakhirSinkron = new Date().toLocaleTimeString('id-ID');

  // Push ke history (maks 30 poin)
  const timeFormatted = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const point = {
    suhu: systemState.telemetry.suhu,
    kelembapan: systemState.telemetry.kelembapan,
    ph: systemState.telemetry.ph,
    pompaAir: systemState.controls.pompaAir,
    pompaPupuk: systemState.controls.pompaPupuk,
    timestamp: timeFormatted
  };

  historyData.push(point);
  if (historyData.length > 30) historyData.shift();

  // Evaluasi mode otomatis
  checkAutoRules();

  // Simpan data periodik ke database SQLite berdasarkan interval (10, 15, 30, atau 60 menit)
  const dbIntervalMinutes = systemState.settings.databaseIntervalMenit || 10;
  const dbIntervalMs = dbIntervalMinutes * 60 * 1000;
  if (Date.now() - lastDbLogTime >= dbIntervalMs) {
    lastDbLogTime = Date.now();
    db.logSensorData({
      suhu: systemState.telemetry.suhu,
      kelembapan: systemState.telemetry.kelembapan,
      ph: systemState.telemetry.ph,
      pompaAir: systemState.controls.pompaAir,
      pompaPupuk: systemState.controls.pompaPupuk,
      source: 'Sensor Gateway'
    });
    addLog('DATABASE', `Data sensor otomatis dicatat ke database (Interval ${dbIntervalMinutes} menit).`, 'info');
  }

  // Broadcast data terbaru ke semua browser
  broadcast({
    type: 'TELEMETRY_UPDATE',
    telemetry: systemState.telemetry,
    historyPoint: point,
    tangkiAir: systemState.tangkiAir,
    tangkiPupuk: systemState.tangkiPupuk,
    totalAirHariIni: systemState.totalAirHariIni,
    totalPupukHariIni: systemState.totalPupukHariIni,
    controls: systemState.controls
  });
}, 2500);

// ==========================================
// REST API ROUTES
// ==========================================

// 1. Ambil status lengkap sistem
app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    systemState,
    history: historyData,
    logs: activityLogs
  });
});

// 2. Endpoint telemetry untuk ESP32 / IoT Hardware sungguhan
app.post('/api/telemetry', (req, res) => {
  const { suhu, kelembapan, ph, deviceId, pompaAir, pompaPupuk, durasiAir, durasiPupuk, modeFuzzy } = req.body;

  if (suhu !== undefined) systemState.telemetry.suhu = Number(parseFloat(suhu).toFixed(1));
  if (kelembapan !== undefined) systemState.telemetry.kelembapan = Number(parseFloat(kelembapan).toFixed(1));
  if (ph !== undefined) systemState.telemetry.ph = Number(parseFloat(ph).toFixed(2));

  systemState.telemetry.timestamp = new Date().toISOString();
  systemState.statusPerangkat.online = true;
  systemState.statusPerangkat.tipe = deviceId ? `ESP32 (${deviceId})${modeFuzzy ? ` [${modeFuzzy}]` : ''}` : 'Perangkat IoT Terhubung';
  systemState.statusPerangkat.terakhirSinkron = new Date().toLocaleTimeString('id-ID');
  systemState.statusPerangkat.ipKlien = req.ip || req.socket.remoteAddress;

  // Nonaktifkan simulator jika hardware riil mulai mengirim data
  if (systemState.settings.simulationActive) {
    systemState.settings.simulationActive = false;
    addLog('HARDWARE', `Perangkat IoT fisik (${systemState.statusPerangkat.tipe}) terdeteksi. Simulasi dinonaktifkan.`, 'success');
  }

  // Sinkronisasi status riil pompa dari ESP32 saat Mode AUTO
  if (systemState.controls.mode === 'auto') {
    if (pompaAir !== undefined) {
      const isAirOn = Boolean(pompaAir);
      if (isAirOn && !systemState.controls.pompaAir) {
        onWateringStarted('auto', durasiAir);
        addLog('FUZZY', `Pompa air AKTIF oleh ESP32 (Fuzzy: ${durasiAir || 0} detik).`, 'success');
      } else if (!isAirOn && systemState.controls.pompaAir) {
        onWateringStopped('Siklus pompa air Fuzzy selesai.');
        addLog('FUZZY', 'Pompa air MATI (Fuzzy selesai).', 'info');
      }
      systemState.controls.pompaAir = isAirOn;
    }

    if (pompaPupuk !== undefined) {
      const isPupukOn = Boolean(pompaPupuk);
      if (isPupukOn && !systemState.controls.pompaPupuk) {
        onPupukStarted('auto', durasiPupuk);
        addLog('FUZZY', `Pompa pupuk AKTIF oleh ESP32 (Fuzzy: ${durasiPupuk || 0} detik).`, 'success');
      } else if (!isPupukOn && systemState.controls.pompaPupuk) {
        onPupukStopped('Siklus pompa pupuk Fuzzy selesai.');
        addLog('FUZZY', 'Pompa pupuk MATI (Fuzzy selesai).', 'info');
      }
      systemState.controls.pompaPupuk = isPupukOn;
    }
  }

  // Catat langsung ke database SQLite dari perangkat fisik
  db.logSensorData({
    suhu: systemState.telemetry.suhu,
    kelembapan: systemState.telemetry.kelembapan,
    ph: systemState.telemetry.ph,
    pompaAir: systemState.controls.pompaAir,
    pompaPupuk: systemState.controls.pompaPupuk,
    source: deviceId ? `ESP32 (${deviceId})` : 'ESP32'
  });

  const timeFormatted = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const point = {
    suhu: systemState.telemetry.suhu,
    kelembapan: systemState.telemetry.kelembapan,
    ph: systemState.telemetry.ph,
    pompaAir: systemState.controls.pompaAir,
    pompaPupuk: systemState.controls.pompaPupuk,
    timestamp: timeFormatted
  };

  historyData.push(point);
  if (historyData.length > 30) historyData.shift();

  // Evaluasi aturan server hanya jika simulasi masih aktif
  if (systemState.settings.simulationActive) {
    checkAutoRules();
  }

  broadcast({
    type: 'TELEMETRY_UPDATE',
    telemetry: systemState.telemetry,
    historyPoint: point,
    controls: systemState.controls,
    statusPerangkat: systemState.statusPerangkat
  });

  // Kirim balik status aktuator agar ESP32 bisa langsung mengontrol relay fisik
  res.json({
    success: true,
    controls: systemState.controls,
    timestamp: Date.now()
  });
});

// 3. Kontrol pompa & mode dari web dashboard
app.post('/api/controls', (req, res) => {
  const { mode, pompaAir, pompaPupuk, durasiSiram, volumePupuk, durasiPupuk } = req.body;
  let logItem = null;

  // Ganti Mode (Auto vs Manual)
  if (mode !== undefined && (mode === 'auto' || mode === 'manual')) {
    systemState.controls.mode = mode;
    if (mode === 'manual') {
      logItem = addLog('MODE', 'Mode diubah ke MANUAL oleh Operator. Tombol penyiraman manual aktif.', 'warning');
    } else {
      logItem = addLog('MODE', 'Mode diubah ke AUTO. Sistem otomatis aktif, tombol manual dinonaktifkan.', 'success');
      checkAutoRules();
    }
  }

  // Kontrol Pompa Air
  if (pompaAir !== undefined) {
    const isNowOn = Boolean(pompaAir);
    // Jika sistem dalam Mode Auto, blokir penyalaan manual
    if (isNowOn && systemState.controls.mode === 'auto') {
      return res.status(400).json({
        success: false,
        message: 'Tombol penyiraman dinonaktifkan saat Mode Auto aktif.',
        controls: systemState.controls
      });
    }

    if (isNowOn && !systemState.controls.pompaAir) {
      const durasi = Math.min(60, Math.max(1, Number(durasiSiram) || 15));
      onWateringStarted('manual', durasi);
      logItem = addLog('POMPA AIR', `Penyiraman Air DINYALAKAN (Manual - durasi ${durasi} detik).`, 'success');

      // Auto-off timer untuk penyiraman manual
      if (durasi && durasi > 0) {
        setTimeout(() => {
          if (systemState.controls.pompaAir) {
            systemState.controls.pompaAir = false;
            onWateringStopped(`Penyiraman air manual selesai (${durasi} detik).`);
            addLog('POMPA AIR', `Penyiraman air selesai otomatis (${durasi} detik).`, 'info');
            broadcast({
              type: 'CONTROLS_UPDATE',
              controls: systemState.controls,
              log: activityLogs[0]
            });
          }
        }, durasi * 1000);
      }
    } else if (!isNowOn && systemState.controls.pompaAir) {
      onWateringStopped('Penyiraman air dimatikan secara manual.');
      logItem = addLog('POMPA AIR', 'Penyiraman Air DIMATIKAN.', 'info');
    }
    systemState.controls.pompaAir = isNowOn;
  }

  // Kontrol Pompa Pupuk
  if (pompaPupuk !== undefined) {
    const isNowOn = Boolean(pompaPupuk);
    // Jika sistem dalam Mode Auto, blokir penyalaan manual
    if (isNowOn && systemState.controls.mode === 'auto') {
      return res.status(400).json({
        success: false,
        message: 'Tombol penyiraman pupuk dinonaktifkan saat Mode Auto aktif.',
        controls: systemState.controls
      });
    }

    if (isNowOn && !systemState.controls.pompaPupuk) {
      const durasi = Math.min(60, Math.max(1, Number(durasiPupuk || durasiSiram) || 10));
      onPupukStarted('manual', durasi);
      logItem = addLog('POMPA PUPUK', `Penyiraman Pupuk Cair DIAKTIFKAN (${durasi} detik).`, 'success');

      // Matikan otomatis setelah durasi detik
      if (durasi && durasi > 0) {
        setTimeout(() => {
          if (systemState.controls.pompaPupuk) {
            systemState.controls.pompaPupuk = false;
            onPupukStopped(`Penyiraman pupuk selesai dialirkan (${durasi} detik).`);
            addLog('POMPA PUPUK', `Penyiraman pupuk selesai dialirkan (${durasi} detik).`, 'info');
            broadcast({
              type: 'CONTROLS_UPDATE',
              controls: systemState.controls,
              log: activityLogs[0]
            });
          }
        }, durasi * 1000);
      }
    } else if (!isNowOn && systemState.controls.pompaPupuk) {
      onPupukStopped('Pompa pupuk dimatikan.');
      logItem = addLog('POMPA PUPUK', 'Pompa Pupuk DIMATIKAN.', 'info');
    }
    systemState.controls.pompaPupuk = isNowOn;
  }

  broadcast({
    type: 'CONTROLS_UPDATE',
    controls: systemState.controls,
    log: logItem || activityLogs[0]
  });

  res.json({
    success: true,
    controls: systemState.controls,
    log: logItem
  });
});

// 4. Ubah Pengaturan Threshold & Interval
app.post('/api/settings', (req, res) => {
  const { thresholdKelembapanMin, thresholdKelembapanMax, durasiSiramOtomatisDetik, databaseIntervalMenit, simulationActive } = req.body;

  if (thresholdKelembapanMin !== undefined) systemState.settings.thresholdKelembapanMin = Number(thresholdKelembapanMin);
  if (thresholdKelembapanMax !== undefined) systemState.settings.thresholdKelembapanMax = Number(thresholdKelembapanMax);
  if (durasiSiramOtomatisDetik !== undefined) systemState.settings.durasiSiramOtomatisDetik = Number(durasiSiramOtomatisDetik);
  if (databaseIntervalMenit !== undefined) {
    const parsed = Number(databaseIntervalMenit);
    if ([10, 15, 30, 60].includes(parsed)) {
      systemState.settings.databaseIntervalMenit = parsed;
      lastDbLogTime = Date.now();
    }
  }
  if (simulationActive !== undefined) systemState.settings.simulationActive = Boolean(simulationActive);

  addLog('PENGATURAN', `Konfigurasi diubah: Min ${systemState.settings.thresholdKelembapanMin}%, Max ${systemState.settings.thresholdKelembapanMax}%, Durasi ${systemState.settings.durasiSiramOtomatisDetik}s, DB Interval ${systemState.settings.databaseIntervalMenit}m.`, 'info');

  broadcast({
    type: 'SETTINGS_UPDATE',
    settings: systemState.settings,
    log: activityLogs[0]
  });

  res.json({
    success: true,
    settings: systemState.settings
  });
});

// Konfigurasi interval input database
app.get('/api/database/config', (req, res) => {
  const intervalMenit = systemState.settings.databaseIntervalMenit || 10;
  res.json({
    success: true,
    databaseIntervalMenit: intervalMenit,
    lastDbLogTime,
    nextDbLogTime: lastDbLogTime + intervalMenit * 60 * 1000
  });
});

app.post('/api/database/config', (req, res) => {
  const { databaseIntervalMenit } = req.body;
  const validIntervals = [10, 15, 30, 60];
  const parsed = Number(databaseIntervalMenit);
  if (!validIntervals.includes(parsed)) {
    return res.status(400).json({ success: false, error: 'Interval harus salah satu dari: 10, 15, 30, atau 60 menit.' });
  }
  systemState.settings.databaseIntervalMenit = parsed;
  lastDbLogTime = Date.now();
  addLog('PENGATURAN', `Interval input database diubah menjadi ${parsed} menit.`, 'info');
  broadcast({
    type: 'SETTINGS_UPDATE',
    settings: systemState.settings,
    lastDbLogTime,
    nextDbLogTime: lastDbLogTime + parsed * 60 * 1000
  });
  res.json({
    success: true,
    databaseIntervalMenit: parsed,
    lastDbLogTime,
    nextDbLogTime: lastDbLogTime + parsed * 60 * 1000
  });
});

// Input manual langsung ke database saat tombol ditekan
app.post('/api/database/input-now', (req, res) => {
  const result = db.logSensorData({
    suhu: systemState.telemetry.suhu,
    kelembapan: systemState.telemetry.kelembapan,
    ph: systemState.telemetry.ph,
    pompaAir: systemState.controls.pompaAir,
    pompaPupuk: systemState.controls.pompaPupuk,
    source: req.body.source || 'Sensor Gateway'
  });
  lastDbLogTime = Date.now();
  addLog('DATABASE', 'Data sensor langsung dicatat ke database oleh pengguna.', 'success');
  broadcast({
    type: 'DATABASE_UPDATED',
    lastDbLogTime,
    nextDbLogTime: lastDbLogTime + (systemState.settings.databaseIntervalMenit || 10) * 60 * 1000
  });
  res.json({
    success: true,
    message: 'Data sensor berhasil dicatat ke database.',
    lastInsertRowid: result?.lastInsertRowid,
    nextDbLogTime: lastDbLogTime + (systemState.settings.databaseIntervalMenit || 10) * 60 * 1000
  });
});

// ==========================================
// 5. DATABASE & ARSIP HISTORIS KESELURUHAN
// ==========================================

// Ringkasan metrik statistik sensor & penyiraman
app.get('/api/database/summary', (req, res) => {
  try {
    const summary = db.getDatabaseSummary();
    res.json({ success: true, ...summary });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Query data arsip sensor (pagination & filter tanggal)
app.get('/api/database/sensor', (req, res) => {
  try {
    const result = db.getSensorLogs(req.query);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Query data arsip riwayat penyiraman (pagination & filter jenis / mode / tanggal)
app.get('/api/database/watering', (req, res) => {
  try {
    const result = db.getWateringLogs(req.query);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Data chart historis untuk halaman database
app.get('/api/database/chart', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 60;
    const data = db.getChartHistory(limit);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Ekspor data ke file CSV untuk diunduh (Excel / Google Sheets)
app.get('/api/database/export/:type', (req, res) => {
  const type = req.params.type;
  try {
    const csv = db.exportToCSV(type);
    const filename = `aquasmart_${type}_export_${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(csv);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Pembersihan riwayat data database
app.post('/api/database/clear', (req, res) => {
  try {
    const { target } = req.body;
    const result = db.clearLogs(target);
    addLog('DATABASE', `Data riwayat (${target || 'all'}) dibersihkan oleh Operator.`, 'warning');
    broadcast({
      type: 'DATABASE_CLEARED',
      target,
      log: activityLogs[0]
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// WEBSOCKET HANDLERS
// ==========================================
wss.on('connection', (ws) => {
  // Kirim snapshot state saat pertama konek
  ws.send(JSON.stringify({
    type: 'INIT_STATE',
    systemState,
    history: historyData,
    logs: activityLogs
  }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.action === 'SET_MODE') {
        systemState.controls.mode = data.mode;
        addLog('MODE', `Mode diubah ke ${data.mode.toUpperCase()}`, 'info');
        broadcast({ type: 'CONTROLS_UPDATE', controls: systemState.controls, log: activityLogs[0] });
      } else if (data.action === 'TOGGLE_PUMP_AIR') {
        systemState.controls.pompaAir = !systemState.controls.pompaAir;
        if (systemState.controls.pompaAir) {
          onWateringStarted(systemState.controls.mode);
        } else {
          onWateringStopped('Pompa air dimatikan via switch manual');
        }
        addLog('POMPA AIR', `Pompa air ${systemState.controls.pompaAir ? 'MENYALA' : 'MATI'}`, systemState.controls.pompaAir ? 'success' : 'info');
        broadcast({ type: 'CONTROLS_UPDATE', controls: systemState.controls, log: activityLogs[0] });
      } else if (data.action === 'TOGGLE_PUMP_PUPUK') {
        systemState.controls.pompaPupuk = !systemState.controls.pompaPupuk;
        if (systemState.controls.pompaPupuk) {
          onPupukStarted(systemState.controls.mode);
        } else {
          onPupukStopped('Pompa pupuk dimatikan via switch manual');
        }
        addLog('POMPA PUPUK', `Pompa pupuk ${systemState.controls.pompaPupuk ? 'MENYALA' : 'MATI'}`, systemState.controls.pompaPupuk ? 'success' : 'info');
        broadcast({ type: 'CONTROLS_UPDATE', controls: systemState.controls, log: activityLogs[0] });
      }
    } catch (e) {
      console.error('WS Error:', e.message);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🌱 AquaSmart IoT Server Running on: http://0.0.0.0:${PORT}`);
  console.log(`📡 WebSocket Ready on: ws://0.0.0.0:${PORT}`);
  console.log(`⚙️ Mode Default: ${systemState.controls.mode.toUpperCase()}`);
  console.log(`💧 Penyiraman Otomatis: Aktif jika Kelembapan < ${systemState.settings.thresholdKelembapanMin}%`);
  console.log(`====================================================`);
});
