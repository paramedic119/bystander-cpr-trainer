import './style.css';
import confetti from 'canvas-confetti';

// --- 定数 ---
const MEASURE_DURATION = 15;
const TARGET_BPM_MIN = 100;
const TARGET_BPM_MAX = 120;
const METRONOME_BPM = 105;
const VERTICAL_ANGLE_THRESHOLD = 15;

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
const canvasCtx = canvasElement.getContext('2d');
const timerElement = document.getElementById('timer');
const countdownElement = document.getElementById('countdown');
const metronomeVisual = document.getElementById('metronome-visual');
const instructionText = document.getElementById('instruction-text');
const inputVideoFile = document.getElementById('input-video-file');

// --- 画面遷移 ---
function showScreen(screenName) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[screenName].classList.add('active');

  if (screenName === 'measure') {
    resetMeasurementData();
    if (!isUploadedVideo) {
      startCamera();
    } else {
      // 動画アップロードモードの場合は巻き戻しておく
      videoElement.currentTime = 0;
      instructionText.innerText = "動画の準備ができました。";
    }
  } else if (screenName === 'intro') {
    // 最初の画面に戻る時は全てをクリーンアップ
    stopCamera();
    stopVideoFile();
    stopMeasurement();
  }
}

function resetMeasurementData() {
  isMeasuring = false;
  results_history = [];
  bpm_list = [];
  last_y = 0;
  last_peak_time = 0;
  y_direction = 0;
  timerElement.classList.add('hidden');
  document.getElementById('btn-start').classList.remove('hidden');
  document.getElementById('btn-stop').classList.add('hidden');
  document.getElementById('btn-switch-camera').classList.remove('hidden');
  document.getElementById('btn-back-to-intro-from-measure').classList.remove('hidden');
}

// --- メトロノーム ---
function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
}

