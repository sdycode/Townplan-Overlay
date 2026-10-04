/* Map Overlay Aligner
 * Base map: Leaflet + raster tiles (no API key).
 * Sheets: PDF pages (rendered by pdf.js) or images, each placed with a CSS transform.
 *
 * Each sheet's placement is stored in one of two forms:
 *   locked   -> geo:    anchor LatLng + k (screen scale = k * 2^zoom), so it follows the map
 *   unlocked -> screen: cx, cy, s (container pixels), so it stays put while the map moves
 * "locked" storage is used in Locked and Adjust modes, "unlocked" only in Map-only mode.
 */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const $ = (id) => document.getElementById(id);
const IS_SAFARI = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
const MAX_CANVAS_AREA = IS_SAFARI ? 16e6 : 60e6;

// ---------- Base map ----------
const google = (lyrs) => L.tileLayer(`https://mt{s}.google.com/vt/lyrs=${lyrs}&x={x}&y={y}&z={z}`, {
  subdomains: ['0', '1', '2', '3'], maxNativeZoom: 20, maxZoom: 22, attribution: 'Map data © Google',
});
const BASES = {
  'Google Hybrid': google('y'),
  'Google Satellite': google('s'),
  'Google Roads': google('m'),
  'Google Terrain': google('p'),
  'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxNativeZoom: 19, maxZoom: 22, attribution: '© OpenStreetMap contributors',
  }),
  'Esri Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxNativeZoom: 19, maxZoom: 22, attribution: 'Tiles © Esri',
  }),
};

const savedView = readJSON('ovl:view') || { lat: 18.6298, lng: 73.7997, zoom: 13, base: 'Google Hybrid' }; // PCMC
const map = L.map('map', {
  zoomSnap: 0.1, zoomDelta: 0.5, wheelPxPerZoomLevel: 120, maxZoom: 22,
}).setView([savedView.lat, savedView.lng], savedView.zoom);

let baseLayer = null;
function setBase(name) {
  if (!BASES[name]) name = 'Google Hybrid';
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = BASES[name].addTo(map);
  $('baseSel').value = name;
  saveView();
}
for (const name of Object.keys(BASES)) $('baseSel').add(new Option(name, name));
$('baseSel').onchange = (e) => setBase(e.target.value);
setBase(savedView.base);
$('mapZoomIn').onchange = (e) => map.setZoom(Number(e.target.value));

const capture = document.createElement('div');
capture.id = 'capture';
map.getContainer().append(capture);

// ---------- State ----------
const workspace = readJSON('ovl:workspace') || {};
const G = {
  mode: 'locked', locked: true, spaceTemp: false,
  master: workspace.master ?? 1, allVisible: true, adjustAll: false,
  activeId: null, quality: 4000,
};
const sheets = []; // index 0 = top of the stack

const active = () => sheets.find((sh) => sh.id === G.activeId) || null;
const targets = () => (G.adjustAll ? sheets.filter((sh) => sh.visible && placed(sh)) : [active()].filter(Boolean));

// ---------- Placement ----------
function placed(sh) { return !!sh.el && (!G.locked || !!sh.anchor); }

function screenOf(sh) {
  if (G.locked) {
    const p = map.latLngToContainerPoint(sh.anchor);
    return { cx: p.x, cy: p.y, s: sh.k * Math.pow(2, map.getZoom()) };
  }
  return { cx: sh.cx, cy: sh.cy, s: sh.s };
}

function setScreenOf(sh, scr) {
  if (G.locked) {
    sh.anchor = map.containerPointToLatLng([scr.cx, scr.cy]);
    sh.k = scr.s / Math.pow(2, map.getZoom());
  } else {
    sh.cx = scr.cx; sh.cy = scr.cy; sh.s = scr.s;
  }
}

function transformCSS(sh, cx, cy, s) {
  return `translate(${cx}px, ${cy}px) rotate(${sh.rot}deg) scale(${s * sh.sx}, ${s * sh.sy}) translate(-50%, -50%)`;
}

function renderSheet(sh) {
  if (!placed(sh)) return;
  const { cx, cy, s } = screenOf(sh);
  const w = sh.wrap;
  w.style.transform = transformCSS(sh, cx, cy, s);
  w.style.setProperty('--inv', 1 / (s * Math.min(sh.sx, sh.sy)));
  w.style.opacity = sh.opacity * G.master;
  w.style.display = sh.visible && G.allVisible ? '' : 'none';
  w.classList.toggle('blend', sh.blend);
  w.classList.toggle('target', G.adjustAll ? sh.visible : sh.id === G.activeId);
}

function renderAll() {
  sheets.forEach(renderSheet);
  syncUI();
}

map.on('move zoom resize viewreset zoomend', () => {
  for (const sh of sheets) sh.wrap.classList.remove('anim');
  renderAll();
});
map.on('moveend', saveView);
// Animate sheets along with Leaflet's zoom animation
map.on('zoomanim', (e) => {
  if (!G.locked) return;
  const z = e.zoom;
  const half = map.getSize().divideBy(2);
  for (const sh of sheets) {
    if (!placed(sh)) continue;
    const p = map.project(sh.anchor, z).subtract(map.project(e.center, z)).add(half);
    sh.wrap.classList.toggle('anim', !e.noUpdate);
    sh.wrap.style.transform = transformCSS(sh, p.x, p.y, sh.k * Math.pow(2, z));
  }
});

// ---------- Adding / rendering sheets ----------
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const isPdfFile = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

$('fileInput').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (let i = 0; i < files.length; i++) {
    status(`Loading ${i + 1}/${files.length}: ${files[i].name}`);
    await addSheet(files[i]);
  }
};

// opts.restoring: re-opening from the stored workspace (don't store the file again)
// opts.quiet: added by a collection load (don't move the map, change mode or fetch the cloud primary)
// Returns the sheet, or null if it failed to load
async function addSheet(file, opts = {}) {
  const interactive = !opts.restoring && !opts.quiet;
  const wrap = document.createElement('div');
  wrap.className = 'sheet';
  const sh = {
    id: opts.id || uid(), name: file.name, file, isPdf: isPdfFile(file), pdf: null,
    page: opts.page || 1, numPages: 1, el: null, w: 0, h: 0, wrap,
    anchor: null, k: 1, cx: 0, cy: 0, s: 1,
    rot: 0, sx: 1, sy: 1, opacity: 0.6, visible: opts.visible ?? true, blend: false,
    cloudId: null, touched: false, // cloudId: cloud alignment last applied/saved for this sheet
  };
  try {
    if (sh.isPdf) {
      sh.pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      sh.numPages = sh.pdf.numPages;
      sh.page = Math.min(sh.page, sh.numPages);
    }
    sheets.unshift(sh);
    orderDOM();
    await renderContent(sh, false, interactive);
  } catch (err) {
    console.error(err);
    removeSheet(sh, true);
    status(`Failed to load ${file.name}: ${err.message}`);
    return null;
  }
  if (!opts.restoring) dbPut(sh);
  G.activeId = sh.id;
  saveWorkspace();
  renderList();
  renderAll();
  if (interactive) cloudApplyPrimary(sh);
  return sh;
}

// keepPlacement: same content at a new resolution (keep its on-screen size)
async function renderContent(sh, keepPlacement, interactive) {
  let el, w, h;
  if (sh.isPdf) {
    const page = await sh.pdf.getPage(sh.page);
    const vp1 = page.getViewport({ scale: 1 });
    let scale = G.quality / Math.max(vp1.width, vp1.height);
    scale = Math.min(scale, Math.sqrt(MAX_CANVAS_AREA / (vp1.width * vp1.height)));
    const vp = page.getViewport({ scale });
    el = document.createElement('canvas');
    w = el.width = Math.floor(vp.width);
    h = el.height = Math.floor(vp.height);
    await page.render({ canvasContext: el.getContext('2d'), viewport: vp }).promise;
  } else {
    el = new Image();
    el.src = URL.createObjectURL(sh.file);
    await el.decode();
    w = el.naturalWidth; h = el.naturalHeight;
  }

  let scr = null;
  if (keepPlacement && placed(sh)) {
    scr = screenOf(sh);
    scr.s *= sh.w / w;
  }
  freeContent(sh);
  el.style.width = w + 'px';
  el.style.height = h + 'px';
  sh.wrap.append(el);
  sh.el = el; sh.w = w; sh.h = h;

  if (scr) setScreenOf(sh, scr);
  else if (restoreSheet(sh, interactive)) { if (interactive) setMode('locked'); }
  else { fitSheet(sh); if (interactive) setMode('adjust'); }
  renderSheet(sh);
}

