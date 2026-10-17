/**
 * AquaSmart IoT - Database Module
 * Uses Node.js 22.5+ built-in node:sqlite (DatabaseSync)
 * Creates tables, handles insertions, seed data, queries, and CSV exports.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'aquasmart.db');
const db = new DatabaseSync(DB_PATH);

// Enable WAL mode for better concurrency and performance
db.exec('PRAGMA journal_mode = WAL;');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS sensor_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    suhu REAL NOT NULL,
    kelembapan REAL NOT NULL,
    ph REAL NOT NULL,
    pompa_air INTEGER DEFAULT 0,
    pompa_pupuk INTEGER DEFAULT 0,
    source TEXT DEFAULT 'simulator'
  );

  CREATE TABLE IF NOT EXISTS watering_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    tipe TEXT NOT NULL,
    mode TEXT NOT NULL,
    durasi_detik INTEGER NOT NULL,
    volume_estimasi REAL NOT NULL,
    kelembapan_sebelum REAL,
    kelembapan_sesudah REAL,
    keterangan TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sensor_time ON sensor_logs(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_watering_time ON watering_logs(timestamp DESC);
`);

// Seed initial realistic data if database is empty so user has immediate rich data
function seedInitialDataIfEmpty() {
  const sensorCount = db.prepare('SELECT COUNT(*) as count FROM sensor_logs').get().count;
  const wateringCount = db.prepare('SELECT COUNT(*) as count FROM watering_logs').get().count;

  if (sensorCount === 0) {
    const insertSensor = db.prepare(`
      INSERT INTO sensor_logs (timestamp, suhu, kelembapan, ph, pompa_air, pompa_pupuk, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const now = Date.now();
    // Seed 60 sensor points across the past 24 hours
    for (let i = 59; i >= 0; i--) {
      const pastTime = new Date(now - i * 24 * 60000).toISOString();
      const suhu = Number((27.5 + Math.sin(i * 0.3) * 2.2 + (Math.random() * 0.4 - 0.2)).toFixed(1));
      const kelembapan = Number((42.0 + Math.cos(i * 0.25) * 8.5 + (Math.random() * 1.5 - 0.7)).toFixed(1));
      const ph = Number((6.6 + Math.sin(i * 0.15) * 0.35 + (Math.random() * 0.1 - 0.05)).toFixed(2));
      const pompaAir = (kelembapan < 40) ? 1 : 0;
      const pompaPupuk = (i % 18 === 0) ? 1 : 0;

      insertSensor.run(pastTime, suhu, kelembapan, ph, pompaAir, pompaPupuk, 'simulator');
    }
  }

  if (wateringCount === 0) {
    const insertWatering = db.prepare(`
      INSERT INTO watering_logs (timestamp, tipe, mode, durasi_detik, volume_estimasi, kelembapan_sebelum, kelembapan_sesudah, keterangan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = Date.now();
    const seedEvents = [
      {
        hoursAgo: 22,
        tipe: 'AIR',
        mode: 'AUTO',
        durasi_detik: 15,
        volume_estimasi: 1.25,
        kelembapan_sebelum: 38.2,
        kelembapan_sesudah: 66.5,
        keterangan: 'Penyiraman otomatis: Kelembapan tanah di bawah batas minimum (38.2% < 40%)'
      },
      {
        hoursAgo: 16,
        tipe: 'PUPUK',
        mode: 'MANUAL',
        durasi_detik: 5,
        volume_estimasi: 25.0,
        kelembapan_sebelum: 54.0,
        kelembapan_sesudah: 56.2,
        keterangan: 'Aplikasi fertigasi pupuk cair NPK organik teratur oleh Operator'
      },
      {
        hoursAgo: 11,
        tipe: 'AIR',
        mode: 'AUTO',
        durasi_detik: 15,
        volume_estimasi: 1.25,
        kelembapan_sebelum: 39.0,
        kelembapan_sesudah: 67.1,
        keterangan: 'Penyiraman otomatis siklus siang hari: Sensor mendeteksi tanah kering'
      },
      {
        hoursAgo: 5,
        tipe: 'AIR',
        mode: 'MANUAL',
        durasi_detik: 30,
        volume_estimasi: 2.5,
        kelembapan_sebelum: 44.5,
        kelembapan_sesudah: 72.0,
        keterangan: 'Penyiraman manual: Siram ekstra sore hari (Quick Burst 30 detik)'
      },
      {
        hoursAgo: 1.5,
        tipe: 'PUPUK',
        mode: 'MANUAL',
        durasi_detik: 5,
        volume_estimasi: 25.0,
        kelembapan_sebelum: 58.0,
        kelembapan_sesudah: 60.1,
        keterangan: 'Dosis pupuk harian kedua: Penambahan nutrisi mikro'
      }
    ];

    seedEvents.forEach(e => {
      const timeStr = new Date(now - e.hoursAgo * 3600000).toISOString();
      insertWatering.run(
        timeStr,
        e.tipe,
        e.mode,
        e.durasi_detik,
        e.volume_estimasi,
        e.kelembapan_sebelum,
        e.kelembapan_sesudah,
        e.keterangan
      );
    });
  }
}

seedInitialDataIfEmpty();

// Insert a single sensor log
function logSensorData({ suhu, kelembapan, ph, pompaAir, pompaPupuk, source = 'simulator' }) {
  try {
    const stmt = db.prepare(`
      INSERT INTO sensor_logs (timestamp, suhu, kelembapan, ph, pompa_air, pompa_pupuk, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      new Date().toISOString(),
      Number(parseFloat(suhu).toFixed(1)),
      Number(parseFloat(kelembapan).toFixed(1)),
      Number(parseFloat(ph).toFixed(2)),
      pompaAir ? 1 : 0,
      pompaPupuk ? 1 : 0,
      source
    );
    return result;
  } catch (err) {
    console.error('Error logging sensor data:', err);
  }
}

// Insert watering log
function logWateringEvent({ tipe, mode, durasi_detik, volume_estimasi, kelembapan_sebelum, kelembapan_sesudah, keterangan }) {
  try {
    const stmt = db.prepare(`
      INSERT INTO watering_logs (timestamp, tipe, mode, durasi_detik, volume_estimasi, kelembapan_sebelum, kelembapan_sesudah, keterangan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      new Date().toISOString(),
      tipe.toUpperCase(),
      mode.toUpperCase(),
      durasi_detik || 0,
      volume_estimasi || 0,
      kelembapan_sebelum !== undefined ? Number(kelembapan_sebelum) : null,
      kelembapan_sesudah !== undefined ? Number(kelembapan_sesudah) : null,
      keterangan || ''
    );
    return result;
  } catch (err) {
    console.error('Error logging watering event:', err);
  }
}

// Get sensor logs with filtering and pagination
function getSensorLogs({ startDate, endDate, search, page = 1, limit = 20 }) {
  let whereClauses = [];
  let params = [];

  if (startDate) {
    whereClauses.push('timestamp >= ?');
    params.push(startDate);
  }
  if (endDate) {
    whereClauses.push('timestamp <= ?');
    params.push(endDate);
  }
  if (search) {
    whereClauses.push('(source LIKE ? OR timestamp LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  // Get total count
  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM sensor_logs ${whereSql}`);
  const total = countStmt.get(...params).total;

  // Get page data
  const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
  const dataStmt = db.prepare(`
    SELECT * FROM sensor_logs 
    ${whereSql} 
    ORDER BY timestamp DESC 
    LIMIT ? OFFSET ?
  `);
  const data = dataStmt.all(...params, parseInt(limit), offset);

  return {
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    totalPages: Math.ceil(total / parseInt(limit)) || 1,
    data
  };
}

// Get watering logs with filtering and pagination
function getWateringLogs({ startDate, endDate, tipe, mode, search, page = 1, limit = 20 }) {
  let whereClauses = [];
  let params = [];

  if (startDate) {
    whereClauses.push('timestamp >= ?');
    params.push(startDate);
  }
  if (endDate) {
    whereClauses.push('timestamp <= ?');
    params.push(endDate);
  }
  if (tipe && tipe !== 'ALL') {
    whereClauses.push('tipe = ?');
    params.push(tipe.toUpperCase());
  }
  if (mode && mode !== 'ALL') {
    whereClauses.push('mode = ?');
    params.push(mode.toUpperCase());
  }
  if (search) {
    whereClauses.push('(keterangan LIKE ? OR tipe LIKE ? OR mode LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM watering_logs ${whereSql}`);
  const total = countStmt.get(...params).total;

  const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
  const dataStmt = db.prepare(`
    SELECT * FROM watering_logs 
    ${whereSql} 
    ORDER BY timestamp DESC 
    LIMIT ? OFFSET ?
  `);
  const data = dataStmt.all(...params, parseInt(limit), offset);

  return {
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    totalPages: Math.ceil(total / parseInt(limit)) || 1,
    data
  };
}

// Get overall statistics summary for the metrics cards
function getDatabaseSummary() {
  const sensorStats = db.prepare(`
    SELECT 
      COUNT(*) as totalRecords,
      AVG(suhu) as avgSuhu,
      AVG(kelembapan) as avgKelembapan,
      AVG(ph) as avgPh,
      MIN(suhu) as minSuhu,
      MAX(suhu) as maxSuhu,
      MIN(kelembapan) as minKelembapan,
      MAX(kelembapan) as maxKelembapan
    FROM sensor_logs
  `).get();

  const wateringWaterStats = db.prepare(`
    SELECT 
      COUNT(*) as totalSiramAir,
      SUM(volume_estimasi) as totalAirLiter,
      SUM(durasi_detik) as totalDurasiAir
    FROM watering_logs
    WHERE tipe = 'AIR'
  `).get();

  const wateringPupukStats = db.prepare(`
    SELECT 
      COUNT(*) as totalFertigasiPupuk,
      SUM(volume_estimasi) as totalPupukMl,
      SUM(durasi_detik) as totalDurasiPupuk
    FROM watering_logs
    WHERE tipe = 'PUPUK'
  `).get();

  // Today's watering count
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();

  const todayWatering = db.prepare(`
    SELECT COUNT(*) as todayCount, SUM(volume_estimasi) as todayVolume
    FROM watering_logs
    WHERE timestamp >= ? AND tipe = 'AIR'
  `).get(todayIso);

  return {
    sensor: {
      totalRecords: sensorStats.totalRecords || 0,
      avgSuhu: sensorStats.avgSuhu ? Number(sensorStats.avgSuhu.toFixed(1)) : 0,
      avgKelembapan: sensorStats.avgKelembapan ? Number(sensorStats.avgKelembapan.toFixed(1)) : 0,
      avgPh: sensorStats.avgPh ? Number(sensorStats.avgPh.toFixed(2)) : 0,
      minSuhu: sensorStats.minSuhu || 0,
      maxSuhu: sensorStats.maxSuhu || 0,
      minKelembapan: sensorStats.minKelembapan || 0,
      maxKelembapan: sensorStats.maxKelembapan || 0
    },
    watering: {
      totalSiramAir: wateringWaterStats.totalSiramAir || 0,
      totalAirLiter: wateringWaterStats.totalAirLiter ? Number(wateringWaterStats.totalAirLiter.toFixed(2)) : 0,
      totalFertigasiPupuk: wateringPupukStats.totalFertigasiPupuk || 0,
      totalPupukMl: wateringPupukStats.totalPupukMl ? Number(wateringPupukStats.totalPupukMl.toFixed(0)) : 0,
      todayCount: todayWatering.todayCount || 0,
      todayVolume: todayWatering.todayVolume ? Number(todayWatering.todayVolume.toFixed(2)) : 0
    }
  };
}

// Get chart history points (downsampled for fast dashboard charts)
function getChartHistory(limit = 50) {
  const stmt = db.prepare(`
    SELECT id, timestamp, suhu, kelembapan, ph, pompa_air, pompa_pupuk 
    FROM sensor_logs 
    ORDER BY timestamp DESC 
    LIMIT ?
  `);
  const rows = stmt.all(limit);
  return rows.reverse(); // ascending order for chart
}

// Clear logs
function clearLogs(target) {
  if (target === 'sensor') {
    db.exec('DELETE FROM sensor_logs');
    return { success: true, message: 'Data sensor berhasil dibersihkan.' };
  } else if (target === 'watering') {
    db.exec('DELETE FROM watering_logs');
    return { success: true, message: 'Data riwayat penyiraman berhasil dibersihkan.' };
  } else if (target === 'all') {
    db.exec('DELETE FROM sensor_logs');
    db.exec('DELETE FROM watering_logs');
    return { success: true, message: 'Seluruh database berhasil dibersihkan.' };
  }
  return { success: false, message: 'Target pembersihan tidak valid.' };
}

// Export data to CSV string
function exportToCSV(type) {
  if (type === 'sensor') {
    const rows = db.prepare('SELECT * FROM sensor_logs ORDER BY timestamp DESC').all();
    let csv = 'ID,Waktu (ISO),Waktu Lokal,Suhu (°C),Kelembapan (%),pH Tanah,Pompa Air,Pompa Pupuk,Sumber\n';
    rows.forEach(r => {
      const localTime = new Date(r.timestamp).toLocaleString('id-ID');
      csv += `${r.id},"${r.timestamp}","${localTime}",${r.suhu},${r.kelembapan},${r.ph},${r.pompa_air ? 'ON' : 'OFF'},${r.pompa_pupuk ? 'ON' : 'OFF'},"${r.source}"\n`;
    });
    return csv;
  } else if (type === 'watering') {
    const rows = db.prepare('SELECT * FROM watering_logs ORDER BY timestamp DESC').all();
    let csv = 'ID,Waktu (ISO),Waktu Lokal,Jenis,Mode,Durasi (Detik),Volume Estimasi,Kelembapan Sebelum (%),Kelembapan Sesudah (%),Keterangan\n';
    rows.forEach(r => {
      const localTime = new Date(r.timestamp).toLocaleString('id-ID');
      const unit = r.tipe === 'AIR' ? 'Liter' : 'ml';
      csv += `${r.id},"${r.timestamp}","${localTime}","${r.tipe}","${r.mode}",${r.durasi_detik},"${r.volume_estimasi} ${unit}",${r.kelembapan_sebelum !== null ? r.kelembapan_sebelum : '-'},${r.kelembapan_sesudah !== null ? r.kelembapan_sesudah : '-'},"${(r.keterangan || '').replace(/"/g, '""')}"\n`;
    });
    return csv;
  }
  return '';
}

module.exports = {
  db,
  logSensorData,
  logWateringEvent,
  getSensorLogs,
  getWateringLogs,
  getDatabaseSummary,
  getChartHistory,
  clearLogs,
  exportToCSV
};
