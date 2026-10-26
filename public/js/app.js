/**
 * AQUASMART IOT - CLIENT DASHBOARD LOGIC
 * Real-time WebSocket sync, Chart.js managers, Actuator Controls, and Audio Feedback
 */

(function () {
  'use strict';

  // ==========================================
  // STATE & REFS
  // ==========================================
  let systemState = {
    telemetry: { suhu: 28.4, kelembapan: 45.0, ph: 6.8 },
    controls: { mode: 'auto', pompaAir: false, pompaPupuk: false },
    settings: {
      thresholdKelembapanMin: 40,
      thresholdKelembapanMax: 65,
      durasiSiramOtomatisDetik: 60,
      databaseIntervalMenit: 10,
      simulationActive: true
    }
  };

  let chartDataHistory = [];
  let isChartPaused = false;
  let audioMuted = false;
  let ws = null;
  let reconnectTimer = null;
  let countdownWaterTimer = null;
  let countdownFertTimer = null;
  let waterSecondsLeft = 0;
  let fertSecondsLeft = 0;

  // Chart Instances
  let chartSuhuInstance = null;
  let chartMoistureInstance = null;
  let chartPhInstance = null;

  // Audio Context (Synthesizer for tactile feedback)
  let audioCtx = null;
  function getAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) audioCtx = new AudioContextClass();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  function playTone(freq, type = 'sine', duration = 0.12, gain = 0.08) {
    if (audioMuted) return;
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gainNode.gain.setValueAtTime(gain, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
      osc.connect(gainNode);
      gainNode.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch (e) {
      console.warn('Audio play error:', e);
    }
  }

  function soundRelayClick(isOn = true) {
    if (isOn) {
      playTone(720, 'sine', 0.08, 0.07);
      setTimeout(() => playTone(980, 'triangle', 0.1, 0.06), 70);
    } else {
      playTone(540, 'sine', 0.08, 0.07);
      setTimeout(() => playTone(420, 'triangle', 0.1, 0.06), 70);
    }
  }

  function soundAlert() {
    playTone(880, 'square', 0.15, 0.08);
    setTimeout(() => playTone(440, 'square', 0.2, 0.08), 160);
  }

  // ==========================================
  // WEBSOCKET & API CONNECTION
  // ==========================================
  function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}`;

    try {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('✅ Connected to AquaSmart IoT Gateway');
        updateGatewayStatus(true, 'Gateway: Terhubung');
        if (reconnectTimer) {
          clearInterval(reconnectTimer);
          reconnectTimer = null;
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleServerMessage(msg);
        } catch (err) {
          console.error('Error parsing WS message:', err);
        }
      };

      ws.onclose = () => {
        console.warn('⚠️ Disconnected from Gateway, retrying...');
        updateGatewayStatus(false, 'Gateway: Terputus (Reconnecting)');
        if (!reconnectTimer) {
          reconnectTimer = setInterval(initWebSocket, 4000);
        }
        // Fallback polling REST
        fetchStatusViaRest();
      };

      ws.onerror = (err) => {
        console.error('WebSocket Error:', err);
        ws.close();
      };
    } catch (e) {
      console.warn('WebSocket init exception:', e);
      fetchStatusViaRest();
    }
  }

  async function fetchStatusViaRest() {
    try {
      const res = await fetch('/api/status');
      if (res.ok) {
        const data = await res.json();
        handleServerMessage({
          type: 'INIT_STATE',
          systemState: data.systemState,
          history: data.history,
          logs: data.logs
        });
        updateGatewayStatus(true, 'Gateway: Terhubung');
      }
    } catch (err) {
      console.warn('REST fallback failed:', err);
    }
  }

  function updateGatewayStatus(online, text) {
    const dot = document.querySelector('#deviceStatusPill .status-dot');
    const label = document.getElementById('deviceStatusText');
    const sourceTag = document.getElementById('sourceTag');

    if (dot) {
      if (online) {
        dot.classList.add('online');
      } else {
        dot.classList.remove('online');
      }
    }
    if (label) {
      label.textContent = online ? 'Gateway: Terhubung' : (text || 'Gateway: Terputus');
    }
    if (sourceTag) {
      sourceTag.remove();
    }
  }

  function handleServerMessage(data) {
    if (data.type === 'INIT_STATE') {
      systemState = data.systemState;
      if (data.history && Array.isArray(data.history)) {
        chartDataHistory = data.history;
        initCharts();
      }
      if (data.logs && Array.isArray(data.logs)) {
        renderLogs(data.logs);
      }
      updateUI();
    } else if (data.type === 'TELEMETRY_UPDATE') {
      systemState.telemetry = data.telemetry;
      if (data.tangkiAir !== undefined) systemState.tangkiAir = data.tangkiAir;
      if (data.tangkiPupuk !== undefined) systemState.tangkiPupuk = data.tangkiPupuk;
      if (data.totalAirHariIni !== undefined) systemState.totalAirHariIni = data.totalAirHariIni;
      if (data.totalPupukHariIni !== undefined) systemState.totalPupukHariIni = data.totalPupukHariIni;
      if (data.controls) systemState.controls = data.controls;

      if (!isChartPaused && data.historyPoint) {
        chartDataHistory.push(data.historyPoint);
        if (chartDataHistory.length > 30) chartDataHistory.shift();
        appendDataToCharts(data.historyPoint);
      }

      updateUI();
    } else if (data.type === 'CONTROLS_UPDATE') {
      systemState.controls = data.controls;
      if (data.log) prependLog(data.log);
      updateActuatorControlsUI();
      updateModeUI();
    } else if (data.type === 'SETTINGS_UPDATE') {
      systemState.settings = data.settings;
      if (data.log) prependLog(data.log);
      updateUI();
    }
  }

  // ==========================================
  // UI UPDATE FUNCTIONS
  // ==========================================
  function updateUI() {
    updateTelemetrySensors();
    updateReservoirAndTotals();
    updateModeUI();
    updateActuatorControlsUI();
  }

  // 1. Sensor Telemetry Updates
  function updateTelemetrySensors() {
    const { suhu, kelembapan, ph } = systemState.telemetry;

    // Suhu
    const elSuhuVal = document.getElementById('suhuValue');
    const elSuhuBarFill = document.getElementById('suhuBarFill');
    const elSuhuBadge = document.getElementById('suhuStatusBadge');
    const elSuhuComfort = document.getElementById('suhuComfort');
    const elChartStatSuhu = document.getElementById('chartStatSuhu');

    if (elSuhuVal) elSuhuVal.textContent = suhu.toFixed(1);
    if (elChartStatSuhu) elChartStatSuhu.textContent = suhu.toFixed(1);
    
    // Bar fill (0°C to 50°C)
    const suhuPercent = Math.min(100, Math.max(0, (suhu / 50) * 100));
    if (elSuhuBarFill) elSuhuBarFill.style.width = `${suhuPercent}%`;

    if (suhu >= 24.0 && suhu <= 32.0) {
      setBadge(elSuhuBadge, 'Optimal (24-32°C)', 'status-optimal');
      if (elSuhuComfort) elSuhuComfort.textContent = 'Nyaman';
    } else if (suhu > 32.0) {
      setBadge(elSuhuBadge, 'Terlalu Panas', 'status-danger');
      if (elSuhuComfort) elSuhuComfort.textContent = 'Stres Panas';
    } else {
      setBadge(elSuhuBadge, 'Rendah / Sejuk', 'status-warning');
      if (elSuhuComfort) elSuhuComfort.textContent = 'Sejuk';
    }

    // Kelembapan Tanah
    const elMoistureVal = document.getElementById('moistureValue');
    const elMoistureCircleText = document.getElementById('moistureCircleText');
    const elMoistureCircleProgress = document.getElementById('moistureCircleProgress');
    const elMoistureBadge = document.getElementById('moistureStatusBadge');
    const elWaterNeed = document.getElementById('waterNeedStatus');
    const elChartStatMoisture = document.getElementById('chartStatMoisture');

    if (elMoistureVal) elMoistureVal.textContent = kelembapan.toFixed(1);
    if (elMoistureCircleText) elMoistureCircleText.textContent = `${Math.round(kelembapan)}%`;
    if (elChartStatMoisture) elChartStatMoisture.textContent = kelembapan.toFixed(1);

    // Circular SVG dash offset (radius = 42 -> 2 * PI * 42 ≈ 264)
    const circumference = 264;
    const progressOffset = circumference - (circumference * Math.min(100, Math.max(0, kelembapan))) / 100;
    if (elMoistureCircleProgress) {
      elMoistureCircleProgress.style.strokeDashoffset = progressOffset;
      if (kelembapan < systemState.settings.thresholdKelembapanMin) {
        elMoistureCircleProgress.style.stroke = 'var(--rose-danger)';
      } else {
        elMoistureCircleProgress.style.stroke = 'var(--emerald-primary)';
      }
    }

    const minT = systemState.settings.thresholdKelembapanMin;
    const maxT = systemState.settings.thresholdKelembapanMax;

    if (kelembapan < minT) {
      setBadge(elMoistureBadge, 'Kering - Butuh Air', 'status-danger');
      if (elWaterNeed) elWaterNeed.textContent = 'Mendesak';
    } else if (kelembapan >= minT && kelembapan <= maxT) {
      setBadge(elMoistureBadge, 'Lembap Ideal', 'status-optimal');
      if (elWaterNeed) elWaterNeed.textContent = 'Tercukupi';
    } else {
      setBadge(elMoistureBadge, 'Sangat Basah', 'status-warning');
      if (elWaterNeed) elWaterNeed.textContent = 'Jenuh';
    }

    // Batas Threshold labels
    const elThreshMin = document.getElementById('moistureThreshMin');
    const elThreshMax = document.getElementById('moistureThreshMax');
    const elDescThreshMin = document.getElementById('descThreshMin');
    const elDescThreshMax = document.getElementById('descThreshMax');
    const elLegendThreshMin = document.getElementById('legendThreshMin');

    if (elThreshMin) elThreshMin.textContent = `${minT} %`;
    if (elThreshMax) elThreshMax.textContent = `${maxT} %`;
    if (elDescThreshMin) elDescThreshMin.textContent = `${minT}%`;
    if (elDescThreshMax) elDescThreshMax.textContent = `${maxT}%`;
    if (elLegendThreshMin) elLegendThreshMin.textContent = `${minT}%`;

    // pH Tanah
    const elPhVal = document.getElementById('phValue');
    const elPhPointer = document.getElementById('phPointer');
    const elPhBadge = document.getElementById('phStatusBadge');
    const elPhStatusText = document.getElementById('phStatusText');
    const elChartStatPh = document.getElementById('chartStatPh');

    if (elPhVal) elPhVal.textContent = ph.toFixed(2);
    if (elChartStatPh) elChartStatPh.textContent = ph.toFixed(2);

    // Spectrum pointer: 1 to 14
    const phPercent = Math.min(100, Math.max(0, ((ph - 1) / (14 - 1)) * 100));
    if (elPhPointer) elPhPointer.style.left = `${phPercent}%`;

    if (ph >= 6.0 && ph <= 7.2) {
      setBadge(elPhBadge, 'Netral (Ideal)', 'status-optimal');
      if (elPhStatusText) elPhStatusText.textContent = 'Subur / Prima';
    } else if (ph < 6.0) {
      setBadge(elPhBadge, 'Tanah Asam', 'status-warning');
      if (elPhStatusText) elPhStatusText.textContent = 'Perlu Kapur/Dolomit';
    } else {
      setBadge(elPhBadge, 'Tanah Basa', 'status-warning');
      if (elPhStatusText) elPhStatusText.textContent = 'Alkalin Tinggi';
    }
  }

  function setBadge(elem, text, cls) {
    if (!elem) return;
    elem.textContent = text;
    elem.className = `badge-status ${cls}`;
  }

  // 2. Reservoir & Totals
  function updateReservoirAndTotals() {
    const valTangkiAir = document.getElementById('valTangkiAir');
    const fillTangkiAir = document.getElementById('fillTangkiAir');
    const valTangkiPupuk = document.getElementById('valTangkiPupuk');
    const fillTangkiPupuk = document.getElementById('fillTangkiPupuk');
    const totalAirVal = document.getElementById('totalAirVal');
    const totalPupukVal = document.getElementById('totalPupukVal');

    if (systemState.tangkiAir !== undefined) {
      if (valTangkiAir) valTangkiAir.textContent = `${Math.round(systemState.tangkiAir)}%`;
      if (fillTangkiAir) fillTangkiAir.style.width = `${systemState.tangkiAir}%`;
    }
    if (systemState.tangkiPupuk !== undefined) {
      if (valTangkiPupuk) valTangkiPupuk.textContent = `${Math.round(systemState.tangkiPupuk)}%`;
      if (fillTangkiPupuk) fillTangkiPupuk.style.width = `${systemState.tangkiPupuk}%`;
    }
    if (systemState.totalAirHariIni !== undefined && totalAirVal) {
      totalAirVal.textContent = `${systemState.totalAirHariIni.toFixed(2)} L`;
    }
    if (systemState.totalPupukHariIni !== undefined && totalPupukVal) {
      totalPupukVal.textContent = `${systemState.totalPupukHariIni} ml`;
    }
  }

  // 3. Mode Switch UI
  function updateModeUI() {
    const mode = systemState.controls.mode;
    const btnAuto = document.getElementById('btnModeAuto');
    const btnManual = document.getElementById('btnModeManual');
    const badge = document.getElementById('activeModeBadge');
    const desc = document.getElementById('modeDescriptionText');
    const controlNote = document.getElementById('controlNoteText');

    if (mode === 'auto') {
      if (btnAuto) btnAuto.classList.add('active');
      if (btnManual) btnManual.classList.remove('active');
      if (badge) {
        badge.textContent = 'MODE AUTO';
        badge.classList.remove('manual-active');
      }
      if (desc) {
        desc.innerHTML = `Sistem otomatis memantau kelembapan tanah. Pompa air akan aktif mandiri bila kelembapan &lt; <strong>${systemState.settings.thresholdKelembapanMin}%</strong> dan mati saat mencapai target <strong>${systemState.settings.thresholdKelembapanMax}%</strong>.`;
      }
      if (controlNote) {
        controlNote.textContent = 'Mode Auto: Sistem mengontrol penyiraman otomatis. Tombol penyiraman manual dinonaktifkan.';
      }
    } else {
      if (btnManual) btnManual.classList.add('active');
      if (btnAuto) btnAuto.classList.remove('active');
      if (badge) {
        badge.textContent = 'MODE MANUAL';
        badge.classList.add('manual-active');
      }
      if (desc) {
        desc.innerHTML = `Kontrol manual aktif penuh. Atur durasi penyiraman dengan slider dan tekan tombol untuk mengaktifkan pompa.`;
      }
      if (controlNote) {
        controlNote.textContent = 'Mode Manual: Kendali sakelar aktif. Geser slider untuk mengatur durasi (maksimal 60 detik).';
      }
    }
  }

  // 4. Actuator Controls UI (Water and Fertilizer)
  function updateActuatorControlsUI() {
    const isWaterOn = systemState.controls.pompaAir;
    const isFertOn = systemState.controls.pompaPupuk;
    const isAuto = systemState.controls.mode === 'auto';

    // Card water
    const cardWater = document.getElementById('actuatorWaterCard');
    const badgeWater = document.getElementById('waterStateBadge');
    const textWater = document.getElementById('waterStateText');
    const animWater = document.getElementById('waterAnimation');
    const labelWater = document.getElementById('waterFlowLabel');
    const btnWater = document.getElementById('btnToggleWater');
    const btnWaterText = document.getElementById('btnWaterText');
    const sliderGroupWater = document.getElementById('waterSliderGroup');
    const inputWaterDur = document.getElementById('inputWaterDuration');

    if (isWaterOn) {
      if (cardWater) cardWater.classList.add('active');
      if (badgeWater) {
        badgeWater.className = 'actuator-state-badge state-on-water';
        if (textWater) textWater.textContent = 'MENYIRAM (AKTIF)';
      }
      if (animWater) animWater.classList.add('flowing');
      if (labelWater) labelWater.textContent = '💧 Air Mengalir Menuju Sprinkler...';
      if (btnWater) {
        btnWater.className = 'btn-actuator-main btn-water-on';
        if (btnWaterText) btnWaterText.textContent = 'MATIKAN PENYIRAMAN AIR';
      }
    } else {
      if (cardWater) cardWater.classList.remove('active');
      if (badgeWater) {
        badgeWater.className = 'actuator-state-badge state-off';
        if (textWater) textWater.textContent = 'STANDBY / MATI';
      }
      if (animWater) animWater.classList.remove('flowing');
      if (labelWater) labelWater.textContent = 'Pipa Siaga (Tidak Ada Aliran)';
      if (btnWater) {
        btnWater.className = 'btn-actuator-main btn-water-off';
        if (btnWaterText) btnWaterText.textContent = 'NYALAKAN PENYIRAMAN AIR';
      }
      stopWaterCountdown();
    }

    // Card fertilizer
    const cardFert = document.getElementById('actuatorFertCard');
    const badgeFert = document.getElementById('fertStateBadge');
    const textFert = document.getElementById('fertStateText');
    const animFert = document.getElementById('fertAnimation');
    const labelFert = document.getElementById('fertFlowLabel');
    const btnFert = document.getElementById('btnToggleFert');
    const btnFertText = document.getElementById('btnFertText');
    const sliderGroupFert = document.getElementById('fertSliderGroup');
    const inputFertDur = document.getElementById('inputFertDuration');

    if (isFertOn) {
      if (cardFert) cardFert.classList.add('active');
      if (badgeFert) {
        badgeFert.className = 'actuator-state-badge state-on-fert';
        if (textFert) textFert.textContent = 'INJEKSI AKTIF';
      }
      if (animFert) animFert.classList.add('flowing');
      if (labelFert) labelFert.textContent = '🌿 Injeksi Pupuk Cair Berlangsung...';
      if (btnFert) {
        btnFert.className = 'btn-actuator-main btn-fert-on';
        if (btnFertText) btnFertText.textContent = 'MATIKAN POMPA PUPUK';
      }
    } else {
      if (cardFert) cardFert.classList.remove('active');
      if (badgeFert) {
        badgeFert.className = 'actuator-state-badge state-off';
        if (textFert) textFert.textContent = 'STANDBY / MATI';
      }
      if (animFert) animFert.classList.remove('flowing');
      if (labelFert) labelFert.textContent = 'Injektor Pupuk Siaga';
      if (btnFert) {
        btnFert.className = 'btn-actuator-main btn-fert-off';
        if (btnFertText) btnFertText.textContent = 'AKTIFKAN PENYIRAMAN PUPUK';
      }
      stopFertCountdown();
    }

    // MODE AUTO: Ubah tampilan tombol penyiraman menjadi seperti tombol mati yang tidak bisa ditekan
    if (isAuto) {
      if (btnWater) {
        btnWater.classList.add('mode-auto-disabled');
        btnWater.disabled = true;
        btnWater.setAttribute('aria-disabled', 'true');
        btnWater.setAttribute('title', 'Tombol penyiraman dinonaktifkan dalam Mode Auto');
        if (!isWaterOn && btnWaterText) {
          btnWaterText.textContent = 'PENYIRAMAN AIR (NONAKTIF - MODE AUTO)';
        }
      }
      if (btnFert) {
        btnFert.classList.add('mode-auto-disabled');
        btnFert.disabled = true;
        btnFert.setAttribute('aria-disabled', 'true');
        btnFert.setAttribute('title', 'Tombol penyiraman pupuk dinonaktifkan dalam Mode Auto');
        if (!isFertOn && btnFertText) {
          btnFertText.textContent = 'PENYIRAMAN PUPUK (NONAKTIF - MODE AUTO)';
        }
      }
      if (sliderGroupWater) sliderGroupWater.classList.add('mode-auto-disabled');
      if (inputWaterDur) inputWaterDur.disabled = true;
      if (sliderGroupFert) sliderGroupFert.classList.add('mode-auto-disabled');
      if (inputFertDur) inputFertDur.disabled = true;
    } else {
      if (btnWater) {
        btnWater.classList.remove('mode-auto-disabled');
        btnWater.disabled = false;
        btnWater.removeAttribute('aria-disabled');
        btnWater.removeAttribute('title');
      }
      if (btnFert) {
        btnFert.classList.remove('mode-auto-disabled');
        btnFert.disabled = false;
        btnFert.removeAttribute('aria-disabled');
        btnFert.removeAttribute('title');
      }
      if (sliderGroupWater) sliderGroupWater.classList.remove('mode-auto-disabled');
      if (inputWaterDur) inputWaterDur.disabled = false;
      if (sliderGroupFert) sliderGroupFert.classList.remove('mode-auto-disabled');
      if (inputFertDur) inputFertDur.disabled = false;
    }
  }

  function formatWaterTime(seconds) {
    if (seconds >= 60) {
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      return `${m}:${String(s).padStart(2, '0')}`;
    }
    return String(seconds);
  }

  // Countdowns
  function startWaterCountdown(seconds) {
    stopWaterCountdown();
    waterSecondsLeft = seconds;
    const box = document.getElementById('waterCountdown');
    const num = document.getElementById('waterCountdownNum');
    const unit = document.querySelector('#waterCountdown .countdown-unit');
    if (box) box.classList.remove('hidden');
    if (num) num.textContent = formatWaterTime(waterSecondsLeft);
    if (unit) unit.textContent = waterSecondsLeft >= 60 ? 'menit tersisa' : 'detik tersisa';

    countdownWaterTimer = setInterval(() => {
      waterSecondsLeft--;
      if (waterSecondsLeft <= 0) {
        stopWaterCountdown();
      } else {
        if (num) num.textContent = formatWaterTime(waterSecondsLeft);
        if (unit) unit.textContent = waterSecondsLeft >= 60 ? 'menit tersisa' : 'detik tersisa';
      }
    }, 1000);
  }

  function stopWaterCountdown() {
    if (countdownWaterTimer) {
      clearInterval(countdownWaterTimer);
      countdownWaterTimer = null;
    }
    const box = document.getElementById('waterCountdown');
    if (box) box.classList.add('hidden');
  }

  function startFertCountdown(seconds) {
    stopFertCountdown();
    fertSecondsLeft = seconds;
    const box = document.getElementById('fertCountdown');
    const num = document.getElementById('fertCountdownNum');
    if (box) box.classList.remove('hidden');
    if (num) num.textContent = fertSecondsLeft;

    countdownFertTimer = setInterval(() => {
      fertSecondsLeft--;
      if (fertSecondsLeft <= 0) {
        stopFertCountdown();
      } else {
        if (num) num.textContent = fertSecondsLeft;
      }
    }, 1000);
  }

  function stopFertCountdown() {
    if (countdownFertTimer) {
      clearInterval(countdownFertTimer);
      countdownFertTimer = null;
    }
    const box = document.getElementById('fertCountdown');
    if (box) box.classList.add('hidden');
  }

  // ==========================================
  // CHART.JS INITIALIZATION & UPDATES
  // ==========================================
  function createChartGradient(ctx, colorStart, colorEnd) {
    const gradient = ctx.createLinearGradient(0, 0, 0, 220);
    gradient.addColorStop(0, colorStart);
    gradient.addColorStop(1, colorEnd);
    return gradient;
  }

  function initCharts() {
    if (typeof Chart === 'undefined') {
      console.warn('Chart.js is not loaded yet');
      return;
    }

    const labels = chartDataHistory.map(d => d.timestamp);
    const dataSuhu = chartDataHistory.map(d => d.suhu);
    const dataMoisture = chartDataHistory.map(d => d.kelembapan);
    const dataPh = chartDataHistory.map(d => d.ph);

    // Common Chart options
    const commonOptions = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      interaction: {
        intersect: false,
        mode: 'index'
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.95)',
          titleColor: '#f8fafc',
          bodyColor: '#94a3b8',
          borderColor: 'rgba(255, 255, 255, 0.1)',
          borderWidth: 1,
          padding: 10,
          displayColors: true,
          boxWidth: 8,
          boxHeight: 8,
          usePointStyle: true
        }
      },
      scales: {
        x: {
          grid: {
            color: 'rgba(255, 255, 255, 0.04)',
            drawBorder: false
          },
          ticks: {
            color: '#64748b',
            font: { size: 10, family: 'Plus Jakarta Sans' },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 7
          }
        },
        y: {
          grid: {
            color: 'rgba(255, 255, 255, 0.05)',
            drawBorder: false
          },
          ticks: {
            color: '#64748b',
            font: { size: 10, family: 'Plus Jakarta Sans' }
          }
        }
      }
    };

    // 1. Chart Suhu
    const canvasSuhu = document.getElementById('chartSuhuCanvas');
    if (canvasSuhu) {
      const ctxSuhu = canvasSuhu.getContext('2d');
      if (chartSuhuInstance) chartSuhuInstance.destroy();

      chartSuhuInstance = new Chart(ctxSuhu, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Suhu (°C)',
            data: dataSuhu,
            borderColor: '#f59e0b',
            backgroundColor: createChartGradient(ctxSuhu, 'rgba(245, 158, 11, 0.35)', 'rgba(245, 158, 11, 0.01)'),
            borderWidth: 2.5,
            fill: true,
            tension: 0.35,
            pointRadius: 2,
            pointHoverRadius: 6,
            pointBackgroundColor: '#f59e0b'
          }]
        },
        options: {
          ...commonOptions,
          scales: {
            ...commonOptions.scales,
            y: {
              ...commonOptions.scales.y,
              suggestedMin: 20,
              suggestedMax: 38
            }
          }
        }
      });
    }

    // 2. Chart Kelembapan Tanah
    const canvasMoisture = document.getElementById('chartMoistureCanvas');
    if (canvasMoisture) {
      const ctxMoisture = canvasMoisture.getContext('2d');
      if (chartMoistureInstance) chartMoistureInstance.destroy();

      chartMoistureInstance = new Chart(ctxMoisture, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Kelembapan Tanah (%)',
            data: dataMoisture,
            borderColor: '#10b981',
            backgroundColor: createChartGradient(ctxMoisture, 'rgba(16, 185, 129, 0.35)', 'rgba(16, 185, 129, 0.01)'),
            borderWidth: 2.5,
            fill: true,
            tension: 0.35,
            pointRadius: 2,
            pointHoverRadius: 6,
            pointBackgroundColor: '#10b981'
          }]
        },
        options: {
          ...commonOptions,
          scales: {
            ...commonOptions.scales,
            y: {
              ...commonOptions.scales.y,
              suggestedMin: 15,
              suggestedMax: 85
            }
          }
        }
      });
    }

    // 3. Chart pH Tanah
    const canvasPh = document.getElementById('chartPhCanvas');
    if (canvasPh) {
      const ctxPh = canvasPh.getContext('2d');
      if (chartPhInstance) chartPhInstance.destroy();

      chartPhInstance = new Chart(ctxPh, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'pH Tanah',
            data: dataPh,
            borderColor: '#8b5cf6',
            backgroundColor: createChartGradient(ctxPh, 'rgba(139, 92, 246, 0.35)', 'rgba(139, 92, 246, 0.01)'),
            borderWidth: 2.5,
            fill: true,
            tension: 0.35,
            pointRadius: 2,
            pointHoverRadius: 6,
            pointBackgroundColor: '#8b5cf6'
          }]
        },
        options: {
          ...commonOptions,
          scales: {
            ...commonOptions.scales,
            y: {
              ...commonOptions.scales.y,
              suggestedMin: 5.5,
              suggestedMax: 8.5
            }
          }
        }
      });
    }
  }

  function appendDataToCharts(point) {
    if (!chartSuhuInstance || !chartMoistureInstance || !chartPhInstance) {
      initCharts();
      return;
    }

    const { timestamp, suhu, kelembapan, ph } = point;

    // Update Suhu
    chartSuhuInstance.data.labels.push(timestamp);
    chartSuhuInstance.data.datasets[0].data.push(suhu);
    if (chartSuhuInstance.data.labels.length > 30) {
      chartSuhuInstance.data.labels.shift();
      chartSuhuInstance.data.datasets[0].data.shift();
    }
    chartSuhuInstance.update('none');

    // Update Moisture
    chartMoistureInstance.data.labels.push(timestamp);
    chartMoistureInstance.data.datasets[0].data.push(kelembapan);
    if (chartMoistureInstance.data.labels.length > 30) {
      chartMoistureInstance.data.labels.shift();
      chartMoistureInstance.data.datasets[0].data.shift();
    }
    chartMoistureInstance.update('none');

    // Update pH
    chartPhInstance.data.labels.push(timestamp);
    chartPhInstance.data.datasets[0].data.push(ph);
    if (chartPhInstance.data.labels.length > 30) {
      chartPhInstance.data.labels.shift();
      chartPhInstance.data.datasets[0].data.shift();
    }
    chartPhInstance.update('none');
  }

  // ==========================================
  // CONTROLS ACTIONS (SEND TO BACKEND)
  // ==========================================
  async function sendControlRequest(payload) {
    try {
      soundRelayClick(Boolean(payload.pompaAir || payload.pompaPupuk));
      const res = await fetch('/api/controls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const result = await res.json();
        if (result.controls) {
          systemState.controls = result.controls;
          updateUI();
        }
      }
    } catch (err) {
      console.error('Failed to send control command:', err);
    }
  }

  // Set Mode
  function setMode(mode) {
    if (systemState.controls.mode === mode) return;
    playTone(660, 'sine', 0.1);
    sendControlRequest({ mode });
  }

  // Toggle Pompa Air
  function toggleWaterPump() {
    if (systemState.controls.mode === 'auto') {
      return; // Tombol mati / nonaktif saat mode auto
    }
    const nextState = !systemState.controls.pompaAir;
    if (nextState) {
      const slider = document.getElementById('inputWaterDuration');
      const dur = slider ? Math.min(60, Math.max(1, Number(slider.value))) : (systemState.settings.durasiSiramOtomatisDetik || 15);
      startWaterCountdown(dur);
      sendControlRequest({ pompaAir: true, durasiSiram: dur });
    } else {
      stopWaterCountdown();
      sendControlRequest({ pompaAir: false });
    }
  }

  // Toggle Pompa Pupuk
  function toggleFertPump() {
    if (systemState.controls.mode === 'auto') {
      return; // Tombol mati / nonaktif saat mode auto
    }
    const nextState = !systemState.controls.pompaPupuk;
    if (nextState) {
      const slider = document.getElementById('inputFertDuration');
      const dur = slider ? Math.min(60, Math.max(1, Number(slider.value))) : 10;
      startFertCountdown(dur);
      sendControlRequest({ pompaPupuk: true, durasiPupuk: dur });
    } else {
      stopFertCountdown();
      sendControlRequest({ pompaPupuk: false });
    }
  }

  // Emergency Cut-off
  function triggerEmergencyStop() {
    soundAlert();
    stopWaterCountdown();
    stopFertCountdown();
    sendControlRequest({ pompaAir: false, pompaPupuk: false });
  }

  // ==========================================
  // EVENT LOGS RENDERING & CSV EXPORT
  // ==========================================
  let currentLogs = [];

  function renderLogs(logs) {
    currentLogs = logs || [];
    const container = document.getElementById('logList');
    if (!container) return;
    container.innerHTML = '';
    currentLogs.forEach(log => {
      container.appendChild(createLogRow(log));
    });
  }

  function prependLog(log) {
    currentLogs.unshift(log);
    if (currentLogs.length > 50) currentLogs.pop();
    const container = document.getElementById('logList');
    if (!container) return;
    const row = createLogRow(log);
    container.insertBefore(row, container.firstChild);
  }

  function createLogRow(log) {
    const row = document.createElement('div');
    row.className = 'log-row';

    let badgeClass = 'badge-log-system';
    const cat = (log.kategori || '').toUpperCase();
    if (cat.includes('WATER') || cat.includes('AIR')) badgeClass = 'badge-log-water';
    else if (cat.includes('FERT') || cat.includes('PUPUK')) badgeClass = 'badge-log-fert';
    else if (cat.includes('AUTO')) badgeClass = 'badge-log-auto';
    else if (cat.includes('MODE')) badgeClass = 'badge-log-mode';

    row.innerHTML = `
      <span class="log-time">${log.waktu || ''}</span>
      <div><span class="log-badge ${badgeClass}">${log.kategori || 'SISTEM'}</span></div>
      <span class="log-msg" title="${log.pesan}">${log.pesan}</span>
    `;
    return row;
  }

  function exportLogsCSV() {
    if (!currentLogs.length) {
      alert('Belum ada log untuk diekspor.');
      return;
    }
    const headers = ['Waktu', 'Kategori', 'Pesan'];
    const rows = currentLogs.map(l => [
      `"${l.waktu}"`,
      `"${l.kategori}"`,
      `"${l.pesan.replace(/"/g, '""')}"`
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + 
      [headers.join(','), ...rows.map(e => e.join(','))].join('\n');

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `AquaSmart_Log_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // ==========================================
  // REALTIME DIGITAL CLOCK
  // ==========================================
  function updateClock() {
    const clockEl = document.getElementById('digitalClock');
    if (!clockEl) return;
    const now = new Date();
    const timeStr = now.toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    clockEl.textContent = `${timeStr} WIB`;
  }
  setInterval(updateClock, 1000);
  updateClock();

  // ==========================================
  // MODAL & SETTINGS
  // ==========================================
  function setupModals() {
    const modal = document.getElementById('settingsModal');
    const btnOpen = document.getElementById('btnOpenSettings');
    const btnClose = document.getElementById('btnCloseModal');
    const linkEsp = document.getElementById('linkESPGuide');
    const linkThresh = document.getElementById('linkThresholdConfig');

    function openModal(defaultTab = 'tab-threshold') {
      if (modal) {
        modal.classList.remove('hidden');
        switchModalTab(defaultTab);
        populateSettingsForm();
      }
    }

    function closeModal() {
      if (modal) modal.classList.add('hidden');
    }

    if (btnOpen) btnOpen.addEventListener('click', () => openModal('tab-threshold'));
    if (btnClose) btnClose.addEventListener('click', closeModal);
    if (linkEsp) {
      linkEsp.addEventListener('click', (e) => {
        e.preventDefault();
        openModal('tab-esp32');
      });
    }
    if (linkThresh) {
      linkThresh.addEventListener('click', (e) => {
        e.preventDefault();
        openModal('tab-threshold');
      });
    }

    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });

    // Tab buttons inside modal
    const tabs = document.querySelectorAll('.tab-btn');
    tabs.forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-tab');
        switchModalTab(target);
      });
    });

    // Sliders live label display
    const rangeMin = document.getElementById('inputThreshMin');
    const dispMin = document.getElementById('displayThreshMin');
    if (rangeMin && dispMin) {
      rangeMin.addEventListener('input', () => {
        dispMin.textContent = `${rangeMin.value}%`;
      });
    }

    const rangeMax = document.getElementById('inputThreshMax');
    const dispMax = document.getElementById('displayThreshMax');
    if (rangeMax && dispMax) {
      rangeMax.addEventListener('input', () => {
        dispMax.textContent = `${rangeMax.value}%`;
      });
    }

    const rangeDur = document.getElementById('inputDuration');
    const dispDur = document.getElementById('displayDuration');
    if (rangeDur && dispDur) {
      rangeDur.addEventListener('change', () => {
        const val = Number(rangeDur.value);
        dispDur.textContent = val >= 60 ? `${val / 60} Menit` : `${val} Detik`;
      });
    }

    const selectDbInt = document.getElementById('inputDbIntervalSettings');
    const dispDbInt = document.getElementById('displayDbInterval');
    if (selectDbInt && dispDbInt) {
      selectDbInt.addEventListener('change', () => {
        const val = Number(selectDbInt.value);
        dispDbInt.textContent = val >= 60 ? '1 Jam' : `${val} Menit`;
      });
    }

    // Form submit
    const form = document.getElementById('settingsForm');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const minVal = Number(rangeMin.value);
        const maxVal = Number(rangeMax.value);
        const durVal = Number(rangeDur.value);
        const dbIntVal = selectDbInt ? Number(selectDbInt.value) : undefined;
        const simActive = document.getElementById('checkSimulation').checked;

        if (minVal >= maxVal) {
          alert('Ambang batas bawah harus lebih kecil daripada target batas maksimal!');
          return;
        }

        try {
          const res = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              thresholdKelembapanMin: minVal,
              thresholdKelembapanMax: maxVal,
              durasiSiramOtomatisDetik: durVal,
              databaseIntervalMenit: dbIntVal,
              simulationActive: simActive
            })
          });
          if (res.ok) {
            closeModal();
            playTone(800, 'sine', 0.15);
          }
        } catch (err) {
          console.error('Error saving settings:', err);
        }
      });
    }

    // Copy Arduino Code Button
    const btnCopy = document.getElementById('btnCopyInoCode');
    const codeBlock = document.getElementById('inoCodeBlock');
    if (btnCopy && codeBlock) {
      btnCopy.addEventListener('click', () => {
        navigator.clipboard.writeText(codeBlock.innerText).then(() => {
          btnCopy.textContent = 'Tersalin!';
          setTimeout(() => {
            btnCopy.textContent = 'Salin Kode';
          }, 2000);
        });
      });
    }
  }

  function switchModalTab(tabId) {
    const tabs = document.querySelectorAll('.tab-btn');
    const contents = document.querySelectorAll('.tab-content');

    tabs.forEach(t => {
      if (t.getAttribute('data-tab') === tabId) t.classList.add('active');
      else t.classList.remove('active');
    });

    contents.forEach(c => {
      if (c.id === tabId) c.classList.add('active');
      else c.classList.remove('active');
    });
  }

  function populateSettingsForm() {
    const s = systemState.settings;
    if (!s) return;
    const rMin = document.getElementById('inputThreshMin');
    const dMin = document.getElementById('displayThreshMin');
    const rMax = document.getElementById('inputThreshMax');
    const dMax = document.getElementById('displayThreshMax');
    const rDur = document.getElementById('inputDuration');
    const dDur = document.getElementById('displayDuration');
    const selDb = document.getElementById('inputDbIntervalSettings');
    const dDb = document.getElementById('displayDbInterval');
    const cSim = document.getElementById('checkSimulation');

    if (rMin && dMin) {
      rMin.value = s.thresholdKelembapanMin;
      dMin.textContent = `${s.thresholdKelembapanMin}%`;
    }
    if (rMax && dMax) {
      rMax.value = s.thresholdKelembapanMax;
      dMax.textContent = `${s.thresholdKelembapanMax}%`;
    }
    if (rDur && dDur) {
      rDur.value = s.durasiSiramOtomatisDetik || 60;
      const v = Number(rDur.value);
      dDur.textContent = v >= 60 ? `${v / 60} Menit` : `${v} Detik`;
    }
    if (selDb && dDb) {
      selDb.value = s.databaseIntervalMenit || 10;
      const v = Number(selDb.value);
      dDb.textContent = v >= 60 ? '1 Jam' : `${v} Menit`;
    }
    if (cSim) {
      cSim.checked = s.simulationActive;
    }
  }

  // ==========================================
  // EVENT LISTENERS BINDING
  // ==========================================
  function bindEventListeners() {
    // Mode Buttons
    const btnAuto = document.getElementById('btnModeAuto');
    const btnManual = document.getElementById('btnModeManual');
    if (btnAuto) btnAuto.addEventListener('click', () => setMode('auto'));
    if (btnManual) btnManual.addEventListener('click', () => setMode('manual'));

    // Emergency Stop
    const btnEmer = document.getElementById('btnEmergencyStop');
    if (btnEmer) btnEmer.addEventListener('click', triggerEmergencyStop);

    // Primary Water and Fert buttons
    const btnWater = document.getElementById('btnToggleWater');
    if (btnWater) btnWater.addEventListener('click', toggleWaterPump);

    const btnFert = document.getElementById('btnToggleFert');
    if (btnFert) btnFert.addEventListener('click', toggleFertPump);

    // Water duration slider (1 - 60 detik)
    const inputWaterDur = document.getElementById('inputWaterDuration');
    const dispWaterDur = document.getElementById('displayWaterDuration');
    if (inputWaterDur && dispWaterDur) {
      inputWaterDur.addEventListener('input', () => {
        dispWaterDur.textContent = `${inputWaterDur.value} Detik`;
      });
    }

    // Fertilizer duration slider (1 - 60 detik)
    const inputFertDur = document.getElementById('inputFertDuration');
    const dispFertDur = document.getElementById('displayFertDuration');
    if (inputFertDur && dispFertDur) {
      inputFertDur.addEventListener('input', () => {
        dispFertDur.textContent = `${inputFertDur.value} Detik`;
      });
    }

    // Chart pause / resume
    const btnPause = document.getElementById('btnPauseChart');
    const labelPause = document.getElementById('chartPauseLabel');
    const iconPause = document.getElementById('iconPause');
    const iconPlay = document.getElementById('iconPlay');

    if (btnPause) {
      btnPause.addEventListener('click', () => {
        isChartPaused = !isChartPaused;
        if (isChartPaused) {
          if (labelPause) labelPause.textContent = 'Lanjut Live';
          if (iconPause) iconPause.classList.add('hidden');
          if (iconPlay) iconPlay.classList.remove('hidden');
        } else {
          if (labelPause) labelPause.textContent = 'Jeda Live';
          if (iconPause) iconPause.classList.remove('hidden');
          if (iconPlay) iconPlay.classList.add('hidden');
        }
      });
    }

    // Chart Clear
    const btnClear = document.getElementById('btnClearChart');
    if (btnClear) {
      btnClear.addEventListener('click', () => {
        chartDataHistory = [];
        if (chartSuhuInstance) {
          chartSuhuInstance.data.labels = [];
          chartSuhuInstance.data.datasets[0].data = [];
          chartSuhuInstance.update();
        }
        if (chartMoistureInstance) {
          chartMoistureInstance.data.labels = [];
          chartMoistureInstance.data.datasets[0].data = [];
          chartMoistureInstance.update();
        }
        if (chartPhInstance) {
          chartPhInstance.data.labels = [];
          chartPhInstance.data.datasets[0].data = [];
          chartPhInstance.update();
        }
      });
    }

    // Export Log
    const btnExport = document.getElementById('btnExportLog');
    if (btnExport) btnExport.addEventListener('click', exportLogsCSV);

    // Sound toggle
    const btnSound = document.getElementById('btnSoundToggle');
    const iconSoundOn = document.getElementById('iconSoundOn');
    const iconSoundOff = document.getElementById('iconSoundOff');

    if (btnSound) {
      btnSound.addEventListener('click', () => {
        audioMuted = !audioMuted;
        if (audioMuted) {
          if (iconSoundOn) iconSoundOn.classList.add('hidden');
          if (iconSoundOff) iconSoundOff.classList.remove('hidden');
        } else {
          if (iconSoundOn) iconSoundOn.classList.remove('hidden');
          if (iconSoundOff) iconSoundOff.classList.add('hidden');
          playTone(520, 'sine', 0.1);
        }
      });
    }
  }

  // ==========================================
  // INITIALIZATION ON DOM READY
  // ==========================================
  document.addEventListener('DOMContentLoaded', () => {
    bindEventListeners();
    setupModals();
    initWebSocket();
  });

})();