function freeContent(sh) {
  if (sh.el instanceof HTMLCanvasElement) sh.el.width = sh.el.height = 0;
  if (sh.el instanceof HTMLImageElement) URL.revokeObjectURL(sh.el.src);
  sh.wrap.innerHTML = '';
  sh.el = null;
}

function fitSheet(sh) {
  const size = map.getSize();
  const s = 0.8 * Math.min(size.x / sh.w, size.y / sh.h);
  setScreenOf(sh, { cx: size.x / 2, cy: size.y / 2, s });
}

function removeSheet(sh, silent) {
  const i = sheets.indexOf(sh);
  if (i >= 0) sheets.splice(i, 1);
  freeContent(sh);
  sh.wrap.remove();
  if (sh.pdf) sh.pdf.destroy();
  if (!silent) dbDelete(sh.id);
  if (G.activeId === sh.id) G.activeId = sheets[Math.min(i, sheets.length - 1)]?.id ?? null;
  saveWorkspace();
  renderList();
  renderAll();
}

function moveSheet(sh, dir) {
  const i = sheets.indexOf(sh), j = i + dir;
  if (j < 0 || j >= sheets.length) return;
  [sheets[i], sheets[j]] = [sheets[j], sheets[i]];
  orderDOM(); saveWorkspace(); renderList();
}

// Later DOM siblings paint on top, so append bottom-of-stack first
function orderDOM() {
  for (let i = sheets.length - 1; i >= 0; i--) map.getContainer().insertBefore(sheets[i].wrap, capture);
}

async function rerenderAllPdfs() {
  const pdfs = sheets.filter((sh) => sh.isPdf);
  for (let i = 0; i < pdfs.length; i++) {
    status(`Re-rendering ${i + 1}/${pdfs.length}…`);
    await renderContent(pdfs[i], true, false);
  }
  status('Quality updated');
  renderAll();
}
$('qualitySel').onchange = (e) => { G.quality = Number(e.target.value); saveWorkspace(); rerenderAllPdfs(); };

// ---------- Sheets list UI ----------
function renderList() {
  const list = $('sheetList');
  list.innerHTML = '';
  sheets.forEach((sh, i) => {
    const li = document.createElement('li');
    li.className = 'sheet-row' + (sh.id === G.activeId ? ' active' : '') + (sh.visible ? '' : ' hidden-sheet');
    li.title = sh.name;
    li.innerHTML = `
      <input type="checkbox" title="Show / hide (H)" ${sh.visible ? 'checked' : ''}>
      <span class="name"></span>
      <button data-a="up" title="Move up (draw on top)" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button data-a="down" title="Move down" ${i === sheets.length - 1 ? 'disabled' : ''}>↓</button>
      <button data-a="del" title="Remove sheet">×</button>`;
    li.querySelector('.name').textContent = sh.name;
    if (sh.numPages > 1) li.querySelector('.name').insertAdjacentHTML('beforeend', ` <small>p${sh.page}</small>`);
    li.querySelector('input').onclick = (e) => { e.stopPropagation(); setSheetVisible(sh, e.target.checked); };
    li.querySelector('[data-a=up]').onclick = (e) => { e.stopPropagation(); moveSheet(sh, -1); };
    li.querySelector('[data-a=down]').onclick = (e) => { e.stopPropagation(); moveSheet(sh, 1); };
    li.querySelector('[data-a=del]').onclick = (e) => {
      e.stopPropagation();
      if (confirm(`Remove "${sh.name}"? Its alignment stays saved for next time.`)) removeSheet(sh);
    };
    li.onclick = () => setActive(sh.id);
    list.append(li);
  });
  $('sheetCount').textContent = sheets.length ? `(${sheets.length})` : '';
  $('allControls').hidden = sheets.length === 0;

  const sh = active();
  $('sheetProps').hidden = !sh;
  if (sh) {
    $('propName').textContent = sh.name;
    $('pageRow').hidden = sh.numPages < 2;
    const sel = $('pageSel');
    sel.innerHTML = '';
    for (let p = 1; p <= sh.numPages; p++) sel.add(new Option(`${p} / ${sh.numPages}`, p));
    sel.value = sh.page;
  }
  updateBadge();
  refreshCloudList(false);
}

function setActive(id) {
  G.activeId = id;
  renderList();
  renderAll();
}

function setSheetVisible(sh, v) {
  sh.visible = v;
  saveWorkspace(); renderList(); renderAll();
}

// ---------- Selected sheet properties ----------
function editActive(fn) {
  const sh = active();
  if (!sh || !placed(sh)) return;
  fn(sh);
  renderAll();
  saveSheetSoon(sh);
}

$('pageSel').onchange = async (e) => {
  const sh = active();
  if (!sh) return;
  sh.page = Number(e.target.value);
  status(`Rendering page ${sh.page}…`);
  await renderContent(sh, false, true);
  sh.cloudId = null;
  saveWorkspace(); renderList(); renderAll();
  status('');
  cloudApplyPrimary(sh);
};
$('opRange').oninput = (e) => editActive((sh) => (sh.opacity = e.target.value / 100));
$('blendChk').onchange = (e) => editActive((sh) => (sh.blend = e.target.checked));
$('ovlScaleIn').onchange = (e) => editActive((sh) => {
  const v = Number(e.target.value);
  if (v > 0) { const scr = screenOf(sh); scr.s = v / 100; setScreenOf(sh, scr); }
});
$('rotIn').onchange = (e) => editActive((sh) => (sh.rot = Number(e.target.value) || 0));
$('sxIn').onchange = (e) => editActive((sh) => (sh.sx = (Number(e.target.value) || 100) / 100));
$('syIn').onchange = (e) => editActive((sh) => (sh.sy = (Number(e.target.value) || 100) / 100));
$('fitBtn').onclick = () => editActive(fitSheet);
$('resetBtn').onclick = () => {
  const sh = active();
  if (!sh || !placed(sh)) return;
  if (!confirm(`Reset "${sh.name}": rotation, stretch and position, and forget its saved alignment?`)) return;
  localStorage.removeItem(storeKey(sh));
  sh.rot = 0; sh.sx = sh.sy = 1;
  fitSheet(sh);
  setMode('adjust');
  status('Sheet reset');
};

// ---------- Common controls ----------
function setMaster(v) {
  G.master = Math.max(0, Math.min(1, v));
  saveWorkspace(); renderAll();
}
$('masterRange').oninput = (e) => setMaster(e.target.value / 100);

function setAllVisible(v) { G.allVisible = v; renderAll(); }
$('allVisChk').onchange = (e) => setAllVisible(e.target.checked);

function setAdjustAll(v) { G.adjustAll = v; updateBadge(); renderAll(); }
$('adjustAllChk').onchange = (e) => setAdjustAll(e.target.checked);

function setVal(id, v) { const el = $(id); if (document.activeElement !== el) el.value = v; }
function syncUI() {
  setVal('mapZoomIn', map.getZoom().toFixed(1));
  $('masterRange').value = Math.round(G.master * 100);
  $('masterVal').textContent = Math.round(G.master * 100) + '%';
  $('allVisChk').checked = G.allVisible;
  $('adjustAllChk').checked = G.adjustAll;
  const sh = active();
  if (!sh || !placed(sh)) return;
  $('opRange').value = Math.round(sh.opacity * 100);
  $('opVal').textContent = Math.round(sh.opacity * 100) + '%';
  $('blendChk').checked = sh.blend;
  setVal('ovlScaleIn', (screenOf(sh).s * 100).toFixed(2));
  setVal('rotIn', sh.rot.toFixed(2));
  setVal('sxIn', (sh.sx * 100).toFixed(1));
  setVal('syIn', (sh.sy * 100).toFixed(1));
}

// ---------- Modes ----------
// locked:  map controls on, sheets follow the map (explore after aligning)
// adjust:  mouse/keys move only the selected sheet(s); they stay geo-anchored, so Space-panning keeps alignment
// maponly: map controls on, sheets stay fixed on screen
const MODES = {
  locked: { badge: '🔒 LOCKED: map & sheets move together', help: 'Pan/zoom moves the map and all sheets. Switch to Adjust to change an alignment.' },
  adjust: { badge: '📄 ADJUST', help: 'Drag/scroll moves the selected sheet (click a sheet to select it). Hold <kbd>Space</kbd> to pan/zoom everything. Press <kbd>L</kbd> to lock when done.' },
  maponly: { badge: '🗺 MAP only', help: 'Pan/zoom moves only the map; sheets stay still on screen.' },
};

