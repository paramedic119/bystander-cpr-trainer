// --- デバッグログ ---
const log = (msg) => console.log(`[DEBUG] ${msg}`);
log("main.js initialized (Enhanced Rhythm Logic)");

// --- 定数 ---
const MEASURE_DURATION = 15;
const TARGET_BPM_MIN = 98; // 許容範囲を少し広げる (100 -> 98)
const TARGET_BPM_MAX = 122; // 許容範囲を少し広げる (120 -> 122)
const METRONOME_BPM = 105;
const VERTICAL_ANGLE_THRESHOLD = 15;
const MIN_PEAK_INTERVAL = 300; // 300ms(200BPM)以下の動きはノイズとして無視

// --- 状態管理 ---
let currentState = 'intro';
let isMeasuring = false;
let isUploadedVideo = false;
let currentFacingMode = 'user';
let startTime = 0;
let results_history = [];
let bpm_list = [];
let last_peak_time = 0;
let last_y = 0;
let y_direction = 0;

// Web Audio API & Scheduler
let audioCtx = null;
let nextNoteTime = 0.0;
const scheduleAheadTime = 0.1;
let timerID = null;

// --- DOM要素 ---
const screens = {
  intro: document.getElementById('screen-intro'),
  guide: document.getElementById('screen-guide'),
  measure: document.getElementById('screen-measure'),
  result: document.getElementById('screen-result'),
};

const videoElement = document.getElementById('input-video');
const canvasElement = document.getElementById('output-canvas');
const canvasCtx = canvasElement ? canvasElement.getContext('2d') : null;
const timerElement = document.getElementById('timer');
const bpmDisplayElement = document.getElementById('current-bpm-display');
const countdownElement = document.getElementById('countdown');
const metronomeVisual = document.getElementById('metronome-visual');
const instructionText = document.getElementById('instruction-text');
const inputVideoFile = document.getElementById('input-video-file');

// --- 画面遷移 ---
function showScreen(screenName) {
  log(`showScreen: ${screenName}`);
  Object.keys(screens).forEach(key => {
    if (screens[key]) screens[key].classList.remove('active');
  });
  if (screens[screenName]) {
    screens[screenName].classList.add('active');
    currentState = screenName;
  }
  if (screenName === 'measure') {
    resetMeasurementUI();
    if (!isUploadedVideo) startCamera();
    else {
      videoElement.currentTime = 0;
      if (instructionText) instructionText.innerText = "動画の準備ができました。";
    }
  } else if (screenName === 'intro') {
    stopCamera();
    stopVideoFile();
    stopMeasurement();
  }
}

function resetMeasurementUI() {
  isMeasuring = false;
  results_history = [];
  bpm_list = [];
  last_y = 0;
  last_peak_time = 0;
  if (timerElement) timerElement.classList.add('hidden');
  if (bpmDisplayElement) {
    bpmDisplayElement.classList.add('hidden');
    bpmDisplayElement.innerText = "-- BPM";
  }
  if (countdownElement) countdownElement.classList.add('hidden');
  ['btn-start', 'btn-stop', 'btn-switch-camera', 'btn-back-to-intro-from-measure'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', id === 'btn-stop');
  });
}

// --- メトロノーム ---
function initAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function scheduleNote(time) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.type = 'sine'; osc.frequency.setValueAtTime(880, time);
  gain.gain.setValueAtTime(0, time);
  gain.gain.linearRampToValueAtTime(0.1, time + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.1);
  osc.start(time); osc.stop(time + 0.1);
  const delay = (time - audioCtx.currentTime) * 1000;
  setTimeout(() => { if (isMeasuring) flashMetronome(); }, Math.max(0, delay));
}

function scheduler() {
  while (nextNoteTime < audioCtx.currentTime + scheduleAheadTime) {
    scheduleNote(nextNoteTime);
    nextNoteTime += 60.0 / METRONOME_BPM;
  }
}

// --- MediaPipe Setup ---
let pose = null;
let camera = null;
let lastComplexity = -1;

