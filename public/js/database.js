/**
 * AquaSmart IoT - Database & History Controller
 * Handles live queries, pagination, filtering, CSV/JSON export, and Chart.js analytics.
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
    },
    chart: {
      limit: 30,
      sensorChart: null,
      phChart: null
    }
  };

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
              <span class="badge-tag ${item.source === 'simulator' ? 'sim' : 'esp'}">
                ${item.source === 'simulator' ? 'Simulasi' : item.source}
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
  // TAB 3: CHARTS HISTORIS
  // ==========================================
  async function loadCharts() {
    try {
      const res = await fetch(`/api/database/chart?limit=${state.chart.limit}`);
      const result = await res.json();
      if (!result.success || !result.data) return;

      const points = result.data;
      const labels = points.map(p => {
        const d = new Date(p.timestamp);
        return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      });

      const tempVals = points.map(p => p.suhu);
      const moistureVals = points.map(p => p.kelembapan);
      const phVals = points.map(p => p.ph);

      // 1. Chart Suhu & Kelembapan
      const ctxSensor = document.getElementById('dbSensorTrendChart');
      if (ctxSensor) {
        if (state.chart.sensorChart) {
          state.chart.sensorChart.destroy();
        }

        state.chart.sensorChart = new Chart(ctxSensor, {
          type: 'line',
          data: {
            labels,
            datasets: [
              {
                label: 'Kelembapan Tanah (%)',
                data: moistureVals,
                borderColor: '#06b6d4',
                backgroundColor: 'rgba(6, 182, 212, 0.12)',
                fill: true,
                tension: 0.35,
                borderWidth: 2.5,
                yAxisID: 'yMoisture',
                pointRadius: 2.5,
                pointHoverRadius: 6
              },
              {
                label: 'Suhu Lingkungan (°C)',
                data: tempVals,
                borderColor: '#f59e0b',
                backgroundColor: 'rgba(245, 158, 11, 0.08)',
                fill: true,
                tension: 0.35,
                borderWidth: 2.5,
                yAxisID: 'yTemp',
                pointRadius: 2.5,
                pointHoverRadius: 6
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
              mode: 'index',
              intersect: false
            },
            plugins: {
              legend: {
                position: 'top',
                labels: { color: '#94a3b8', font: { family: 'Plus Jakarta Sans', size: 12 } }
              }
            },
            scales: {
              x: {
                grid: { color: 'rgba(255, 255, 255, 0.05)' },
                ticks: { color: '#64748b' }
              },
              yMoisture: {
                type: 'linear',
                position: 'left',
                min: 0,
                max: 100,
                title: { display: true, text: 'Kelembapan (%)', color: '#06b6d4' },
                grid: { color: 'rgba(255, 255, 255, 0.05)' },
                ticks: { color: '#06b6d4' }
              },
              yTemp: {
                type: 'linear',
                position: 'right',
                min: 15,
                max: 45,
                title: { display: true, text: 'Suhu (°C)', color: '#f59e0b' },
                grid: { drawOnChartArea: false },
                ticks: { color: '#f59e0b' }
              }
            }
          }
        });
      }

      // 2. Chart pH Tanah
      const ctxPh = document.getElementById('dbPhTrendChart');
      if (ctxPh) {
        if (state.chart.phChart) {
          state.chart.phChart.destroy();
        }

        state.chart.phChart = new Chart(ctxPh, {
          type: 'line',
          data: {
            labels,
            datasets: [
              {
                label: 'Derajat Keasaman pH Tanah',
                data: phVals,
                borderColor: '#8b5cf6',
                backgroundColor: 'rgba(139, 92, 246, 0.15)',
                fill: true,
                tension: 0.35,
                borderWidth: 2.5,
                pointRadius: 2.5,
                pointHoverRadius: 6
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                position: 'top',
                labels: { color: '#94a3b8', font: { family: 'Plus Jakarta Sans', size: 12 } }
              }
            },
            scales: {
              x: {
                grid: { color: 'rgba(255, 255, 255, 0.05)' },
                ticks: { color: '#64748b' }
              },
              y: {
                min: 4,
                max: 10,
                title: { display: true, text: 'Nilai pH', color: '#8b5cf6' },
                grid: { color: 'rgba(255, 255, 255, 0.05)' },
                ticks: { color: '#8b5cf6' }
              }
            }
          }
        });
      }

    } catch (err) {
      console.error('Error loading charts:', err);
    }
  }

  // ==========================================
  // TAB SWITCHING LOGIC
  // ==========================================
  const tabBtns = document.querySelectorAll('.db-tab-btn');
  const tabContents = {
    sensor: document.getElementById('tabContentSensor'),
    watering: document.getElementById('tabContentWatering'),
    chart: document.getElementById('tabContentChart')
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
      } else if (targetTab === 'chart') {
        loadCharts();
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

  // JSON Export for Sensor
  document.getElementById('btnExportSensorJson')?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/database/sensor?limit=1000');
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `aquasmart_sensor_records_${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Gagal mengekspor data JSON: ' + err.message);
    }
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

  // ==========================================
  // CHART RANGE BUTTONS
  // ==========================================
  document.querySelectorAll('.chart-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chart-range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.chart.limit = parseInt(btn.getAttribute('data-limit'));
      loadCharts();
    });
  });

  // Global Refresh Button
  document.getElementById('btnGlobalRefresh')?.addEventListener('click', () => {
    fetchSummary();
    if (state.activeTab === 'sensor') loadSensorData(state.sensor.page);
    else if (state.activeTab === 'watering') loadWateringData(state.watering.page);
    else if (state.activeTab === 'chart') loadCharts();
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

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'DATABASE_CLEARED') {
          fetchSummary();
          loadSensorData(state.sensor.page);
          loadWateringData(state.watering.page);
        } else if (msg.type === 'CONTROLS_UPDATE') {
          // If watering finishes, update summary and table
          fetchSummary();
        }
      } catch (e) {
        // ignore parse error
      }
    };

    ws.onclose = () => {
      setTimeout(initWebSocket, 4000);
    };
  }
  initWebSocket();

  // ==========================================
  // INITIAL DATA LOAD
  // ==========================================
  fetchSummary();
  loadSensorData(1);
});