function setMode(mode) {
  const scrs = sheets.map((sh) => (placed(sh) ? screenOf(sh) : null));
  G.mode = mode;
  G.locked = mode !== 'maponly';
  sheets.forEach((sh, i) => scrs[i] && setScreenOf(sh, scrs[i]));

  const adjust = mode === 'adjust';
  document.body.classList.remove('mode-locked', 'mode-adjust', 'mode-maponly');
  document.body.classList.add('mode-' + mode);
  document.querySelectorAll('.seg3 button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('modeHelp').innerHTML = MODES[mode].help;
  for (const h of ['dragging', 'scrollWheelZoom', 'doubleClickZoom', 'boxZoom', 'keyboard', 'touchZoom']) {
    adjust ? map[h].disable() : map[h].enable();
  }
  updateBadge();
  renderAll();
}
document.querySelectorAll('.seg3 button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

function updateBadge() {
  let text = MODES[G.mode].badge;
  if (G.spaceTemp) text = '🔒 Space held: moving everything';
  else if (G.mode === 'adjust') {
    text += G.adjustAll ? ': ALL sheets' : active() ? `: ${active().name}` : ': (no sheet)';
  }
  $('modeBadge').textContent = text;
}

// ---------- Mouse interaction in Adjust mode ----------
function localPoint(e) {
  const r = capture.getBoundingClientRect();
  return { px: e.clientX - r.left, py: e.clientY - r.top };
}

// Is container point (px, py) inside the sheet's (rotated, scaled) rectangle?
function hitTest(sh, px, py) {
  if (!placed(sh) || !sh.visible || !G.allVisible) return false;
  const { cx, cy, s } = screenOf(sh);
  const rad = -sh.rot * Math.PI / 180;
  const dx = px - cx, dy = py - cy;
  const lx = (dx * Math.cos(rad) - dy * Math.sin(rad)) / (s * sh.sx);
  const ly = (dx * Math.sin(rad) + dy * Math.cos(rad)) / (s * sh.sy);
  return Math.abs(lx) <= sh.w / 2 && Math.abs(ly) <= sh.h / 2;
}

let drag = null;
capture.addEventListener('pointerdown', (e) => {
  const list = targets();
  const { px, py } = localPoint(e);
  capture.setPointerCapture(e.pointerId);
  capture.classList.add('dragging');
  drag = { x: e.clientX, y: e.clientY, px, py, moved: false, items: list.map((sh) => ({ sh, scr: screenOf(sh) })) };
});
capture.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 3) return;
  drag.moved = true;
  for (const { sh, scr } of drag.items) setScreenOf(sh, { cx: scr.cx + dx, cy: scr.cy + dy, s: scr.s });
  renderAll();
});
const endDrag = () => {
  if (!drag) return;
  if (drag.moved) drag.items.forEach(({ sh }) => saveSheetSoon(sh));
  else selectAt(drag.px, drag.py);
  drag = null;
  capture.classList.remove('dragging');
};
capture.addEventListener('pointerup', endDrag);
capture.addEventListener('pointercancel', endDrag);

// Click without dragging: select the topmost sheet under the cursor (keep the current one if it's under there too)
function selectAt(px, py) {
  const cur = active();
  if (cur && hitTest(cur, px, py)) return;
  const hit = sheets.find((sh) => hitTest(sh, px, py));
  if (hit) setActive(hit.id);
}

capture.addEventListener('wheel', (e) => {
  e.preventDefault();
  const list = targets();
  if (!list.length) return;
  const { px, py } = localPoint(e);
  const unit = e.deltaMode === 1 ? 16 : 1;
  if (e.shiftKey) {
    const d = (e.deltaY || e.deltaX) * unit;
    rotateAround(list, px, py, -d * (e.altKey ? 0.005 : 0.05));
  } else {
    // ctrlKey = trackpad pinch
    const rate = e.ctrlKey ? 0.01 : (e.altKey ? 0.0003 : 0.0015);
    scaleAround(list, px, py, Math.exp(-e.deltaY * unit * rate));
  }
  renderAll();
  list.forEach(saveSheetSoon);
}, { passive: false });

function scaleAround(list, px, py, f) {
  for (const sh of list) {
    const scr = screenOf(sh);
    setScreenOf(sh, { cx: px + (scr.cx - px) * f, cy: py + (scr.cy - py) * f, s: scr.s * f });
  }
}

function rotateAround(list, px, py, ang) {
  const rad = ang * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  for (const sh of list) {
    const scr = screenOf(sh);
    const vx = scr.cx - px, vy = scr.cy - py;
    setScreenOf(sh, { cx: px + vx * cos - vy * sin, cy: py + vx * sin + vy * cos, s: scr.s });
    sh.rot += ang;
  }
}

// Pivot for keyboard scale/rotate: the selected sheet's centre, or the middle of all targets
function pivotOf(list) {
  const pts = list.map(screenOf);
  return { px: pts.reduce((a, p) => a + p.cx, 0) / pts.length, py: pts.reduce((a, p) => a + p.cy, 0) / pts.length };
}

// ---------- Keyboard ----------
document.addEventListener('keydown', (e) => {
  if (!$('previewModal').hidden) { if (e.key === 'Escape') closePreview(); return; }
  if (!$('libModal').hidden) { if (e.key === 'Escape') closeLibrary(); return; }
  if (e.target.matches?.('input, select, textarea') || e.metaKey || e.ctrlKey) return;
  const k = e.key;
  if (k === ' ') {
    e.preventDefault();
    if (G.mode === 'adjust' && !e.repeat) { G.spaceTemp = true; setMode('locked'); }
    return;
  }
  const lower = k.toLowerCase();
  if (lower === 'm') return setMode(G.mode === 'adjust' ? 'locked' : 'adjust');
  if (lower === 'l') return setMode('locked');
  if (lower === 'a') return setMode('adjust');
  if (lower === 't') return setAdjustAll(!G.adjustAll);
  if (lower === 'g') return setLegend($('legend').hidden);
  if (lower === 'f') return $('fitBtn').click();
  if (k === 'H') return setAllVisible(!G.allVisible);
  if (k === 'h') { const sh = active(); return sh && setSheetVisible(sh, !sh.visible); }
  if (k === '[' || k === ']') {
    if (!sheets.length) return;
    const i = Math.max(0, sheets.indexOf(active()));
    return setActive(sheets[(i + (k === ']' ? 1 : -1) + sheets.length) % sheets.length].id);
  }
  if (/^[0-9]$/.test(k)) return setMaster(k === '0' ? 1 : Number(k) / 10);

  const list = targets();
  if (G.mode !== 'adjust' || !list.length) return;
  const big = e.shiftKey;
  const step = big ? 10 : 1;
  const { px, py } = pivotOf(list);
  let dx = 0, dy = 0;
  switch (k) {
    case 'ArrowLeft': dx = -step; break;
    case 'ArrowRight': dx = step; break;
    case 'ArrowUp': dy = -step; break;
    case 'ArrowDown': dy = step; break;
    case 'q': case 'Q': rotateAround(list, px, py, big ? -1 : -0.1); break;
    case 'e': case 'E': rotateAround(list, px, py, big ? 1 : 0.1); break;
    case '-': case '_': scaleAround(list, px, py, 1 / (big ? 1.02 : 1.002)); break;
    case '=': case '+': scaleAround(list, px, py, big ? 1.02 : 1.002); break;
    default: return;
  }
  e.preventDefault();
  if (dx || dy) for (const sh of list) { const scr = screenOf(sh); setScreenOf(sh, { cx: scr.cx + dx, cy: scr.cy + dy, s: scr.s }); }
  renderAll();
  list.forEach(saveSheetSoon);
});
document.addEventListener('keyup', (e) => {
  if (e.key === ' ' && G.spaceTemp) { G.spaceTemp = false; setMode('adjust'); }
});
window.addEventListener('blur', () => { if (G.spaceTemp) { G.spaceTemp = false; setMode('adjust'); } });

