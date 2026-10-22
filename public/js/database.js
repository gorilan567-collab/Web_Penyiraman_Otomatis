/**
 * AquaSmart IoT - Database & History Controller
 * Handles live queries, pagination, filtering, and CSV export.
 * Auto-refresh setiap 30 menit untuk sinkronisasi data terbaru.
 */

document.addEventListener('DOMContentLoaded', () => {
  // ==========================================
  // STATE MANAGEMENT
  // ==========================================
  const state = {
    activeTab: 'sensor',
    sensor: {
      page: 1,
      limit: 30,
      search: '',
      range: 'ALL',
      total: 0,
      totalPages: 1
    },
    watering: {
      page: 1,
      limit: 30,
      search: '',
      type: 'ALL',
      mode: 'ALL',
      total: 0,
      totalPages: 1
    }
  };

  // ==========================================
  // DATABASE INPUT INTERVAL & AUTO-SYNC TIMER
  // ==========================================
  let dbIntervalMinutes = 10;
  let nextDbLogTime = Date.now() + dbIntervalMinutes * 60 * 1000;
  let nextRefreshAt = Date.now() + 60 * 1000; // Sinkron tampilan tiap 1 menit

  async function fetchDbConfig() {
    try {
      const res = await fetch('/api/database/config');
      const data = await res.json();
      if (data.success) {
        dbIntervalMinutes = data.databaseIntervalMenit || 10;
        const select = document.getElementById('dbIntervalSelect');
        if (select) select.value = String(dbIntervalMinutes);
        if (data.nextDbLogTime) {
          nextDbLogTime = data.nextDbLogTime;
        }
      }
    } catch (e) {
      console.warn('Gagal memuat konfigurasi interval database:', e);
    }
  }

  function updateCountdownDisplay() {
    const now = Date.now();

    // 1. Countdown Input Database
    const remainingInput = Math.max(0, nextDbLogTime - now);
    const inMins = Math.floor(remainingInput / 60000);
    const inSecs = Math.floor((remainingInput % 60000) / 1000);
    const inputBadge = document.getElementById('dbNextInputCountdown');
    if (inputBadge) {
      inputBadge.textContent = `⏱ Input berikutnya: ${String(inMins).padStart(2, '0')}:${String(inSecs).padStart(2, '0')}`;
    }

    if (remainingInput <= 0) {
      nextDbLogTime = now + dbIntervalMinutes * 60000;
      setTimeout(() => {
        fetchSummary();
        if (state.activeTab === 'sensor') loadSensorData(state.sensor.page);
      }, 1500);
    }

    // 2. Countdown Sinkron Otomatis Tampilan
    const remainingRefresh = Math.max(0, nextRefreshAt - now);
    const refMins = Math.floor(remainingRefresh / 60000);
    const refSecs = Math.floor((remainingRefresh % 60000) / 1000);
    const refreshBadge = document.getElementById('autoRefreshCountdown');
    if (refreshBadge) {
      refreshBadge.textContent = `⏱ Sinkron otomatis dalam ${String(refMins).padStart(2, '0')}:${String(refSecs).padStart(2, '0')}`;
    }
    if (remainingRefresh <= 0) {
      nextRefreshAt = now + 60 * 1000;
      triggerAutoRefresh();
    }
  }

  function triggerAutoRefresh() {
    fetchSummary();
    if (state.activeTab === 'sensor') loadSensorData(state.sensor.page);
    else if (state.activeTab === 'watering') loadWateringData(state.watering.page);
    const el = document.getElementById('autoRefreshCountdown');
    if (el) {
      el.classList.add('refresh-flash');
      setTimeout(() => el.classList.remove('refresh-flash'), 800);
    }
  }

  // Update countdown setiap detik
  setInterval(updateCountdownDisplay, 1000);
  updateCountdownDisplay();

  // Event listener untuk pilihan interval input database
  const dbIntervalSelect = document.getElementById('dbIntervalSelect');
  if (dbIntervalSelect) {
    dbIntervalSelect.addEventListener('change', async () => {
      const selected = Number(dbIntervalSelect.value);
      try {
        const res = await fetch('/api/database/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ databaseIntervalMenit: selected })
        });
        const data = await res.json();
        if (data.success) {
          dbIntervalMinutes = selected;
          nextDbLogTime = data.nextDbLogTime || (Date.now() + dbIntervalMinutes * 60000);
          updateCountdownDisplay();
          const badge = document.getElementById('dbNextInputCountdown');
          if (badge) {
            badge.classList.add('refresh-flash');
            setTimeout(() => badge.classList.remove('refresh-flash'), 800);
          }
        }
      } catch (err) {
        console.error('Gagal memperbarui interval database:', err);
      }
    });
  }

  // Event listener tombol input manual data sekarang
  const btnManualDbLog = document.getElementById('btnManualDbLog');
  if (btnManualDbLog) {
    btnManualDbLog.addEventListener('click', async () => {
      const originalText = btnManualDbLog.innerHTML;
      btnManualDbLog.disabled = true;
      btnManualDbLog.innerHTML = '<span>Menyimpan...</span>';
      try {
        const res = await fetch('/api/database/input-now', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'Sensor Gateway' })
        });
        const data = await res.json();
        if (data.success) {
          nextDbLogTime = data.nextDbLogTime || (Date.now() + dbIntervalMinutes * 60000);
          fetchSummary();
          loadSensorData(1);
          const badge = document.getElementById('dbNextInputCountdown');
          if (badge) {
            badge.classList.add('refresh-flash');
            setTimeout(() => badge.classList.remove('refresh-flash'), 800);
          }
        }
      } catch (err) {
        console.error('Gagal input manual database:', err);
      } finally {
        btnManualDbLog.disabled = false;
        btnManualDbLog.innerHTML = originalText;
      }
    });
  }

  // ==========================================
  // REAL-TIME CLOCK
  // ==========================================
  function updateClock() {
    const clockEl = document.getElementById('digitalClock');
    if (!clockEl) return;
    const now = new Date();
    const timeStr = now.toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    clockEl.textContent = `${timeStr} WIB`;
  }
  setInterval(updateClock, 1000);
  updateClock();

  // ==========================================
  // METRICS & SUMMARY
  // ==========================================
  async function fetchSummary() {
    try {
      const res = await fetch('/api/database/summary');
      const data = await res.json();
      if (!data.success) return;

      const { sensor, watering } = data;

      // Update Metric Cards
      document.getElementById('metricTotalSensor').textContent = sensor.totalRecords.toLocaleString('id-ID');
      document.getElementById('metricAvgTemp').textContent = `Rata-rata Suhu: ${sensor.avgSuhu}°C (Min: ${sensor.minSuhu}° | Max: ${sensor.maxSuhu}°)`;
      document.getElementById('metricAvgMoisture').textContent = `${sensor.avgKelembapan}%`;
      document.getElementById('metricMoistureRange').textContent = `Rentang: ${sensor.minKelembapan}% s/d ${sensor.maxKelembapan}%`;
      
      document.getElementById('metricAvgPh').textContent = sensor.avgPh.toFixed(2);
      const phStatus = sensor.avgPh < 6.5 ? 'Kondisi: Cenderung Asam' : (sensor.avgPh > 7.5 ? 'Kondisi: Cenderung Basa' : 'Kondisi: Netral Ideal');
      document.getElementById('metricPhStatus').textContent = phStatus;

      document.getElementById('metricTotalWaterCount').innerHTML = `${watering.totalSiramAir} <small>kali</small>`;
      document.getElementById('metricTotalWaterVol').textContent = `Total: ~${watering.totalAirLiter} Liter (Hari ini: ${watering.todayVolume} L)`;

      document.getElementById('metricTotalPupukCount').innerHTML = `${watering.totalFertigasiPupuk} <small>kali</small>`;
      document.getElementById('metricTotalPupukVol').textContent = `Total: ~${watering.totalPupukMl} ml nutrisi`;

      // Update Badges on Tabs
      document.getElementById('badgeTabSensor').textContent = sensor.totalRecords.toLocaleString('id-ID');
      document.getElementById('badgeTabWatering').textContent = (watering.totalSiramAir + watering.totalFertigasiPupuk).toLocaleString('id-ID');

    } catch (err) {
      console.error('Error fetching summary:', err);
    }
  }

  // ==========================================
  // TAB 1: SENSOR DATA TABLE & PAGINATION
  // ==========================================
  async function loadSensorData(page = 1) {
    state.sensor.page = page;
    const tbody = document.getElementById('sensorTableBody');
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; padding: 2.5rem; color: var(--text-muted);">
          Memuat data telemetri sensor...
        </td>
      </tr>
    `;

    try {
      const params = new URLSearchParams({
        page: state.sensor.page,
        limit: state.sensor.limit
      });

      if (state.sensor.search) params.append('search', state.sensor.search);

      // Handle time range
      if (state.sensor.range !== 'ALL') {
        const now = new Date();
        let startDate;
        if (state.sensor.range === '24H') {
          startDate = new Date(now.getTime() - 24 * 3600 * 1000);
        } else if (state.sensor.range === 'TODAY') {
          startDate = new Date();
          startDate.setHours(0, 0, 0, 0);
        } else if (state.sensor.range === '7D') {
          startDate = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
        }
        if (startDate) params.append('startDate', startDate.toISOString());
      }

      const res = await fetch(`/api/database/sensor?${params.toString()}`);
      const result = await res.json();

      if (!result.success || !result.data || result.data.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="8" class="table-empty-state">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="8" y1="12" x2="16" y2="12"></line>
              </svg>
              <p>Tidak ada rekaman data sensor yang cocok dengan filter.</p>
            </td>
          </tr>
        `;
        renderPagination('sensor', 0, 1, 1);
        return;
      }

      state.sensor.total = result.total;
      state.sensor.totalPages = result.totalPages;

      // Render rows
      tbody.innerHTML = result.data.map(item => {
        const dateObj = new Date(item.timestamp);
        const formattedTime = dateObj.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const formattedDate = dateObj.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });

        // pH category
        let phBadgeClass = 'badge-tag auto';
        let phText = `${item.ph.toFixed(2)} (Netral)`;
        if (item.ph < 6.5) {
          phBadgeClass = 'badge-tag manual';
          phText = `${item.ph.toFixed(2)} (Asam)`;
        } else if (item.ph > 7.5) {
          phBadgeClass = 'badge-tag water';
          phText = `${item.ph.toFixed(2)} (Basa)`;
        }

        // Moisture percentage
        const moisturePct = Math.min(100, Math.max(0, item.kelembapan));

        return `
          <tr>
            <td style="font-weight: 700; color: var(--text-dim);">#${item.id}</td>
            <td>
              <div style="font-weight: 600; color: #fff;">${formattedTime}</div>
              <div style="font-size: 0.75rem; color: var(--text-dim);">${formattedDate}</div>
            </td>
            <td>
              <span style="font-weight: 700; color: var(--amber-primary); font-size: 0.95rem;">
                ${item.suhu}°C
              </span>
            </td>
            <td>
              <div class="table-meter">
                <span style="font-weight: 700; color: var(--cyan-primary); min-width: 44px;">
                  ${item.kelembapan}%
                </span>
                <div class="table-meter-bar">
                  <div class="table-meter-fill moisture" style="width: ${moisturePct}%"></div>
                </div>
              </div>
            </td>
            <td>
              <span class="${phBadgeClass}">${phText}</span>
            </td>
            <td>
              <span class="badge-tag ${item.pompa_air ? 'on' : 'off'}">
                ${item.pompa_air ? '● NYALA' : '○ MATI'}
              </span>
            </td>
            <td>
              <span class="badge-tag ${item.pompa_pupuk ? 'on' : 'off'}">
                ${item.pompa_pupuk ? '● NYALA' : '○ MATI'}
              </span>
            </td>
            <td>
              <span class="badge-tag esp">
                ${item.source === 'simulator' ? 'Sensor Gateway' : item.source}
              </span>
            </td>
          </tr>
        `;
      }).join('');

      renderPagination('sensor', result.total, state.sensor.page, result.totalPages);

    } catch (err) {
      console.error('Error loading sensor data:', err);
      tbody.innerHTML = `
        <tr>
          <td colspan="8" style="text-align: center; padding: 2rem; color: #ef4444;">
            Gagal mengambil data sensor dari server.
          </td>
        </tr>
      `;
    }
  }

  // ==========================================
  // TAB 2: WATERING DATA TABLE & PAGINATION
  // ==========================================
  async function loadWateringData(page = 1) {
    state.watering.page = page;
    const tbody = document.getElementById('wateringTableBody');
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; padding: 2.5rem; color: var(--text-muted);">
          Memuat riwayat penyiraman & fertigasi...
        </td>
      </tr>
    `;

    try {
      const params = new URLSearchParams({
        page: state.watering.page,
        limit: state.watering.limit
      });

      if (state.watering.search) params.append('search', state.watering.search);
      if (state.watering.type !== 'ALL') params.append('tipe', state.watering.type);
      if (state.watering.mode !== 'ALL') params.append('mode', state.watering.mode);

      const res = await fetch(`/api/database/watering?${params.toString()}`);
      const result = await res.json();

      if (!result.success || !result.data || result.data.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="8" class="table-empty-state">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="8" y1="12" x2="16" y2="12"></line>
              </svg>
              <p>Tidak ada riwayat penyiraman yang sesuai.</p>
            </td>
          </tr>
        `;
        renderPagination('watering', 0, 1, 1);
        return;
      }

      state.watering.total = result.total;
      state.watering.totalPages = result.totalPages;

      tbody.innerHTML = result.data.map(item => {
        const dateObj = new Date(item.timestamp);
        const formattedTime = dateObj.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const formattedDate = dateObj.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });

        const isWater = item.tipe === 'AIR';
        const typeBadge = isWater
          ? `<span class="badge-tag water">💧 Air Bersih</span>`
          : `<span class="badge-tag pupuk">🌿 Pupuk Cair</span>`;

        const isAuto = item.mode === 'AUTO';
        const modeBadge = isAuto
          ? `<span class="badge-tag auto">🤖 AUTO</span>`
          : `<span class="badge-tag manual">🖐️ MANUAL</span>`;

        const volumeUnit = isWater ? 'Liter' : 'ml';
        const volumeText = `${item.volume_estimasi} ${volumeUnit}`;

        // Moisture delta
        let deltaHtml = '-';
        if (item.kelembapan_sebelum !== null && item.kelembapan_sesudah !== null) {
          const delta = (item.kelembapan_sesudah - item.kelembapan_sebelum).toFixed(1);
          const deltaColor = delta >= 0 ? '#10b981' : '#f59e0b';
          deltaHtml = `
            <div style="font-size: 0.82rem;">
              <span>${item.kelembapan_sebelum}%</span> ➔ <strong style="color: #fff;">${item.kelembapan_sesudah}%</strong>
              <small style="color: ${deltaColor}; margin-left: 4px;">(${delta >= 0 ? '+' : ''}${delta}%)</small>
            </div>
          `;
        }

        return `
          <tr>
            <td style="font-weight: 700; color: var(--text-dim);">#${item.id}</td>
            <td>
              <div style="font-weight: 600; color: #fff;">${formattedTime}</div>
              <div style="font-size: 0.75rem; color: var(--text-dim);">${formattedDate}</div>
            </td>
            <td>${typeBadge}</td>
            <td>${modeBadge}</td>
            <td>
              <span style="font-weight: 700; color: #fff;">${item.durasi_detik}</span> detik
            </td>
            <td>
              <span style="font-weight: 700; color: ${isWater ? 'var(--cyan-primary)' : '#a3e635'};">
                ${volumeText}
              </span>
            </td>
            <td>${deltaHtml}</td>
            <td style="color: var(--text-muted); font-size: 0.82rem; max-width: 320px;">
              ${item.keterangan || '-'}
            </td>
          </tr>
        `;
      }).join('');

      renderPagination('watering', result.total, state.watering.page, result.totalPages);

    } catch (err) {
      console.error('Error loading watering data:', err);
      tbody.innerHTML = `
        <tr>
          <td colspan="8" style="text-align: center; padding: 2rem; color: #ef4444;">
            Gagal mengambil riwayat penyiraman dari server.
          </td>
        </tr>
      `;
    }
  }

  // ==========================================
  // PAGINATION CONTROLS GENERATOR
  // ==========================================
  function renderPagination(type, total, currentPage, totalPages) {
    const infoEl = document.getElementById(`${type}PaginationInfo`);
    const controlsEl = document.getElementById(`${type}PaginationControls`);
    if (!infoEl || !controlsEl) return;

    if (total === 0) {
      infoEl.textContent = 'Menampilkan 0 dari 0 data';
      controlsEl.innerHTML = '';
      return;
    }

    const limit = state[type].limit;
    const start = (currentPage - 1) * limit + 1;
    const end = Math.min(total, currentPage * limit);
    infoEl.textContent = `Menampilkan ${start} - ${end} dari ${total} data`;

    let html = '';
    // Previous Button
    html += `
      <button class="page-btn" ${currentPage <= 1 ? 'disabled' : ''} onclick="window.changePage('${type}', ${currentPage - 1})" title="Halaman Sebelumnya">
        &laquo;
      </button>
    `;

    // Page Numbers (sliding window max 5 numbers)
    let startPage = Math.max(1, currentPage - 2);
    let endPage = Math.min(totalPages, startPage + 4);
    if (endPage - startPage < 4) {
      startPage = Math.max(1, endPage - 4);
    }

    for (let p = startPage; p <= endPage; p++) {
      html += `
        <button class="page-btn ${p === currentPage ? 'active' : ''}" onclick="window.changePage('${type}', ${p})">
          ${p}
        </button>
      `;
    }

    // Next Button
    html += `
      <button class="page-btn" ${currentPage >= totalPages ? 'disabled' : ''} onclick="window.changePage('${type}', ${currentPage + 1})" title="Halaman Selanjutnya">
        &raquo;
      </button>
    `;

    controlsEl.innerHTML = html;
  }

  // Expose global page changer for onclick
  window.changePage = (type, page) => {
    if (type === 'sensor') loadSensorData(page);
    else if (type === 'watering') loadWateringData(page);
  };

  // ==========================================
  // CSV DOWNLOAD HELPERS
  // ==========================================
  function downloadCSV(type, label) {
    const btn = document.getElementById(type === 'sensor' ? 'btnDownloadSensorCsv' : 'btnDownloadWateringCsv');
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
      btn.innerHTML = '<span style="opacity:0.7">Mengunduh...</span>';
      btn.disabled = true;
    }

    fetch(`/api/database/export/${type}`)
      .then(res => {
        if (!res.ok) throw new Error('Server error: ' + res.status);
        return res.blob();
      })
      .then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `aquasmart_${type}_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      })
      .catch(err => {
        alert('Gagal mengunduh CSV: ' + err.message);
      })
      .finally(() => {
        if (btn) {
          btn.innerHTML = originalHtml;
          btn.disabled = false;
        }
      });
  }

  // ==========================================
  // TAB SWITCHING LOGIC
  // ==========================================
  const tabBtns = document.querySelectorAll('.db-tab-btn');
  const tabContents = {
    sensor: document.getElementById('tabContentSensor'),
    watering: document.getElementById('tabContentWatering')
  };

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      state.activeTab = targetTab;

      // Update active button
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Update visible content
      Object.keys(tabContents).forEach(tabKey => {
        if (tabKey === targetTab) {
          tabContents[tabKey].classList.remove('hidden');
        } else {
          tabContents[tabKey].classList.add('hidden');
        }
      });

      // Lazy load tab data
      if (targetTab === 'sensor') {
        loadSensorData(state.sensor.page);
      } else if (targetTab === 'watering') {
        loadWateringData(state.watering.page);
      }
    });
  });

  // ==========================================
  // SENSOR FILTERS & EVENTS
  // ==========================================
  const sensorSearchInput = document.getElementById('sensorSearchInput');
  let searchSensorTimeout = null;
  sensorSearchInput?.addEventListener('input', (e) => {
    clearTimeout(searchSensorTimeout);
    searchSensorTimeout = setTimeout(() => {
      state.sensor.search = e.target.value.trim();
      loadSensorData(1);
    }, 350);
  });

  document.getElementById('sensorTimeRange')?.addEventListener('change', (e) => {
    state.sensor.range = e.target.value;
    loadSensorData(1);
  });

  document.getElementById('sensorPageLimit')?.addEventListener('change', (e) => {
    state.sensor.limit = parseInt(e.target.value);
    loadSensorData(1);
  });

  document.getElementById('btnRefreshSensor')?.addEventListener('click', () => {
    loadSensorData(state.sensor.page);
    fetchSummary();
  });

  // Tombol Unduh CSV - Data Sensor
  document.getElementById('btnDownloadSensorCsv')?.addEventListener('click', () => {
    downloadCSV('sensor', 'Sensor Telemetri');
  });

  // Tombol Unduh CSV - Riwayat Penyiraman
  document.getElementById('btnDownloadWateringCsv')?.addEventListener('click', () => {
    downloadCSV('watering', 'Riwayat Penyiraman');
  });

  // Tombol Unduh CSV - Seluruh Database (kedua tabel sekaligus)
  document.getElementById('btnDownloadAllCsv')?.addEventListener('click', () => {
    // Unduh sensor dulu, lalu pupuk dengan jeda singkat
    downloadCSV('sensor', 'Sensor');
    setTimeout(() => downloadCSV('watering', 'Penyiraman'), 800);
  });

  // ==========================================
  // WATERING FILTERS & EVENTS
  // ==========================================
  const wateringSearchInput = document.getElementById('wateringSearchInput');
  let searchWateringTimeout = null;
  wateringSearchInput?.addEventListener('input', (e) => {
    clearTimeout(searchWateringTimeout);
    searchWateringTimeout = setTimeout(() => {
      state.watering.search = e.target.value.trim();
      loadWateringData(1);
    }, 350);
  });

  document.getElementById('wateringFilterType')?.addEventListener('change', (e) => {
    state.watering.type = e.target.value;
    loadWateringData(1);
  });

  document.getElementById('wateringFilterMode')?.addEventListener('change', (e) => {
    state.watering.mode = e.target.value;
    loadWateringData(1);
  });

  document.getElementById('wateringPageLimit')?.addEventListener('change', (e) => {
    state.watering.limit = parseInt(e.target.value);
    loadWateringData(1);
  });

  document.getElementById('btnRefreshWatering')?.addEventListener('click', () => {
    loadWateringData(state.watering.page);
    fetchSummary();
  });

  // (Grafik historis telah dihapus sesuai permintaan)

  // Global Refresh Button
  document.getElementById('btnGlobalRefresh')?.addEventListener('click', () => {
    nextRefreshAt = Date.now() + AUTO_REFRESH_INTERVAL_MS;
    fetchSummary();
    if (state.activeTab === 'sensor') loadSensorData(state.sensor.page);
    else if (state.activeTab === 'watering') loadWateringData(state.watering.page);
  });

  // ==========================================
  // CLEAR DATA CONFIRMATION MODAL
  // ==========================================
  const clearModal = document.getElementById('clearModal');
  const btnOpenClearModal = document.getElementById('btnOpenClearModal');
  const btnCancelClear = document.getElementById('btnCancelClear');
  const btnConfirmClear = document.getElementById('btnConfirmClear');
  const clearTargetSelect = document.getElementById('clearTargetSelect');

  btnOpenClearModal?.addEventListener('click', () => {
    clearModal.classList.add('open');
  });

  btnCancelClear?.addEventListener('click', () => {
    clearModal.classList.remove('open');
  });

  clearModal?.addEventListener('click', (e) => {
    if (e.target === clearModal) clearModal.classList.remove('open');
  });

  btnConfirmClear?.addEventListener('click', async () => {
    const target = clearTargetSelect.value;
    try {
      const res = await fetch('/api/database/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target })
      });
      const data = await res.json();
      if (data.success) {
        clearModal.classList.remove('open');
        fetchSummary();
        loadSensorData(1);
        loadWateringData(1);
        loadCharts();
        alert('Data berhasil dibersihkan.');
      } else {
        alert('Gagal membersihkan data: ' + data.message);
      }
    } catch (err) {
      alert('Terjadi kesalahan saat membersihkan data: ' + err.message);
    }
  });

  // ==========================================
  // WEBSOCKET SINKRONISASI REAL-TIME
  // ==========================================
  function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      const label = document.getElementById('deviceStatusText');
      const dot = document.querySelector('#deviceStatusPill .status-dot');
      if (label) label.textContent = 'Gateway: Terhubung';
      if (dot) dot.classList.add('online');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'DATABASE_CLEARED') {
          fetchSummary();
          loadSensorData(state.sensor.page);
          loadWateringData(state.watering.page);
        } else if (msg.type === 'CONTROLS_UPDATE' || msg.type === 'DATABASE_UPDATED') {
          fetchSummary();
          if (state.activeTab === 'sensor') loadSensorData(state.sensor.page);
          else if (state.activeTab === 'watering') loadWateringData(state.watering.page);
        } else if (msg.type === 'SETTINGS_UPDATE') {
          if (msg.settings && msg.settings.databaseIntervalMenit) {
            dbIntervalMinutes = msg.settings.databaseIntervalMenit;
            const select = document.getElementById('dbIntervalSelect');
            if (select) select.value = String(dbIntervalMinutes);
            if (msg.nextDbLogTime) nextDbLogTime = msg.nextDbLogTime;
          }
        }
      } catch (e) {
        // ignore parse error
      }
    };

    ws.onclose = () => {
      const label = document.getElementById('deviceStatusText');
      const dot = document.querySelector('#deviceStatusPill .status-dot');
      if (label) label.textContent = 'Gateway: Terputus';
      if (dot) dot.classList.remove('online');
      setTimeout(initWebSocket, 4000);
    };
  }
  initWebSocket();

  // ==========================================
  // INITIAL DATA LOAD
  // ==========================================
  fetchDbConfig();
  fetchSummary();
  loadSensorData(1);
  loadWateringData(1);
});
