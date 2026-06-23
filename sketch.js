// ─── GLOBALS ──────────────────────────────────────────────────────────────────
let currentMedia = null;
let currentVideo = null;
let isWebcam = false;
let svgImages = [null, null, null, null, null, null, null];
let stateShapes = ['circle','circle','circle','circle','circle','circle','circle'];
let pg;

const NUM_STATES = 7;
const STATE_LABELS = ['1·HIGH','2·LT-MID','3·MID-HI','4·MID','5·MID-LO','6·DK-MID','7·SHADOW'];
const DEFAULT_COLORS = ['#ffffff','#cccccc','#999999','#777777','#555555','#333333','#111111'];
const DEFAULT_SHAPES = ['circle','circle','circle','circle','circle','circle','circle'];
const SHAPES = ['circle','square','diamond','cross','ring','triangle','dot'];

// ─── BAYER MATRICES ───────────────────────────────────────────────────────────
const BAYER = {
  2: [
    [0, 2],
    [3, 1]
  ],
  4: [
    [ 0,  8,  2, 10],
    [12,  4, 14,  6],
    [ 3, 11,  1,  9],
    [15,  7, 13,  5]
  ],
  8: [
    [ 0, 32,  8, 40,  2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44,  4, 36, 14, 46,  6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [ 3, 35, 11, 43,  1, 33,  9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47,  7, 39, 13, 45,  5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21]
  ]
};

// ─── CACHING & PERFORMANCE ────────────────────────────────────────────────────
let lastParams = null;
let cachedBriArr = null;
let cachedStateArr = null;
let cacheValid = false;

// ─── RECORDING ────────────────────────────────────────────────────────────────
let isRecording = false;
let mediaRecorder = null;
let recordedChunks = [];
let exportExt = 'webm';

// ─────────────────────────────────────────────────────────────────────────────
// P5 SETUP
// ─────────────────────────────────────────────────────────────────────────────
function setup() {
  const canvas = createCanvas(1000, 1000);
  canvas.parent('canvas-container');
  pixelDensity(1);
  pg = createGraphics(1, 1);
  pg.pixelDensity(1);
  frameRate(30);

  buildStateUI();
  setupSectionToggles();
  setupSliders();
  setupMediaListeners();
  setupExportListeners();
  setupPresetListeners();
}

// ─────────────────────────────────────────────────────────────────────────────
// P5 DRAW
// ─────────────────────────────────────────────────────────────────────────────
function draw() {
  const bgColor = document.getElementById('bgColor').value;
  background(bgColor);

  const mW = currentMedia ? (currentMedia.width  || (currentMedia.elt && currentMedia.elt.videoWidth))  : 0;
  const mH = currentMedia ? (currentMedia.height || (currentMedia.elt && currentMedia.elt.videoHeight)) : 0;

  if (!currentMedia || !mW || !mH) {
    fill(50); noStroke(); textAlign(CENTER, CENTER);
    textSize(width * 0.022); textStyle(NORMAL);
    text('LOAD MEDIA TO BEGIN', width / 2, height / 2);
    return;
  }

  const p = getParams();
  const paramsStr = JSON.stringify(p);

  // Only recompute if params changed
  if (paramsStr !== lastParams) {
    const { gridCols, gridRows, outW, outH } = computeGrid(mW, mH, p);
    if (width !== outW || height !== outH) resizeCanvas(outW, outH);

    if (pg.width !== gridCols || pg.height !== gridRows) pg.resizeCanvas(gridCols, gridRows);
    const crop = computeCrop(mW, mH, p);
    pg.clear();
    pg.image(currentMedia, 0, 0, gridCols, gridRows, crop.sx, crop.sy, crop.cw, crop.ch);
    pg.loadPixels();
    if (!pg.pixels || pg.pixels.length === 0) return;

    cachedBriArr = buildBrightnessArray(pg.pixels, gridCols, gridRows, p);
    cachedStateArr = runDither(cachedBriArr, gridCols, gridRows, p.enableStateMap ? NUM_STATES : 1, p);
    lastParams = paramsStr;
    cacheValid = true;
  }

  if (cacheValid && cachedBriArr && cachedStateArr) {
    const { gridCols, gridRows } = computeGrid(mW, mH, p);
    renderCells(cachedBriArr, cachedStateArr, gridCols, gridRows, p);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER CELLS TO P5 CANVAS
// ─────────────────────────────────────────────────────────────────────────────
function renderCells(briArr, stateArr, gridCols, gridRows, p) {
  const cellW = width  / gridCols;
  const cellH = height / gridRows;
  const cellSize = Math.min(cellW, cellH);
  const rotStep = Math.floor(millis() / p.rotInterval);
  const rot = p.snapRot ? (rotStep % 4) * HALF_PI : 0;

  noStroke();
  for (let y = 0; y < gridRows; y++) {
    for (let x = 0; x < gridCols; x++) {
      const idx = y * gridCols + x;
      const state = p.enableStateMap ? stateArr[idx] : 0;
      const sf = brightnessToScale(briArr[idx], p);
      if (sf <= 0.01) continue;

      const stateColor = p.stateColors[state];
      const shapeType  = stateShapes[state];

      push();
      translate(x * cellW + cellW / 2, y * cellH + cellH / 2);
      if (p.snapRot) rotate(rot);
      scale(sf);

      if (svgImages[state]) {
        if (p.doFill) tint(stateColor); else noTint();
        imageMode(CENTER);
        image(svgImages[state], 0, 0, cellSize, cellSize);
      } else {
        if (p.doFill) fill(stateColor); else fill(150);
        noStroke();
        drawShape(shapeType, cellSize);
      }
      pop();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SHAPE DRAWING (P5)
// ─────────────────────────────────────────────────────────────────────────────
function drawShape(type, size) {
  const h = size * 0.866;
  const t = size * 0.28;
  switch (type) {
    case 'circle':
      ellipse(0, 0, size, size);
      break;
    case 'square':
      rectMode(CENTER);
      rect(0, 0, size, size);
      break;
    case 'diamond':
      beginShape();
      vertex(0, -size / 2);
      vertex(size / 2, 0);
      vertex(0,  size / 2);
      vertex(-size / 2, 0);
      endShape(CLOSE);
      break;
    case 'cross':
      rectMode(CENTER);
      rect(0, 0, size, t);
      rect(0, 0, t, size);
      break;
    case 'ring':
      noFill();
      stroke(p5.instance ? p5.instance._renderer.fillColor() : '#fff');
      strokeWeight(size * 0.18);
      ellipse(0, 0, size * 0.72, size * 0.72);
      noStroke();
      break;
    case 'triangle':
      triangle(0, -h / 2, size / 2, h / 2, -size / 2, h / 2);
      break;
    case 'dot':
      ellipse(0, 0, size * 0.5, size * 0.5);
      break;
    default:
      ellipse(0, 0, size, size);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SVG SHAPE GENERATOR
// ─────────────────────────────────────────────────────────────────────────────
function svgShapeEl(type, cx, cy, size, color) {
  const h = size * 0.866;
  const t = size * 0.28;
  switch (type) {
    case 'circle':
      return `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(size/2)}" fill="${color}"/>`;
    case 'square':
      return `<rect x="${f(cx-size/2)}" y="${f(cy-size/2)}" width="${f(size)}" height="${f(size)}" fill="${color}"/>`;
    case 'diamond':
      return `<polygon points="${f(cx)},${f(cy-size/2)} ${f(cx+size/2)},${f(cy)} ${f(cx)},${f(cy+size/2)} ${f(cx-size/2)},${f(cy)}" fill="${color}"/>`;
    case 'cross':
      return `<rect x="${f(cx-size/2)}" y="${f(cy-t/2)}" width="${f(size)}" height="${f(t)}" fill="${color}"/>`
           + `<rect x="${f(cx-t/2)}" y="${f(cy-size/2)}" width="${f(t)}" height="${f(size)}" fill="${color}"/>`;
    case 'ring':
      return `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(size*0.36)}" fill="none" stroke="${color}" stroke-width="${f(size*0.18)}"/>`;
    case 'triangle':
      return `<polygon points="${f(cx)},${f(cy-h/2)} ${f(cx+size/2)},${f(cy+h/2)} ${f(cx-size/2)},${f(cy+h/2)}" fill="${color}"/>`;
    case 'dot':
      return `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(size*0.25)}" fill="${color}"/>`;
    default:
      return `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(size/2)}" fill="${color}"/>`;
  }
}

function f(n) { return Math.round(n * 100) / 100; }

// ─────────────────────────────────────────────────────────────────────────────
// IMAGE ADJUSTMENTS
// ─────────────────────────────────────────────────────────────────────────────
function buildBrightnessArray(pixels, w, h, p) {
  const arr = new Float32Array(w * h);
  const cFactor = (259 * (p.contrast + 255)) / (255 * (259 - p.contrast));
  for (let i = 0; i < w * h; i++) {
    const pi = i * 4;
    let b = 0.299 * pixels[pi] + 0.587 * pixels[pi+1] + 0.114 * pixels[pi+2];
    b += (p.brightness / 100) * 128;
    b = cFactor * (b - 128) + 128;
    b = 255 * Math.pow(Math.max(0, b) / 255, 1 / p.gamma);
    arr[i] = Math.max(0, Math.min(255, b));
  }
  return arr;
}

// ─────────────────────────────────────────────────────────────────────────────
// DITHERING ALGORITHMS
// ─────────────────────────────────────────────────────────────────────────────
function runDither(briArr, w, h, numStates, p) {
  const pre = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let b = ((briArr[i] - 128) * p.mapIntensity) + 128;
    b = Math.max(0, Math.min(255, b));
    if (p.invert) b = 255 - b;
    pre[i] = b;
  }

  const out = new Int32Array(w * h);
  const algo = p.algo;

  if (algo === 'threshold') {
    for (let i = 0; i < w * h; i++) {
      out[i] = brightnessToState(pre[i], numStates);
    }

  } else if (algo.startsWith('ordered')) {
    const n = parseInt(algo.replace('ordered', ''));
    const mat = BAYER[n];
    const maxM = n * n;
    const spread = 255 / numStates;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const noise = (mat[y % n][x % n] / maxM - 0.5) * spread;
        const b = Math.max(0, Math.min(255, pre[i] + noise));
        out[i] = brightnessToState(b, numStates);
      }
    }

  } else if (algo === 'floyd') {
    const buf = new Float32Array(pre);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const old = buf[i];
        const s = brightnessToState(old, numStates);
        out[i] = s;
        const qb = stateToMidBrightness(s, numStates);
        const err = old - qb;
        if (x + 1 < w)          buf[i + 1]     += err * 7 / 16;
        if (y + 1 < h) {
          if (x - 1 >= 0)        buf[i + w - 1] += err * 3 / 16;
                                 buf[i + w]     += err * 5 / 16;
          if (x + 1 < w)         buf[i + w + 1] += err * 1 / 16;
        }
      }
    }

  } else if (algo === 'atkinson') {
    const buf = new Float32Array(pre);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const old = buf[i];
        const s = brightnessToState(old, numStates);
        out[i] = s;
        const qb = stateToMidBrightness(s, numStates);
        const err = (old - qb) / 8;
        if (x + 1 < w)           buf[i + 1]     += err;
        if (x + 2 < w)           buf[i + 2]     += err;
        if (y + 1 < h) {
          if (x - 1 >= 0)        buf[i + w - 1] += err;
                                 buf[i + w]     += err;
          if (x + 1 < w)         buf[i + w + 1] += err;
        }
        if (y + 2 < h)           buf[i + 2*w]   += err;
      }
    }

  } else if (algo === 'sierra') {
    const buf = new Float32Array(pre);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const old = buf[i];
        const s = brightnessToState(old, numStates);
        out[i] = s;
        const qb = stateToMidBrightness(s, numStates);
        const err = old - qb;
        if (x + 1 < w)           buf[i + 1]     += err * 2 / 4;
        if (y + 1 < h) {
          if (x - 1 >= 0)        buf[i + w - 1] += err * 1 / 4;
          if (x + 1 < w)         buf[i + w + 1] += err * 1 / 4;
        }
      }
    }
  }

  return out;
}

