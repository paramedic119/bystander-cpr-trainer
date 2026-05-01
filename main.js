import './style.css';
import confetti from 'canvas-confetti';

// --- 定数 ---
const MEASURE_DURATION = 15;
const TARGET_BPM_MIN = 100;
const TARGET_BPM_MAX = 120;
const VERTICAL_ANGLE_THRESHOLD = 15;

// --- 状態管理 ---
let isMeasuring = false;
let isUploadedVideo = false;
let startTime = 0;
let results_history = [];
let metronomeInterval = null;
let bpm_list = [];
let last_peak_time = 0;
let last_y = 0;
let y_direction = 0;

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
const audioMetronome = document.getElementById('audio-metronome');
const timerElement = document.getElementById('timer');
const countdownElement = document.getElementById('countdown');
const metronomeVisual = document.getElementById('metronome-visual');
const instructionText = document.getElementById('instruction-text');
const processingOverlay = document.getElementById('processing-overlay');
const inputVideoFile = document.getElementById('input-video-file');

// --- 画面遷移 ---
function showScreen(screenName) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[screenName].classList.add('active');

  if (screenName === 'measure') {
    if (!isUploadedVideo) {
      startCamera();
    }
  } else {
    // 計測画面以外では全てを停止
    if (screenName !== 'measure') {
      stopCamera();
      stopVideoFile();
      stopMeasurement();
    }
  }
}

// --- MediaPipe Setup ---
let pose = null;
let camera = null;

