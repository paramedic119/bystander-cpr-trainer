// --- デバッグログ ---
const log = (msg) => console.log(`[DEBUG] ${msg}`);
log("main.js initialized (Clean Refactor)");

// --- 定数 ---
const MEASURE_DURATION = 15;
const TARGET_BPM_MIN = 100; // ガイドライン準拠 (100-120)
const TARGET_BPM_MAX = 120;
const METRONOME_BPM = 110;  // 推奨テンポ
const VERTICAL_ANGLE_THRESHOLD = 20; // 20度以内が合格
const MIN_PEAK_INTERVAL = 400; 
const SMOOTHING_FACTOR = 0.4;

// --- 解析用データ (計測ごとにリセット) ---
let results_history = [];
let bpm_list = [];
let max_wrist_y = 0;
let best_posture_frame = null;

// --- 状態管理 ---
let isMeasuring = false;
let isUploadedVideo = false;
let currentFacingMode = 'user';
let startTime = 0;
let last_peak_time = 0;
let last_y = 0;
let y_direction = 0;
let smoothed_shoulder = { x: 0, y: 0 };
let smoothed_wrist = { x: 0, y: 0 };

// --- Web Audio API ---
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
const inputVideoFile = document.getElementById('input-video-file');

// --- 1. 初期化ロジック ---

function resetAnalysisData() {
  log("Resetting analysis data...");
  results_history = [];
  bpm_list = [];
  max_wrist_y = 0;
  best_posture_frame = null;
  last_peak_time = 0;
  last_y = 0;
  y_direction = 0;
  smoothed_shoulder = { x: 0, y: 0 };
  smoothed_wrist = { x: 0, y: 0 };
}

function resetUI() {
  if (timerElement) timerElement.innerText = "00:15";
  if (bpmDisplayElement) bpmDisplayElement.innerText = "-- BPM";
  document.getElementById('posture-check-container')?.classList.add('hidden');
  
  // 動画読み込み時は水平器を隠す
  const levelContainer = document.getElementById('level-container');
  if (levelContainer) {
    levelContainer.classList.toggle('hidden', isUploadedVideo);
  }
  
  ['btn-start', 'btn-stop', 'btn-switch-camera', 'btn-back-to-intro-from-measure'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', id === 'btn-stop');
  });
}

// --- 2. 画面遷移 ---

function showScreen(screenName) {
  Object.keys(screens).forEach(key => screens[key]?.classList.remove('active'));
  if (screens[screenName]) {
    screens[screenName].classList.add('active');
    if (screenName === 'measure') {
      resetUI();
      if (!isUploadedVideo) startCamera();
    } else if (screenName === 'intro') {
      stopCamera(); stopVideoFile();
    }
  }
}

// --- 3. メトロノーム ---

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
function flashMetronome() { if (metronomeVisual) { metronomeVisual.classList.remove('hidden'); setTimeout(() => metronomeVisual.classList.add('hidden'), 100); } }

// --- 4. MediaPipe & Camera ---

