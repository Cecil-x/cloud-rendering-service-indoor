const startButton = document.querySelector('#start');
const statusEl = document.querySelector('#status');
const video = document.querySelector('#stream');
const serverUrlInput = document.querySelector('#serverUrl');
const pointCloudFileInput = document.querySelector('#pointCloudFile');
const pointCloudFiles = document.querySelector('#pointCloudFiles');

const ICE_CONFIG = {
  iceServers: [
    {
      urls: [
        'turn:172.20.13.53:3478?transport=udp',
        'turn:172.20.13.53:3478?transport=tcp'
      ],
      username: 'cloudrender',
      credential: 'CloudRender@123456'
    }
  ],
  iceTransportPolicy: 'relay'
};

let socket;
let peer;
let pendingIceCandidates = [];
let dragging = false;
let lastX = 0;
let lastY = 0;

startButton.addEventListener('click', startSession);
serverUrlInput.value = localStorage.getItem('cloudRendererUrl') || location.origin;
pointCloudFileInput.value = localStorage.getItem('pointCloudFile') || '';
loadPointCloudOptions();
serverUrlInput.addEventListener('change', loadPointCloudOptions);
serverUrlInput.addEventListener('blur', loadPointCloudOptions);

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
  socket = null;
  peer = null;
  pendingIceCandidates = [];
  video.srcObject = null;
}

function setStatus(text) {
  statusEl.textContent = text;
}

