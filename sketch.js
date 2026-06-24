// ─── GLOBALS ──────────────────────────────────────────────────────────────────
let currentMedia = null;
let currentVideo = null;
let isWebcam = false;
let svgs = [null, null, null, null, null, null, null];
let stateShapes = ['circle','circle','circle','circle','circle','circle','circle'];
let pg;

const SHAPES = ['circle','square','diamond','cross','ring','triangle','dot'];
const STATE_LABELS = ['1 (High)','2 (Lt Mid)','3 (Mid Hi)','4 (Mid)','5 (Mid Lo)','6 (Dk Mid)','7 (Shadow)'];

// ─── BAYER MATRICES ───────────────────────────────────────────────────────────
const BAYER = {
  2: [[0, 2], [3, 1]],
  4: [
    [ 0,  8,  2, 10], [12,  4, 14,  6],
    [ 3, 11,  1,  9], [15,  7, 13,  5]
  ],
  8: [
    [ 0, 32,  8, 40,  2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44,  4, 36, 14, 46,  6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
    [ 3, 35, 11, 43,  1, 33,  9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47,  7, 39, 13, 45,  5, 37], [63, 31, 55, 23, 61, 29, 53, 21]
  ]
};

// ─── AUDIO ────────────────────────────────────────────────────────────────────
let audioContext = null;
let analyser = null;
let dataArray = null;
let audioSource = null;
let audioEnabled = false;
let audioFile = null;
let audioFileContext = null;

let audioData = {
  bass: 0,      // low freq (controls scale)
  mid: 0,       // mid freq (controls rotation)
  treble: 0,    // high freq (controls grid)
  overall: 0
};

// ─── CACHING ──────────────────────────────────────────────────────────────────
let lastParams = null;
let cachedBriArr = null;
let cachedStateArr = null;

// ─── RECORDING ────────────────────────────────────────────────────────────────
let isRecording = false;
let mediaRecorder;
let recordedChunks = [];
let exportExt = 'webm';

// ─────────────────────────────────────────────────────────────────────────────
function setup() {
  let canvas = createCanvas(1000, 1000);
  canvas.parent('canvas-container');
  pixelDensity(1);
  frameRate(30);
  pg = createGraphics(150, 150);
  pg.pixelDensity(1);

  setupDOMListeners();
  buildShapeUI();
}

// ─────────────────────────────────────────────────────────────────────────────
function draw() {
  let bgColor = document.getElementById('bgColor').value;
  background(bgColor);

  let mWidth = currentMedia ? (currentMedia.width || (currentMedia.elt && currentMedia.elt.videoWidth)) : 0;
  let mHeight = currentMedia ? (currentMedia.height || (currentMedia.elt && currentMedia.elt.videoHeight)) : 0;

  if (!currentMedia || !mWidth || !mHeight) {
    fill(50); noStroke(); textAlign(CENTER, CENTER); textSize(width * 0.03);
    text("LOAD MEDIA TO BEGIN", width / 2, height / 2);
    return;
  }

  let p = getParams();
  let aspect = getTargetAspect(p.aspectRatio, mWidth, mHeight);
  let mAspect = mWidth / mHeight;

  let outW, outH, gridCols, gridRows;
  if (aspect >= 1) {
    outW = p.canvasRes; outH = Math.floor(p.canvasRes / aspect);
    gridCols = p.gridRes; gridRows = Math.max(1, Math.floor(p.gridRes / aspect));
  } else {
    outH = p.canvasRes; outW = Math.floor(p.canvasRes * aspect);
    gridRows = p.gridRes; gridCols = Math.max(1, Math.floor(p.gridRes * aspect));
  }

  if (width !== outW || height !== outH) resizeCanvas(outW, outH);

  let cx = mWidth / 2, cy = mHeight / 2;
  let sourceW = (p.aspectRatio === '1x1') ? Math.min(mWidth, mHeight) : mWidth;
  let sourceH = (p.aspectRatio === '1x1') ? Math.min(mWidth, mHeight) : mHeight;
  let cropW = sourceW / p.mediaScale, cropH = sourceH / p.mediaScale;
  let sx = cx - (cropW / 2), sy = cy - (cropH / 2);

  pg.resizeCanvas(gridCols, gridRows);
  pg.clear();
  pg.image(currentMedia, 0, 0, gridCols, gridRows, sx, sy, cropW, cropH);
  pg.loadPixels();

  let paramsStr = JSON.stringify(p);
  if (paramsStr !== lastParams) {
    cachedBriArr = buildBrightnessArray(pg.pixels, gridCols, gridRows, p);
    cachedStateArr = runDither(cachedBriArr, gridCols, gridRows, p.enableStateMap ? 7 : 1, p);
    lastParams = paramsStr;
  }

  if (cachedBriArr && cachedStateArr) {
    renderCells(cachedBriArr, cachedStateArr, gridCols, gridRows, p, outW, outH);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
function renderCells(briArr, stateArr, gridCols, gridRows, p, outW, outH) {
  let cellW = outW / gridCols, cellH = outH / gridRows;
  let drawSize = Math.min(cellW, cellH);

  // Audio modulation
  let audioScale = audioEnabled ? (1 + audioData.bass * 0.5) : 1;
  let audioRot = audioEnabled ? (audioData.mid * Math.PI * 2) : 0;

  noStroke();
  for (let y = 0; y < gridRows; y++) {
    for (let x = 0; x < gridCols; x++) {
      let index = (x + y * gridCols);
      let r = pg.pixels[index * 4];
      let g = pg.pixels[index * 4 + 1];
      let b = pg.pixels[index * 4 + 2];
      let a = pg.pixels[index * 4 + 3];

      if (a === 0) continue;

      let brightness = (0.299 * r) + (0.587 * g) + (0.114 * b);
      brightness = ((brightness - 128) * p.mapIntensity) + 128;
      brightness = constrain(brightness, 0, 255);
      if (p.invertMapping) brightness = 255 - brightness;

      let state = p.enableStateMap ? Math.floor(map(brightness, 255, 0, 0, 6.99)) : 6;
      state = constrain(state, 0, 6);

      let midtoneDist = Math.abs(brightness - 128);
      let scaleFactor = map(midtoneDist, 0, 128, p.minScale, p.maxScale) * audioScale;

      if (scaleFactor <= 0.015) continue;

      let currentRot = 0;
      if (p.snapRot) {
        let step = Math.floor(millis() / p.rotInterval);
        currentRot = (step % 4) * HALF_PI;
      }
      currentRot += audioRot;

      let activeColor = document.getElementById(`color${state}`).value;
      if (p.fillSvg) tint(activeColor); else noTint();

      push();
      translate(x * cellW + cellW / 2, y * cellH + cellH / 2);
      rotate(currentRot);
      scale(scaleFactor);
      drawingContext.globalAlpha = a / 255.0;
      imageMode(CENTER);

      if (svgs[state]) {
        image(svgs[state], 0, 0, drawSize, drawSize);
      } else {
        fill(p.fillSvg ? activeColor : 150);
        noStroke();
        rectMode(CENTER);

        let shapeType = stateShapes[state];
        drawShape(shapeType, drawSize);
      }
      pop();
    }
  }
}

function drawShape(type, size) {
  switch (type) {
    case 'circle':
      ellipse(0, 0, size, size);
      break;
    case 'square':
      rect(0, 0, size, size);
      break;
    case 'diamond':
      beginShape();
      vertex(0, -size / 2);
      vertex(size / 2, 0);
      vertex(0, size / 2);
      vertex(-size / 2, 0);
      endShape(CLOSE);
      break;
    case 'cross':
      rect(0, 0, size, size * 0.28);
      rect(0, 0, size * 0.28, size);
      break;
    case 'ring':
      noFill();
      stroke(fill);
      strokeWeight(size * 0.18);
      ellipse(0, 0, size * 0.72);
      noStroke();
      break;
    case 'triangle':
      triangle(0, -size / 2, size / 2, size / 2, -size / 2, size / 2);
      break;
    case 'dot':
      ellipse(0, 0, size * 0.5);
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IMAGE ADJUSTMENTS
// ─────────────────────────────────────────────────────────────────────────────
function buildBrightnessArray(pixels, w, h, p) {
  let arr = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let pi = i * 4;
    let b = 0.299 * pixels[pi] + 0.587 * pixels[pi+1] + 0.114 * pixels[pi+2];
    arr[i] = constrain(b, 0, 255);
  }
  return arr;
}

// ─────────────────────────────────────────────────────────────────────────────
// DITHERING
// ─────────────────────────────────────────────────────────────────────────────
function runDither(briArr, w, h, numStates, p) {
  let pre = new Float32Array(briArr);
  for (let i = 0; i < w * h; i++) {
    let b = ((pre[i] - 128) * p.mapIntensity) + 128;
    b = constrain(b, 0, 255);
    if (p.invertMapping) b = 255 - b;
    pre[i] = b;
  }

  let out = new Int32Array(w * h);
  let algo = p.algo;

  if (algo === 'threshold') {
    for (let i = 0; i < w * h; i++) {
      out[i] = Math.min(numStates - 1, Math.max(0, Math.floor((1 - pre[i] / 255) * numStates)));
    }
  } else if (algo.startsWith('ordered')) {
    let n = parseInt(algo.replace('ordered', ''));
    let mat = BAYER[n];
    let maxM = n * n;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let i = y * w + x;
        let noise = (mat[y % n][x % n] / maxM - 0.5) * 255 / numStates;
        let b = constrain(pre[i] + noise, 0, 255);
        out[i] = Math.min(numStates - 1, Math.max(0, Math.floor((1 - b / 255) * numStates)));
      }
    }
  } else if (algo === 'floyd') {
    let buf = new Float32Array(pre);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let i = y * w + x;
        let old = buf[i];
        let s = Math.min(numStates - 1, Math.max(0, Math.floor((1 - old / 255) * numStates)));
        out[i] = s;
        let qb = (1 - (s + 0.5) / numStates) * 255;
        let err = old - qb;
        if (x + 1 < w) buf[i + 1] += err * 7 / 16;
        if (y + 1 < h) {
          if (x - 1 >= 0) buf[i + w - 1] += err * 3 / 16;
          buf[i + w] += err * 5 / 16;
          if (x + 1 < w) buf[i + w + 1] += err * 1 / 16;
        }
      }
    }
  } else if (algo === 'atkinson') {
    let buf = new Float32Array(pre);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let i = y * w + x;
        let old = buf[i];
        let s = Math.min(numStates - 1, Math.max(0, Math.floor((1 - old / 255) * numStates)));
        out[i] = s;
        let qb = (1 - (s + 0.5) / numStates) * 255;
        let err = (old - qb) / 8;
        if (x + 1 < w) buf[i + 1] += err;
        if (x + 2 < w) buf[i + 2] += err;
        if (y + 1 < h) {
          if (x - 1 >= 0) buf[i + w - 1] += err;
          buf[i + w] += err;
          if (x + 1 < w) buf[i + w + 1] += err;
        }
        if (y + 2 < h) buf[i + 2*w] += err;
      }
    }
  } else if (algo === 'sierra') {
    let buf = new Float32Array(pre);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let i = y * w + x;
        let old = buf[i];
        let s = Math.min(numStates - 1, Math.max(0, Math.floor((1 - old / 255) * numStates)));
        out[i] = s;
        let qb = (1 - (s + 0.5) / numStates) * 255;
        let err = old - qb;
        if (x + 1 < w) buf[i + 1] += err * 2 / 4;
        if (y + 1 < h) {
          if (x - 1 >= 0) buf[i + w - 1] += err * 1 / 4;
          if (x + 1 < w) buf[i + w + 1] += err * 1 / 4;
        }
      }
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function getTargetAspect(aspectStr, mW, mH) {
  let map = { '1x1': 1, '16x9': 16/9, '9x16': 9/16, '4x3': 4/3 };
  return map[aspectStr] || (mW / mH);
}