let pose = null, camera = null;
function initPose() {
  if (pose) return;
  const PoseClass = window.Pose || (window.mediapipe && window.mediapipe.Pose);
  if (!PoseClass) return;
  pose = new PoseClass({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}` });
  pose.setOptions({ modelComplexity: 1, smoothLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
  pose.onResults(onResults);
}

function startCamera() {
  initPose();
  const CameraClass = window.Camera || (window.mediapipe && window.mediapipe.Camera);
  if (!CameraClass) return;
  videoElement.pause(); videoElement.srcObject = null; videoElement.src = "";
  if (camera) camera.stop();
  camera = new CameraClass(videoElement, {
    onFrame: async () => { if (pose && !isUploadedVideo) await pose.send({ image: videoElement }); },
    width: 640, height: 480, facingMode: currentFacingMode
  });
  camera.start();
}

function stopCamera() { if (camera) camera.stop(); }

async function startVideoFile(file) {
  isUploadedVideo = true; initPose(); stopCamera();
  videoElement.src = URL.createObjectURL(file);
  videoElement.onloadedmetadata = () => {
    showScreen('measure');
    if (canvasElement) { canvasElement.width = videoElement.videoWidth; canvasElement.height = videoElement.videoHeight; }
  };
  videoElement.load();
}
function stopVideoFile() { if (isUploadedVideo) { videoElement.pause(); isUploadedVideo = false; } }

// --- 5. 解析コアロジック ---

function onResults(results) {
  if (!results.image || !canvasCtx) return;
  const w = results.image.width, h = results.image.height;
  if (canvasElement.width !== w || canvasElement.height !== h) {
    canvasElement.width = w; canvasElement.height = h;
  }
  
  canvasCtx.save();
  canvasCtx.clearRect(0, 0, w, h);
  canvasCtx.drawImage(results.image, 0, 0, w, h);
  
  if (results.poseLandmarks) {
    if (window.drawConnectors) {
      window.drawConnectors(canvasCtx, results.poseLandmarks, [[11, 13], [13, 15], [12, 14], [14, 16]], { color: '#ffffff', lineWidth: 4 });
      window.drawLandmarks(canvasCtx, [results.poseLandmarks[11], results.poseLandmarks[12], results.poseLandmarks[15], results.poseLandmarks[16]], { color: '#4ade80', radius: 6 });
    }
    if (isMeasuring) analyzePose(results.poseLandmarks, w, h, results.image);
  }
  canvasCtx.restore();
}

function analyzePose(landmarks, width, height, image) {
  // 保存済み動画の場合、前後3秒を解析から除外
  if (isUploadedVideo) {
    const cur = videoElement.currentTime;
    const dur = videoElement.duration;
    if (cur < 3 || cur > (dur - 3)) return; // 判定対象外の時間帯はスキップ
  }

  const shoulder = landmarks[11].visibility > landmarks[12].visibility ? landmarks[11] : landmarks[12];
  const wrist = landmarks[15].visibility > landmarks[16].visibility ? landmarks[15] : landmarks[16];

  // スムージング
  if (smoothed_shoulder.x === 0) {
    smoothed_shoulder = { x: shoulder.x, y: shoulder.y };
    smoothed_wrist = { x: wrist.x, y: wrist.y };
  } else {
    smoothed_shoulder.x = shoulder.x * SMOOTHING_FACTOR + smoothed_shoulder.x * (1 - SMOOTHING_FACTOR);
    smoothed_shoulder.y = shoulder.y * SMOOTHING_FACTOR + smoothed_shoulder.y * (1 - SMOOTHING_FACTOR);
    smoothed_wrist.x = wrist.x * SMOOTHING_FACTOR + smoothed_wrist.x * (1 - SMOOTHING_FACTOR);
    smoothed_wrist.y = wrist.y * SMOOTHING_FACTOR + smoothed_wrist.y * (1 - SMOOTHING_FACTOR);
  }

  // 角度計算 (垂直=0度)
  const dx = (smoothed_wrist.x - smoothed_shoulder.x) * width;
  const dy = (smoothed_wrist.y - smoothed_shoulder.y) * height;
  const angle = Math.abs(Math.atan2(dx, dy) * 180 / Math.PI);
  
  results_history.push({ angle, wristY: smoothed_wrist.y });

  // リズム判定（手首のY座標のピーク）
  const current_y = smoothed_wrist.y;
  if (last_y !== 0) {
    const diff = current_y - last_y;
    if (diff > 0.003 && y_direction !== 1) y_direction = 1; // 押し込み開始
    else if (diff < -0.003 && y_direction !== -1) {
      y_direction = -1; // 切り返し地点
      const now = isUploadedVideo ? videoElement.currentTime * 1000 : performance.now();
      if (last_peak_time !== 0) {
        const interval = now - last_peak_time;
        if (interval > MIN_PEAK_INTERVAL) {
          const bpm = 60000 / interval;
          if (bpm > 60 && bpm < 200) {
            bpm_list.push(bpm);
            if (bpmDisplayElement) {
              const avg = bpm_list.slice(-3).reduce((a, b) => a + b, 0) / Math.min(bpm_list.length, 3);
              bpmDisplayElement.innerText = `${Math.round(avg)} BPM`;
            }
          }
        }
      }
      last_peak_time = now;
      
      // 最深部でのフレーム保存（姿勢チェック用）
      if (current_y > max_wrist_y) {
        max_wrist_y = current_y;
        const offCanvas = document.createElement('canvas');
        offCanvas.width = width; offCanvas.height = height;
        offCanvas.getContext('2d').drawImage(image, 0, 0);
        best_posture_frame = { image: offCanvas, angle: angle, landmarks: landmarks };
      }
    }
  }
  last_y = current_y;
}

// --- 6. 計測フロー制御 ---

async function startMeasurement() {
  initAudio(); if (audioCtx.state === 'suspended') await audioCtx.resume();
  resetAnalysisData(); // ★ここでクリーンにリセット
  
  ['btn-start', 'btn-back-to-intro-from-measure', 'btn-switch-camera'].forEach(id => document.getElementById(id)?.classList.add('hidden'));
  
  if (!isUploadedVideo) {
    if (countdownElement) {
      countdownElement.classList.remove('hidden');
      for (let i = 3; i > 0; i--) { countdownElement.innerText = i; scheduleNote(audioCtx.currentTime); await new Promise(r => setTimeout(r, 1000)); }
      countdownElement.classList.add('hidden');
    }
  }
  
  document.getElementById('btn-stop')?.classList.remove('hidden');
  isMeasuring = true; startTime = Date.now();
  nextNoteTime = audioCtx.currentTime;
  timerID = setInterval(scheduler, 25.0);
  
  if (isUploadedVideo) {
    videoElement.currentTime = 0;
    videoElement.play();
    processVideoFrame();
  }

  const timerInterval = setInterval(() => {
    if (!isMeasuring) { clearInterval(timerInterval); return; }
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (isUploadedVideo) {
      if (videoElement.ended) { clearInterval(timerInterval); finishMeasurement(); }
    } else {
      const remaining = MEASURE_DURATION - elapsed;
      if (timerElement) timerElement.innerText = `00:${Math.max(0, remaining).toString().padStart(2, '0')}`;
      if (remaining <= 0) { clearInterval(timerInterval); finishMeasurement(); }
    }
  }, 1000);
}

async function processVideoFrame() {
  if (isUploadedVideo && !videoElement.paused && !videoElement.ended) {
    if (pose) await pose.send({ image: videoElement });
    requestAnimationFrame(processVideoFrame);
  }
}

function finishMeasurement() {
  log("Finishing measurement and calculating results...");
  calculateResult(); // ★先に判定を行う
  stopMeasurement(); // その後停止
  showScreen('result');
}

function stopMeasurement() {
  isMeasuring = false;
  if (timerID) clearInterval(timerID);
  if (isUploadedVideo) videoElement.pause();
  ['btn-stop'].forEach(id => document.getElementById(id)?.classList.add('hidden'));
}

// --- 7. 判定・結果表示 ---

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
  const peakAngle = best_posture_frame ? best_posture_frame.angle : medianAngle;
  
  // 厳格な姿勢判定: 中央値と代表値の両方が閾値内であること
  const isVerticalOk = (medianAngle > 0) && (medianAngle <= VERTICAL_ANGLE_THRESHOLD) && (peakAngle <= VERTICAL_ANGLE_THRESHOLD);
  
  log(`Results: BPM=${medianBPM}, Angle(Med)=${medianAngle}, Angle(Peak)=${peakAngle}`);

  const rankEl = document.querySelector('.rank'), rankTextEl = document.querySelector('.rank-text'), evalV = document.getElementById('eval-vertical'), evalR = document.getElementById('eval-rhythm');
  
  if (evalV) { evalV.innerText = isVerticalOk ? "合格" : "もう少し！"; evalV.className = `status ${isVerticalOk ? 'pass' : 'fail'}`; }
  if (evalR) { evalR.innerText = isRhythmOk ? "合格" : "もう少し！"; evalR.className = `status ${isRhythmOk ? 'pass' : 'fail'}`; }
  
  if (isRhythmOk && isVerticalOk) {
    rankEl.innerText = "◎"; rankTextEl.innerText = "完璧です！素晴らしい！";
    if (window.confetti) window.confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
  } else if (isRhythmOk || isVerticalOk) {
    rankEl.innerText = "○"; rankTextEl.innerText = "あと一歩です！";
  } else {
    rankEl.innerText = "△"; rankTextEl.innerText = "練習あるのみ！";
  }

  if (best_posture_frame) {
    const pc = document.getElementById('posture-canvas'), pct = document.getElementById('posture-check-container');
    if (pc && pct) {
      pct.classList.remove('hidden');
      pc.width = best_posture_frame.image.width; pc.height = best_posture_frame.image.height;
      const ctx = pc.getContext('2d');
      ctx.drawImage(best_posture_frame.image, 0, 0);
      const lm = best_posture_frame.landmarks;
      const s = lm[11].visibility > lm[12].visibility ? lm[11] : lm[12];
      const w = lm[15].visibility > lm[16].visibility ? lm[15] : lm[16];
      const sx = s.x * pc.width, sy = s.y * pc.height, wx = w.x * pc.width, wy = w.y * pc.height;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(wx, wy);
      ctx.strokeStyle = (best_posture_frame.angle <= VERTICAL_ANGLE_THRESHOLD) ? '#4ade80' : '#f87171';
      ctx.lineWidth = 6; ctx.stroke();
      ctx.beginPath(); ctx.setLineDash([5, 5]); ctx.moveTo(sx, sy); ctx.lineTo(sx, wy);
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke();
    }
  }

  const advice = document.getElementById('advice-text');
  if (advice) {
    if (!isVerticalOk) advice.innerText = "腕が垂直になっていないようです。肩の真下に手首がくるように意識しましょう。";
    else if (!isRhythmOk) advice.innerText = "リズムが少しずれています。1分間に100〜120回を意識しましょう。";
    else advice.innerText = "素晴らしい技術です！この調子で練習を続けましょう。";
  }
}

// --- 8. 水平器（ジャイロセンサー） ---
let levelActive = false;

async function initLevelSensor() {
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    // iOS用の権限リクエスト
    try {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission === 'granted') startLevelMonitoring();
    } catch (e) { log("Level sensor permission denied"); }
  } else {
    // Android/PC等
    startLevelMonitoring();
  }
}

function startLevelMonitoring() {
  if (levelActive) return;
  levelActive = true;
  window.addEventListener('deviceorientation', (e) => {
    if (!isMeasuring && screens.measure.classList.contains('active')) {
      const levelLine = document.getElementById('level-line');
      const levelContainer = document.getElementById('level-container');
      if (!levelLine || !levelContainer) return;

      // デバイスの回転角を取得（画面の向きを考慮）
      let roll = 0;
      if (window.innerHeight > window.innerWidth) {
        roll = e.gamma; // 縦持ち
      } else {
        roll = e.beta; // 横持ち
      }

      // ガイド線を回転
      levelLine.style.transform = `rotate(${roll}deg)`;

      // ±3度以内なら「水平」とみなして緑色にする
      if (Math.abs(roll) < 3) {
        levelContainer.classList.add('level-ok');
      } else {
        levelContainer.classList.remove('level-ok');
      }
    }
  });
}

// --- 9. イベントリスナー ---

document.addEventListener('click', async (e) => {
  const tid = e.target.closest('button')?.id || e.target.id;
  if (!tid) return;
  switch (tid) {
    case 'btn-to-guide': isUploadedVideo = false; showScreen('guide'); break;
    case 'btn-to-measure': 
      showScreen('measure'); 
      initLevelSensor(); // 計測画面に進む際にセンサーを初期化
      break;
    case 'btn-back-to-intro':
    case 'btn-back-to-intro-from-measure': showScreen('intro'); break;
    case 'btn-start': startMeasurement(); break;
    case 'btn-stop': finishMeasurement(); break;
    case 'btn-retry': showScreen('measure'); break;
    case 'btn-switch-camera': currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user'; if (!isUploadedVideo) startCamera(); break;
    case 'btn-upload-trigger': if (inputVideoFile) inputVideoFile.click(); break;
  }
});

if (inputVideoFile) inputVideoFile.addEventListener('change', (e) => { if (e.target.files[0]) startVideoFile(e.target.files[0]); });
showScreen('intro');
window.addEventListener('resize', () => { if (!isUploadedVideo && canvasElement) { canvasElement.width = canvasElement.clientWidth; canvasElement.height = canvasElement.clientHeight; } });