function scheduleNote(time) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.type = 'sine';
  osc.frequency.setValueAtTime(880, time);
  gain.gain.setValueAtTime(0, time);
  gain.gain.linearRampToValueAtTime(0.1, time + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.1);
  osc.start(time);
  osc.stop(time + 0.1);

  const delay = (time - audioCtx.currentTime) * 1000;
  setTimeout(() => {
    if (isMeasuring) flashMetronome();
  }, delay > 0 ? delay : 0);
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

  pose = new PoseClass({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`
  });

  pose.setOptions({
    modelComplexity: complexity,
    smoothLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  });

  pose.onResults(onResults);
  lastComplexity = complexity;
}

function startCamera() {
  initPose(0);
  const CameraClass = window.Camera || (window.mediapipe && window.mediapipe.Camera);
  if (!CameraClass || !pose) return;

  videoElement.pause();
  videoElement.srcObject = null;
  videoElement.src = "";
  
  if (camera) camera.stop();

  camera = new CameraClass(videoElement, {
    onFrame: async () => {
      if (pose && !isUploadedVideo) await pose.send({ image: videoElement });
    },
    width: 640,
    height: 480,
    facingMode: currentFacingMode
  });
  camera.start().catch(err => console.error(err));
}

function stopCamera() {
  if (camera) camera.stop();
}

async function startVideoFile(file) {
  isUploadedVideo = true;
  initPose(1);
  stopCamera();
  videoElement.pause();
  videoElement.srcObject = null;
  
  const url = URL.createObjectURL(file);
  videoElement.src = url;
  videoElement.onloadedmetadata = () => {
    showScreen('measure');
    canvasElement.width = videoElement.videoWidth;
    canvasElement.height = videoElement.videoHeight;
  };
  videoElement.load();
}

function stopVideoFile() {
  if (isUploadedVideo) {
    videoElement.pause();
    if (videoElement.src) {
      // ここではURLを解放せず、Introに戻る時のみ解放するように調整可能だが、
      // メモリ管理のためIntroに戻る時に処理
      isUploadedVideo = false;
    }
  }
}

// --- 解析ロジック ---
function onResults(results) {
  if (!results.image) return;
  const w = results.image.width;
  const h = results.image.height;
  if (w && h && (canvasElement.width !== w || canvasElement.height !== h)) {
    canvasElement.width = w;
    canvasElement.height = h;
  }

  canvasCtx.save();
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
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

function analyzePose(landmarks) {
  const wrist = landmarks[15].visibility > landmarks[16].visibility ? landmarks[15] : landmarks[16];
  const shoulder = landmarks[11].visibility > landmarks[12].visibility ? landmarks[11] : landmarks[12];
  
  const angle = Math.abs(Math.atan2(wrist.x - shoulder.x, wrist.y - shoulder.y) * 180 / Math.PI);
  results_history.push({ angle, wristY: wrist.y, time: Date.now() });

  const current_y = wrist.y;
  if (last_y !== 0) {
    const diff = current_y - last_y;
    if (diff > 0.002 && y_direction !== 1) {
      y_direction = 1;
    } else if (diff < -0.002 && y_direction !== -1) {
      y_direction = -1;
      const now = Date.now();
      if (last_peak_time !== 0) {
        const bpm = 60000 / (now - last_peak_time);
        if (bpm > 60 && bpm < 200) bpm_list.push(bpm);
      }
      last_peak_time = now;
    }
  }
  last_y = current_y;
}

function flashMetronome() {
  metronomeVisual.classList.remove('hidden');
  setTimeout(() => metronomeVisual.classList.add('hidden'), 100);
}

async function startMeasurement() {
  initAudio();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const btnStart = document.getElementById('btn-start');
  const btnStop = document.getElementById('btn-stop');
  const btnSwitch = document.getElementById('btn-switch-camera');
  const btnBack = document.getElementById('btn-back-to-intro-from-measure');
  
  btnStart.classList.add('hidden');
  btnBack.classList.add('hidden');
  btnSwitch.classList.add('hidden');
  
  if (!isUploadedVideo) {
    countdownElement.classList.remove('hidden');
    for (let i = 3; i > 0; i--) {
      countdownElement.innerText = i;
      scheduleNote(audioCtx.currentTime);
      await new Promise(r => setTimeout(r, 1000));
    }
    countdownElement.classList.add('hidden');
  }

  btnStop.classList.remove('hidden');
  
  // 以前の計測データをリセット
  results_history = [];
  bpm_list = [];
  last_y = 0;
  last_peak_time = 0;
  isMeasuring = true;
  startTime = Date.now();

  timerElement.classList.remove('hidden');
  instructionText.innerText = isUploadedVideo ? "解析中..." : "その調子！続けてください";
  
  nextNoteTime = audioCtx.currentTime;
  timerID = setInterval(scheduler, 25.0);

  if (isUploadedVideo) {
    videoElement.currentTime = 0;
    try {
      await videoElement.play();
      processVideoFrame();
    } catch (e) {
      alert('動画再生失敗');
      stopMeasurement();
      return;
    }
  }
  
  const timerInterval = setInterval(() => {
    if (!isMeasuring) {
      clearInterval(timerInterval);
      return;
    }
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (isUploadedVideo) {
      if (videoElement.ended) { clearInterval(timerInterval); finishMeasurement(); }
    } else {
      const remaining = MEASURE_DURATION - elapsed;
      if (remaining <= 0) { clearInterval(timerInterval); finishMeasurement(); }
      timerElement.innerText = `00:${remaining.toString().padStart(2, '0')}`;
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
  isMeasuring = false;
  clearInterval(timerID);
  timerElement.classList.add('hidden');
  document.getElementById('btn-start').classList.remove('hidden');
  document.getElementById('btn-stop').classList.add('hidden');
  document.getElementById('btn-switch-camera').classList.remove('hidden');
  document.getElementById('btn-back-to-intro-from-measure').classList.remove('hidden');
}

function finishMeasurement() {
  stopMeasurement();
  calculateResult();
  showScreen('result');
}

function calculateResult() {
  const avgBPM = bpm_list.length > 0 ? bpm_list.reduce((a, b) => a + b, 0) / bpm_list.length : 0;
  const isRhythmOk = avgBPM >= TARGET_BPM_MIN && avgBPM <= TARGET_BPM_MAX;
  const avgAngle = results_history.length > 0 ? results_history.reduce((a, b) => a + b.angle, 0) / results_history.length : 99;
  const isVerticalOk = avgAngle <= VERTICAL_ANGLE_THRESHOLD;
  
  const rankElement = document.querySelector('.rank');
  const rankTextElement = document.querySelector('.rank-text');
  const evalVertical = document.getElementById('eval-vertical');
  const evalRhythm = document.getElementById('eval-rhythm');
  const adviceText = document.getElementById('advice-text');
  
  evalVertical.innerText = isVerticalOk ? "合格" : "もう少し！";
  evalVertical.className = `status ${isVerticalOk ? 'pass' : 'fail'}`;
  evalRhythm.innerText = isRhythmOk ? "合格" : "もう少し！";
  evalRhythm.className = `status ${isRhythmOk ? 'pass' : 'fail'}`;
  
  if (isRhythmOk && isVerticalOk) {
    rankElement.innerText = "◎";
    rankTextElement.innerText = "完璧です！素晴らしい！";
    adviceText.innerText = "垂直に、正しいリズムで押せています。この感覚を忘れないようにしましょう。";
    confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
  } else if (isRhythmOk || isVerticalOk) {
    rankElement.innerText = "○";
    rankTextElement.innerText = "あと一歩です！";
    adviceText.innerText = isRhythmOk ? 
      "リズムはバッチリです！次はもう少し腕を真っ直ぐ、真上から押すことを意識してみましょう。" :
      "押し方はとても綺麗です！次はメトロノームの音に合わせて、もう少しテンポを意識してみましょう。";
  } else {
    rankElement.innerText = "△";
    rankTextElement.innerText = "練習を続けましょう！";
    adviceText.innerText = "まずはリラックスして、メトロノームの音を聞きながら腕を真っ直ぐ伸ばすことから始めてみましょう。";
  }
}

// --- イベントリスナー ---
document.getElementById('btn-to-guide').onclick = () => { isUploadedVideo = false; showScreen('guide'); };
document.getElementById('btn-upload-trigger').onclick = () => inputVideoFile.click();
inputVideoFile.onchange = (e) => { const file = e.target.files[0]; if (file) startVideoFile(file); };
document.getElementById('btn-to-measure').onclick = () => showScreen('measure');
document.getElementById('btn-back-to-intro').onclick = () => showScreen('intro');
document.getElementById('btn-back-to-intro-from-measure').onclick = () => showScreen('intro');
document.getElementById('btn-start').onclick = startMeasurement;
document.getElementById('btn-stop').onclick = finishMeasurement;
document.getElementById('btn-switch-camera').onclick = switchCamera;
document.getElementById('btn-retry').onclick = () => showScreen('measure');

showScreen('intro');

window.addEventListener('resize', () => {
  if (!isUploadedVideo) {
    canvasElement.width = canvasElement.clientWidth;
    canvasElement.height = canvasElement.clientHeight;
  }
});