function brightnessToState(b, numStates) {
  return Math.min(numStates - 1, Math.max(0, Math.floor((1 - b / 255) * numStates)));
}

function stateToMidBrightness(s, numStates) {
  return (1 - (s + 0.5) / numStates) * 255;
}

function brightnessToScale(b, p) {
  return p.minScale + (1 - b / 255) * (p.maxScale - p.minScale);
}

// ─────────────────────────────────────────────────────────────────────────────
// GRID / CROP HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function getTargetAspect(aspectStr, mW, mH) {
  const map = { '1x1': 1, '16x9': 16/9, '9x16': 9/16, '4x3': 4/3, '3x2': 3/2, '2x1': 2 };
  return map[aspectStr] || (mW / mH);
}

function computeGrid(mW, mH, p) {
  const tar = getTargetAspect(p.aspectRatio, mW, mH);
  const res = p.canvasRes;
  const gr  = p.gridRes;
  let outW, outH, gridCols, gridRows;
  if (tar >= 1) {
    outW = res; outH = Math.floor(res / tar);
    gridCols = gr; gridRows = Math.max(1, Math.floor(gr / tar));
  } else {
    outH = res; outW = Math.floor(res * tar);
    gridRows = gr; gridCols = Math.max(1, Math.floor(gr * tar));
  }
  return { outW, outH, gridCols: Math.max(1, gridCols), gridRows: Math.max(1, gridRows) };
}