function initPose() {
  if (pose) return;
  const PoseClass = window.Pose || (window.mediapipe && window.mediapipe.Pose);
  if (!PoseClass) {
    console.error('MediaPipe Pose class not found');
    return;
  }

  pose = new PoseClass({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`
  });

  pose.setOptions({
    modelComplexity: 1,
    smoothLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  });

  pose.onResults(onResults);
}

function startCamera() {
  initPose();
  const CameraClass = window.Camera || (window.mediapipe && window.mediapipe.Camera);
  if (!CameraClass || !pose) return;

  // 以前の動画ソースをクリア
  videoElement.pause();
  videoElement.srcObject = null;
  videoElement.src = "";
  videoElement.style.display = 'none';

  if (!camera) {
    camera = new CameraClass(videoElement, {
      onFrame: async () => {
        if (pose && !isUploadedVideo) await pose.send({ image: videoElement });
      },
      width: 640,
      height: 480
    });
  }
  camera.start().catch(err => {
    console.error('Camera start error:', err);
    alert('カメラの起動に失敗しました。カメラの使用を許可してください。');
  });
}

function stopCamera() {
  if (camera) {
    camera.stop();
  }
}

async function startVideoFile(file) {
  isUploadedVideo = true;
  initPose();
  
  // 既存のカメラを停止
  stopCamera();
  
  // 以前のソースをクリア
  videoElement.pause();
  videoElement.srcObject = null;
  
  const url = URL.createObjectURL(file);
  videoElement.src = url;
  videoElement.muted = true; // ブラウザポリシー対策
  
  // 読み込み完了を待つ
  videoElement.onloadedmetadata = () => {
    showScreen('measure');
    instructionText.innerText = "動画の準備ができました。";
    processingOverlay.classList.add('hidden');
    
    // Canvasの初期リサイズ
    canvasElement.width = videoElement.videoWidth;
    canvasElement.height = videoElement.videoHeight;
  };

  videoElement.onerror = () => {
    alert('動画の読み込みに失敗しました。');
    isUploadedVideo = false;
  };
  
  videoElement.load();
}

function stopVideoFile() {
  if (isUploadedVideo) {
    videoElement.pause();
    if (videoElement.src) {
      URL.revokeObjectURL(videoElement.src);
      videoElement.src = "";
    }
    isUploadedVideo = false;
  }
}

// --- 解析ロジック ---
function onResults(results) {
  if (!results.image) return;

  // キャンバスサイズの動的調整
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

    if (isMeasuring) {
      analyzePose(results.poseLandmarks);
    }
  }
  canvasCtx.restore();
}

function analyzePose(landmarks) {
  const wrist = landmarks[15].visibility > landmarks[16].visibility ? landmarks[15] : landmarks[16];
  const shoulder = landmarks[11].visibility > landmarks[12].visibility ? landmarks[11] : landmarks[12];
  
  // 垂直性の判定
  const angle = Math.abs(Math.atan2(wrist.x - shoulder.x, wrist.y - shoulder.y) * 180 / Math.PI);
  results_history.push({ angle, wristY: wrist.y, time: Date.now() });

  // リズム判定
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
        if (bpm > 60 && bpm < 200) {
          bpm_list.push(bpm);
          flashMetronome();
        }
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

// --- 計測コントロール ---
async function startMeasurement() {
  const btnStart = document.getElementById('btn-start');
  const btnStop = document.getElementById('btn-stop');
  const btnBack = document.getElementById('btn-back-to-intro-from-measure');
  
  btnStart.classList.add('hidden');
  btnBack.classList.add('hidden');
  
  if (!isUploadedVideo) {
    countdownElement.classList.remove('hidden');
    for (let i = 3; i > 0; i--) {
      countdownElement.innerText = i;
      await new Promise(r => setTimeout(r, 1000));
    }
    countdownElement.classList.add('hidden');
  }

  btnStop.classList.remove('hidden');
  
  // 状態のリセット
  isMeasuring = true;
  startTime = Date.now();
  results_history = [];
  bpm_list = [];
  last_y = 0;
  last_peak_time = 0;
  
  timerElement.classList.remove('hidden');
  instructionText.innerText = isUploadedVideo ? "解析中..." : "そのまま続けてください！";
  
  if (isUploadedVideo) {
    videoElement.currentTime = 0;
    try {
      await videoElement.play();
      processVideoFrame();
    } catch (e) {
      console.error('Play error:', e);
      alert('動画の再生に失敗しました。');
      stopMeasurement();
      return;
    }
  } else {
    startMetronome();
  }
  
  const timerInterval = setInterval(() => {
    if (!isMeasuring) {
      clearInterval(timerInterval);
      return;
    }

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const remaining = MEASURE_DURATION - elapsed;
    
    if (isUploadedVideo) {
      if (videoElement.ended) {
        clearInterval(timerInterval);
        finishMeasurement();
      }
      timerElement.innerText = "解析中...";
    } else {
      if (remaining <= 0) {
        clearInterval(timerInterval);
        finishMeasurement();
      }
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

function startMetronome() {
  const interval = 60000 / 110;
  metronomeInterval = setInterval(() => {
    audioMetronome.currentTime = 0;
    audioMetronome.play().catch(() => {});
  }, interval);
}

function stopMeasurement() {
  isMeasuring = false;
  clearInterval(metronomeInterval);
  timerElement.classList.add('hidden');
  document.getElementById('btn-start').classList.remove('hidden');
  document.getElementById('btn-stop').classList.add('hidden');
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
document.getElementById('btn-to-guide').onclick = () => {
  isUploadedVideo = false;
  showScreen('guide');
};

document.getElementById('btn-upload-trigger').onclick = () => {
  inputVideoFile.click();
};

inputVideoFile.onchange = (e) => {
  const file = e.target.files[0];
  if (file) {
    startVideoFile(file);
  }
};

document.getElementById('btn-to-measure').onclick = () => showScreen('measure');
document.getElementById('btn-back-to-intro').onclick = () => showScreen('intro');
document.getElementById('btn-back-to-intro-from-measure').onclick = () => showScreen('intro');
document.getElementById('btn-start').onclick = startMeasurement;
document.getElementById('btn-stop').onclick = finishMeasurement;
document.getElementById('btn-retry').onclick = () => {
  // リトライ時は現在のモード（カメラor動画）を維持
  showScreen('measure');
};

showScreen('intro');

window.addEventListener('resize', () => {
  if (!isUploadedVideo) {
    // ライブカメラの場合は表示サイズに合わせる
    canvasElement.width = canvasElement.clientWidth;
    canvasElement.height = canvasElement.clientHeight;
  }
});