function initPose(complexity) {
  if (pose && lastComplexity === complexity) return;
  const PoseClass = window.Pose || (window.mediapipe && window.mediapipe.Pose);
  if (!PoseClass) return;
  pose = new PoseClass({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}` });
  pose.setOptions({ modelComplexity: complexity, smoothLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
  pose.onResults(onResults);
  lastComplexity = complexity;
}

function startCamera() {
  initPose(0);
  const CameraClass = window.Camera || (window.mediapipe && window.mediapipe.Camera);
  if (!CameraClass) return;
  videoElement.pause(); videoElement.srcObject = null; videoElement.src = "";
  if (camera) camera.stop();
  camera = new CameraClass(videoElement, {
    onFrame: async () => { if (pose && !isUploadedVideo) await pose.send({ image: videoElement }); },
    width: 640, height: 480, facingMode: currentFacingMode
  });
  camera.start().catch(err => log(err));
}

function stopCamera() { if (camera) camera.stop(); }

async function startVideoFile(file) {
  isUploadedVideo = true; initPose(1); stopCamera();
  const url = URL.createObjectURL(file);
  videoElement.src = url;
  videoElement.onloadedmetadata = () => {
    showScreen('measure');
    if (canvasElement) { canvasElement.width = videoElement.videoWidth; canvasElement.height = videoElement.videoHeight; }
  };
  videoElement.load();
}

function stopVideoFile() { if (isUploadedVideo) { videoElement.pause(); isUploadedVideo = false; } }

function onResults(results) {
  if (!results.image) return;
  const w = results.image.width, h = results.image.height;
  if (canvasElement && w && h && (canvasElement.width !== w || canvasElement.height !== h)) {
    canvasElement.width = w; canvasElement.height = h;
  }
  if (canvasCtx) {
    canvasCtx.save(); canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);
    if (results.poseLandmarks) {
      if (window.drawConnectors && window.drawLandmarks) {
        window.drawConnectors(canvasCtx, results.poseLandmarks, [[11, 13], [13, 15], [12, 14], [14, 16], [11, 12], [11, 23], [12, 24], [23, 24]], { color: '#ffffff', lineWidth: 4 });
        window.drawLandmarks(canvasCtx, [results.poseLandmarks[11], results.poseLandmarks[12], results.poseLandmarks[13], results.poseLandmarks[14], results.poseLandmarks[15], results.poseLandmarks[16]], { color: '#4ade80', lineWidth: 2, radius: 8 });
      }
      if (isMeasuring) analyzePose(results.poseLandmarks);
    }
    canvasCtx.restore();
  }
}

function analyzePose(landmarks) {
  const elbow = landmarks[13].visibility > landmarks[14].visibility ? landmarks[13] : landmarks[14];
  const shoulder = landmarks[11].visibility > landmarks[12].visibility ? landmarks[11] : landmarks[12];
  
  const angle = Math.abs(Math.atan2(elbow.x - shoulder.x, elbow.y - shoulder.y) * 180 / Math.PI);
  const current_y = elbow.y;
  
  if (last_y !== 0) {
    const diff = current_y - last_y;
    if (diff > 0.002 && y_direction !== 1) {
      y_direction = 1;
    } else if (diff < -0.002 && y_direction !== -1) {
      y_direction = -1;
      const now = performance.now(); // Date.now() ではなく performance.now() を使用
      if (last_peak_time !== 0) {
        const interval = now - last_peak_time;
        // 300ms(200BPM)以下の極端に短い間隔は二重検知（ノイズ）として無視
        if (interval > MIN_PEAK_INTERVAL) {
          const bpm = 60000 / interval;
          if (bpm > 60 && bpm < 200) {
            bpm_list.push(bpm);
            // リアルタイム表示を更新
            if (bpmDisplayElement) {
              bpmDisplayElement.innerText = `${Math.round(bpm)} BPM`;
            }
          }
        }
      }
      last_peak_time = now;
    }
  }
  
  results_history.push({ angle, wristY: current_y, time: Date.now() });
  last_y = current_y;
}

function flashMetronome() {
  if (metronomeVisual) { metronomeVisual.classList.remove('hidden'); setTimeout(() => metronomeVisual.classList.add('hidden'), 100); }
}

async function startMeasurement() {
  initAudio(); if (audioCtx.state === 'suspended') await audioCtx.resume();
  ['btn-start', 'btn-back-to-intro-from-measure', 'btn-switch-camera'].forEach(id => document.getElementById(id)?.classList.add('hidden'));
  if (!isUploadedVideo) {
    if (countdownElement) countdownElement.classList.remove('hidden');
    for (let i = 3; i > 0; i--) { if (countdownElement) countdownElement.innerText = i; scheduleNote(audioCtx.currentTime); await new Promise(r => setTimeout(r, 1000)); }
    if (countdownElement) countdownElement.classList.add('hidden');
  }
  document.getElementById('btn-stop')?.classList.remove('hidden');
  isMeasuring = true; startTime = Date.now();
  if (timerElement) timerElement.classList.remove('hidden');
  if (bpmDisplayElement) {
    bpmDisplayElement.classList.remove('hidden');
    bpmDisplayElement.innerText = "-- BPM";
  }
  nextNoteTime = audioCtx.currentTime; timerID = setInterval(scheduler, 25.0);
  if (isUploadedVideo) {
    videoElement.currentTime = 0;
    try { await videoElement.play(); processVideoFrame(); } catch (e) { stopMeasurement(); return; }
  }
  const timerInterval = setInterval(() => {
    if (!isMeasuring) { clearInterval(timerInterval); return; }
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (isUploadedVideo) { if (videoElement.ended) { clearInterval(timerInterval); finishMeasurement(); } }
    else {
      const remaining = MEASURE_DURATION - elapsed;
      if (remaining <= 0) { clearInterval(timerInterval); finishMeasurement(); }
      if (timerElement) timerElement.innerText = `00:${Math.max(0, remaining).toString().padStart(2, '0')}`;
    }
  }, 1000);
}

async function processVideoFrame() {
  if (isUploadedVideo && !videoElement.paused && !videoElement.ended) {
    if (pose) await pose.send({ image: videoElement });
    requestAnimationFrame(processVideoFrame);
  }
}

function stopMeasurement() {
  isMeasuring = false; if (timerID) clearInterval(timerID);
  resetMeasurementUI();
}

function finishMeasurement() {
  stopMeasurement(); calculateResult(); showScreen('result');
}

function calculateResult() {
  const avgY = results_history.length > 0 ? results_history.reduce((a, b) => a + b.wristY, 0) / results_history.length : 0;
  const validAngles = results_history.filter(h => h.wristY > avgY).map(h => h.angle);
  const avgBPM = bpm_list.length > 0 ? bpm_list.reduce((a, b) => a + b, 0) / bpm_list.length : 0;
  
  // 判定基準をわずかに広げる (98 - 122)
  const isRhythmOk = avgBPM >= TARGET_BPM_MIN && avgBPM <= TARGET_BPM_MAX;
  const avgAngle = validAngles.length > 0 ? validAngles.reduce((a, b) => a + b, 0) / validAngles.length : 99;
  const isVerticalOk = avgAngle <= VERTICAL_ANGLE_THRESHOLD;
  
  const rankElement = document.querySelector('.rank'), rankTextElement = document.querySelector('.rank-text'), evalVertical = document.getElementById('eval-vertical'), evalRhythm = document.getElementById('eval-rhythm'), adviceText = document.getElementById('advice-text');
  if (evalVertical) { evalVertical.innerText = isVerticalOk ? "合格" : "もう少し！"; evalVertical.className = `status ${isVerticalOk ? 'pass' : 'fail'}`; }
  if (evalRhythm) { evalRhythm.innerText = isRhythmOk ? "合格" : "もう少し！"; evalRhythm.className = `status ${isRhythmOk ? 'pass' : 'fail'}`; }
  
  if (isRhythmOk && isVerticalOk) {
    if (rankElement) rankElement.innerText = "◎"; if (rankTextElement) rankTextElement.innerText = "完璧です！素晴らしい！";
    if (window.confetti) window.confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
  } else if (isRhythmOk || isVerticalOk) {
    if (rankElement) rankElement.innerText = "○"; if (rankTextElement) rankTextElement.innerText = "あと一歩です！";
  } else {
    if (rankElement) rankElement.innerText = "△"; if (rankTextElement) rankTextElement.innerText = "練習あるのみ！";
  }
}

document.addEventListener('click', (e) => {
  const targetId = e.target.closest('button')?.id || e.target.id;
  if (!targetId) return;
  log(`Click: ${targetId}`);
  switch (targetId) {
    case 'btn-to-guide': isUploadedVideo = false; showScreen('guide'); break;
    case 'btn-to-measure': showScreen('measure'); break;
    case 'btn-back-to-intro':
    case 'btn-back-to-intro-from-measure': showScreen('intro'); break;
    case 'btn-start': startMeasurement(); break;
    case 'btn-stop': finishMeasurement(); break;
    case 'btn-retry': showScreen('measure'); break;
    case 'btn-switch-camera': currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user'; if (!isUploadedVideo) startCamera(); break;
    case 'btn-upload-trigger': if (inputVideoFile) inputVideoFile.click(); break;
  }
});

if (inputVideoFile) { inputVideoFile.addEventListener('change', (e) => { const file = e.target.files[0]; if (file) startVideoFile(file); }); }
showScreen('intro');
window.addEventListener('resize', () => { if (!isUploadedVideo && canvasElement) { canvasElement.width = canvasElement.clientWidth; canvasElement.height = canvasElement.clientHeight; } });