function computeCrop(mW, mH, p) {
  const tar = getTargetAspect(p.aspectRatio, mW, mH);
  const mAspect = mW / mH;
  let srcW = mW, srcH = mH;
  if (p.aspectRatio !== 'original') {
    if (tar > mAspect) { srcW = mW; srcH = mW / tar; }
    else               { srcH = mH; srcW = mH * tar; }
  }
  const cw = srcW / p.mediaScale;
  const ch = srcH / p.mediaScale;
  return { sx: mW/2 - cw/2, sy: mH/2 - ch/2, cw, ch };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ALL PARAMS FROM DOM
// ─────────────────────────────────────────────────────────────────────────────
function getParams() {
  const v = id => document.getElementById(id);
  return {
    gridRes:      parseInt(v('gridRes').value),
    aspectRatio:  v('aspectRatio').value,
    invert:       v('invertMapping').checked,
    minScale:     parseInt(v('minScale').value) / 100,
    maxScale:     parseInt(v('maxScale').value) / 100,
    snapRot:      v('snapRot').checked,
    rotInterval:  parseInt(v('rotInterval').value),
    doFill:       v('fillSvg').checked,
    mediaScale:   parseInt(v('mediaScale').value) / 100,
    canvasRes:    parseInt(v('canvasRes').value),
    enableStateMap: v('enableStateMap').checked,
    mapIntensity: parseInt(v('mapIntensity').value) / 100,
    algo:         v('ditherAlgo').value,
    brightness:   parseInt(v('brightness').value),
    contrast:     parseInt(v('contrast').value),
    gamma:        parseInt(v('gamma').value) / 100,
    stateColors:  Array.from({ length: NUM_STATES }, (_, i) => v(`color${i}`).value),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SVG EXPORT
// ─────────────────────────────────────────────────────────────────────────────
function exportSVG() {
  if (!currentMedia || !cachedBriArr || !cachedStateArr) { alert('No media loaded or not ready.'); return; }

  const mW = currentMedia.width  || (currentMedia.elt && currentMedia.elt.videoWidth)  || 0;
  const mH = currentMedia.height || (currentMedia.elt && currentMedia.elt.videoHeight) || 0;
  if (!mW || !mH) return;

  const p = getParams();
  const { gridCols, gridRows, outW, outH } = computeGrid(mW, mH, p);
  const cellW = outW / gridCols;
  const cellH = outH / gridRows;
  const cellSize = Math.min(cellW, cellH);

  const bg = document.getElementById('bgColor').value;
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${outW} ${outH}">`,
    `<rect width="${outW}" height="${outH}" fill="${bg}"/>`,
  ];

  for (let y = 0; y < gridRows; y++) {
    for (let x = 0; x < gridCols; x++) {
      const idx   = y * gridCols + x;
      const state = p.enableStateMap ? cachedStateArr[idx] : 0;
      const sf    = brightnessToScale(cachedBriArr[idx], p);
      if (sf <= 0.01) continue;

      const cx   = x * cellW + cellW / 2;
      const cy   = y * cellH + cellH / 2;
      const sz   = cellSize * sf;
      const color = p.doFill ? p.stateColors[state] : '#999999';
      const shape = svgImages[state] ? 'circle' : stateShapes[state];

      lines.push(svgShapeEl(shape, cx, cy, sz, color));
    }
  }

  lines.push('</svg>');

  const blob = new Blob([lines.join('\n')], { type: 'image/svg+xml' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: 'dither_export.svg' });
  a.click();
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────────────────────────────────────
// VIDEO RECORDING
// ─────────────────────────────────────────────────────────────────────────────
function toggleRecording() {
  if (!isRecording) {
    const stream = document.querySelector('canvas').captureStream(30);
    let mimeType = 'video/webm'; exportExt = 'webm';
    if (MediaRecorder.isTypeSupported('video/mp4')) { mimeType = 'video/mp4'; exportExt = 'mp4'; }

    mediaRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 25_000_000 });
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: mimeType });
      const url  = URL.createObjectURL(blob);
      const a    = Object.assign(document.createElement('a'), {
        href: url, download: `dither_export.${exportExt}`, style: 'display:none'
      });
      document.body.appendChild(a); a.click(); URL.revokeObjectURL(url);
      document.body.removeChild(a);
      recordedChunks = [];
    };
    mediaRecorder.start();
    isRecording = true;
    document.getElementById('exportVid').textContent = '■ STOP & SAVE';
    document.getElementById('recStatus').style.display = 'block';

  } else {
    mediaRecorder.stop();
    isRecording = false;
    document.getElementById('exportVid').textContent = '⬤ RECORD VIDEO';
    document.getElementById('recStatus').style.display = 'none';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRESET SAVE / LOAD / RESET
// ─────────────────────────────────────────────────────────────────────────────
function savePreset() {
  const p = getParams();
  const blob = new Blob([JSON.stringify({ ...p, stateShapes: [...stateShapes] }, null, 2)],
    { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: 'dither_preset.json' }).click();
  URL.revokeObjectURL(url);
}

function loadPreset(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const p = JSON.parse(ev.target.result);
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
      const chk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v; };

      if (p.gridRes    !== undefined) set('gridRes', p.gridRes);
      if (p.aspectRatio)              set('aspectRatio', p.aspectRatio);
      if (p.mediaScale !== undefined) set('mediaScale', p.mediaScale * 100);
      if (p.canvasRes  !== undefined) set('canvasRes', p.canvasRes);
      if (p.mapIntensity !== undefined) set('mapIntensity', p.mapIntensity * 100);
      if (p.minScale   !== undefined) set('minScale', p.minScale * 100);
      if (p.maxScale   !== undefined) set('maxScale', p.maxScale * 100);
      if (p.rotInterval !== undefined) set('rotInterval', p.rotInterval);
      if (p.algo)                     set('ditherAlgo', p.algo);
      if (p.brightness !== undefined) set('brightness', p.brightness);
      if (p.contrast   !== undefined) set('contrast', p.contrast);
      if (p.gamma      !== undefined) set('gamma', Math.round(p.gamma * 100));
      if (p.bgColor)                  set('bgColor', p.bgColor);
      if (p.invert     !== undefined) chk('invertMapping', p.invert);
      if (p.enableStateMap !== undefined) chk('enableStateMap', p.enableStateMap);
      if (p.doFill     !== undefined) chk('fillSvg', p.doFill);
      if (p.snapRot    !== undefined) chk('snapRot', p.snapRot);
      if (p.stateColors) p.stateColors.forEach((c, i) => set(`color${i}`, c));
      if (p.stateShapes) {
        p.stateShapes.forEach((s, i) => { stateShapes[i] = s; set(`shape${i}`, s); });
      }
      document.querySelectorAll('input[type="range"]').forEach(el => el.dispatchEvent(new Event('input')));
      cacheValid = false;
    } catch { alert('Invalid preset file.'); }
  };
  reader.readAsText(file);
  e.target.value = '';
}

