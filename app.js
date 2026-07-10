// ================= CONSTANTS & APP STATE =================
let db = { documents: [] };
const vaultDb = new Dexie('ScanVaultDatabase');
vaultDb.version(1).stores({
  documents: 'id, createdAt, category, date'
});

let currentTab = 'dashboard';
let inputMode = 'upload'; // 'upload' or 'camera'
let webcamStream = null;

// Image Editor State
let loadedImage = null;
let currentRotation = 0; // 0, 90, 180, 270
let activeFilter = 'original'; // 'original', 'grayscale', 'document', 'monochrome'
let currentBrightness = 0; // -100 to 100
let currentContrast = 0; // -100 to 100
let pendingPages = [];

// Current Editing / Viewing Doc ID
let activeDocumentId = null;

// ================= INITIALIZATION =================
document.addEventListener('DOMContentLoaded', async () => {
  await loadDatabase();
  initializeLucide();
  setupEventListeners();
  initTheme();
  refreshUI();
  
  // Set default date picker to today
  document.getElementById('doc-date').valueAsDate = new Date();
});

// Helper to initialize Lucide icons
function initializeLucide() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

// Load documents from IndexedDB and migrate the legacy LocalStorage database once.
async function loadDatabase() {
  try {
    const legacyDb = localStorage.getItem('scanvault_db');
    if (legacyDb && await vaultDb.documents.count() === 0) {
      const parsed = JSON.parse(legacyDb);
      if (Array.isArray(parsed.documents)) {
        const migrated = parsed.documents.map(normalizeDocument);
        await vaultDb.documents.bulkPut(migrated);
      }
      localStorage.removeItem('scanvault_db');
    }
    db.documents = (await vaultDb.documents.toArray())
      .map(normalizeDocument)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } catch (e) {
    console.error('Gagal memuat IndexedDB.', e);
    db = { documents: [] };
  }
}

function normalizeDocument(doc) {
  const pages = Array.isArray(doc.pages) && doc.pages.length ? doc.pages : (doc.image ? [doc.image] : []);
  return { ...doc, pages, image: pages[0] || '', createdAt: doc.createdAt || Date.now() };
}

// Save the in-memory view into IndexedDB; document images never go to LocalStorage.
async function saveDatabase() {
  await vaultDb.transaction('rw', vaultDb.documents, async () => {
    await vaultDb.documents.clear();
    if (db.documents.length) await vaultDb.documents.bulkPut(db.documents);
  });
  refreshUI();
}

