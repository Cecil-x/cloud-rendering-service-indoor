const startButton = document.querySelector('#start');
const statusEl = document.querySelector('#status');
const video = document.querySelector('#stream');
const serverUrlInput = document.querySelector('#serverUrl');
const pointCloudFileInput = document.querySelector('#pointCloudFile');
const pointCloudFiles = document.querySelector('#pointCloudFiles');
const pointDensityInput = document.querySelector('#pointDensity');
const pointDensityValue = document.querySelector('#pointDensityValue');
const telemetryEl = document.querySelector('#telemetry');
const calibrationStatusEl = document.querySelector('#calibrationStatus');
const backendStatusEl = document.querySelector('#backendStatus');
const backendWsUrlInput = document.querySelector('#backendWsUrl');
const connectBackendWsButton = document.querySelector('#connectBackendWs');
const disconnectBackendWsButton = document.querySelector('#disconnectBackendWs');
const droneForm = document.querySelector('#droneForm');
const droneInputs = {
  x: document.querySelector('#droneX'),
  y: document.querySelector('#droneY'),
  z: document.querySelector('#droneZ'),
  yaw: document.querySelector('#droneYaw'),
  gimbalYaw: document.querySelector('#gimbalYaw'),
  gimbalPitch: document.querySelector('#gimbalPitch')
};

const ICE_CONFIG = {
  iceServers: [
    {
      urls: 'turn:172.20.13.53:3478?transport=udp',
      username: 'cloudrender',
      credential: 'CloudRender@123456'
    }
  ],
  iceTransportPolicy: 'relay'
};

let socket;
let peer;
let pendingIceCandidates = [];
let backendSocket;
let calibrationMode = '';
let dragging = false;
let lastX = 0;
let lastY = 0;

startButton.addEventListener('click', startSession);
serverUrlInput.value = localStorage.getItem('cloudRendererUrl') || location.origin;
pointCloudFileInput.value = localStorage.getItem('pointCloudFile') || '';
loadPointCloudOptions();
serverUrlInput.addEventListener('change', loadPointCloudOptions);
serverUrlInput.addEventListener('blur', loadPointCloudOptions);
pointDensityInput?.addEventListener('input', () => {
  const percent = Number(pointDensityInput.value);
  updatePointDensityLabel(percent);
  send({ type: 'point-density', percent });
});
document.querySelectorAll('[data-drone-action]').forEach(button => {
  button.addEventListener('click', () => sendDroneControl(button.dataset.droneAction));
});
droneForm?.addEventListener('submit', event => {
  event.preventDefault();
  send({
    type: 'drone-set',
    x: Number(droneInputs.x.value),
    y: Number(droneInputs.y.value),
    z: Number(droneInputs.z.value),
    yaw: Number(droneInputs.yaw.value),
    gimbalYaw: Number(droneInputs.gimbalYaw.value),
    gimbalPitch: Number(droneInputs.gimbalPitch.value)
  });
});
document.querySelector('#pickOrigin')?.addEventListener('click', () => startCalibrationPick('origin'));
document.querySelector('#pickXAxis')?.addEventListener('click', () => send({ type: 'calibration-use-current-heading' }));
connectBackendWsButton?.addEventListener('click', connectBackendTelemetry);
disconnectBackendWsButton?.addEventListener('click', disconnectBackendTelemetry);