function resetAll() {
  const defaults = {
    gridRes: 50, mediaScale: 100, canvasRes: 1000, mapIntensity: 100,
    minScale: 20, maxScale: 120, rotInterval: 500,
    brightness: 0, contrast: 0, gamma: 100
  };
  Object.entries(defaults).forEach(([id, v]) => {
    const el = document.getElementById(id);
    if (el) { el.value = v; el.dispatchEvent(new Event('input')); }
  });
  document.getElementById('aspectRatio').value = 'original';
  document.getElementById('ditherAlgo').value  = 'ordered4';
  document.getElementById('bgColor').value     = '#000000';
  document.getElementById('fillSvg').checked        = true;
  document.getElementById('invertMapping').checked  = false;
  document.getElementById('enableStateMap').checked = true;
  document.getElementById('snapRot').checked        = false;

  DEFAULT_COLORS.forEach((c, i) => document.getElementById(`color${i}`).value = c);
  DEFAULT_SHAPES.forEach((s, i) => {
    stateShapes[i] = s;
    const el = document.getElementById(`shape${i}`);
    if (el) el.value = s;
  });
  cacheValid = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM BUILDERS & LISTENERS
// ─────────────────────────────────────────────────────────────────────────────
function buildStateUI() {
  const container = document.getElementById('stateList');
  for (let i = 0; i < NUM_STATES; i++) {
    const div = document.createElement('div');
    div.className = 'state-item';
    div.innerHTML = `
      <input type="color" id="color${i}" value="${DEFAULT_COLORS[i]}" class="state-color">
      <div class="state-meta">
        <div class="state-name">${STATE_LABELS[i]}</div>
        <select class="shape-select" id="shape${i}">
          ${SHAPES.map(s => `<option value="${s}">${s.toUpperCase()}</option>`).join('')}
        </select>
      </div>
      <div class="state-actions">
        <label class="svg-btn" id="svgLabel${i}" for="svg${i}">SVG</label>
        <input type="file" id="svg${i}" accept=".svg">
        <button class="rst-btn" id="reset${i}">×</button>
      </div>
    `;
    container.appendChild(div);

    document.getElementById(`shape${i}`).addEventListener('change', e => {
      stateShapes[i] = e.target.value;
      cacheValid = false;
    });
    document.getElementById(`svg${i}`).addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      loadImage(URL.createObjectURL(file), img => {
        svgImages[i] = img;
        document.getElementById(`svgLabel${i}`).classList.add('has-svg');
        cacheValid = false;
      });
    });
    document.getElementById(`reset${i}`).addEventListener('click', () => {
      document.getElementById(`svg${i}`).value = '';
      svgImages[i] = null;
      document.getElementById(`svgLabel${i}`).classList.remove('has-svg');
      cacheValid = false;
    });
  }
}