// ================= EVENT LISTENERS SETUP =================
function setupEventListeners() {
  // Sidebar menu navigation
  const menuItems = document.querySelectorAll('.sidebar-menu .menu-item');
  menuItems.forEach(item => {
    item.addEventListener('click', (e) => {
      const tabId = item.getAttribute('data-tab');
      switchTab(tabId);
    });
  });

  // Theme Toggle buttons
  const themeBtns = document.querySelectorAll('.theme-switch .theme-btn');
  themeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      themeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const selectedTheme = btn.getAttribute('data-theme');
      applyTheme(selectedTheme);
    });
  });

  // Global Search bar input (synchronize with Library Search)
  const globalSearch = document.getElementById('global-search');
  globalSearch.addEventListener('input', (e) => {
    const val = e.target.value;
    document.getElementById('library-search').value = val;
    switchTab('library');
    renderDocumentsList();
  });

  // Library search and filters
  document.getElementById('library-search').addEventListener('input', renderDocumentsList);
  document.getElementById('library-filter-category').addEventListener('change', renderDocumentsList);
  document.getElementById('library-sort-by').addEventListener('change', renderDocumentsList);

  // View style toggle buttons (Grid/List)
  const gridBtn = document.getElementById('view-grid-btn');
  const listBtn = document.getElementById('view-list-btn');
  const container = document.getElementById('documents-container');

  gridBtn.addEventListener('click', () => {
    gridBtn.classList.add('active');
    listBtn.classList.remove('active');
    container.classList.add('grid-view');
    container.classList.remove('list-view');
    renderDocumentsList();
  });

  listBtn.addEventListener('click', () => {
    listBtn.classList.add('active');
    gridBtn.classList.remove('active');
    container.classList.add('list-view');
    container.classList.remove('grid-view');
    renderDocumentsList();
  });

  // Quick Action scan buttons
  document.getElementById('quick-scan-btn').addEventListener('click', () => {
    switchTab('scanner');
  });
  document.getElementById('dashboard-scan-btn').addEventListener('click', () => {
    switchTab('scanner');
    setInputMode('camera');
  });
  document.getElementById('empty-state-scan-btn').addEventListener('click', () => {
    switchTab('scanner');
  });
  document.getElementById('view-all-docs-btn').addEventListener('click', () => {
    switchTab('library');
  });

  // Scanner input mode tabs (Upload vs Webcam)
  document.getElementById('tab-mode-upload').addEventListener('click', () => setInputMode('upload'));
  document.getElementById('tab-mode-camera').addEventListener('click', () => setInputMode('camera'));

  // Dropzone drag/drop trigger
  const dropzone = document.getElementById('file-dropzone');
  const fileInput = document.getElementById('file-input');
  
  document.getElementById('browse-file-btn').addEventListener('click', () => fileInput.click());
  
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileSelection(e.target.files[0]);
    }
  });

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleFileSelection(e.dataTransfer.files[0]);
    }
  });

  // Camera selection device change
  document.getElementById('camera-select').addEventListener('change', startWebcam);
  document.getElementById('retry-camera-btn').addEventListener('click', startWebcam);

  // Capture photo button
  document.getElementById('capture-btn').addEventListener('click', capturePhoto);

  // Canvas Image Editor filter buttons
  const filterBtns = document.querySelectorAll('.filter-buttons .filter-btn');
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.getAttribute('data-filter');
      redrawCanvas();
    });
  });

  // Canvas adjustment sliders
  const contrastSlider = document.getElementById('contrast-slider');
  const brightnessSlider = document.getElementById('brightness-slider');
  
  contrastSlider.addEventListener('input', (e) => {
    currentContrast = parseInt(e.target.value);
    document.getElementById('contrast-val').textContent = currentContrast > 0 ? `+${currentContrast}` : currentContrast;
    redrawCanvas();
  });

  brightnessSlider.addEventListener('input', (e) => {
    currentBrightness = parseInt(e.target.value);
    document.getElementById('brightness-val').textContent = currentBrightness > 0 ? `+${currentBrightness}` : currentBrightness;
    redrawCanvas();
  });

  // Image actions (Rotate, Reset)
  document.getElementById('rotate-btn').addEventListener('click', () => {
    currentRotation = (currentRotation + 90) % 360;
    redrawCanvas();
  });

  document.getElementById('reset-image-btn').addEventListener('click', resetEditor);
  document.getElementById('add-page-btn').addEventListener('click', addCurrentPage);

  // OCR button action
  document.getElementById('ocr-extract-btn').addEventListener('click', runOcrTextExtraction);

  // Document metadata form submit
  document.getElementById('doc-metadata-form').addEventListener('submit', saveScannedDocument);

  // Modal details management
  document.getElementById('close-detail-modal').addEventListener('click', closeDetailsModal);
  document.getElementById('doc-detail-modal').addEventListener('click', (e) => {
    if (e.target.id === 'doc-detail-modal') closeDetailsModal();
  });

  // Edit OCR Text in detail modal
  const editOcrBtn = document.getElementById('edit-modal-ocr-btn');
  const modalOcrText = document.getElementById('modal-doc-ocr-text');
  
  editOcrBtn.addEventListener('click', () => {
    const isReadOnly = modalOcrText.hasAttribute('readonly');
    if (isReadOnly) {
      modalOcrText.removeAttribute('readonly');
      modalOcrText.focus();
      document.getElementById('edit-ocr-btn-text').textContent = "Simpan Perubahan";
      editOcrBtn.classList.remove('btn-outline');
      editOcrBtn.classList.add('btn-primary');
    } else {
      modalOcrText.setAttribute('readonly', 'true');
      document.getElementById('edit-ocr-btn-text').textContent = "Edit Teks";
      editOcrBtn.classList.add('btn-outline');
      editOcrBtn.classList.remove('btn-primary');
      
      // Save changes to database
      updateDocumentText(activeDocumentId, modalOcrText.value);
    }
  });

  // Copy text, Delete and PDF actions
  document.getElementById('copy-doc-text-btn').addEventListener('click', copyExtractedText);
  document.getElementById('download-pdf-btn').addEventListener('click', downloadPdfDocument);
  document.getElementById('compress-pdf-btn').addEventListener('click', downloadCompressedPdfDocument);
  document.getElementById('delete-doc-btn').addEventListener('click', deleteDocumentAction);

  // Settings features
  document.getElementById('settings-export-btn').addEventListener('click', exportDatabase);
  
  const importTrigger = document.getElementById('settings-import-trigger-btn');
  const importInput = document.getElementById('settings-import-input');
  importTrigger.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', importDatabase);

  document.getElementById('settings-clear-btn').addEventListener('click', clearDatabase);
  
}