// ---------- Alignment save / restore ----------
// Saved in geo form; worldW = sheet width in world pixels at zoom 0 (resolution independent)
const storeKey = (sh) => `ovl:${sh.name}#${sh.page}`;

function geoState(sh) {
  const scr = screenOf(sh);
  const ll = map.containerPointToLatLng([scr.cx, scr.cy]);
  return {
    file: sh.name, page: sh.page,
    lat: ll.lat, lng: ll.lng,
    worldW: scr.s / Math.pow(2, map.getZoom()) * sh.w,
    rot: sh.rot, sx: sh.sx, sy: sh.sy, opacity: sh.opacity, blend: sh.blend,
    zoom: map.getZoom(),
  };
}

// Returns false (and changes nothing) if the saved data is unusable
function applyGeo(sh, g, moveMap) {
  if (!g || ![g.lat, g.lng, g.worldW].every(Number.isFinite) || g.worldW <= 0) return false;
  sh.rot = g.rot || 0; sh.sx = g.sx || 1; sh.sy = g.sy || 1;
  if (g.opacity != null) sh.opacity = g.opacity;
  sh.blend = !!g.blend;
  // Set the anchor before moving the map: setView fires 'move', which renders
  const wasLocked = G.locked;
  G.locked = true;
  sh.anchor = L.latLng(g.lat, g.lng);
  sh.k = g.worldW / sh.w;
  if (moveMap) map.setView([g.lat, g.lng], Number.isFinite(g.zoom) ? g.zoom : map.getZoom(), { animate: false });
  const scr = screenOf(sh);
  G.locked = wasLocked;
  setScreenOf(sh, scr);
  return true;
}

function restoreSheet(sh, moveMap) {
  const g = readJSON(storeKey(sh));
  if (!g) return false;
  if (!applyGeo(sh, g, moveMap)) { localStorage.removeItem(storeKey(sh)); return false; }
  if (moveMap) status(`Restored saved alignment for ${sh.name}`);
  return true;
}

const saveTimers = new Map();
function saveSheetSoon(sh) {
  sh.touched = true;
  clearTimeout(saveTimers.get(sh.id));
  saveTimers.set(sh.id, setTimeout(() => placed(sh) && writeJSON(storeKey(sh), geoState(sh)), 300));
}

function saveView() {
  const c = map.getCenter();
  writeJSON('ovl:view', { lat: c.lat, lng: c.lng, zoom: map.getZoom(), base: $('baseSel').value });
}

$('saveBtn').onclick = () => {
  if (!sheets.length) return status('Add a sheet first');
  const data = { version: 2, sheets: sheets.filter(placed).map(geoState) };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = sheets.length === 1
    ? `${sheets[0].name.replace(/\.[^.]+$/, '')}-p${sheets[0].page}-alignment.json`
    : `alignments-${sheets.length}-sheets.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

// Matches saved entries to open sheets by file name + page; a single entry with no match goes to the selected sheet
$('loadInput').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!sheets.length) return status('Add the sheets first, then load their alignments');
  let entries;
  try {
    const data = JSON.parse(await file.text());
    entries = Array.isArray(data.sheets) ? data.sheets : [data];
  } catch { return status('Invalid alignment file'); }

  let applied = 0;
  for (const g of entries) {
    let sh = sheets.find((s) => s.name === g.file && s.page === g.page) || sheets.find((s) => s.name === g.file);
    if (!sh && entries.length === 1) sh = active();
    if (sh && sh.el && applyGeo(sh, g, false)) { applied++; saveSheetSoon(sh); }
  }
  if (!applied) return status('No matching sheets for this alignment file');
  if (applied === 1 && entries.length === 1) {
    const g = entries[0];
    map.setView([g.lat, g.lng], Number.isFinite(g.zoom) ? g.zoom : map.getZoom(), { animate: false });
  }
  setMode('locked');
  status(`Applied ${applied} of ${entries.length} alignment(s)`);
};

// ---------- Cloud: Firebase Realtime Database over REST (open rules, no sign-in) ----------
// /overlayAligner/sheets/{fileKey}/name
// /overlayAligner/sheets/{fileKey}/pages/p{page}/primary            -> alignment id
// /overlayAligner/sheets/{fileKey}/pages/p{page}/alignments/{id}    -> {label, createdAt, updatedAt, ...geoState}
// /overlayAligner/collections/{id}  -> {name, createdAt, updatedAt, items: {itemKey: {name, page, order, visible, alignment}}}
// A sheet's identity is its file name + page.
const FB = window.FIREBASE_CONFIG || {};
const CLOUD_ROOT = 'overlayAligner';
let cloudBase = null;

// Firebase keys can't contain . $ # [ ] /
const fbKey = (s) => encodeURIComponent(s).replace(/\./g, '%2E');
const sheetPath = (sh) => ['sheets', fbKey(sh.name), 'pages', 'p' + sh.page];

function dbCandidates() {
  const id = FB.projectId;
  const list = [readJSON('ovl:dbURL'), FB.databaseURL];
  if (id) {
    list.push(`https://${id}-default-rtdb.firebaseio.com`,
      `https://${id}-default-rtdb.asia-southeast1.firebasedatabase.app`,
      `https://${id}-default-rtdb.europe-west1.firebasedatabase.app`);
  }
  return [...new Set(list.filter(Boolean).map((u) => u.trim().replace(/\/+$/, '')))];
}

async function findDb() {
  if (cloudBase) return cloudBase;
  for (const u of dbCandidates()) {
    let r;
    try { r = await fetch(`${u}/${CLOUD_ROOT}.json?shallow=true`); } catch { continue; }
    if (r.status === 404) continue;
    cloudBase = u;
    return u;
  }
  throw new Error('Realtime Database not found. Create it in the Firebase console (see README).');
}