function setupSectionToggles() {
  document.querySelectorAll('.section-header').forEach(header => {
    const body = document.getElementById(header.dataset.toggle);
    header.classList.add('open');
    header.addEventListener('click', () => {
      const isOpen = header.classList.toggle('open');
      body.classList.toggle('hidden', !isOpen);
    });
  });
}

function setupSliders() {
  const defs = [
    ['mediaScale',   'val-mediaScale',   v => v + '%'],
    ['canvasRes',    'val-canvasRes',     v => v + 'px'],
    ['gridRes',      'val-gridRes',       v => v],
    ['mapIntensity', 'val-mapIntensity',  v => v + '%'],
    ['minScale',     'val-minScale',      v => v + '%'],
    ['maxScale',     'val-maxScale',      v => v + '%'],
    ['rotInterval',  'val-rotInterval',   v => v + 'ms'],
    ['brightness',   'val-brightness',    v => (v > 0 ? '+' : '') + v],
    ['contrast',     'val-contrast',      v => (v > 0 ? '+' : '') + v],
    ['gamma',        'val-gamma',         v => (v / 100).toFixed(1)],
  ];
  defs.forEach(([id, valId, fmt]) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => {
      document.getElementById(valId).textContent = fmt(el.value);
      cacheValid = false;
    });
  });
}

