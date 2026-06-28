/* ═══════════════════════════════════════════════════════════
   RPLE Nayax Inventory — script.js
   ═══════════════════════════════════════════════════════════ */

'use strict';

// ── Constants ───────────────────────────────────────────────
const STORAGE_KEY = 'rple-nayax-v3';
const DEBOUNCE_MS = 2000; // ignore same code re-detected within 2s

// ── State ───────────────────────────────────────────────────
let devices     = [];
let batchQueue  = [];
let activeMode  = 'single';   // 'single' | 'batch'
let activeFilter = 'all';
let scanRunning  = false;
let videoStream  = null;
let scanInterval = null;
let lastCode     = '';
let lastCodeTime = 0;
let barcodeDetector = null;

// ── DOM refs ─────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Persistence ──────────────────────────────────────────────
function loadDevices() {
  try { devices = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch { devices = []; }
}

function saveDevices() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(devices));
}

// ── Toast ─────────────────────────────────────────────────────
function toast(msg, type = '', duration = 2800) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' toast-' + type : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast'; }, duration);
}

// ── Tabs ──────────────────────────────────────────────────────
function switchTab(tabName, btn) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  btn.classList.add('active');
  $('view-' + tabName).classList.add('active');
  if (tabName === 'inventory') { renderStats(); renderList(); }
  if (tabName !== 'register')  { stopScan(); }
}

// ── Mode (single / batch) ─────────────────────────────────────
function setMode(m) {
  activeMode = m;
  $('mode-single').classList.toggle('active', m === 'single');
  $('mode-batch').classList.toggle('active', m === 'batch');
  $('panel-single').style.display = m === 'single' ? '' : 'none';
  $('panel-batch').style.display  = m === 'batch'  ? '' : 'none';
}

// ── Scanner ───────────────────────────────────────────────────

/** Initialize native BarcodeDetector if available */
function initBarcodeDetector() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    return new BarcodeDetector({
      formats: [
        'code_128', 'code_39', 'code_93',
        'ean_13',   'ean_8',
        'upc_a',    'upc_e',
        'itf',      'qr_code',
        'data_matrix', 'pdf417', 'aztec',
      ],
    });
  } catch { return null; }
}

/** Set scan status bar text */
function setScanStatus(msg, type = '') {
  const el = $('scan-status');
  if (!msg) { el.className = 'scan-status'; return; }
  el.textContent = msg;
  el.className   = 'scan-status active' + (type ? ' ' + type : '');
}

async function startScan() {
  if (scanRunning) return;

  setScanStatus('Opening camera…');

  try {
    videoStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
  } catch (err) {
    setScanStatus('Camera blocked — check browser permissions', 'err');
    toast('Camera blocked — check permissions', 'err');
    return;
  }

  const video = $('cam-video');
  video.srcObject = videoStream;
  await video.play();

  // Show camera UI
  $('scan-idle').style.display    = 'none';
  video.style.display             = 'block';
  $('scan-overlay').classList.add('active');
  $('btn-open').style.display     = 'none';
  $('btn-close').style.display    = '';

  scanRunning = true;
  setScanStatus('Align barcode within the frame');

  // Init detector once
  if (!barcodeDetector) barcodeDetector = initBarcodeDetector();

  // Poll frames
  scanInterval = setInterval(decodeFrame, 120);
}

function stopScan() {
  clearInterval(scanInterval);
  scanInterval = null;

  if (videoStream) {
    videoStream.getTracks().forEach(t => t.stop());
    videoStream = null;
  }

  const video = $('cam-video');
  video.srcObject = null;
  video.style.display = 'none';

  $('scan-idle').style.display = 'flex';
  $('scan-overlay').classList.remove('active');
  $('btn-open').style.display  = '';
  $('btn-close').style.display = 'none';

  setScanStatus('');
  scanRunning = false;
}

async function decodeFrame() {
  const video = $('cam-video');
  if (!scanRunning || video.readyState < 2 || video.videoWidth === 0) return;

  let code = null;

  // ── Strategy 1: Native BarcodeDetector (fastest, most accurate) ──
  if (barcodeDetector) {
    try {
      const results = await barcodeDetector.detect(video);
      if (results.length) code = results[0].rawValue;
    } catch { /* ignore */ }
  }

  // ── Strategy 2: ZXing via canvas (fallback for Safari / older Chrome) ──
  if (!code) {
    code = tryZXing(video);
  }

  if (!code) return;

  // Debounce — skip if same code seen recently
  const now = Date.now();
  if (code === lastCode && now - lastCodeTime < DEBOUNCE_MS) return;
  lastCode     = code;
  lastCodeTime = now;

  onCodeDetected(code);
}

/** ZXing fallback: draw video frame to canvas, decode with MultiFormatReader */
const _canvas = document.createElement('canvas');
const _ctx    = _canvas.getContext('2d');