async function cloud(method, path, body, query) {
  const base = await findDb();
  const url = `${base}/${CLOUD_ROOT}/${path.map(encodeURIComponent).join('/')}.json${query ? '?' + query : ''}`;
  let r;
  try {
    r = await fetch(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (err) {
    setCloudStatus(false, 'Network error: ' + err.message);
    throw err;
  }
  const text = await r.text();
  if (!r.ok) {
    const msg = r.status === 401
      ? 'Permission denied: set the database rules (see README)'
      : `Cloud error ${r.status}: ${text.slice(0, 120)}`;
    setCloudStatus(false, msg);
    throw new Error(msg);
  }
  setCloudStatus(true);
  return text ? JSON.parse(text) : null;
}

function setCloudStatus(ok, msg) {
  const el = $('cloudStatus');
  el.textContent = ok ? 'connected' : 'not connected';
  el.className = ok ? 'ok' : 'bad';
  $('cloudHelp').textContent = ok ? `Using ${cloudBase}` : msg || '';
}

async function initCloud() {
  $('dbUrlIn').value = readJSON('ovl:dbURL') || '';
  try {
    await findDb();
    await refreshCollections();
  } catch (err) {
    setCloudStatus(false, err.message);
    renderCollections();
  }
}
$('dbUrlIn').onchange = (e) => {
  writeJSON('ovl:dbURL', e.target.value.trim() || null);
  cloudBase = null;
  initCloud();
  refreshCloudList(true);
};

const sortedAlignments = (data) =>
  Object.entries(data?.alignments || {}).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

// --- Saved alignments of the selected sheet ---
let cloudView = { key: null, data: null, loading: false, error: null };

async function refreshCloudList(force) {
  const sh = active();
  const key = sh ? `${sh.name}#${sh.page}` : null;
  if (!force && key === cloudView.key) return renderCloudList();
  cloudView = { key, data: null, loading: !!sh, error: null };
  renderCloudList();
  if (!sh) return;
  try {
    const data = (await cloud('GET', sheetPath(sh))) || {};
    if (cloudView.key === key) cloudView.data = data;
  } catch (err) {
    if (cloudView.key === key) cloudView.error = err.message;
  }
  if (cloudView.key === key) { cloudView.loading = false; renderCloudList(); }
}

function renderCloudList() {
  const ul = $('alignList');
  const sh = active();
  ul.innerHTML = '';
  const note = (text, cls = 'note') => { const li = document.createElement('li'); li.className = cls; li.textContent = text; ul.append(li); };
  $('cloudUpdateBtn').disabled = !sh || !sh.cloudId;
  if (!sh) return;
  if (cloudView.loading) return note('Loading…');
  if (cloudView.error) return note(cloudView.error, 'err');
  const list = sortedAlignments(cloudView.data);
  if (!list.length) return note('None saved yet. Use "Save as new".');
  const primary = cloudView.data.primary;
  for (const [id, a] of list) {
    const li = document.createElement('li');
    if (id === sh.cloudId) li.className = 'current';
    li.innerHTML = `
      <button class="star" title="${id === primary ? 'Primary (loads automatically)' : 'Set as primary'}">${id === primary ? '★' : '☆'}</button>
      <span class="lbl"></span>
      <button data-a="apply" title="Apply to the sheet">▶</button>
      <button data-a="rename" title="Rename">✎</button>
      <button data-a="del" title="${list.length === 1 ? 'The last alignment cannot be deleted' : 'Delete'}" ${list.length === 1 ? 'disabled' : ''}>🗑</button>`;
    const lbl = li.querySelector('.lbl');
    lbl.textContent = a.label || 'Untitled';
    lbl.insertAdjacentHTML('beforeend', ` <small>${new Date(a.updatedAt || a.createdAt || 0).toLocaleDateString()}</small>`);
    lbl.title = `${a.label || 'Untitled'}\nSaved ${new Date(a.updatedAt || a.createdAt || 0).toLocaleString()}`;
    li.querySelector('.star').onclick = () => id !== primary && cloudAction(() => cloudSetPrimary(sh, id));
    li.querySelector('[data-a=apply]').onclick = () => applyCloudAlignment(sh, id, a);
    li.querySelector('[data-a=rename]').onclick = () => cloudAction(() => cloudRename(sh, id, a));
    li.querySelector('[data-a=del]').onclick = () => cloudAction(() => cloudDelete(sh, id, a));
    ul.append(li);
  }
}

async function cloudAction(fn) {
  try { await fn(); } catch (err) { status(err.message); }
  refreshCloudList(true);
}

function applyCloudAlignment(sh, id, a) {
  if (!applyGeo(sh, a, false)) return status('That alignment is invalid');
  sh.cloudId = id;
  saveSheetSoon(sh);
  if (!map.getBounds().contains([a.lat, a.lng])) map.panTo([a.lat, a.lng]);
  setMode('locked');
  renderCloudList();
  status(`Applied "${a.label}"`);
}

// On adding a sheet (or changing its page): load its ★ primary, unless the user already started adjusting
async function cloudApplyPrimary(sh) {
  sh.touched = false;
  let data;
  try { data = await cloud('GET', sheetPath(sh)); } catch { return; }
  const a = data?.primary && data.alignments?.[data.primary];
  if (!a || !sheets.includes(sh)) return;
  if (sh.touched) return status(`☁ ${sh.name} has a ★ primary alignment; press ▶ to apply it`);
  if (!applyGeo(sh, a, true)) return;
  sh.cloudId = data.primary;
  saveSheetSoon(sh);
  setMode('locked');
  renderCloudList();
  status(`☁ Loaded ★ "${a.label}" for ${sh.name}`);
}

const cloudRecord = (sh) => ({ ...geoState(sh), updatedAt: Date.now() });

$('cloudSaveNewBtn').onclick = () => cloudAction(async () => {
  const sh = active();
  if (!sh || !placed(sh)) return;
  const label = prompt(`Name for this alignment of "${sh.name}" (page ${sh.page}):`, `Alignment ${new Date().toLocaleString()}`);
  if (label === null) return;
  const rec = { ...cloudRecord(sh), label: label.trim() || 'Untitled', createdAt: Date.now() };
  const { name: id } = await cloud('POST', [...sheetPath(sh), 'alignments'], rec);
  await cloud('PATCH', ['sheets', fbKey(sh.name)], { name: sh.name });
  const data = await cloud('GET', sheetPath(sh));
  if (!data?.primary || !data.alignments?.[data.primary]) await cloud('PUT', [...sheetPath(sh), 'primary'], id);
  sh.cloudId = id;
  status(`☁ Saved "${rec.label}"`);
});

$('cloudUpdateBtn').onclick = () => cloudAction(async () => {
  const sh = active();
  if (!sh || !placed(sh) || !sh.cloudId) return;
  const a = cloudView.data?.alignments?.[sh.cloudId];
  if (!confirm(`Overwrite "${a?.label || 'this alignment'}" with the current position?`)) return;
  await cloud('PATCH', [...sheetPath(sh), 'alignments', sh.cloudId], cloudRecord(sh));
  status('☁ Alignment updated');
});
$('cloudRefreshBtn').onclick = () => refreshCloudList(true);

async function cloudSetPrimary(sh, id) {
  await cloud('PUT', [...sheetPath(sh), 'primary'], id);
  status('★ Primary alignment set');
}

async function cloudRename(sh, id, a) {
  const label = prompt('New name:', a.label || '');
  if (label === null || !label.trim()) return;
  await cloud('PATCH', [...sheetPath(sh), 'alignments', id], { label: label.trim() });
}

// One alignment always stays; deleting the primary promotes the newest remaining one
async function cloudDelete(sh, id, a) {
  const data = (await cloud('GET', sheetPath(sh))) || {};
  const rest = sortedAlignments(data).filter(([k]) => k !== id);
  if (!rest.length) return status('The last alignment cannot be deleted');
  if (!confirm(`Delete alignment "${a.label}"?`)) return;
  await cloud('DELETE', [...sheetPath(sh), 'alignments', id]);
  if (data.primary === id) await cloud('PUT', [...sheetPath(sh), 'primary'], rest[0][0]);
  if (sh.cloudId === id) sh.cloudId = null;
  status('Alignment deleted');
}

// --- Collections: a named snapshot of open sheets and their alignments ---
let collections = {};
let pendingColl = null; // { order: Map(itemKey -> order), items: [missing items] }

const itemKey = (name, page) => `${fbKey(name)}_p${page}`;

async function refreshCollections(selectId) {
  try { collections = (await cloud('GET', ['collections'])) || {}; } catch (err) { status(err.message); }
  renderCollections(selectId);
}
$('collRefreshBtn').onclick = () => refreshCollections();

function renderCollections(selectId) {
  const sel = $('collSel');
  const prev = selectId || sel.value;
  sel.innerHTML = '';
  const list = Object.entries(collections).sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
  for (const [id, c] of list) {
    sel.add(new Option(`${c.name || 'Untitled'} (${Object.keys(c.items || {}).length} sheets)`, id));
  }
  if (!list.length) sel.add(new Option('No collections yet', ''));
  if (prev && collections[prev]) sel.value = prev;
  const has = !!sel.value;
  for (const id of ['collLoadBtn', 'collUpdateBtn', 'collRenameBtn', 'collDeleteBtn']) $(id).disabled = !has;
}

function snapshotItems() {
  return Object.fromEntries(sheets.filter(placed).map((sh, i) => [itemKey(sh.name, sh.page), {
    name: sh.name, page: sh.page, order: i, visible: sh.visible, alignment: geoState(sh),
  }]));
}

const collAction = (fn) => async () => {
  try { await fn(); } catch (err) { status(err.message); }
};

$('collNewBtn').onclick = collAction(async () => {
  if (!sheets.length) return status('Add sheets first');
  const name = prompt('Collection name:', `Collection ${new Date().toLocaleDateString()}`);
  if (name === null) return;
  const now = Date.now();
  const { name: id } = await cloud('POST', ['collections'], {
    name: name.trim() || 'Untitled', createdAt: now, updatedAt: now, items: snapshotItems(),
  });
  await refreshCollections(id);
  status(`☁ Saved collection with ${sheets.length} sheet(s)`);
});

$('collUpdateBtn').onclick = collAction(async () => {
  const id = $('collSel').value;
  if (!id || !sheets.length) return;
  if (!confirm(`Overwrite "${collections[id].name}" with the ${sheets.length} open sheet(s)?`)) return;
  await cloud('PATCH', ['collections', id], { updatedAt: Date.now(), items: snapshotItems() });
  await refreshCollections(id);
  status('☁ Collection updated');
});

$('collRenameBtn').onclick = collAction(async () => {
  const id = $('collSel').value;
  const name = id && prompt('New name:', collections[id].name);
  if (!name || !name.trim()) return;
  await cloud('PATCH', ['collections', id], { name: name.trim() });
  await refreshCollections(id);
});

$('collDeleteBtn').onclick = collAction(async () => {
  const id = $('collSel').value;
  if (!id || !confirm(`Delete collection "${collections[id].name}"? Sheets' own saved alignments are kept.`)) return;
  await cloud('DELETE', ['collections', id]);
  await refreshCollections();
  status('Collection deleted');
});

$('collLoadBtn').onclick = collAction(async () => {
  const id = $('collSel').value;
  if (!id) return;
  const c = await cloud('GET', ['collections', id]);
  if (!c) return refreshCollections();
  const items = Object.values(c.items || {}).sort((a, b) => a.order - b.order);
  const inColl = (sh) => items.some((it) => it.name === sh.name && it.page === sh.page);
  const others = sheets.filter((sh) => !inColl(sh));
  if (others.length && confirm(`Close the ${others.length} open sheet(s) that are not in "${c.name}"?`)) {
    others.forEach((sh) => removeSheet(sh));
  }

  const missing = [];
  for (const it of items) {
    let sh = sheets.find((s) => s.name === it.name && s.page === it.page);
    if (!sh) {
      // Same file already open on another page: reuse it
      const same = sheets.find((s) => s.name === it.name);
      if (same) sh = await addSheet(same.file, { page: it.page, visible: it.visible, quiet: true });
    }
    if (sh) applyItem(sh, it);
    else missing.push(it);
  }
  pendingColl = { order: new Map(items.map((it) => [itemKey(it.name, it.page), it.order])), items: missing };
  finishCollectionLoad(items);
  status(missing.length
    ? `Loaded ${items.length - missing.length} of ${items.length}. Pick the missing files below.`
    : `☁ Loaded collection "${c.name}"`);
});

function applyItem(sh, it) {
  applyGeo(sh, it.alignment, false);
  sh.visible = it.visible ?? true;
  saveSheetSoon(sh);
}

// Re-sort open sheets in collection order, show what's still missing, and zoom to the collection
function finishCollectionLoad(items) {
  const rank = (sh) => pendingColl?.order.get(itemKey(sh.name, sh.page)) ?? 1e9;
  sheets.sort((a, b) => rank(a) - rank(b));
  orderDOM();
  const missing = pendingColl?.items || [];
  $('collMissing').hidden = !missing.length;
  $('collMissingList').textContent = [...new Set(missing.map((it) => it.name))].join(', ');
  if (sheets[0]) G.activeId = sheets[0].id;
  setMode('locked');
  saveWorkspace(); renderList(); renderAll();
  const pts = (items || []).filter((it) => it.alignment).map((it) => [it.alignment.lat, it.alignment.lng]);
  if (pts.length === 1) map.setView(pts[0], Math.max(map.getZoom(), 15));
  else if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.5));
}

