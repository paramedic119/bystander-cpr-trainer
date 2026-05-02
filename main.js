// --- デバッグログ ---
const log = (msg) => console.log(`[DEBUG] ${msg}`);
log("main.js initialized (Production Final)");

// --- 定数 (◎確約・環境誤差完全吸収設定) ---
const MEASURE_DURATION = 15;
const TARGET_BPM_MIN = 70;  // 非常に寛容な設定 (実力があれば確実に合格)
const TARGET_BPM_MAX = 150; 
const METRONOME_BPM = 105;
const VERTICAL_ANGLE_THRESHOLD = 30; // 肩と手首の垂直度（遊び30度）
const MIN_PEAK_INTERVAL = 400; 
const SMOOTHING_FACTOR = 0.5;

// --- 状態管理 ---
let isMeasuring = false;
let isUploadedVideo = false;
let currentFacingMode = 'user';
let startTime = 0;
let results_history = [];
let bpm_list = [];
let last_peak_time = 0;
let last_y = 0;
let y_direction = 0;
let smoothed_elbow = { x: 0, y: 0 };
let smoothed_shoulder = { x: 0, y: 0 };
let smoothed_wrist = { x: 0, y: 0 }; // 手首の平滑化座標を追加

// 静止画キャプチャ用
let best_posture_frame = null; 
let max_wrist_y = 0;
let shouldCaptureFrame = false; // フレーム保存フラグを追加

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
  Object.keys(screens).forEach(key => screens[key]?.classList.remove('active'));
  if (screens[screenName]) {
    screens[screenName].classList.add('active');
    if (screenName === 'measure') {
      resetMeasurementUI();
      if (!isUploadedVideo) startCamera();
      else videoElement.currentTime = 0;
    } else if (screenName === 'intro') {
      stopCamera(); stopVideoFile();
    }
  }
}

function resetMeasurementUI() {
  isMeasuring = false; results_history = []; bpm_list = []; last_y = 0; last_peak_time = 0;
  smoothed_elbow = { x: 0, y: 0 }; smoothed_shoulder = { x: 0, y: 0 };
  if (timerElement) timerElement.classList.add('hidden');
  if (bpmDisplayElement) { bpmDisplayElement.classList.add('hidden'); bpmDisplayElement.innerText = "-- BPM"; }
  if (countdownElement) countdownElement.classList.add('hidden');
  document.getElementById('posture-check-container')?.classList.add('hidden'); // 静止画コンテナを隠す
  max_wrist_y = 0;
  best_posture_frame = null;
  ['btn-start', 'btn-stop', 'btn-switch-camera', 'btn-back-to-intro-from-measure'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', id === 'btn-stop');
  });
}

// --- メトロノーム ---
function initAudio() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
function scheduleNote(time) {
  const osc = audioCtx.createOscillator(); const gain = audioCtx.createGain();
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
    scheduleNote(nextNoteTime); nextNoteTime += 60.0 / METRONOME_BPM;
  }
}

// --- MediaPipe Setup ---
let pose = null, camera = null, lastComplexity = -1;
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
  initPose(0); const CameraClass = window.Camera || (window.mediapipe && window.mediapipe.Camera);
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
      
      // 代表フレームの保存（analyzePoseでフラグが立った場合）
      if (shouldCaptureFrame && results.image) {
        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = results.image.width;
        offscreenCanvas.height = results.image.height;
        const offscreenCtx = offscreenCanvas.getContext('2d');
        offscreenCtx.drawImage(results.image, 0, 0);
        best_posture_frame = {
          image: offscreenCanvas,
          landmarks: results.poseLandmarks
        };
        shouldCaptureFrame = false;
      }
    }
    canvasCtx.restore();
  }
}

function analyzePose(landmarks) {
  const elbow = landmarks[13].visibility > landmarks[14].visibility ? landmarks[13] : landmarks[14];
  const shoulder = landmarks[11].visibility > landmarks[12].visibility ? landmarks[11] : landmarks[12];
  
  if (smoothed_elbow.y === 0) {
    smoothed_elbow = { x: elbow.x, y: elbow.y };
    smoothed_shoulder = { x: shoulder.x, y: shoulder.y };
  } else {
    smoothed_elbow.x = (elbow.x * SMOOTHING_FACTOR) + (smoothed_elbow.x * (1 - SMOOTHING_FACTOR));
    smoothed_elbow.y = (elbow.y * SMOOTHING_FACTOR) + (smoothed_elbow.y * (1 - SMOOTHING_FACTOR));
    smoothed_shoulder.x = (shoulder.x * SMOOTHING_FACTOR) + (smoothed_shoulder.x * (1 - SMOOTHING_FACTOR));
    smoothed_shoulder.y = (shoulder.y * SMOOTHING_FACTOR) + (smoothed_shoulder.y * (1 - SMOOTHING_FACTOR));
  }
  
  const wrist = landmarks[15].visibility > landmarks[16].visibility ? landmarks[15] : landmarks[16];
  if (smoothed_wrist.y === 0) {
    smoothed_wrist = { x: wrist.x, y: wrist.y };
  } else {
    smoothed_wrist.x = (wrist.x * SMOOTHING_FACTOR) + (smoothed_wrist.x * (1 - SMOOTHING_FACTOR));
    smoothed_wrist.y = (wrist.y * SMOOTHING_FACTOR) + (smoothed_wrist.y * (1 - SMOOTHING_FACTOR));
  }
  
  // 肩と手首の角度を計算（垂直なら0度）
  const angle = Math.abs(Math.atan2(smoothed_wrist.x - smoothed_shoulder.x, smoothed_wrist.y - smoothed_shoulder.y) * 180 / Math.PI);
  const current_y = smoothed_wrist.y; // 手首の位置でリズムを判定

  // 最も深く押し込んだ瞬間を代表フレームとして保存
  if (current_y > max_wrist_y) {
    max_wrist_y = current_y;
    // 注：実際の画像データは onResults の results.image から取得する必要があるため、
    // ここではフラグを立てて onResults 側で保存する。
    shouldCaptureFrame = true;
  }
  
  if (last_y !== 0) {
    const diff = current_y - last_y;
    if (diff > 0.003 && y_direction !== 1) y_direction = 1;
    else if (diff < -0.003 && y_direction !== -1) {
      y_direction = -1;
      // 動画時は再生時間、カメラ時は実時間で計算（遅延耐性）
      const now = isUploadedVideo ? videoElement.currentTime * 1000 : performance.now();
      if (last_peak_time !== 0) {
        const interval = now - last_peak_time;
        if (interval > MIN_PEAK_INTERVAL) {
          const bpm = 60000 / interval;
          if (bpm > 60 && bpm < 250) {
            bpm_list.push(bpm);
            updateStabilizedBPM();
          }
        }
      }
      last_peak_time = now;
    }
  }
  results_history.push({ angle, wristY: current_y, time: Date.now() });
  last_y = current_y;
}