function setupMediaListeners() {
  document.getElementById('webcamBtn').addEventListener('click', () => {
    cleanupMedia();
    const cap = createCapture(VIDEO, () => {
      currentMedia = cap; isWebcam = true;
      document.getElementById('webcamBtn').style.display = 'none';
      document.getElementById('stopWebcamBtn').style.display = '';
      cacheValid = false;
    });
    cap.hide();
  });

  document.getElementById('stopWebcamBtn').addEventListener('click', () => {
    cleanupMedia();
    document.getElementById('webcamBtn').style.display = '';
    document.getElementById('stopWebcamBtn').style.display = 'none';
  });

  document.getElementById('mediaUpload').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    cleanupMedia();
    const url = URL.createObjectURL(file);
    const info = document.getElementById('mediaInfo');
    info.style.display = 'block';
    info.textContent = `${file.name}  ·  ${(file.size / 1024 / 1024).toFixed(1)} MB`;

    if (file.type.startsWith('video/')) {
      const vid = createVideo(url, () => {
        vid.loop(); vid.volume(0); vid.hide();
        currentVideo = vid; currentMedia = vid;
        cacheValid = false;
      });
    } else {
      loadImage(url, img => { currentMedia = img; cacheValid = false; });
    }
  });
}

function setupExportListeners() {
  document.getElementById('exportPng').addEventListener('click', () => saveCanvas('dither_export', 'png'));
  document.getElementById('exportSvg').addEventListener('click', exportSVG);
  document.getElementById('exportVid').addEventListener('click', toggleRecording);
}

function setupPresetListeners() {
  document.getElementById('savePresetBtn').addEventListener('click', savePreset);
  document.getElementById('loadPresetInput').addEventListener('change', loadPreset);
  document.getElementById('resetAllBtn').addEventListener('click', resetAll);
}

function cleanupMedia() {
  if (currentVideo) { currentVideo.pause(); currentVideo.remove(); currentVideo = null; }
  currentMedia = null; isWebcam = false;
  cacheValid = false;
}