function getParams() {
  return {
    aspectRatio: document.getElementById('aspectRatio').value,
    mediaScale: parseInt(document.getElementById('mediaScale').value) / 100,
    canvasRes: parseInt(document.getElementById('canvasRes').value),
    gridRes: parseInt(document.getElementById('gridRes').value),
    ditherAlgo: document.getElementById('ditherAlgo').value,
    bgColor: document.getElementById('bgColor').value,
    fillSvg: document.getElementById('fillSvg').checked,
    invertMapping: document.getElementById('invertMapping').checked,
    enableStateMap: document.getElementById('enableStateMap').checked,
    mapIntensity: parseInt(document.getElementById('mapIntensity').value) / 100,
    minScale: parseInt(document.getElementById('minScale').value) / 100,
    maxScale: parseInt(document.getElementById('maxScale').value) / 100,
    snapRot: document.getElementById('snapRot').checked,
    rotInterval: parseInt(document.getElementById('rotInterval').value),
    algo: document.getElementById('ditherAlgo').value
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SVG EXPORT
// ─────────────────────────────────────────────────────────────────────────────
function exportSVG() {
  if (!currentMedia || !cachedBriArr || !cachedStateArr) { alert('No media ready'); return; }

  let mW = currentMedia.width || (currentMedia.elt && currentMedia.elt.videoWidth) || 0;
  let mH = currentMedia.height || (currentMedia.elt && currentMedia.elt.videoHeight) || 0;
  if (!mW || !mH) return;

  let p = getParams();
  let aspect = getTargetAspect(p.aspectRatio, mW, mH);
  let outW = p.canvasRes, outH = Math.floor(p.canvasRes / aspect);
  let gridCols = p.gridRes, gridRows = Math.max(1, Math.floor(p.gridRes / aspect));
  let cellW = outW / gridCols, cellH = outH / gridRows;
  let drawSize = Math.min(cellW, cellH);

  let bg = document.getElementById('bgColor').value;
  let svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${outW} ${outH}">\n<rect width="${outW}" height="${outH}" fill="${bg}"/>\n`;

  for (let y = 0; y < gridRows; y++) {
    for (let x = 0; x < gridCols; x++) {
      let idx = y * gridCols + x;
      let state = p.enableStateMap ? cachedStateArr[idx] : 6;
      let brightness = cachedBriArr[idx];
      let midtoneDist = Math.abs(brightness - 128);
      let sf = map(midtoneDist, 0, 128, p.minScale, p.maxScale);
      if (sf <= 0.01) continue;

      let cx = x * cellW + cellW / 2, cy = y * cellH + cellH / 2;
      let sz = drawSize * sf;
      let color = document.getElementById(`color${state}`).value;
      let shape = stateShapes[state];

      svg += svgShape(shape, cx, cy, sz, color) + '\n';
    }
  }

  svg += '</svg>';

  let blob = new Blob([svg], { type: 'image/svg+xml' });
  let url = URL.createObjectURL(blob);
  let a = document.createElement('a');
  a.href = url;
  a.download = 'dither_export.svg';
  a.click();
  URL.revokeObjectURL(url);
}

function svgShape(type, cx, cy, size, color) {
  let h = size * 0.866, t = size * 0.28;
  switch (type) {
    case 'circle': return `<circle cx="${cx}" cy="${cy}" r="${size/2}" fill="${color}"/>`;
    case 'square': return `<rect x="${cx-size/2}" y="${cy-size/2}" width="${size}" height="${size}" fill="${color}"/>`;
    case 'diamond': return `<polygon points="${cx},${cy-size/2} ${cx+size/2},${cy} ${cx},${cy+size/2} ${cx-size/2},${cy}" fill="${color}"/>`;
    case 'cross': return `<rect x="${cx-size/2}" y="${cy-t/2}" width="${size}" height="${t}" fill="${color}"/><rect x="${cx-t/2}" y="${cy-size/2}" width="${t}" height="${size}" fill="${color}"/>`;
    case 'ring': return `<circle cx="${cx}" cy="${cy}" r="${size*0.36}" fill="none" stroke="${color}" stroke-width="${size*0.18}"/>`;
    case 'triangle': return `<polygon points="${cx},${cy-h/2} ${cx+size/2},${cy+h/2} ${cx-size/2},${cy+h/2}" fill="${color}"/>`;
    case 'dot': return `<circle cx="${cx}" cy="${cy}" r="${size*0.25}" fill="${color}"/>`;
    default: return `<circle cx="${cx}" cy="${cy}" r="${size/2}" fill="${color}"/>`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIO
// ─────────────────────────────────────────────────────────────────────────────
async function startMicrophone() {
  try {
    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    let stream = await navigator.mediaDevices.getUserUserMedia({ audio: true });
    audioSource = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    audioSource.connect(analyser);
    dataArray = new Uint8Array(analyser.frequencyBinCount);
    audioEnabled = true;
    document.getElementById('micBtn').textContent = '⏹ STOP MICROPHONE';
    animateAudio();
  } catch (e) {
    alert('Microphone access denied');
  }
}

function stopMicrophone() {
  if (audioSource) {
    audioSource.disconnect();
    audioSource = null;
  }
  audioEnabled = false;
  document.getElementById('micBtn').textContent = '🎤 START MICROPHONE';
}

function loadAudioFile(file) {
  let reader = new FileReader();
  reader.onload = e => {
    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    audioContext.decodeAudioData(e.target.result, buffer => {
      audioFileContext = audioContext.createBufferSource();
      audioFileContext.buffer = buffer;
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      audioFileContext.connect(analyser);
      analyser.connect(audioContext.destination);
      audioFileContext.start(0);
      dataArray = new Uint8Array(analyser.frequencyBinCount);
      audioEnabled = true;
      animateAudio();
    });
  };
  reader.readAsArrayBuffer(file);
}

function animateAudio() {
  if (!audioEnabled || !analyser) return;

  analyser.getByteFrequencyData(dataArray);

  let bassSum = 0, midSum = 0, trebleSum = 0;
  let bassCount = Math.floor(dataArray.length * 0.1);
  let midStart = bassCount, midEnd = Math.floor(dataArray.length * 0.6);
  let trebleStart = midEnd;

  for (let i = 0; i < bassCount; i++) bassSum += dataArray[i];
  for (let i = midStart; i < midEnd; i++) midSum += dataArray[i];
  for (let i = trebleStart; i < dataArray.length; i++) trebleSum += dataArray[i];

  let sens = parseInt(document.getElementById('audioSensitivity').value) / 100;
  audioData.bass = (bassSum / bassCount / 255) * sens;
  audioData.mid = (midSum / (midEnd - midStart) / 255) * sens;
  audioData.treble = (trebleSum / (dataArray.length - trebleStart) / 255) * sens;
  audioData.overall = (audioData.bass + audioData.mid + audioData.treble) / 3;

  requestAnimationFrame(animateAudio);
}

// ─────────────────────────────────────────────────────────────────────────────
// PRESETS
// ─────────────────────────────────────────────────────────────────────────────
function savePreset() {
  let preset = {
    aspectRatio: document.getElementById('aspectRatio').value,
    mediaScale: document.getElementById('mediaScale').value,
    canvasRes: document.getElementById('canvasRes').value,
    gridRes: document.getElementById('gridRes').value,
    ditherAlgo: document.getElementById('ditherAlgo').value,
    bgColor: document.getElementById('bgColor').value,
    fillSvg: document.getElementById('fillSvg').checked,
    invertMapping: document.getElementById('invertMapping').checked,
    enableStateMap: document.getElementById('enableStateMap').checked,
    mapIntensity: document.getElementById('mapIntensity').value,
    minScale: document.getElementById('minScale').value,
    maxScale: document.getElementById('maxScale').value,
    snapRot: document.getElementById('snapRot').checked,
    rotInterval: document.getElementById('rotInterval').value,
    stateShapes: stateShapes.slice(),
    colors: Array.from({ length: 7 }, (_, i) => document.getElementById(`color${i}`).value)
  };

  let blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
  let url = URL.createObjectURL(blob);
  let a = document.createElement('a');
  a.href = url;
  a.download = 'dither_preset.json';
  a.click();
  URL.revokeObjectURL(url);
}

function loadPreset(e) {
  let file = e.target.files[0];
  if (!file) return;
  let reader = new FileReader();
  reader.onload = ev => {
    try {
      let preset = JSON.parse(ev.target.result);
      if (preset.aspectRatio) document.getElementById('aspectRatio').value = preset.aspectRatio;
      if (preset.mediaScale) document.getElementById('mediaScale').value = preset.mediaScale;
      if (preset.canvasRes) document.getElementById('canvasRes').value = preset.canvasRes;
      if (preset.gridRes) document.getElementById('gridRes').value = preset.gridRes;
      if (preset.ditherAlgo) document.getElementById('ditherAlgo').value = preset.ditherAlgo;
      if (preset.bgColor) document.getElementById('bgColor').value = preset.bgColor;
      if (preset.fillSvg !== undefined) document.getElementById('fillSvg').checked = preset.fillSvg;
      if (preset.invertMapping !== undefined) document.getElementById('invertMapping').checked = preset.invertMapping;
      if (preset.enableStateMap !== undefined) document.getElementById('enableStateMap').checked = preset.enableStateMap;
      if (preset.mapIntensity) document.getElementById('mapIntensity').value = preset.mapIntensity;
      if (preset.minScale) document.getElementById('minScale').value = preset.minScale;
      if (preset.maxScale) document.getElementById('maxScale').value = preset.maxScale;
      if (preset.snapRot !== undefined) document.getElementById('snapRot').checked = preset.snapRot;
      if (preset.rotInterval) document.getElementById('rotInterval').value = preset.rotInterval;
      if (preset.stateShapes) preset.stateShapes.forEach((s, i) => { stateShapes[i] = s; if (document.getElementById(`shape${i}`)) document.getElementById(`shape${i}`).value = s; });
      if (preset.colors) preset.colors.forEach((c, i) => document.getElementById(`color${i}`).value = c);
      lastParams = null;
    } catch { alert('Invalid preset'); }
  };
  reader.readAsText(file);
  e.target.value = '';
}

function resetAll() {
  document.getElementById('aspectRatio').value = 'original';
  document.getElementById('mediaScale').value = 100;
  document.getElementById('canvasRes').value = 1000;
  document.getElementById('gridRes').value = 50;
  document.getElementById('ditherAlgo').value = 'ordered4';
  document.getElementById('bgColor').value = '#000000';
  document.getElementById('fillSvg').checked = true;
  document.getElementById('invertMapping').checked = false;
  document.getElementById('enableStateMap').checked = true;
  document.getElementById('mapIntensity').value = 100;
  document.getElementById('minScale').value = 50;
  document.getElementById('maxScale').value = 150;
  document.getElementById('snapRot').checked = true;
  document.getElementById('rotInterval').value = 500;

  let colors = ['#ffffff','#cccccc','#999999','#777777','#555555','#333333','#111111'];
  colors.forEach((c, i) => document.getElementById(`color${i}`).value = c);
  stateShapes.forEach((_, i) => { stateShapes[i] = 'circle'; if (document.getElementById(`shape${i}`)) document.getElementById(`shape${i}`).value = 'circle'; });

  lastParams = null;
  updateAllLabels();
}

function updateAllLabels() {
  document.getElementById('val-mediaScale').innerText = document.getElementById('mediaScale').value + '%';
  document.getElementById('val-canvasRes').innerText = document.getElementById('canvasRes').value + 'px';
  document.getElementById('val-gridRes').innerText = document.getElementById('gridRes').value;
  document.getElementById('val-mapIntensity').innerText = document.getElementById('mapIntensity').value + '%';
  document.getElementById('val-minScale').innerText = document.getElementById('minScale').value + '%';
  document.getElementById('val-maxScale').innerText = document.getElementById('maxScale').value + '%';
  document.getElementById('val-rotInterval').innerText = document.getElementById('rotInterval').value + 'ms';
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM
// ─────────────────────────────────────────────────────────────────────────────
function buildShapeUI() {
  for (let i = 0; i < 7; i++) {
    let select = document.createElement('select');
    select.id = `shape${i}`;
    select.className = 'shape-select';
    SHAPES.forEach(s => {
      let opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s.toUpperCase();
      if (s === 'circle') opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', e => { stateShapes[i] = e.target.value; lastParams = null; });

    let svg = document.getElementById(`svg${i}`);
    svg.addEventListener('change', e => {
      let file = e.target.files[0];
      if (!file) return;
      loadImage(URL.createObjectURL(file), img => { svgs[i] = img; });
    });
  }
}

function setupDOMListeners() {
  // Media
  document.getElementById('webcamBtn').addEventListener('click', () => {
    if (isWebcam) {
      currentVideo && currentVideo.remove();
      isWebcam = false;
      currentMedia = null;
      document.getElementById('webcamBtn').innerText = 'Start Webcam';
    } else {
      let cap = createCapture(VIDEO, () => { currentMedia = cap; isWebcam = true; document.getElementById('webcamBtn').innerText = 'Stop Webcam'; });
      cap.hide();
    }
  });

  document.getElementById('mediaUpload').addEventListener('change', e => {
    let file = e.target.files[0];
    if (!file) return;
    let url = URL.createObjectURL(file);
    if (file.type.startsWith('video/')) {
      let vid = createVideo(url, () => { vid.loop(); vid.volume(0); vid.hide(); currentMedia = vid; });
    } else {
      loadImage(url, img => { currentMedia = img; });
    }
  });

  // SVG / Reset buttons
  for (let i = 0; i < 7; i++) {
    document.getElementById(`reset${i}`).addEventListener('click', () => {
      document.getElementById(`svg${i}`).value = '';
      svgs[i] = null;
    });
  }

  // Audio
  document.getElementById('enableAudio').addEventListener('change', e => {
    document.getElementById('audioControls').style.display = e.target.checked ? 'block' : 'none';
  });

  document.getElementById('micBtn').addEventListener('click', () => {
    if (audioEnabled) stopMicrophone();
    else startMicrophone();
  });

  document.getElementById('audioUpload').addEventListener('change', e => {
    if (e.target.files[0]) loadAudioFile(e.target.files[0]);
  });

  // Presets
  document.getElementById('savePresetBtn').addEventListener('click', savePreset);
  document.getElementById('loadPresetInput').addEventListener('change', loadPreset);
  document.getElementById('resetAllBtn').addEventListener('click', resetAll);

  // Export
  document.getElementById('exportPng').addEventListener('click', () => saveCanvas('dither_export', 'png'));
  document.getElementById('exportSvg').addEventListener('click', exportSVG);

  document.getElementById('exportVid').addEventListener('click', () => {
    if (!isRecording) {
      let stream = document.querySelector('canvas').captureStream(30);
      let mimeType = 'video/webm';
      exportExt = 'webm';
      if (MediaRecorder.isTypeSupported('video/mp4')) { mimeType = 'video/mp4'; exportExt = 'mp4'; }

      mediaRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 20000000 });
      mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
      mediaRecorder.onstop = () => {
        let blob = new Blob(recordedChunks, { type: mimeType });
        let url = URL.createObjectURL(blob);
        let a = document.createElement('a');
        a.href = url;
        a.download = `dither_export.${exportExt}`;
        a.click();
        URL.revokeObjectURL(url);
        recordedChunks = [];
      };
      mediaRecorder.start();
      isRecording = true;
      document.getElementById('exportVid').innerText = 'Stop & Save Video';
      document.getElementById('exportVid').style.backgroundColor = '#aa2a2a';
      document.getElementById('recStatus').style.display = 'block';
    } else {
      mediaRecorder.stop();
      isRecording = false;
      document.getElementById('exportVid').innerText = 'Record Video (.mp4 / .webm)';
      document.getElementById('exportVid').style.backgroundColor = '#5a2a2a';
      document.getElementById('recStatus').style.display = 'none';
    }
  });

  // Sliders
  ['mediaScale', 'canvasRes', 'gridRes', 'mapIntensity', 'minScale', 'maxScale', 'rotInterval', 'audioSensitivity'].forEach(id => {
    let el = document.getElementById(id);
    if (el) el.addEventListener('input', () => { lastParams = null; updateAllLabels(); });
  });

  ['ditherAlgo', 'aspectRatio'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => { lastParams = null; });
  });

  ['fillSvg', 'invertMapping', 'enableStateMap', 'snapRot'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => { lastParams = null; });
  });

  document.querySelectorAll('input[type="color"]').forEach(el => {
    el.addEventListener('change', () => { lastParams = null; });
  });

  buildShapeUI();
  updateAllLabels();
}