async function startSession() {
  try {
    startButton.disabled = true;
    setStatus('Creating server renderer...');
    closeSession();

    const serviceUrl = normalizeServiceUrl(serverUrlInput.value);
    const pointCloudFile = pointCloudFileInput.value.trim();
    localStorage.setItem('cloudRendererUrl', serviceUrl);
    localStorage.setItem('pointCloudFile', pointCloudFile);

    const response = await fetch(`${serviceUrl}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ pointCloudFile })
    });
    if (!response.ok) throw new Error(await response.text());
    const { id, pointCloudFile: loadedPointCloudFile } = await response.json();
    if (loadedPointCloudFile) pointCloudFileInput.value = loadedPointCloudFile;

    socket = new WebSocket(signalUrl(serviceUrl, id));
    socket.addEventListener('open', () => setStatus(`Signaling connected, loading: ${loadedPointCloudFile || pointCloudFile || 'default file'}`));
    socket.addEventListener('message', event => handleSignal(JSON.parse(event.data)));
    socket.addEventListener('error', () => setStatus('信令连接失败，请确认服务端口和新版服务是否已启动'));
    socket.addEventListener('close', () => {
      startButton.disabled = false;
      setStatus('Session closed');
    });
  } catch (error) {
    startButton.disabled = false;
    setStatus(`Startup failed: ${error.message}`);
  }
}

async function loadPointCloudOptions() {
  const selected = localStorage.getItem('pointCloudFile') || pointCloudFileInput.value;
  const serviceUrl = normalizeServiceUrl(serverUrlInput.value);

  try {
    const response = await fetch(`${serviceUrl}/api/point-clouds`, { cache: 'no-store' });
    if (!response.ok) throw new Error(await response.text());
    const { current, files } = await response.json();
    pointCloudFiles.innerHTML = '';

    for (const file of files) {
      const option = document.createElement('option');
      option.value = file;
      option.label = file === current ? `${file}（默认）` : file;
      pointCloudFiles.append(option);
    }

    pointCloudFileInput.value = files.includes(selected) ? selected : current;
    setStatus(`已读取文件列表：${files.length} 个`);
  } catch (error) {
    pointCloudFiles.innerHTML = '';
    if (!pointCloudFileInput.value) pointCloudFileInput.value = 'GlobalMap.pcd';
    setStatus(`Failed to read server file list; enter a file name manually: ${error.message}`);
  }
}

async function handleSignal(message) {
  if (message.type === 'renderer-ready') {
    await createPeer();
    const offer = await peer.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: false });
    await peer.setLocalDescription(offer);
    send({ type: 'offer', sdp: offer.sdp });
  }

  if (message.type === 'answer') {
    await peer.setRemoteDescription({ type: 'answer', sdp: message.sdp });
    await flushPendingIceCandidates();
    setStatus('视频协商完成');
  }

  if (message.type === 'ice' && message.candidate) {
    if (!peer?.remoteDescription) {
      pendingIceCandidates.push(message.candidate);
      return;
    }
    await peer.addIceCandidate(message.candidate);
  }

  if (message.type === 'telemetry') {
    updateTelemetry(message);
  }

  if (message.type === 'calibration') {
    updateCalibrationStatus(message);
  }
}

async function flushPendingIceCandidates() {
  if (!peer?.remoteDescription) return;
  const candidates = pendingIceCandidates;
  pendingIceCandidates = [];
  for (const candidate of candidates) {
    await peer.addIceCandidate(candidate);
  }
}

async function createPeer() {
  if (peer) return;
  peer = new RTCPeerConnection(ICE_CONFIG);
  peer.addTransceiver('video', { direction: 'recvonly' });
  peer.onicecandidate = event => send({ type: 'ice', candidate: event.candidate });
  peer.ontrack = event => {
    console.log('Remote track received:', event.track.kind);
    video.srcObject = event.streams[0];
    const [track] = event.streams[0].getVideoTracks();
    track.contentHint = 'detail';
    video.onloadedmetadata = () => {
      console.log('Video metadata:', video.videoWidth, video.videoHeight);
      video.play().catch(error => console.error('Video play failed:', error));
    };
    setStatus('Playing remote rendered video stream');
  };
  peer.onconnectionstatechange = () => {
    console.log('WebRTC:', peer.connectionState);
    setStatus(`WebRTC: ${peer.connectionState}`);
  };
  peer.oniceconnectionstatechange = () => console.log('ICE:', peer.iceConnectionState);
}

video.addEventListener('pointerdown', event => {
  if (calibrationMode) {
    event.preventDefault();
    sendCalibrationPick(event);
    return;
  }
  dragging = true;
  lastX = event.clientX;
  lastY = event.clientY;
  video.setPointerCapture(event.pointerId);
});

video.addEventListener('pointermove', event => {
  if (!dragging) return;
  const dx = event.clientX - lastX;
  const dy = event.clientY - lastY;
  lastX = event.clientX;
  lastY = event.clientY;
  send({ type: 'input', action: 'orbit', dx, dy });
});

video.addEventListener('pointerup', event => {
  dragging = false;
  video.releasePointerCapture(event.pointerId);
});

video.addEventListener('wheel', event => {
  event.preventDefault();
  send({ type: 'input', action: 'zoom', delta: event.deltaY });
}, { passive: false });

function sendDroneControl(action) {
  send({ type: 'drone-control', action });
}

function startCalibrationPick(mode) {
  calibrationMode = mode;
  setStatus(mode === 'origin' ? '请在主画面点击无人机起飞原点' : '请在主画面点击无人机 X 正方向点');
}

function sendCalibrationPick(event) {
  const rect = video.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  send({ type: 'calibration-pick', mode: calibrationMode, x, y });
  calibrationMode = '';
}

function updateCalibrationStatus(data) {
  if (!calibrationStatusEl) return;
  const origin = data.origin ? `Origin: ${formatVector(data.origin)}` : 'Origin: not set';
  const xAxis = data.xAxis ? `X axis dir: ${formatVector(data.xAxis)}` : 'X axis: not set';
  const yaw = `Map X yaw: ${formatNumber(data.xAxisYaw)} deg`;
  const ready = data.ready ? 'Status: ready' : 'Status: waiting';
  calibrationStatusEl.textContent = [origin, xAxis, yaw, ready].join('\n');
}

function connectBackendTelemetry() {
  disconnectBackendTelemetry();
  const url = backendWsUrlInput?.value?.trim();
  if (!url) return;
  backendSocket = new WebSocket(url);
  backendSocket.addEventListener('open', () => {
    if (backendStatusEl) backendStatusEl.textContent = `Connected: ${url}`;
  });
  backendSocket.addEventListener('message', event => {
    try {
      const raw = String(event.data || '').trim();
      if (!raw.startsWith('{') && !raw.startsWith('[')) {
        if (backendStatusEl) backendStatusEl.textContent = `Realtime notice: ${raw}`;
        return;
      }
      const payload = JSON.parse(raw);
      send({ type: 'uav-realtime', payload });
      if (backendStatusEl) backendStatusEl.textContent = `Realtime updated: ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      if (backendStatusEl) backendStatusEl.textContent = `Parse failed: ${error.message}`;
    }
  });
  backendSocket.addEventListener('error', () => {
    if (backendStatusEl) backendStatusEl.textContent = 'Realtime WebSocket error';
  });
  backendSocket.addEventListener('close', () => {
    if (backendStatusEl) backendStatusEl.textContent = 'Realtime WebSocket closed';
  });
}