$('collFilesInput').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!pendingColl) return;
  const byName = (it) => files.find((f) => f.name === it.name) || files.find((f) => f.name.toLowerCase() === it.name.toLowerCase());
  const still = [];
  for (const it of pendingColl.items) {
    const f = byName(it);
    const sh = f && await addSheet(f, { page: it.page, visible: it.visible, quiet: true });
    if (sh) applyItem(sh, it);
    else still.push(it);
  }
  const unused = files.filter((f) => !pendingColl.items.some((it) => byName(it) === f));
  pendingColl.items = still;
  finishCollectionLoad([]);
  status((still.length ? `${still.length} still missing. ` : 'All collection sheets loaded. ')
    + (unused.length ? `Not in the collection: ${unused.map((f) => f.name).join(', ')}` : ''));
};

// ---------- Add from link (downloaded through server.py, previewed before adding) ----------
let preview = null; // { file, pdf, isPdf }

async function sniffType(blob, name, type) {
  const b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const str = String.fromCharCode(...b);
  if (str.startsWith('%PDF') || /pdf/i.test(type)) return 'application/pdf';
  if (b[0] === 0x89 && str.slice(1, 4) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (str.startsWith('GIF8')) return 'image/gif';
  if (str.startsWith('RIFF') && str.slice(8, 12) === 'WEBP') return 'image/webp';
  if (/^image\//i.test(type)) return type;
  if (/\.pdf$/i.test(name)) return 'application/pdf';
  return null;
}

$('linkForm').onsubmit = async (e) => {
  e.preventDefault();
  const url = $('linkIn').value.trim();
  if (!/^https?:\/\//i.test(url)) return status('Paste a link starting with http:// or https://');
  status('Downloading…');
  try {
    const r = await fetch('/api/fetch?url=' + encodeURIComponent(url));
    if (r.status === 404 && !r.headers.get('X-Filename')) throw new Error('needs server.py running (python3 server.py)');
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    let name = decodeURIComponent(r.headers.get('X-Filename') || 'download');
    const blob = await r.blob();
    const type = await sniffType(blob, name, r.headers.get('Content-Type') || '');
    if (!type) throw new Error('the link is not a PDF or image (it may be a web page, not a direct download link)');
    if (type === 'application/pdf' && !/\.pdf$/i.test(name)) name += '.pdf';
    await openPreview(new File([blob], name, { type }));
    status('');
  } catch (err) {
    status('Download failed: ' + err.message);
  }
};

async function openPreview(file) {
  closePreview();
  const isPdf = isPdfFile(file);
  preview = { file, isPdf, pdf: null };
  $('previewName').value = file.name;
  $('previewPageRow').hidden = true;
  const mb = (file.size / 1048576).toFixed(1) + ' MB';
  if (isPdf) {
    preview.pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const n = preview.pdf.numPages;
    const sel = $('previewPage');
    sel.innerHTML = '';
    for (let p = 1; p <= n; p++) sel.add(new Option(`${p} / ${n}`, p));
    $('previewPageRow').hidden = n < 2;
    $('previewInfo').textContent = `PDF · ${n} page(s) · ${mb}`;
    await renderPreviewPage(1);
  } else {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await img.decode();
    $('previewThumb').replaceChildren(img);
    $('previewInfo').textContent = `Image · ${img.naturalWidth}×${img.naturalHeight}px · ${mb}`;
  }
  $('previewModal').hidden = false;
}

async function renderPreviewPage(n) {
  const page = await preview.pdf.getPage(n);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: 1000 / Math.max(vp1.width, vp1.height) });
  const c = document.createElement('canvas');
  c.width = vp.width; c.height = vp.height;
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  $('previewThumb').replaceChildren(c);
}
$('previewPage').onchange = (e) => renderPreviewPage(Number(e.target.value));

function closePreview() {
  const img = $('previewThumb').querySelector('img');
  if (img) URL.revokeObjectURL(img.src);
  $('previewThumb').replaceChildren();
  if (preview?.pdf) preview.pdf.destroy();
  preview = null;
  $('previewModal').hidden = true;
}
$('previewCancel').onclick = closePreview;
$('previewModal').onclick = (e) => { if (e.target === $('previewModal')) closePreview(); };

$('previewAdd').onclick = async () => {
  if (!preview) return;
  const { file, isPdf } = preview;
  const name = $('previewName').value.trim() || file.name;
  const page = isPdf ? Number($('previewPage').value) || 1 : 1;
  const f = name === file.name ? file : new File([file], name, { type: file.type });
  closePreview();
  $('linkIn').value = '';
  await addSheet(f, { page });
};

// ---------- Library: sheets published as GitHub release assets ----------
// Sources come from library-config.js plus any added in the app (localStorage).
// The asset list comes from the GitHub API (CORS-enabled, cached 1 h); files download through server.py.
const LIB_SOURCES_KEY = 'ovl:libSources';
const lib = { items: [], sourceIdx: 0, selected: new Set(), cloudKeys: new Set(), cache: new Map(), previewName: null, error: null };

function libSources() {
  return [...(window.LIBRARY_SOURCES || []).map((s) => ({ ...s, builtin: true })), ...(readJSON(LIB_SOURCES_KEY) || [])];
}

function parseRelease(url) {
  const m = String(url).match(/github\.com\/([^/]+)\/([^/]+)\/releases\/tag\/([^/?#]+)/);
  return m && { owner: m[1], repo: m[2], tag: decodeURIComponent(m[3]) };
}

const prettyName = (n) => n.replace(/\.[^.]+$/, '').replace(/[_.]+/g, ' ').trim();
const mb = (bytes) => (bytes / 1048576).toFixed(1) + ' MB';
const isOpen = (name) => sheets.some((sh) => sh.name === name);

function openLibrary() {
  const sel = $('libSource');
  sel.innerHTML = '';
  libSources().forEach((s, i) => sel.add(new Option(s.label, i)));
  lib.sourceIdx = Math.min(lib.sourceIdx, Math.max(0, libSources().length - 1));
  sel.value = lib.sourceIdx;
  $('libModal').hidden = false;
  $('libFilter').focus();
  loadLibrary(false);
}
function closeLibrary() { $('libModal').hidden = true; }
$('libOpenBtn').onclick = openLibrary;
$('libClose').onclick = closeLibrary;
$('libModal').onclick = (e) => { if (e.target === $('libModal')) closeLibrary(); };
$('libSource').onchange = (e) => { lib.sourceIdx = Number(e.target.value); lib.selected.clear(); loadLibrary(false); };
$('libRefresh').onclick = () => loadLibrary(true);
$('libFilter').oninput = () => renderLibList();

async function loadLibrary(force) {
  const src = libSources()[lib.sourceIdx];
  $('libRemoveSource').hidden = !src || src.builtin;
  lib.items = []; lib.error = null;
  if (!src) { lib.error = 'No sources. Use ＋ Source to add a GitHub release link.'; return renderLibList(); }
  const rel = parseRelease(src.release);
  if (!rel) { lib.error = `Not a GitHub release link: ${src.release}`; return renderLibList(); }

  const cacheKey = 'ovl:lib:' + src.release;
  const cached = readJSON(cacheKey);
  if (!force && cached && Date.now() - cached.at < 3600e3) {
    lib.items = cached.items;
  } else {
    $('libInfo').textContent = 'Loading list from GitHub…';
    renderLibList(true);
    try {
      const r = await fetch(`https://api.github.com/repos/${rel.owner}/${rel.repo}/releases/tags/${encodeURIComponent(rel.tag)}`);
      if (!r.ok) {
        throw new Error(r.status === 404 ? 'Release not found (is the repo public?)'
          : r.status === 403 ? 'GitHub rate limit reached; try again in a while' : `GitHub error ${r.status}`);
      }
      const d = await r.json();
      lib.items = d.assets
        .filter((a) => /\.(pdf|png|jpe?g|gif|webp)$/i.test(a.name))
        .map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      writeJSON(cacheKey, { at: Date.now(), items: lib.items });
    } catch (err) {
      lib.error = err.message;
      if (cached) lib.items = cached.items; // stale list is better than none
    }
  }
  renderLibList();
  // Mark files that already have cloud alignments
  try {
    lib.cloudKeys = new Set(Object.keys((await cloud('GET', ['sheets'], undefined, 'shallow=true')) || {}));
    renderLibList();
  } catch {}
}

function renderLibList(loading) {
  const ul = $('libList');
  ul.innerHTML = '';
  const note = (text, cls = 'note') => { const li = document.createElement('li'); li.className = 'lib-row ' + cls; li.textContent = text; ul.append(li); };
  if (lib.error) note(lib.error, 'err');
  if (loading) return note('Loading…');
  const q = $('libFilter').value.trim().toLowerCase();
  const shown = lib.items.filter((it) => !q || it.name.toLowerCase().includes(q) || prettyName(it.name).toLowerCase().includes(q));
  for (const it of shown) {
    const open = isOpen(it.name);
    const li = document.createElement('li');
    li.className = 'lib-row' + (it.name === lib.previewName ? ' current' : '');
    li.title = it.name;
    li.innerHTML = `<input type="checkbox" ${open ? 'disabled title="Already on the map"' : ''} ${lib.selected.has(it.name) ? 'checked' : ''}>
      <span class="nm"></span>
      ${lib.cloudKeys.has(fbKey(it.name)) ? '<span class="badge cl" title="Has saved cloud alignments">☁ aligned</span>' : ''}
      ${open ? '<span class="badge on">✓ on map</span>' : ''}
      <span class="sz">${mb(it.size)}</span>`;
    li.querySelector('.nm').textContent = prettyName(it.name);
    const cb = li.querySelector('input');
    cb.onclick = (e) => {
      e.stopPropagation();
      cb.checked ? lib.selected.add(it.name) : lib.selected.delete(it.name);
      updateLibFoot();
    };
    li.onclick = () => libPreview(it);
    ul.append(li);
  }
  if (!lib.items.length && !lib.error) note('No PDFs or images in this release.');
  else if (lib.items.length && !shown.length) note('No sheets match the filter.');
  updateLibFoot();
}

function updateLibFoot() {
  for (const n of [...lib.selected]) if (isOpen(n)) lib.selected.delete(n);
  const total = lib.items.reduce((a, it) => a + it.size, 0);
  const onMap = lib.items.filter((it) => isOpen(it.name)).length;
  $('libInfo').textContent = lib.items.length ? `${lib.items.length} sheets · ${mb(total)} · ${onMap} on map` : '';
  $('libAddSel').disabled = !lib.selected.size;
  $('libAddSel').textContent = `＋ Add selected${lib.selected.size ? ` (${lib.selected.size})` : ''}`;
}

// Download through server.py (GitHub downloads have no CORS headers), with progress; keeps the last few in memory
async function libFile(it, onProgress) {
  if (lib.cache.has(it.name)) return lib.cache.get(it.name);
  const r = await fetch('/api/fetch?url=' + encodeURIComponent(it.url));
  if (r.status === 404 && !r.headers.get('X-Filename')) throw new Error('needs server.py running (python3 server.py)');
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  const total = Number(r.headers.get('Content-Length')) || it.size;
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(got, total);
  }
  const blob = new Blob(chunks);
  const type = await sniffType(blob, it.name, '') || 'application/octet-stream';
  const file = new File([blob], it.name, { type });
  lib.cache.set(it.name, file);
  while (lib.cache.size > 4) lib.cache.delete(lib.cache.keys().next().value);
  return file;
}

async function libPreview(it) {
  lib.previewName = it.name;
  renderLibList();
  const pv = $('libPreview');
  const open = isOpen(it.name);
  pv.innerHTML = `<div class="pv-title"></div>
    <div class="muted small pv-info">${mb(it.size)}</div>
    <div class="pv-img"><span class="muted pv-progress">Downloading…</span></div>
    <div class="btns">
      <button class="pv-open" ${open ? '' : 'hidden'}>Show on map</button>
      <button class="primary pv-add" ${open ? 'hidden' : ''} disabled>＋ Add to map</button>
    </div>`;
  pv.querySelector('.pv-title').textContent = it.name;
  pv.querySelector('.pv-open').onclick = () => {
    const sh = sheets.find((s) => s.name === it.name);
    if (sh) { setActive(sh.id); if (sh.anchor) map.panTo(sh.anchor); }
    closeLibrary();
  };
  pv.querySelector('.pv-add').onclick = () => addFromLibrary([it]);
  try {
    const file = await libFile(it, (got, total) => {
      if (lib.previewName === it.name) pv.querySelector('.pv-progress').textContent = `Downloading… ${Math.round((got / total) * 100)}%`;
    });
    if (lib.previewName !== it.name) return;
    if (isPdfFile(file)) {
      const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      const page = await pdf.getPage(1);
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 1200 / Math.max(vp1.width, vp1.height) });
      const c = document.createElement('canvas');
      c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      pv.querySelector('.pv-info').textContent = `PDF · ${pdf.numPages} page(s) · ${mb(it.size)}`;
      pdf.destroy();
      if (lib.previewName === it.name) pv.querySelector('.pv-img').replaceChildren(c);
    } else {
      const img = new Image();
      img.src = URL.createObjectURL(file);
      await img.decode();
      if (lib.previewName !== it.name) return URL.revokeObjectURL(img.src);
      pv.querySelector('.pv-info').textContent = `Image · ${img.naturalWidth}×${img.naturalHeight}px · ${mb(it.size)}`;
      pv.querySelector('.pv-img').replaceChildren(img);
      setTimeout(() => URL.revokeObjectURL(img.src), 1000);
    }
    pv.querySelector('.pv-add').disabled = false;
  } catch (err) {
    if (lib.previewName === it.name) pv.querySelector('.pv-img').innerHTML = `<span class="muted">Download failed: ${err.message}</span>`;
  }
}

async function addFromLibrary(items) {
  const todo = items.filter((it) => !isOpen(it.name));
  closeLibrary();
  for (let i = 0; i < todo.length; i++) {
    const it = todo[i];
    try {
      const file = await libFile(it, (got, total) =>
        status(`Downloading ${i + 1}/${todo.length}: ${prettyName(it.name)} ${Math.round((got / total) * 100)}%`));
      status(`Adding ${i + 1}/${todo.length}: ${prettyName(it.name)}`);
      await addSheet(file);
    } catch (err) {
      status(`Failed: ${it.name}: ${err.message}`);
    }
    lib.selected.delete(it.name);
  }
}
$('libAddSel').onclick = () => addFromLibrary(lib.items.filter((it) => lib.selected.has(it.name)));

$('libAddSource').onclick = () => {
  const url = prompt('Paste a GitHub release link (…/releases/tag/…):');
  if (!url) return;
  const rel = parseRelease(url);
  if (!rel) return alert('That is not a GitHub release link. It should look like https://github.com/owner/repo/releases/tag/name');
  const label = prompt('Name for this source:', `${rel.repo} / ${rel.tag}`);
  if (label === null) return;
  const list = readJSON(LIB_SOURCES_KEY) || [];
  list.push({ label: label.trim() || rel.tag, release: url.trim() });
  writeJSON(LIB_SOURCES_KEY, list);
  lib.sourceIdx = libSources().length - 1;
  openLibrary();
};

$('libRemoveSource').onclick = () => {
  const src = libSources()[lib.sourceIdx];
  if (!src || src.builtin || !confirm(`Remove source "${src.label}"?`)) return;
  const builtinCount = (window.LIBRARY_SOURCES || []).length;
  const list = readJSON(LIB_SOURCES_KEY) || [];
  list.splice(lib.sourceIdx - builtinCount, 1);
  writeJSON(LIB_SOURCES_KEY, list);
  lib.sourceIdx = 0;
  openLibrary();
};

// ---------- Workspace: remembers open sheets across page reloads ----------
// Files are kept in IndexedDB; order/visibility/page in localStorage.
function saveWorkspace() {
  writeJSON('ovl:workspace', {
    order: sheets.map((sh) => sh.id),
    meta: Object.fromEntries(sheets.map((sh) => [sh.id, { page: sh.page, visible: sh.visible }])),
    master: G.master, quality: G.quality,
  });
}

let dbPromise = null;
function idb(mode, fn) {
  dbPromise ||= new Promise((res, rej) => {
    const r = indexedDB.open('overlay-aligner', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbPromise.then((db) => new Promise((res, rej) => {
    const tx = db.transaction('files', mode);
    const req = fn(tx.objectStore('files'));
    tx.oncomplete = () => res(req && req.result);
    tx.onerror = tx.onabort = () => rej(tx.error);
  }));
}
function dbPut(sh) {
  idb('readwrite', (st) => st.put({ id: sh.id, name: sh.name, file: sh.file }))
    .catch((err) => status(`Couldn't store ${sh.name} for next time: ${err?.message || err}`));
}
function dbDelete(id) { idb('readwrite', (st) => st.delete(id)).catch(() => {}); }

async function restoreWorkspace() {
  if (workspace.quality) { G.quality = workspace.quality; $('qualitySel').value = G.quality; }
  let records;
  try { records = await idb('readonly', (st) => st.getAll()); } catch { return; }
  if (!records?.length) return;
  const order = workspace.order || [];
  records.sort((a, b) => (order.indexOf(a.id) + 1 || 1e9) - (order.indexOf(b.id) + 1 || 1e9));
  // addSheet puts each new sheet on top, so add bottom-first
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    const meta = workspace.meta?.[r.id] || {};
    status(`Reopening ${records.length - i}/${records.length}: ${r.name}`);
    await addSheet(r.file, { id: r.id, page: meta.page, visible: meta.visible, restoring: true });
  }
  if (sheets.length) setActive(sheets[0].id);
  status(`Reopened ${sheets.length} sheet(s)`);
}

function readJSON(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function writeJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }

// ---------- Search: coordinates, Google Maps links, place names ----------
const NUM = '(\\d+(?:\\.\\d+)?)';
function validLatLng(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

// 18°37'21.8"N 73°47'39.0"E  |  18.6227, 73.7942  |  18.6227N 73.7942E
function parseCoords(text) {
  const dms = [...text.matchAll(new RegExp(`${NUM}\\s*°\\s*(?:${NUM}\\s*['′]\\s*)?(?:${NUM}\\s*(?:["″]|'')\\s*)?([NSEW])`, 'gi'))];
  if (dms.length === 2) {
    const out = {};
    for (const [, d, m = 0, s = 0, hemi] of dms) {
      const h = hemi.toUpperCase();
      const v = (Number(d) + Number(m) / 60 + Number(s) / 3600) * (h === 'S' || h === 'W' ? -1 : 1);
      out[h === 'N' || h === 'S' ? 'lat' : 'lng'] = v;
    }
    return validLatLng(out.lat, out.lng);
  }
  const dec = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*°?\s*([NS])?\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EW])?\s*$/i);
  if (dec) {
    const lat = Number(dec[1]) * (/s/i.test(dec[2] || '') ? -1 : 1);
    const lng = Number(dec[3]) * (/w/i.test(dec[4] || '') ? -1 : 1);
    return validLatLng(lat, lng);
  }
  return null;
}

// Fallback for full Google links when server.py isn't running
function parseGoogleUrl(url) {
  const u = decodeURIComponent(url);
  const m = u.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || u.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  return m ? validLatLng(Number(m[1]), Number(m[2])) : null;
}

let searchMarker = null;
function goTo(lat, lng, label, zoom) {
  map.setView([lat, lng], zoom ?? Math.max(map.getZoom(), 17));
  if (searchMarker) map.removeLayer(searchMarker);
  searchMarker = L.circleMarker([lat, lng], {
    radius: 8, color: '#fff', weight: 3, fillColor: '#e53935', fillOpacity: 1,
  }).addTo(map).bindPopup(`${label ? label + '<br>' : ''}<small>${lat.toFixed(6)}, ${lng.toFixed(6)}</small>`);
  status(`Moved to ${lat.toFixed(6)}, ${lng.toFixed(6)}`);
}

async function searchPlace(q) {
  const b = map.getBounds().pad(2);
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6'
    + `&viewbox=${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}&q=${encodeURIComponent(q)}`;
  const res = await (await fetch(url)).json();
  const list = $('searchResults');
  list.innerHTML = '';
  if (!res.length) { list.hidden = true; return status(`No results for "${q}"`); }
  for (const r of res) {
    const li = document.createElement('li');
    li.textContent = r.display_name;
    li.onclick = () => goTo(Number(r.lat), Number(r.lon), r.display_name);
    list.append(li);
  }
  list.hidden = res.length < 2;
  goTo(Number(res[0].lat), Number(res[0].lon), res[0].display_name);
}

async function resolveLink(link) {
  try {
    const r = await (await fetch('/api/resolve?url=' + encodeURIComponent(link))).json();
    if (r.lat != null) return goTo(r.lat, r.lng, r.name, r.zoom ?? undefined);
    if (r.name) return searchPlace(r.name);
    return status(r.error || 'No location found in link');
  } catch {
    const p = parseGoogleUrl(link);
    if (p) return goTo(p.lat, p.lng);
    status('Short links need server.py running (python3 server.py)');
  }
}

$('searchForm').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('searchIn').value.trim();
  if (!q) return;
  $('searchResults').hidden = true;
  status('Searching…');
  try {
    const c = parseCoords(q);
    if (c) return goTo(c.lat, c.lng);
    if (/^https?:\/\//i.test(q)) return await resolveLink(q);
    await searchPlace(q);
  } catch (err) {
    console.error(err);
    status('Search failed: ' + err.message);
  }
};
$('searchIn').onkeydown = (e) => { if (e.key === 'Escape') { $('searchResults').hidden = true; e.target.blur(); } };

// ---------- Legend ----------
function setLegend(show) {
  $('legend').hidden = !show;
  $('legendChk').checked = show;
  writeJSON('ovl:legend', show);
}
$('legendChk').onchange = (e) => setLegend(e.target.checked);
$('legendClose').onclick = () => setLegend(false);
setLegend(readJSON('ovl:legend') === true);

// ---------- Misc ----------
let statusTimer = null;
function status(msg) {
  $('status').textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => ($('status').textContent = ''), 5000);
}
$('collapseBtn').onclick = () => {
  const c = $('panel').classList.toggle('collapsed');
  $('collapseBtn').textContent = c ? '+' : '–';
};

setMode('locked');
renderList();
restoreWorkspace();
initCloud();