function tryZXing(video) {
  const Z = window.ZXing || window.ZXingLibrary;
  if (!Z || !Z.MultiFormatReader) return null;

  try {
    _canvas.width  = video.videoWidth;
    _canvas.height = video.videoHeight;
    _ctx.drawImage(video, 0, 0);

    if (!Z.HTMLCanvasElementLuminanceSource) return null;

    const src = new Z.HTMLCanvasElementLuminanceSource(_canvas);
    const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(src));

    if (!window._zxReader) {
      const hints = new Map([
        [Z.DecodeHintType.TRY_HARDER, true],
        [Z.DecodeHintType.POSSIBLE_FORMATS, [
          Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.CODE_93,
          Z.BarcodeFormat.EAN_13,   Z.BarcodeFormat.EAN_8,
          Z.BarcodeFormat.UPC_A,    Z.BarcodeFormat.UPC_E,
          Z.BarcodeFormat.ITF,      Z.BarcodeFormat.QR_CODE,
          Z.BarcodeFormat.DATA_MATRIX, Z.BarcodeFormat.PDF_417, Z.BarcodeFormat.AZTEC,
        ]],
      ]);
      window._zxReader = new Z.MultiFormatReader();
      window._zxReader.setHints(hints);
    }

    const result = window._zxReader.decode(bmp);
    return result ? result.getText() : null;
  } catch {
    return null;
  }
}

/** Called when a valid code is detected */
function onCodeDetected(code) {
  setScanStatus('✓ Scanned: ' + code, 'ok');

  if (activeMode === 'single') {
    $('sn-single').value = code;
    $('sn-single').classList.remove('error');
    stopScan();
    toast('Scanned: ' + code, 'ok');
  } else {
    addToBatch(code);
    beep();
    // Keep camera open; status resets after 1.5s
    setTimeout(() => {
      if (scanRunning) setScanStatus('Ready — scan next device');
    }, 1500);
  }
}

/** Short audio beep for batch feedback */
function beep() {
  try {
    const ac = new AudioContext();
    const o  = ac.createOscillator();
    const g  = ac.createGain();
    o.connect(g); g.connect(ac.destination);
    o.frequency.value = 1200;
    g.gain.value = 0.12;
    o.start(); o.stop(ac.currentTime + 0.07);
  } catch { /* audio not available */ }
}

// ── Single mode save ──────────────────────────────────────────
function saveSingle() {
  const sn     = $('sn-single').value.trim();
  const so     = $('so-single').value.trim();
  const model  = $('model-single').value;
  const loc    = $('loc-single').value.trim();
  const status = $('status-single').value;
  const notes  = $('notes-single').value.trim();

  // Validate
  let valid = true;
  if (!sn) { $('sn-single').classList.add('error'); valid = false; }
  else       $('sn-single').classList.remove('error');
  if (!so) { $('so-single').classList.add('error'); valid = false; }
  else       $('so-single').classList.remove('error');
  if (!loc){ $('loc-single').classList.add('error'); valid = false; }
  else       $('loc-single').classList.remove('error');

  if (!valid) { toast('Fill in the required fields', 'err'); return; }

  if (devices.find(d => d.sn.toLowerCase() === sn.toLowerCase())) {
    toast('S/N already registered', 'err'); return;
  }

  devices.unshift({ sn, so, model, location: loc, status, notes, date: today() });
  saveDevices();
  toast('Device saved!', 'ok');
  clearSingleForm();
}

function clearSingleForm() {
  ['sn-single','so-single','loc-single','notes-single'].forEach(id => { $(id).value = ''; $(id).classList.remove('error'); });
  $('model-single').value  = '';
  $('status-single').value = 'installed';
}

// ── Batch mode ────────────────────────────────────────────────
function addToBatch(sn) {
  sn = sn.trim();
  if (!sn) return;
  if (batchQueue.includes(sn))                                              { toast('Already in queue: ' + sn, 'err'); return; }
  if (devices.find(d => d.sn.toLowerCase() === sn.toLowerCase()))           { toast('Already registered: ' + sn, 'err'); return; }
  batchQueue.push(sn);
  renderBatchQueue();
}

function removeFromBatch(sn) {
  batchQueue = batchQueue.filter(s => s !== sn);
  renderBatchQueue();
}

function clearBatch() {
  if (!batchQueue.length) return;
  if (!confirm('Clear all scanned S/Ns?')) return;
  batchQueue = [];
  renderBatchQueue();
}

function saveBatch() {
  const so    = $('so-batch').value.trim();
  const loc   = $('loc-batch').value.trim();

  if (!batchQueue.length) { toast('No S/Ns scanned yet', 'err'); return; }

  let valid = true;
  if (!so)  { $('so-batch').classList.add('error');  valid = false; }
  else        $('so-batch').classList.remove('error');
  if (!loc) { $('loc-batch').classList.add('error'); valid = false; }
  else        $('loc-batch').classList.remove('error');

  if (!valid) { toast('Fill in the required fields', 'err'); return; }

  const model  = $('model-batch').value;
  const status = $('status-batch').value;
  const notes  = $('notes-batch').value.trim();
  const d      = today();

  batchQueue.forEach(sn => {
    if (!devices.find(dev => dev.sn.toLowerCase() === sn.toLowerCase()))
      devices.unshift({ sn, so, model, location: loc, status, notes, date: d });
  });

  const saved = batchQueue.length;
  saveDevices();
  batchQueue = [];
  renderBatchQueue();
  toast(saved + ' device' + (saved !== 1 ? 's' : '') + ' saved!', 'ok');
  clearBatchForm();
}

