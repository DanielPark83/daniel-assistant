// 다른 기기 연결용 QR 코드 만들기·읽기. 라이브러리는 vendor/ 에 들어 있으며 필요할 때만 불러온다.

const loaded = new Map();

function loadScript(src) {
  if (!loaded.has(src)) {
    loaded.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { loaded.delete(src); reject(new Error('QR 기능을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.')); };
      document.head.appendChild(s);
    }));
  }
  return loaded.get(src);
}

export async function qrSvg(text) {
  await loadScript('vendor/qrcode-generator.js');
  const qr = window.qrcode(0, 'L');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true, title: '다른 기기 연결용 QR 코드' });
}

export async function decodeImageData(imageData) {
  await loadScript('vendor/jsQR.js');
  const code = window.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
  return code ? code.data : null;
}

// 카메라로 QR 코드를 찾는다. 반환값은 카메라를 끄는 함수.
export async function startScanner(video, onResult, onError) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('이 브라우저에서는 카메라를 쓸 수 없습니다. 토큰을 붙여 넣어 연결해 주세요.');
  }
  await loadScript('vendor/jsQR.js');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch {
    throw new Error('카메라 권한이 없습니다. 기기 설정에서 카메라를 허용하거나 토큰을 붙여 넣어 연결해 주세요.');
  }
  video.setAttribute('playsinline', '');
  video.muted = true;
  video.srcObject = stream;
  await video.play().catch(() => {});

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
  const tick = () => {
    if (stopped) return;
    try {
      if (video.readyState >= 2 && video.videoWidth) {
        const w = Math.min(640, video.videoWidth);
        const h = Math.round((video.videoHeight / video.videoWidth) * w);
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        const code = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
        if (code && code.data) { stop(); onResult(code.data); return; }
      }
    } catch (err) {
      stop();
      if (onError) onError(err);
      return;
    }
    setTimeout(tick, 150);
  };
  tick();
  return stop;
}