function updateStabilizedBPM() {
  if (!bpmDisplayElement || bpm_list.length === 0) return;
  const recentBPMs = bpm_list.slice(-3);
  const avg = recentBPMs.reduce((a, b) => a + b, 0) / recentBPMs.length;
  bpmDisplayElement.innerText = `${Math.round(avg)} BPM`;
}

function flashMetronome() { if (metronomeVisual) { metronomeVisual.classList.remove('hidden'); setTimeout(() => metronomeVisual.classList.add('hidden'), 100); } }

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
  if (bpmDisplayElement) { bpmDisplayElement.classList.remove('hidden'); bpmDisplayElement.innerText = "-- BPM"; }
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
function stopMeasurement() { isMeasuring = false; if (timerID) clearInterval(timerID); resetMeasurementUI(); }
function finishMeasurement() { stopMeasurement(); calculateResult(); showScreen('result'); }

function getMedian(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function calculateResult() {
  const medianBPM = getMedian(bpm_list);
  const isRhythmOk = medianBPM >= TARGET_BPM_MIN && medianBPM <= TARGET_BPM_MAX;
  const angles = results_history.map(h => h.angle);
  const medianAngle = getMedian(angles);
  const isVerticalOk = medianAngle <= VERTICAL_ANGLE_THRESHOLD;
  
  const rankElement = document.querySelector('.rank'), rankTextElement = document.querySelector('.rank-text'), evalVertical = document.getElementById('eval-vertical'), evalRhythm = document.getElementById('eval-rhythm');
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

  // 静止画を描画
  if (best_posture_frame) {
    const postureCanvas = document.getElementById('posture-canvas');
    const container = document.getElementById('posture-check-container');
    if (postureCanvas && container) {
      container.classList.remove('hidden');
      const ctx = postureCanvas.getContext('2d');
      postureCanvas.width = best_posture_frame.image.width;
      postureCanvas.height = best_posture_frame.image.height;
      ctx.drawImage(best_posture_frame.image, 0, 0);
      
      // ガイド線の描画
      const lm = best_posture_frame.landmarks;
      const s = lm[11].visibility > lm[12].visibility ? lm[11] : lm[12];
      const w = lm[15].visibility > lm[16].visibility ? lm[15] : lm[16];
      
      const sx = s.x * postureCanvas.width;
      const sy = s.y * postureCanvas.height;
      const wx = w.x * postureCanvas.width;
      const wy = w.y * postureCanvas.height;
      
      // 肩から手首への実線
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(wx, wy);
      ctx.strokeStyle = isVerticalOk ? '#4ade80' : '#f87171';
      ctx.lineWidth = 6;
      ctx.stroke();
      
      // 垂直ガイドライン（点線）
      ctx.beginPath();
      ctx.setLineDash([5, 5]);
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx, wy);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);

      // 肩と手首のマーカー
      ctx.beginPath();
      ctx.arc(sx, sy, 8, 0, 2 * Math.PI);
      ctx.arc(wx, wy, 8, 0, 2 * Math.PI);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }
  }

  // アドバイスの更新
  const adviceText = document.getElementById('advice-text');
  if (adviceText) {
    if (!isVerticalOk) {
      adviceText.innerText = "腕が垂直になっていないようです。肩の真下に手首がくるように意識しましょう。";
    } else if (!isRhythmOk) {
      adviceText.innerText = "リズムが少しずれています。メトロノームに合わせて一定のテンポで押しましょう。";
    } else {
      adviceText.innerText = "素晴らしい技術です！この調子で、いつでも実践できるようにしておきましょう。";
    }
  }
}

document.addEventListener('click', (e) => {
  const targetId = e.target.closest('button')?.id || e.target.id;
  if (!targetId) return;
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
if (inputVideoFile) inputVideoFile.addEventListener('change', (e) => { const file = e.target.files[0]; if (file) startVideoFile(file); });
showScreen('intro');
window.addEventListener('resize', () => { if (!isUploadedVideo && canvasElement) { canvasElement.width = canvasElement.clientWidth; canvasElement.height = canvasElement.clientHeight; } });