function clearBatchForm() {
  ['so-batch','loc-batch','notes-batch'].forEach(id => { $(id).value = ''; $(id).classList.remove('error'); });
  $('model-batch').value  = '';
  $('status-batch').value = 'installed';
}

function renderBatchQueue() {
  const list  = $('batch-list');
  const count = batchQueue.length;
  $('batch-count').textContent     = count + ' item' + (count !== 1 ? 's' : '');
  $('batch-save-count').textContent = count;

  if (!count) {
    list.innerHTML = '<div class="batch-empty">No S/Ns scanned yet.<br>Open the camera and scan each device.</div>';
    return;
  }

  list.innerHTML = batchQueue.map((sn, i) => `
    <div class="batch-item">
      <span class="batch-sn">${i + 1}. ${sn}</span>
      <button class="btn-icon btn-sm" onclick="removeFromBatch('${esc(sn)}')">
        <i class="ti ti-x"></i>
      </button>
    </div>`).join('');
}

// ── Inventory ─────────────────────────────────────────────────
const badgeClass = s => ({ installed:'badge-installed', stock:'badge-stock', fault:'badge-fault' }[s] || 'badge-stock');
const badgeLabel = s => ({ installed:'Installed', stock:'In Stock', fault:'Fault' }[s] || s);

function renderStats() {
  const count = st => devices.filter(d => d.status === st).length;
  $('stats').innerHTML = `
    <div class="stat"><div class="stat-n n-installed">${count('installed')}</div><div class="stat-l">Installed</div></div>
    <div class="stat"><div class="stat-n n-stock">${count('stock')}</div><div class="stat-l">In Stock</div></div>
    <div class="stat"><div class="stat-n n-fault">${count('fault')}</div><div class="stat-l">Fault</div></div>`;
}

function renderList() {
  const q = ($('search').value || '').toLowerCase();
  let list = activeFilter === 'all' ? devices : devices.filter(d => d.status === activeFilter);
  if (q) list = list.filter(d =>
    d.sn.toLowerCase().includes(q) ||
    (d.location || '').toLowerCase().includes(q) ||
    (d.so || '').toString().includes(q)
  );

  const el = $('device-list');
  if (!list.length) {
    el.innerHTML = '<div class="empty"><i class="ti ti-package"></i><p>No devices found</p></div>';
    return;
  }

  el.innerHTML = list.map(d => `
    <div class="dev-card">
      <div class="dev-top">
        <div>
          <div class="dev-sn">${d.sn}</div>
          <div class="dev-sub">${d.model || 'Model not set'}${d.so ? ' &middot; <span class="so-tag">SO #' + d.so + '</span>' : ''}</div>
        </div>
        <span class="badge ${badgeClass(d.status)}">${badgeLabel(d.status)}</span>
      </div>
      <div class="dev-row"><i class="ti ti-map-pin" style="font-size:12px"></i> ${d.location || '—'}</div>
      ${d.notes ? `<div class="dev-notes">${d.notes}</div>` : ''}
      <div class="dev-foot">
        <span class="dev-date">${d.date}</span>
        <button class="btn-icon" onclick="deleteDevice('${esc(d.sn)}')"><i class="ti ti-trash"></i></button>
      </div>
    </div>`).join('');
}

function setFilter(f, btn) {
  activeFilter = f;
  document.querySelectorAll('.f-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderList();
}

function deleteDevice(sn) {
  if (!confirm('Remove ' + sn + '?')) return;
  devices = devices.filter(d => d.sn !== sn);
  saveDevices(); renderStats(); renderList();
  toast('Removed');
}

function exportCSV() {
  if (!devices.length) { toast('Nothing to export', 'err'); return; }
  const header = 'S/N,SO,Model,Location,Status,Notes,Date';
  const rows   = devices.map(d =>
    [d.sn, d.so, d.model, d.location, badgeLabel(d.status), d.notes, d.date]
      .map(v => '"' + (v || '').replace(/"/g, '""') + '"').join(',')
  );
  const a  = document.createElement('a');
  a.href   = 'data:text/csv;charset=utf-8,' + encodeURIComponent('\uFEFF' + [header, ...rows].join('\n'));
  a.download = 'nayax-inventory-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
  toast('CSV exported', 'ok');
}

// ── Helpers ───────────────────────────────────────────────────
function today() { return new Date().toLocaleDateString('en-AU'); }
function esc(s)  { return s.replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }

// ── Boot ──────────────────────────────────────────────────────
loadDevices();
renderStats();
renderList();
renderBatchQueue();