// ================= TAB NAVIGATION =================
function switchTab(tabId) {
  currentTab = tabId;
  
  // Update sidebar active menu state
  const menuItems = document.querySelectorAll('.sidebar-menu .menu-item');
  menuItems.forEach(item => {
    if (item.getAttribute('data-tab') === tabId) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Hide all panels, show selected panel
  const panels = document.querySelectorAll('.tab-panel');
  panels.forEach(panel => {
    if (panel.id === `tab-${tabId}`) {
      panel.classList.add('active');
    } else {
      panel.classList.remove('active');
    }
  });

  // Page titles dictionary
  const pageDetails = {
    dashboard: { title: "Dashboard", subtitle: "Selamat datang! Kelola dan cari dokumen hasil scan Anda." },
    library: { title: "Perpustakaan Dokumen", subtitle: "Lihat hasil scan, lakukan pencarian isi teks (OCR), dan ekspor data." },
    scanner: { title: "Scan Dokumen Baru", subtitle: "Ambil foto lewat kamera laptop/HP atau upload gambar file dokumen fisik." },
    settings: { title: "Pengaturan & Sistem", subtitle: "Atur database lokal, buat backup data, dan kelola kapasitas penyimpanan." }
  };

  const details = pageDetails[tabId] || { title: "ScanVault", subtitle: "" };
  document.getElementById('page-title').textContent = details.title;
  document.getElementById('page-subtitle').textContent = details.subtitle;

  // Manage webcam stream resources
  if (tabId === 'scanner' && inputMode === 'camera') {
    startWebcam();
  } else {
    stopWebcam();
  }

  // Refresh page data when switching tabs
  if (tabId === 'dashboard') {
    renderDashboardStats();
    renderRecentDocuments();
  } else if (tabId === 'library') {
    renderDocumentsList();
  }
}

// ================= THEME MANAGEMENT =================
function initTheme() {
  const savedTheme = localStorage.getItem('scanvault_theme') || 'dark';
  applyTheme(savedTheme);
  
  const themeBtns = document.querySelectorAll('.theme-switch .theme-btn');
  themeBtns.forEach(btn => {
    if (btn.getAttribute('data-theme') === savedTheme) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

function applyTheme(theme) {
  if (theme === 'light') {
    document.body.classList.remove('theme-dark');
    document.body.classList.add('theme-light');
  } else {
    document.body.classList.remove('theme-light');
    document.body.classList.add('theme-dark');
  }
  localStorage.setItem('scanvault_theme', theme);
}

// ================= UI REFRESH HANDLER =================
function refreshUI() {
  renderDashboardStats();
  renderRecentDocuments();
  renderDocumentsList();
}

// ================= SCANNER / CAMERA INPUT METHODS =================
function setInputMode(mode) {
  inputMode = mode;
  
  const tabUpload = document.getElementById('tab-mode-upload');
  const tabCamera = document.getElementById('tab-mode-camera');
  const zoneUpload = document.getElementById('upload-workzone');
  const zoneCamera = document.getElementById('camera-workzone');
  const zoneEditor = document.getElementById('editor-workzone');
  
  // Hide image editor
  zoneEditor.classList.remove('active');
  
  if (mode === 'upload') {
    tabUpload.classList.add('active');
    tabCamera.classList.remove('active');
    zoneUpload.classList.add('active');
    zoneCamera.classList.remove('active');
    stopWebcam();
  } else {
    tabCamera.classList.add('active');
    tabUpload.classList.remove('active');
    zoneCamera.classList.add('active');
    zoneUpload.classList.remove('active');
    startWebcam();
  }
}

// Access Web camera and streams video
async function startWebcam() {
  const video = document.getElementById('webcam-video');
  const errorMsg = document.getElementById('camera-error');
  const cameraSelect = document.getElementById('camera-select');
  
  errorMsg.classList.add('hidden');
  video.classList.remove('hidden');
  
  if (webcamStream) {
    stopWebcam();
  }
  
  const constraints = {
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: "environment"
    }
  };
  
  if (cameraSelect.value) {
    constraints.video.deviceId = { exact: cameraSelect.value };
  }
  
  try {
    webcamStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = webcamStream;
    
    // Refresh camera lists
    await populateCameraDropdown();
  } catch (err) {
    console.error("Error accessing webcam: ", err);
    errorMsg.classList.remove('hidden');
    video.classList.add('hidden');
  }
}

function stopWebcam() {
  if (webcamStream) {
    webcamStream.getTracks().forEach(track => track.stop());
    webcamStream = null;
  }
}

// Fetch available cameras
async function populateCameraDropdown() {
  const cameraSelect = document.getElementById('camera-select');
  const currentVal = cameraSelect.value;
  
  try {
    // Check permission state first
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(device => device.kind === 'videoinput');
    
    cameraSelect.innerHTML = '';
    
    if (videoDevices.length === 0) {
      cameraSelect.innerHTML = '<option value="">Kamera tidak ditemukan</option>';
      return;
    }
    
    videoDevices.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Kamera ${index + 1}`;
      if (device.deviceId === currentVal) {
        option.selected = true;
      }
      cameraSelect.appendChild(option);
    });
  } catch (err) {
    console.error("Gagal mencari list kamera", err);
  }
}

// Select document file from computer
function handleFileSelection(file) {
  if (!file.type.startsWith('image/')) {
    alert('Format file tidak didukung. Silakan pilih file gambar (JPG, PNG, WebP).');
    return;
  }
  
  const reader = new FileReader();
  reader.onload = (event) => {
    loadImageToEditor(event.target.result);
  };
  reader.readAsDataURL(file);
}

// Captures a frame from video and loads to editor
function capturePhoto() {
  const video = document.getElementById('webcam-video');
  if (!webcamStream) return;
  
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  
  // Mirror if front camera usually
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  loadImageToEditor(dataUrl);
  stopWebcam();
}

// ================= IMAGE CANVAS EDITOR & FILTERS =================
function loadImageToEditor(dataUrl) {
  const zoneUpload = document.getElementById('upload-workzone');
  const zoneCamera = document.getElementById('camera-workzone');
  const zoneEditor = document.getElementById('editor-workzone');
  
  zoneUpload.classList.remove('active');
  zoneCamera.classList.remove('active');
  zoneEditor.classList.add('active');
  
  // Reset filter values
  activeFilter = 'original';
  currentRotation = 0;
  currentBrightness = 0;
  currentContrast = 0;
  
  document.getElementById('contrast-slider').value = 0;
  document.getElementById('contrast-val').textContent = "0";
  document.getElementById('brightness-slider').value = 0;
  document.getElementById('brightness-val').textContent = "0";
  
  const filterBtns = document.querySelectorAll('.filter-buttons .filter-btn');
  filterBtns.forEach(btn => {
    if (btn.getAttribute('data-filter') === 'original') {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  loadedImage = new Image();
  loadedImage.onload = () => {
    redrawCanvas();
    // Enable OCR action button since image is loaded
    document.getElementById('ocr-extract-btn').removeAttribute('disabled');
    // Enable Save button as well so they can save without OCR if they want!
    document.getElementById('save-doc-btn').removeAttribute('disabled');
    document.getElementById('add-page-btn').removeAttribute('disabled');
    document.getElementById('ocr-status-badge').textContent = "Gambar Siap";
    document.getElementById('ocr-status-badge').className = "ocr-status-badge badge-idle";
  };
  loadedImage.src = dataUrl;
}

// Redraw canvas with rotation, filters, brightness, contrast
function redrawCanvas() {
  if (!loadedImage) return;
  
  const canvas = document.getElementById('editor-canvas');
  const ctx = canvas.getContext('2d');
  
  // Determine rotated boundaries
  const isRotated = currentRotation === 90 || currentRotation === 270;
  const targetWidth = isRotated ? loadedImage.height : loadedImage.width;
  const targetHeight = isRotated ? loadedImage.width : loadedImage.height;
  
  // Resize canvas constraints (prevent huge resolution slows downs)
  const MAX_DIMENSION = 1200;
  let scale = 1;
  if (targetWidth > MAX_DIMENSION || targetHeight > MAX_DIMENSION) {
    scale = Math.min(MAX_DIMENSION / targetWidth, MAX_DIMENSION / targetHeight);
  }
  
  canvas.width = targetWidth * scale;
  canvas.height = targetHeight * scale;
  
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // Rotate around center coordinate
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((currentRotation * Math.PI) / 180);
  
  const drawW = loadedImage.width * scale;
  const drawH = loadedImage.height * scale;
  ctx.drawImage(loadedImage, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();
  
  // Apply visual enhancements (Brightness / Contrast / Document Binarization)
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;
  
  // Contrast constant calculations
  const cVal = currentContrast;
  const cFactor = (259 * (cVal + 255)) / (255 * (259 - cVal));
  
  const bVal = currentBrightness; // -100 to 100
  
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i+1];
    let b = data[i+2];
    
    // 1. Grayscale, B&W, Document filters
    if (activeFilter === 'grayscale') {
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      r = g = b = gray;
    } else if (activeFilter === 'document') {
      let gray = 0.299 * r + 0.587 * g + 0.114 * b;
      
      // Clean background noise and darken dark lines
      if (gray > 175) {
        gray = 255;
      } else if (gray < 85) {
        gray = gray * 0.45;
      } else {
        gray = (gray - 85) * (255 / 90);
      }
      r = g = b = gray;
    } else if (activeFilter === 'monochrome') {
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      const mono = gray >= 127 ? 255 : 0;
      r = g = b = mono;
    }
    
    // 2. Adjust Brightness
    if (bVal !== 0) {
      r += bVal;
      g += bVal;
      b += bVal;
    }
    
    // 3. Adjust Contrast
    if (cVal !== 0) {
      r = cFactor * (r - 128) + 128;
      g = cFactor * (g - 128) + 128;
      b = cFactor * (b - 128) + 128;
    }
    
    // Limit bounds
    data[i] = Math.max(0, Math.min(255, r));
    data[i+1] = Math.max(0, Math.min(255, g));
    data[i+2] = Math.max(0, Math.min(255, b));
  }
  
  ctx.putImageData(imgData, 0, 0);
}

function resetEditor(skipConfirm = false) {
  if (skipConfirm || confirm("Ulangi proses? Perubahan edit Anda akan hilang.")) {
    loadedImage = null;
    document.getElementById('editor-canvas').getContext('2d').clearRect(0,0,10,10);
    document.getElementById('ocr-extract-btn').setAttribute('disabled', 'true');
    document.getElementById('save-doc-btn').setAttribute('disabled', 'true');
    document.getElementById('add-page-btn').setAttribute('disabled', 'true');
    document.getElementById('ocr-status-badge').textContent = "Menunggu Gambar";
    document.getElementById('ocr-status-badge').className = "ocr-status-badge badge-idle";
    document.getElementById('ocr-extracted-text').value = '';
    
    setInputMode(inputMode);
  }
}

function addCurrentPage() {
  if (!loadedImage) return;
  pendingPages.push(document.getElementById('editor-canvas').toDataURL('image/jpeg', 0.75));
  resetEditor(true);
  alert(`Halaman ${pendingPages.length} ditambahkan. Pilih atau ambil gambar untuk halaman berikutnya.`);
}

// ================= OCR ENGINE TESSERACT =================
async function runOcrTextExtraction() {
  const canvas = document.getElementById('editor-canvas');
  if (!loadedImage) return;
  
  const badge = document.getElementById('ocr-status-badge');
  const progressArea = document.getElementById('ocr-progress-area');
  const progressBar = document.getElementById('ocr-progress-bar');
  const progressText = document.getElementById('ocr-status-text');
  const progressPercent = document.getElementById('ocr-progress-percent');
  const textOutput = document.getElementById('ocr-extracted-text');
  const saveBtn = document.getElementById('save-doc-btn');
  
  badge.textContent = "Menjalankan OCR...";
  badge.className = "ocr-status-badge badge-active";
  progressArea.classList.remove('hidden');
  progressBar.style.width = "0%";
  progressText.textContent = "Menyiapkan mesin OCR...";
  progressPercent.textContent = "0%";
  
  // Disable buttons while processing
  document.getElementById('ocr-extract-btn').setAttribute('disabled', 'true');
  saveBtn.setAttribute('disabled', 'true');
  
  try {
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    
    // Tesseract JS API recognize
    const result = await Tesseract.recognize(
      dataUrl,
      'ind', // Indonesian language model
      {
        logger: m => {
          if (m.status === 'recognizing text') {
            const pct = Math.round(m.progress * 100);
            progressBar.style.width = `${pct}%`;
            progressPercent.textContent = `${pct}%`;
            progressText.textContent = "Membaca teks dalam dokumen...";
          } else {
            progressText.textContent = translateStatus(m.status);
          }
        }
      }
    );
    
    const extractedText = result.data.text || "";
    textOutput.value = extractedText;
    
    badge.textContent = "Ekstraksi Berhasil";
    badge.className = "ocr-status-badge badge-success";
    progressArea.classList.add('hidden');
    
    // Focus metadata title input as logical next step
    document.getElementById('doc-title').focus();
  } catch (err) {
    console.error("OCR process error: ", err);
    badge.textContent = "Ekstraksi Gagal";
    badge.className = "ocr-status-badge badge-error";
    progressText.textContent = "Gagal memproses OCR: " + err.message;
    alert("Proses OCR gagal: " + err.message);
  } finally {
    document.getElementById('ocr-extract-btn').removeAttribute('disabled');
    saveBtn.removeAttribute('disabled');
  }
}

function translateStatus(status) {
  const dict = {
    'loading tesseract core': 'Memuat mesin Tesseract...',
    'initializing tesseract': 'Menginisialisasi OCR...',
    'loading language traineddata': 'Memuat database bahasa...',
    'initializing api': 'Menyiapkan API OCR...',
    'recognizing text': 'Mengenali teks...'
  };
  return dict[status] || status;
}

// ================= SAVE DOCUMENT TO INDEXEDDB =================
async function saveScannedDocument(e) {
  e.preventDefault();
  
  const canvas = document.getElementById('editor-canvas');
  if (!loadedImage) {
    alert('Gambar dokumen tidak ditemukan.');
    return;
  }
  
  const title = document.getElementById('doc-title').value.trim();
  const category = document.getElementById('doc-category').value;
  const date = document.getElementById('doc-date').value;
  const rawTags = document.getElementById('doc-tags').value;
  const description = document.getElementById('doc-description').value.trim();
  const extractedText = document.getElementById('ocr-extracted-text').value;
  
  // Format Tags
  const tags = rawTags.split(',')
                      .map(tag => tag.trim())
                      .filter(tag => tag.length > 0);
  
  // Keep every staged scan and the currently edited image as document pages.
  const pages = [...pendingPages, canvas.toDataURL('image/jpeg', 0.75)];
  const totalSize = pages.reduce((sum, page) => sum + Math.ceil(page.length * 0.75), 0);
  
  const newDoc = {
    id: 'doc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
    title,
    category,
    date,
    tags,
    description,
    extractedText,
    pages,
    image: pages[0], // compatibility thumbnail for existing views/backups
    createdAt: Date.now(),
    scanDate: new Date().toLocaleDateString('id-ID', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }),
    size: totalSize
  };
  
  db.documents.unshift(newDoc);
  await saveDatabase();
  
  alert('Dokumen berhasil disimpan ke vault!');
  
  // Reset Form
  document.getElementById('doc-metadata-form').reset();
  document.getElementById('ocr-extracted-text').value = '';
  document.getElementById('doc-date').valueAsDate = new Date();
  
  // Reset editor preview
  loadedImage = null;
  pendingPages = [];
  document.getElementById('ocr-extract-btn').setAttribute('disabled', 'true');
  document.getElementById('save-doc-btn').setAttribute('disabled', 'true');
  document.getElementById('add-page-btn').setAttribute('disabled', 'true');
  document.getElementById('ocr-status-badge').textContent = "Menunggu Gambar";
  document.getElementById('ocr-status-badge').className = "ocr-status-badge badge-idle";
  
  // Redirect to Library / Documents tab
  switchTab('library');
}

// ================= STORAGE STATS =================
async function getStorageStats() {
  const bytes = db.documents.reduce((sum, doc) => sum + (doc.size || 0), 0);
  const estimate = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : {};
  const quota = estimate.quota || 0;
  const pct = quota ? Math.min(100, (bytes / quota) * 100) : 0;
  
  return {
    bytes: bytes,
    kb: (bytes / 1024).toFixed(1),
    mb: (bytes / (1024 * 1024)).toFixed(2),
    quota,
    pct: Math.round(pct)
  };
}

// ================= DASHBOARD UI DRAWING =================
async function renderDashboardStats() {
  const totalDocs = db.documents.length;
  document.getElementById('stat-total-docs').textContent = totalDocs;
  
  // Active Categories Counter
  const categories = new Set(db.documents.map(d => d.category));
  document.getElementById('stat-total-categories').textContent = categories.size;
  
  // Last added footer text
  const recentAddEl = document.getElementById('stat-recent-add');
  if (totalDocs > 0) {
    const lastDoc = db.documents[0];
    recentAddEl.textContent = `Baru: ${lastDoc.title}`;
  } else {
    recentAddEl.textContent = "Belum ada dokumen baru";
  }
  
  // Storage usage displays
  const storage = await getStorageStats();
  document.getElementById('stat-storage-percent').textContent = `${storage.pct}%`;
  document.getElementById('storage-progress').style.width = `${storage.pct}%`;
  document.getElementById('stat-storage-bytes').textContent = storage.quota
    ? `${storage.kb} KB digunakan`
    : `${storage.kb} KB digunakan (IndexedDB)`;
  
  // Render Category Breakdown list
  renderCategoryDistribution();
}

function renderCategoryDistribution() {
  const listEl = document.getElementById('category-distribution-list');
  listEl.innerHTML = '';
  
  if (db.documents.length === 0) {
    listEl.innerHTML = '<div class="category-item-empty">Belum ada data kategori.</div>';
    return;
  }
  
  // Sum values per category
  const counts = {};
  db.documents.forEach(doc => {
    counts[doc.category] = (counts[doc.category] || 0) + 1;
  });
  
  // Render category items
  Object.keys(counts).forEach(cat => {
    const item = document.createElement('div');
    item.className = 'category-item';
    
    // Dynamic Dot Color based on categories
    let dotClass = 'badge-Lainnya';
    if (cat.includes('Kwitansi')) dotClass = 'badge-emerald';
    else if (cat.includes('Faktur')) dotClass = 'badge-info';
    else if (cat.includes('Kontrak')) dotClass = 'badge-warning';
    else if (cat.includes('Sertifikat')) dotClass = 'badge-Sertifikat';
    else if (cat.includes('Pribadi')) dotClass = 'badge-Pribadi';
    else if (cat.includes('Kerja')) dotClass = 'badge-Kerja';
    
    item.innerHTML = `
      <div class="category-item-label">
        <span class="category-item-dot ${dotClass}" style="background-color: currentColor; display: inline-block;"></span>
        <span>${cat}</span>
      </div>
      <span class="category-item-count">${counts[cat]} Dokumen</span>
    `;
    listEl.appendChild(item);
  });
}

function renderRecentDocuments() {
  const tbody = document.getElementById('dashboard-recent-table-body');
  tbody.innerHTML = '';
  
  const recents = db.documents.slice(0, 5);
  
  if (recents.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="5" class="text-center text-muted py-6">
          Belum ada dokumen. Silakan unggah atau lakukan scan dokumen pertama Anda!
        </td>
      </tr>
    `;
    return;
  }
  
  recents.forEach(doc => {
    const tr = document.createElement('tr');
    
    const kb = (doc.size / 1024).toFixed(1);
    
    tr.innerHTML = `
      <td>
        <div class="doc-name-cell" data-id="${doc.id}">
          <div class="doc-icon-container">
            <i data-lucide="file-text"></i>
          </div>
          <span>${escapeHtml(doc.title)}</span>
        </div>
      </td>
      <td><span class="badge badge-${doc.category.replace('/', '\\/')}">${doc.category}</span></td>
      <td>${doc.date}</td>
      <td class="text-muted">${kb} KB</td>
      <td class="text-center">
        <button class="btn btn-xs btn-outline view-doc-btn" data-id="${doc.id}">
          <i data-lucide="eye"></i>
          <span>Detail</span>
        </button>
      </td>
    `;
    
    // Add event listeners to buttons
    tr.querySelector('.doc-name-cell').addEventListener('click', () => openDetailsModal(doc.id));
    tr.querySelector('.view-doc-btn').addEventListener('click', () => openDetailsModal(doc.id));
    
    tbody.appendChild(tr);
  });
  
  initializeLucide();
}

// ================= LIBRARY / DOCUMENT LIST RENDERER =================
function renderDocumentsList() {
  const container = document.getElementById('documents-container');
  container.innerHTML = '';
  
  const searchVal = document.getElementById('library-search').value.toLowerCase().trim();
  const categoryFilter = document.getElementById('library-filter-category').value;
  const sortBy = document.getElementById('library-sort-by').value;
  
  // Filter documents
  let filtered = db.documents.filter(doc => {
    // 1. Category Filter
    if (categoryFilter !== 'all' && doc.category !== categoryFilter) {
      return false;
    }
    
    // 2. Search Text query match (title, description, tags, and OCR text contents!)
    if (searchVal.length > 0) {
      const matchTitle = doc.title.toLowerCase().includes(searchVal);
      const matchDesc = doc.description && doc.description.toLowerCase().includes(searchVal);
      const matchText = doc.extractedText && doc.extractedText.toLowerCase().includes(searchVal);
      const matchTags = doc.tags && doc.tags.some(tag => tag.toLowerCase().includes(searchVal));
      
      if (!matchTitle && !matchDesc && !matchText && !matchTags) {
        return false;
      }
    }
    
    return true;
  });
  
  // Sort documents
  filtered.sort((a, b) => {
    if (sortBy === 'newest') {
      return new Date(b.date) - new Date(a.date);
    } else if (sortBy === 'oldest') {
      return new Date(a.date) - new Date(b.date);
    } else if (sortBy === 'name_asc') {
      return a.title.localeCompare(b.title);
    } else if (sortBy === 'name_desc') {
      return b.title.localeCompare(a.title);
    } else if (sortBy === 'size_desc') {
      return b.size - a.size;
    }
    return 0;
  });
  
  // Render empty state
  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state-container">
        <i data-lucide="folder-search" class="empty-icon"></i>
        <h3>Dokumen Tidak Ditemukan</h3>
        <p class="text-muted">Hasil pencarian kosong atau Anda belum menambahkan data di kategori ini.</p>
      </div>
    `;
    initializeLucide();
    return;
  }
  
  const isGridView = container.classList.contains('grid-view');
  
  filtered.forEach(doc => {
    if (isGridView) {
      // Draw Card Grid
      const card = document.createElement('div');
      card.className = 'doc-card';
      card.addEventListener('click', () => openDetailsModal(doc.id));
      
      const kb = (doc.size / 1024).toFixed(1);
      
      card.innerHTML = `
        <div class="doc-card-thumb">
          <img src="${doc.image}" alt="${escapeHtml(doc.title)}">
          <div class="doc-card-icon-overlay">
            <i data-lucide="file-text"></i>
          </div>
          <span class="badge doc-card-tag-badge badge-${doc.category.replace('/', '\\/')}">${doc.category}</span>
        </div>
        <div class="doc-card-body">
          <h4 class="doc-card-title">${highlightText(doc.title, searchVal)}</h4>
          <p class="text-muted text-xs mb-2">${doc.date}</p>
          <div class="doc-card-meta">
            <span class="text-muted">${kb} KB</span>
            <span class="text-success font-semibold" style="font-size: 0.7rem;">OCR Ready</span>
          </div>
        </div>
      `;
      container.appendChild(card);
    } else {
      // Draw Row List
      const row = document.createElement('div');
      row.className = 'doc-row';
      row.addEventListener('click', () => openDetailsModal(doc.id));
      
      const kb = (doc.size / 1024).toFixed(1);
      
      row.innerHTML = `
        <div class="doc-row-icon">
          <i data-lucide="file-text"></i>
        </div>
        <div class="doc-row-details">
          <div>
            <div class="doc-row-title">${highlightText(doc.title, searchVal)}</div>
            ${doc.description ? `<div class="text-muted text-xs mt-1 text-ellipsis">${highlightText(doc.description, searchVal)}</div>` : ''}
          </div>
          <div class="doc-row-category">
            <span class="badge badge-${doc.category.replace('/', '\\/')}">${doc.category}</span>
          </div>
          <div class="doc-row-date">${doc.date}</div>
          <div class="doc-row-size">${kb} KB</div>
        </div>
      `;
      container.appendChild(row);
    }
  });
  
  initializeLucide();
}

// Search text highlight helper
function highlightText(text, search) {
  if (!search) return escapeHtml(text);
  const regex = new RegExp(`(${escapeRegExp(search)})`, 'gi');
  return escapeHtml(text).replace(regex, '<mark style="background-color: rgba(16, 185, 129, 0.4); color: white; border-radius: 2px; padding: 0 2px;">$1</mark>');
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(unsafe) {
  return unsafe
       .replace(/&/g, "&amp;")
       .replace(/</g, "&lt;")
       .replace(/>/g, "&gt;")
       .replace(/"/g, "&quot;")
       .replace(/'/g, "&#039;");
}

// ================= DETAILS DIALOG MODAL =================
function openDetailsModal(docId) {
  const doc = db.documents.find(d => d.id === docId);
  if (!doc) return;
  
  activeDocumentId = docId;
  
  // Set modal details
  document.getElementById('modal-doc-title').textContent = doc.title;
  
  const catBadge = document.getElementById('modal-doc-category');
  catBadge.textContent = doc.category;
  catBadge.className = `badge badge-${doc.category.replace('/', '\\/')}`;
  
  document.getElementById('modal-doc-img').src = doc.image;
  document.getElementById('modal-doc-scan-date').textContent = doc.scanDate;
  document.getElementById('modal-doc-date').textContent = doc.date;
  
  const kb = (doc.size / 1024).toFixed(1);
  document.getElementById('modal-doc-size').textContent = `${kb} KB`;
  document.getElementById('modal-doc-page-count').textContent = `${doc.pages ? doc.pages.length : 1} halaman`;
  
  // Render tags
  const tagsContainer = document.getElementById('modal-doc-tags');
  tagsContainer.innerHTML = '';
  if (doc.tags && doc.tags.length > 0) {
    doc.tags.forEach(tag => {
      const span = document.createElement('span');
      span.className = 'tag-pill';
      span.textContent = tag;
      tagsContainer.appendChild(span);
    });
  } else {
    tagsContainer.textContent = '-';
  }
  
  document.getElementById('modal-doc-desc').textContent = doc.description || "Tidak ada catatan.";
  
  // OCR Textarea
  const ocrTextarea = document.getElementById('modal-doc-ocr-text');
  ocrTextarea.value = doc.extractedText || "";
  ocrTextarea.setAttribute('readonly', 'true');
  
  // Reset edit button state
  document.getElementById('edit-ocr-btn-text').textContent = "Edit Teks";
  const editOcrBtn = document.getElementById('edit-modal-ocr-btn');
  editOcrBtn.classList.add('btn-outline');
  editOcrBtn.classList.remove('btn-primary');

  // Open backdrop
  document.getElementById('doc-detail-modal').classList.add('active');
  initializeLucide();
}

function closeDetailsModal() {
  document.getElementById('doc-detail-modal').classList.remove('active');
  activeDocumentId = null;
}

// Update text in db
async function updateDocumentText(docId, newText) {
  const doc = db.documents.find(d => d.id === docId);
  if (doc) {
    doc.extractedText = newText;
    await saveDatabase();
    console.log("Teks dokumen diperbarui!");
  }
}

// Copy extracted OCR text
function copyExtractedText() {
  const ocrText = document.getElementById('modal-doc-ocr-text').value;
  if (!ocrText) {
    alert("Tidak ada teks untuk disalin.");
    return;
  }
  
  navigator.clipboard.writeText(ocrText)
    .then(() => {
      alert("Teks berhasil disalin ke clipboard!");
    })
    .catch(err => {
      console.error("Gagal menyalin teks: ", err);
    });
}

// Delete Document
async function deleteDocumentAction() {
  if (!activeDocumentId) return;
  
  if (confirm("Apakah Anda yakin ingin menghapus dokumen ini secara permanen dari vault?")) {
    const index = db.documents.findIndex(d => d.id === activeDocumentId);
    if (index !== -1) {
      db.documents.splice(index, 1);
      await saveDatabase();
      closeDetailsModal();
      alert("Dokumen berhasil dihapus.");
    }
  }
}

// Generate and export PDF using jsPDF
function downloadPdfDocument() {
  createPdfDocument(false);
}

async function downloadCompressedPdfDocument() {
  const button = document.getElementById('compress-pdf-btn');
  button.disabled = true;
  button.innerHTML = '<i data-lucide="loader-circle"></i><span>Mengompres...</span>';
  initializeLucide();

  try {
    await createPdfDocument(true);
  } catch (error) {
    console.error('Gagal mengompres PDF:', error);
    alert('PDF gagal dikompres. Silakan coba lagi.');
  } finally {
    button.disabled = false;
    button.innerHTML = '<i data-lucide="minimize-2"></i><span>Kompres & Unduh</span>';
    initializeLucide();
  }
}

async function createPdfDocument(compressed) {
  const doc = db.documents.find(d => d.id === activeDocumentId);
  if (!doc) return;
  
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({
    orientation: 'p',
    unit: 'mm',
    format: 'a4'
  });
  
  const pages = doc.pages && doc.pages.length ? doc.pages : [doc.image];
  const exportPages = compressed
    ? await Promise.all(pages.filter(Boolean).map(image => compressImageForPdf(image)))
    : pages.filter(Boolean);

  exportPages.forEach((image, index) => {
    if (index > 0) pdf.addPage();
    const properties = pdf.getImageProperties(image);
    const margin = 10;
    const maxWidth = 210 - margin * 2;
    const maxHeight = 297 - margin * 2;
    const scale = Math.min(maxWidth / properties.width, maxHeight / properties.height);
    const width = properties.width * scale;
    const height = properties.height * scale;
    pdf.addImage(image, 'JPEG', (210 - width) / 2, (297 - height) / 2, width, height);
    pdf.setFontSize(8);
    pdf.setTextColor(90, 90, 90);
    pdf.text(`${doc.title} — Halaman ${index + 1}/${exportPages.length}`, margin, 292);
  });
  
  // Save output PDF
  const baseName = doc.title.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const filename = `${baseName}${compressed ? '_compressed' : ''}.pdf`;
  pdf.save(filename);
}

function compressImageForPdf(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const maxDimension = 1500;
      const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.55));
    };
    image.onerror = reject;
    image.src = dataUrl;
  });
}

// ================= SETTINGS CONTROLLERS =================
// Export database as JSON file backup
function exportDatabase() {
  if (db.documents.length === 0) {
    alert("Database Anda kosong. Tidak ada data untuk diekspor.");
    return;
  }
  
  const jsonStr = JSON.stringify(db, null, 2);
  const blob = new Blob([jsonStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `scanvault_backup_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Import database from JSON file backup
function importDatabase(e) {
  const file = e.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      const importedDb = JSON.parse(event.target.result);
      if (importedDb && Array.isArray(importedDb.documents)) {
        if (confirm(`Anda akan mengimpor ${importedDb.documents.length} dokumen. Tindakan ini akan menggabungkan data cadangan dengan database Anda yang sekarang.`)) {
          
          // Merge logic (prevent duplicate IDs)
          importedDb.documents.forEach(impDoc => {
            const exists = db.documents.some(d => d.id === impDoc.id);
            if (!exists) {
              db.documents.push(normalizeDocument(impDoc));
            }
          });
          
          await saveDatabase();
          alert('Database berhasil diimpor!');
          switchTab('dashboard');
        }
      } else {
        alert('File JSON tidak valid atau bukan merupakan format backup ScanVault.');
      }
    } catch (err) {
      console.error(err);
      alert('Gagal membaca file backup: ' + err.message);
    }
  };
  reader.readAsText(file);
  
  // Reset input value to allow re-selection
  e.target.value = '';
}

// Clear all database entries
async function clearDatabase() {
  if (confirm("APAKAH ANDA YAKIN? Tindakan ini akan MENGHAPUS SEMUA dokumen dan gambar hasil scan secara permanen dari browser ini.")) {
    if (confirm("PENTING: Konfirmasi kedua kali. Semua data akan terhapus sepenuhnya. Lanjutkan?")) {
      db = { documents: [] };
      await saveDatabase();
      alert("Database telah dikosongkan.");
      switchTab('dashboard');
    }
  }
}