function disconnectBackendTelemetry() {
  backendSocket?.close();
  backendSocket = null;
}

function updateTelemetry(data) {
  const position = data.position || {};
  if (telemetryEl) {
    telemetryEl.textContent = [
      `X: ${formatNumber(position.x)}  Y: ${formatNumber(position.y)}  Z: ${formatNumber(position.z)}`,
      `Yaw: ${formatNumber(data.yaw)} deg`,
      `Gimbal yaw: ${formatNumber(data.gimbalYaw)} deg`,
      `Gimbal pitch: ${formatNumber(data.gimbalPitch)} deg`
    ].join('\n');
  }
  if (droneInputs.x) droneInputs.x.value = formatNumber(position.x);
  if (droneInputs.y) droneInputs.y.value = formatNumber(position.y);
  if (droneInputs.z) droneInputs.z.value = formatNumber(position.z);
  if (droneInputs.yaw) droneInputs.yaw.value = formatNumber(data.yaw);
  if (droneInputs.gimbalYaw) droneInputs.gimbalYaw.value = formatNumber(data.gimbalYaw);
  if (droneInputs.gimbalPitch) droneInputs.gimbalPitch.value = formatNumber(data.gimbalPitch);
}

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '0.00';
}

function formatVector(value) {
  return `X ${formatNumber(value.x)} / Y ${formatNumber(value.y)} / Z ${formatNumber(value.z)}`;
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function signalUrl(serviceUrl, session) {
  const url = new URL(serviceUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/signal';
  url.search = `role=client&session=${session}`;
  return url.toString();
}

function normalizeServiceUrl(value) {
  const raw = value.trim() || location.origin;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const url = new URL(withProtocol);
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function closeSession() {
  socket?.close();
  peer?.close();
  disconnectBackendTelemetry();
  socket = null;
  peer = null;
  pendingIceCandidates = [];
  video.srcObject = null;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function updatePointDensityLabel(percent) {
  if (pointDensityValue) pointDensityValue.textContent = `${percent}%`;
}

