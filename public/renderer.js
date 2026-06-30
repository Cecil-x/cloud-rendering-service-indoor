import * as THREE from 'three';
import { PCDLoader } from 'https://unpkg.com/three@0.165.0/examples/jsm/loaders/PCDLoader.js';
import { PLYLoader } from 'https://unpkg.com/three@0.165.0/examples/jsm/loaders/PLYLoader.js';
import { GLTFLoader } from 'https://unpkg.com/three@0.165.0/examples/jsm/loaders/GLTFLoader.js';

const ICE_CONFIG = {
  iceServers: []
};

const canvas = document.querySelector('#stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.autoClear = false;
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const streamConfig = {
  width: 1920,
  height: 1080,
  fps: 30,
  bitrate: 8_000_000
};
const POINT_BUDGET = Infinity;
const TILE_LOAD_LIMIT = Number(new URLSearchParams(window.location.search).get('tileLimit')) || Infinity;
let pointDensityPercent = 20;
renderer.setSize(streamConfig.width, streamConfig.height, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x061014);
scene.fog = new THREE.Fog(0x061014, 60, 180);

const overlayScene = new THREE.Scene();
const overlayCamera = new THREE.OrthographicCamera(0, streamConfig.width, streamConfig.height, 0, -1, 1);
const fpsCanvas = document.createElement('canvas');
fpsCanvas.width = 256;
fpsCanvas.height = 64;
const fpsContext = fpsCanvas.getContext('2d');
const fpsTexture = new THREE.CanvasTexture(fpsCanvas);
const fpsSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: fpsTexture, transparent: true, depthTest: false, depthWrite: false }));
fpsSprite.position.set(96, 34, 0);
fpsSprite.scale.set(176, 44, 1);
overlayScene.add(fpsSprite);
let fpsFrameCount = 0;
let fpsLastTime = performance.now();
let fpsValue = 0;
drawFpsOverlay();

const camera = new THREE.PerspectiveCamera(55, streamConfig.width / streamConfig.height, 0.01, 10000);
const droneCamera = new THREE.PerspectiveCamera(68, 16 / 9, 0.02, 1000);
const target = new THREE.Vector3();
const spherical = new THREE.Spherical(8, Math.PI / 2.5, Math.PI / 4);

scene.add(new THREE.HemisphereLight(0xe9fbff, 0x1b2a2f, 2.4));
const key = new THREE.DirectionalLight(0xffffff, 2.5);
key.position.set(5, 7, 6);
scene.add(key);

const grid = new THREE.GridHelper(40, 40, 0x2a7180, 0x18343b);
grid.position.y = -1;
scene.add(grid);

const droneState = {
  position: new THREE.Vector3(0, 0.8, 0),
  yaw: 0,
  pitch: 0,
  gimbalYaw: 0,
  gimbalPitch: 0
};
const droneDirection = new THREE.Vector3();
const droneRight = new THREE.Vector3();
const droneLookTarget = new THREE.Vector3();
const routeGroup = new THREE.Group();
const calibration = {
  origin: null,
  xAxisPoint: null,
  xAxis: new THREE.Vector3(1, 0, 0),
  rightAxis: new THREE.Vector3(0, 0, 1),
  upAxis: new THREE.Vector3(0, 1, 0),
  xAxisYaw: -Math.PI / 2,
  ready: false
};
const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 0.25;
const drone = createDroneMarker();
const calibrationMarker = createCalibrationMarker();
scene.add(drone);
scene.add(calibrationMarker);
scene.add(routeGroup);
loadDroneModel('/models/airplane.glb');
updateDronePose(false);

const animationClock = new THREE.Clock();
let droneMixer = null;
let droneAnimationActions = [];
let droneAnimationActive = false;
let droneAnimationStopAt = 0;

let pointCloud;
let socket;
let peer;
let pendingIceCandidates = [];
let currentPointCloudFile = '';
let currentCalibrationUrl = '';
let currentRunningRouteUrl = '';
let currentRunningRouteData = null;
let routePollTimer = null;
let routePollInFlight = false;

connectSignal();
animate();

function connectSignal() {
  const session = new URLSearchParams(location.search).get('session');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${proto}//${location.host}/signal?role=renderer&session=${session}`);
  socket.addEventListener('message', event => handleSignal(JSON.parse(event.data)));
}

async function handleSignal(message) {
  if (message.type === 'config') {
    Object.assign(streamConfig, message.stream || {});
    currentPointCloudFile = message.pointCloudFile || '';
    currentCalibrationUrl = message.calibrationUrl || '';
    currentRunningRouteUrl = message.runningRouteUrl || '';
    resizeRenderer(streamConfig.width, streamConfig.height);
    loadPointCloud(message.pointCloudUrl || message.plyUrl, message.pointCloudFile);
    loadSavedCalibration(currentCalibrationUrl);
    startRunningRoutePolling(currentRunningRouteUrl);
  }

  if (message.type === 'offer') {
    await createPeer();
    await peer.setRemoteDescription({ type: 'offer', sdp: message.sdp });
    await flushPendingIceCandidates();
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    send({ type: 'answer', sdp: answer.sdp });
  }

  if (message.type === 'ice' && message.candidate) {
    if (!peer || !peer.remoteDescription) {
      pendingIceCandidates.push(message.candidate);
      return;
    }
    await peer.addIceCandidate(message.candidate);
  }

  if (message.type === 'input') applyInput(message);
  if (message.type === 'drone-control') applyDroneControl(message);
  if (message.type === 'drone-set') setDroneState(message);
  if (message.type === 'calibration-pick') pickCalibrationPoint(message);
  if (message.type === 'calibration-use-current-heading') calibrateXAxisFromCurrentHeading();
  if (message.type === 'uav-realtime') applyRealtimeUavState(message.payload);
  if (message.type === 'point-density') setPointDensity(message.percent);
  if (message.type === 'route-select') setRunningRoute(message.url || message.routeUrl || '');
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
  const stream = canvas.captureStream(streamConfig.fps);
  for (const track of stream.getVideoTracks()) {
    track.contentHint = 'detail';
    const sender = peer.addTrack(track, stream);
    const params = sender.getParameters();
    params.encodings = [{ maxBitrate: streamConfig.bitrate, maxFramerate: streamConfig.fps }];
    await sender.setParameters(params);
  }
  peer.onicecandidate = event => send({ type: 'ice', candidate: event.candidate });
  peer.onconnectionstatechange = () => console.log('WebRTC:', peer.connectionState);
  peer.oniceconnectionstatechange = () => console.log('ICE:', peer.iceConnectionState);
}

function resizeRenderer(width, height) {
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  renderer.setSize(width, height, false);
  overlayCamera.right = width;
  overlayCamera.bottom = height;
  overlayCamera.updateProjectionMatrix();
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  droneCamera.aspect = 16 / 9;
  droneCamera.updateProjectionMatrix();
}

function loadPointCloud(url, fileName = '') {
  const extension = fileName.split('.').pop()?.toLowerCase() || url.split('.').pop()?.toLowerCase();

  if (pointCloud) {
    scene.remove(pointCloud);
    disposePointCloud(pointCloud);
    pointCloud = null;
  }

  if (extension === 'json') {
    console.log(`Loading point cloud: ${fileName || url} with tiled binary loader`);
    loadTiledPointCloud(url, fileName).catch(error => console.error(error));
    return;
  }

  const loader = extension === 'pcd' ? new PCDLoader() : new PLYLoader();
  console.log(`Loading point cloud: ${fileName || url} with ${extension === 'pcd' ? 'PCDLoader' : 'PLYLoader'}`);

  loader.load(url, result => {
    const loadedPoints = result.isPoints ? result : null;
    let geometry = loadedPoints ? result.geometry : result;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    geometry.center();
    geometry = decimatePointGeometry(geometry, POINT_BUDGET);
    applyUniformPointOrder(geometry);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const radius = geometry.boundingSphere?.radius || 10;
    const material = loadedPoints?.material || new THREE.PointsMaterial();
    material.size = Math.max(radius * 0.0025, 0.015);
    material.vertexColors = geometry.hasAttribute('color');
    material.color = new THREE.Color(geometry.hasAttribute('color') ? 0xffffff : 0xa7f3ff);
    material.sizeAttenuation = true;
    material.needsUpdate = true;

    pointCloud = new THREE.Points(geometry, material);
    pointCloud.rotation.x = -Math.PI / 2;
    scene.add(pointCloud);
    applyPointDensity();
    console.log(`Loaded point cloud: ${fileName || url}, points: ${geometry.getAttribute('position')?.count || 0}`);

    spherical.radius = radius * 2.1;
    target.set(0, 0, 0);
     updateCamera();
   }, undefined, error => console.error(error));
}

async function loadTiledPointCloud(url, fileName = '') {
  const manifestUrl = new URL(url, location.href);
  const response = await fetch(manifestUrl);
  if (!response.ok) throw new Error(`Failed to fetch tile manifest: ${response.status} ${response.statusText}`);

  const manifest = await response.json();
  if (manifest.format !== 'points-tiles-v1' || !Array.isArray(manifest.tiles)) {
    throw new Error(`Unsupported tile manifest: ${manifest.format || 'unknown'}`);
  }

  const bounds = manifest.bounds || computeManifestBounds(manifest.tiles);
  const center = new THREE.Vector3(
    ((bounds.min?.[0] || 0) + (bounds.max?.[0] || 0)) / 2,
    ((bounds.min?.[1] || 0) + (bounds.max?.[1] || 0)) / 2,
    ((bounds.min?.[2] || 0) + (bounds.max?.[2] || 0)) / 2
  );
  const radius = new THREE.Vector3(
    (bounds.max?.[0] || 0) - (bounds.min?.[0] || 0),
    (bounds.max?.[1] || 0) - (bounds.min?.[1] || 0),
    (bounds.max?.[2] || 0) - (bounds.min?.[2] || 0)
  ).length() / 2 || 10;

  const group = new THREE.Group();
  group.name = fileName || url;
  group.rotation.x = -Math.PI / 2;
  group.userData.isTiledPointCloud = true;
  group.userData.totalPoints = 0;
  group.userData.loadedTiles = 0;
  group.userData.radius = radius;
  scene.add(group);
  pointCloud = group;

  spherical.radius = radius * 2.1;
  target.set(0, 0, 0);
  updateCamera();

  const tiles = manifest.tiles.slice(0, Math.min(manifest.tiles.length, TILE_LOAD_LIMIT));
  console.log(`Tile manifest: source=${manifest.source || fileName || url}, totalPoints=${manifest.pointCount}, tiles=${manifest.tiles.length}, loading=${tiles.length}`);

  for (let i = 0; i < tiles.length; i++) {
    if (pointCloud !== group) return;
    const tile = tiles[i];
    const tileUrl = new URL(tile.url, manifestUrl);
    const tileGeometry = await loadPointTile(tileUrl, tile, manifest, center);
    applyUniformPointOrder(tileGeometry);

    const material = new THREE.PointsMaterial({
      size: Math.max(radius * 0.0025, 0.015),
      vertexColors: tileGeometry.hasAttribute('color'),
      color: new THREE.Color(tileGeometry.hasAttribute('color') ? 0xffffff : 0xa7f3ff),
      sizeAttenuation: true
    });

    const points = new THREE.Points(tileGeometry, material);
    points.userData.pointCount = tile.points || tileGeometry.getAttribute('position')?.count || 0;
    group.add(points);
    group.userData.totalPoints += points.userData.pointCount;
    group.userData.loadedTiles += 1;
    applyPointDensity();

    if ((i + 1) % 5 === 0 || i + 1 === tiles.length) {
      console.log(`Loaded point tiles: ${i + 1}/${tiles.length}, points=${group.userData.totalPoints}`);
    }
  }

  console.log(`Loaded tiled point cloud: ${fileName || url}, tiles=${group.userData.loadedTiles}, points=${group.userData.totalPoints}`);
}

async function loadPointTile(url, tile, manifest, center) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch tile ${tile.url}: ${response.status} ${response.statusText}`);

  const buffer = await response.arrayBuffer();
  const count = tile.points;
  const positionBytes = count * 3 * 4;
  if (buffer.byteLength < positionBytes) throw new Error(`Tile ${tile.url} is too small`);

  const sourcePositions = new Float32Array(buffer, 0, count * 3);
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = sourcePositions[i * 3] - center.x;
    positions[i * 3 + 1] = sourcePositions[i * 3 + 1] - center.y;
    positions[i * 3 + 2] = sourcePositions[i * 3 + 2] - center.z;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  if (manifest.attributes?.color && buffer.byteLength >= positionBytes + count * 3) {
    const sourceColors = new Uint8Array(buffer, positionBytes, count * 3);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < sourceColors.length; i++) {
      colors[i] = srgbByteToLinear(sourceColors[i]);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function srgbByteToLinear(value) {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function computeManifestBounds(tiles) {
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const tile of tiles) {
    if (!tile.bounds) continue;
    for (let i = 0; i < 3; i++) {
      bounds.min[i] = Math.min(bounds.min[i], tile.bounds.min[i]);
      bounds.max[i] = Math.max(bounds.max[i], tile.bounds.max[i]);
    }
  }
  return bounds;
}

function disposePointCloud(object) {
  object.traverse?.(child => {
    child.geometry?.dispose();
    child.material?.dispose();
  });
  object.geometry?.dispose();
  object.material?.dispose();
}

function setPointDensity(percent) {
  pointDensityPercent = THREE.MathUtils.clamp(Number(percent) || 100, 5, 100);
  applyPointDensity();
}

function applyPointDensity() {
  if (!pointCloud) return;

  if (pointCloud.userData?.isTiledPointCloud) {
    let visibleTotal = 0;
    let total = 0;
    for (const child of pointCloud.children) {
      const geometry = child.geometry;
      const count = geometry?.getAttribute('position')?.count || 0;
      if (!geometry || !count) continue;
      const visibleCount = Math.max(1, Math.floor(count * pointDensityPercent / 100));
      geometry.setDrawRange(0, visibleCount);
      visibleTotal += visibleCount;
      total += count;
    }
    if (total) console.log(`Point density: ${pointDensityPercent}% (${visibleTotal}/${total})`);
    return;
  }

  const geometry = pointCloud.geometry;
  const count = geometry?.getAttribute('position')?.count || 0;
  if (!geometry || !count) return;
  const visibleCount = Math.max(1, Math.floor(count * pointDensityPercent / 100));
  geometry.setDrawRange(0, visibleCount);
  console.log(`Point density: ${pointDensityPercent}% (${visibleCount}/${count})`);
}

function applyUniformPointOrder(geometry) {
  const position = geometry.getAttribute('position');
  const count = position?.count || 0;
  if (!position || count < 2) return;

  const IndexArray = count > 65535 ? Uint32Array : Uint16Array;
  const indices = new IndexArray(count);
  let stride = Math.max(1, Math.floor(count * 0.6180339887498949));
  if (stride % 2 === 0) stride += 1;
  while (gcd(stride, count) !== 1) stride += 2;

  for (let i = 0, index = 0; i < count; i++, index = (index + stride) % count) {
    indices[i] = index;
  }

  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  console.log(`Point cloud uniform draw order enabled: ${count} points, stride ${stride}`);
}

function gcd(a, b) {
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return Math.abs(a);
}

function decimatePointGeometry(geometry, maxPoints) {
  const position = geometry.getAttribute('position');
  const count = position?.count || 0;
  if (!position || count <= maxPoints) return geometry;

  const stride = Math.ceil(count / maxPoints);
  const targetCount = Math.ceil(count / stride);
  const sampled = new THREE.BufferGeometry();
  const positions = new Float32Array(targetCount * 3);
  const color = geometry.getAttribute('color');
  const colors = color ? new color.array.constructor(targetCount * color.itemSize) : null;

  let target = 0;
  for (let source = 0; source < count && target < targetCount; source += stride, target++) {
    positions[target * 3] = position.getX(source);
    positions[target * 3 + 1] = position.getY(source);
    positions[target * 3 + 2] = position.getZ(source);
    if (color && colors) {
      for (let i = 0; i < color.itemSize; i++) {
        colors[target * color.itemSize + i] = color.array[source * color.itemSize + i];
      }
    }
  }

  sampled.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (color && colors) sampled.setAttribute('color', new THREE.BufferAttribute(colors, color.itemSize, color.normalized));
  console.log(`Point cloud decimated: ${count} -> ${targetCount}`);
  geometry.dispose();
  return sampled;
}

function applyInput(input) {
  if (input.action === 'orbit') {
    spherical.theta -= input.dx * 0.006;
    spherical.phi = THREE.MathUtils.clamp(spherical.phi - input.dy * 0.006, 0.08, Math.PI - 0.08);
  }

  if (input.action === 'zoom') {
    spherical.radius = THREE.MathUtils.clamp(spherical.radius * (1 + input.delta * 0.001), 0.2, 10000);
  }

  updateCamera();
}

function applyDroneControl(input) {
  const moveStep = Number(input.step || 0.25);
  const yawStep = THREE.MathUtils.degToRad(Number(input.yawStep || 8));
  const movingActions = new Set(['forward', 'back', 'left', 'right', 'up', 'down', 'yaw-left', 'yaw-right']);

  updateDroneVectors();

  if (input.action === 'forward') droneState.position.addScaledVector(droneDirection, moveStep);
  if (input.action === 'back') droneState.position.addScaledVector(droneDirection, -moveStep);
  if (input.action === 'left') droneState.position.addScaledVector(droneRight, -moveStep);
  if (input.action === 'right') droneState.position.addScaledVector(droneRight, moveStep);
  if (input.action === 'yaw-left') droneState.yaw += yawStep;
  if (input.action === 'yaw-right') droneState.yaw -= yawStep;
  if (input.action === 'up') droneState.position.y += moveStep;
  if (input.action === 'down') droneState.position.y -= moveStep;

  if (movingActions.has(input.action)) markDroneMoving();
  updateDronePose();
}

function setDroneState(input) {
  const previousPosition = droneState.position.clone();
  const previousYaw = droneState.yaw;

  if (Array.isArray(input.position) && input.position.length >= 3) {
    droneState.position.set(Number(input.position[0]), Number(input.position[1]), Number(input.position[2]));
  }
  if (Number.isFinite(input.x) && Number.isFinite(input.y) && Number.isFinite(input.z)) {
    droneState.position.set(Number(input.x), Number(input.y), Number(input.z));
  }
  if (Number.isFinite(input.yaw)) droneState.yaw = THREE.MathUtils.degToRad(Number(input.yaw));
  if (Number.isFinite(input.pitch)) droneState.pitch = THREE.MathUtils.degToRad(Number(input.pitch));
  if (Number.isFinite(input.gimbalYaw)) droneState.gimbalYaw = THREE.MathUtils.degToRad(Number(input.gimbalYaw));
  if (Number.isFinite(input.gimbalPitch)) droneState.gimbalPitch = THREE.MathUtils.degToRad(Number(input.gimbalPitch));
  if (previousPosition.distanceToSquared(droneState.position) > 0.000001 || Math.abs(previousYaw - droneState.yaw) > 0.000001) {
    markDroneMoving();
  }
  updateDronePose();
}

function pickCalibrationPoint(input) {
  if (!pointCloud) {
    console.warn('Calibration pick ignored: point cloud is not loaded');
    return;
  }

  const picked = pickPointOnCloud(Number(input.x), Number(input.y));
  if (!picked) {
    console.warn('Calibration pick missed point cloud');
    sendCalibration();
    return;
  }

  if (input.mode === 'origin') {
    calibration.origin = picked;
    droneState.position.copy(picked);
    updateDronePose();
  }

  if (input.mode === 'x-axis') {
    calibration.xAxisPoint = picked;
  }

  updateCalibration();
  updateCalibrationMarker();
  if (currentRunningRouteData) drawRunningRoute(currentRunningRouteData);
  sendCalibration();
  saveCalibration();
}

function pickPointOnCloud(x, y) {
  const ndc = new THREE.Vector2(
    THREE.MathUtils.clamp(x, 0, 1) * 2 - 1,
    -(THREE.MathUtils.clamp(y, 0, 1) * 2 - 1)
  );
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(pointCloud, true);
  return hits[0]?.point?.clone() || null;
}

function updateCalibration() {
  calibration.ready = false;
  if (!calibration.origin || !calibration.xAxisPoint) return;

  calibration.xAxis.copy(calibration.xAxisPoint).sub(calibration.origin);
  calibration.xAxis.y = 0;
  if (calibration.xAxis.lengthSq() < 0.0001) return;

  calibration.xAxis.normalize();
  calibration.rightAxis.crossVectors(calibration.xAxis, calibration.upAxis).normalize();
  calibration.xAxisYaw = Math.atan2(-calibration.xAxis.x, -calibration.xAxis.z);
  calibration.ready = true;
}

function createCalibrationMarker() {
  const group = new THREE.Group();
  group.visible = false;

  const originMaterial = new THREE.MeshBasicMaterial({ color: 0xfff36d, transparent: true, opacity: 0.95 });
  const origin = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 12), originMaterial);
  group.add(origin);

  const ringMaterial = new THREE.MeshBasicMaterial({ color: 0x58ffd8, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.012, 8, 48), ringMaterial);
  ring.rotation.x = Math.PI / 2;
  group.add(ring);

  const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0x58ffd8, 0.28, 0.12);
  group.add(arrow);

  const labelCanvas = document.createElement('canvas');
  labelCanvas.width = 256;
  labelCanvas.height = 96;
  const labelContext = labelCanvas.getContext('2d');
  labelContext.font = 'bold 34px sans-serif';
  labelContext.fillStyle = '#58ffd8';
  labelContext.shadowColor = '#58ffd8';
  labelContext.shadowBlur = 12;
  labelContext.fillText('ORIGIN / X+', 10, 48);
  const labelTexture = new THREE.CanvasTexture(labelCanvas);
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture, transparent: true, depthTest: false }));
  label.scale.set(0.9, 0.34, 1);
  label.position.set(0, 0.35, 0);
  group.add(label);

  group.userData.arrow = arrow;
  group.userData.label = label;
  return group;
}

function updateCalibrationMarker() {
  if (!calibration.origin) {
    calibrationMarker.visible = false;
    return;
  }

  calibrationMarker.visible = true;
  calibrationMarker.position.copy(calibration.origin);

  const radius = pointCloud?.userData?.radius || pointCloud?.geometry?.boundingSphere?.radius || 10;
  const length = Math.max(radius * 0.12, 0.8);
  const direction = calibration.ready ? calibration.xAxis.clone().normalize() : droneDirection.clone().normalize();
  if (direction.lengthSq() < 0.0001) direction.set(1, 0, 0);

  const arrow = calibrationMarker.userData.arrow;
  arrow.setDirection(direction);
  arrow.setLength(length, Math.max(length * 0.22, 0.22), Math.max(length * 0.09, 0.08));
  arrow.setColor(calibration.ready ? 0x58ffd8 : 0xfff36d);

  const label = calibrationMarker.userData.label;
  label.position.copy(direction).multiplyScalar(length * 0.58);
  label.position.y += Math.max(length * 0.18, 0.35);
}

async function loadRunningRoute(url) {
  if (!url) return;
  if (routePollInFlight) return;
  routePollInFlight = true;

  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || 'running route API failed');

    currentRunningRouteData = result;
    drawRunningRoute(result);
  } catch (error) {
    console.warn('Running route load failed:', error.message || error);
  } finally {
    routePollInFlight = false;
  }
}

function startRunningRoutePolling(url) {
  if (routePollTimer) clearInterval(routePollTimer);
  routePollTimer = null;
  currentRunningRouteData = null;
  clearRouteGroup();

  if (!url) return;
  loadRunningRoute(url);
  routePollTimer = setInterval(() => loadRunningRoute(url), 2000);
}

function setRunningRoute(url) {
  currentRunningRouteUrl = url || '';
  startRunningRoutePolling(currentRunningRouteUrl);
}

function drawRunningRoute(route) {
  clearRouteGroup();

  if (!route.mission || !Array.isArray(route.horizontalPoints) || route.horizontalPoints.length === 0) {
    console.log('No running mission route to draw');
    return;
  }

  const horizontal = route.horizontalPoints
    .map((point, index) => horizontalRoutePointToScene(point, route.strategy?.takeOffAltitude, index))
    .filter(Boolean);

  if (horizontal.length >= 2) {
    routeGroup.add(createRouteLine(horizontal.map(point => point.position), 0x58ffd8));
  }

  for (const point of horizontal) {
    routeGroup.add(createRouteWaypoint(point.position, 0x58ffd8));
    if (point.name) routeGroup.add(createRouteLabel(point.name, point.position, 0x58ffd8));
  }

  const vertical = (route.verticalPoints || [])
    .map((point, index) => verticalRoutePointToScene(point, route.strategy?.takeOffAltitude, index))
    .filter(Boolean);

  if (vertical.length >= 2) {
    routeGroup.add(createRouteLine(vertical.map(point => point.position), 0xfff36d));
  }

  for (const point of vertical) {
    routeGroup.add(createRouteWaypoint(point.position, 0xfff36d, 0.045));
  }

  const labelPosition = horizontal[0]?.position || vertical[0]?.position;
  if (labelPosition) {
    routeGroup.add(createRouteLabel(route.mission.missionName || 'Running Mission', labelPosition.clone().add(new THREE.Vector3(0, 0.45, 0)), 0xfff36d));
  }

  console.log(`Running route drawn: ${route.mission.missionName || route.mission.id}, horizontal=${horizontal.length}, vertical=${vertical.length}`);
}

function horizontalRoutePointToScene(point, takeOffAltitude, index) {
  const x = toFiniteNumber(point.horizontalX);
  const y = toFiniteNumber(point.horizontalY);
  const z = toFiniteNumber(point.horizontalZ) ?? toFiniteNumber(takeOffAltitude) ?? 0;
  if (x == null || y == null) return null;
  return {
    position: routeCoordinateToScene(x, y, z),
    name: point.horizontalPointName || `P${index + 1}`
  };
}

function verticalRoutePointToScene(point, takeOffAltitude) {
  const x = toFiniteNumber(point.verticalX);
  const y = toFiniteNumber(point.verticalY);
  const z = toFiniteNumber(point.verticalUpDownTargetHeight) ?? toFiniteNumber(takeOffAltitude) ?? 0;
  if (x == null || y == null) return null;
  return { position: routeCoordinateToScene(x, y, z) };
}

function routeCoordinateToScene(horizontalX, horizontalY, horizontalZ) {
  if (calibration.ready) {
    return calibration.origin.clone()
      .addScaledVector(calibration.xAxis, horizontalX)
      .addScaledVector(calibration.rightAxis, -horizontalY)
      .addScaledVector(calibration.upAxis, horizontalZ);
  }

  return new THREE.Vector3(horizontalX, horizontalZ, horizontalY);
}

function createRouteLine(points, color) {
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 });
  return new THREE.Line(geometry, material);
}

function createRouteWaypoint(position, color, size = 0.065) {
  const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
  const marker = new THREE.Mesh(new THREE.SphereGeometry(size, 12, 8), material);
  marker.position.copy(position);
  return marker;
}

function createRouteLabel(text, position, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  context.font = 'bold 34px sans-serif';
  context.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  context.shadowColor = context.fillStyle;
  context.shadowBlur = 12;
  context.fillText(String(text).slice(0, 24), 14, 58);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  sprite.position.copy(position).add(new THREE.Vector3(0, 0.22, 0));
  sprite.scale.set(1.4, 0.35, 1);
  return sprite;
}

function clearRouteGroup() {
  for (const child of [...routeGroup.children]) {
    routeGroup.remove(child);
    child.geometry?.dispose();
    child.material?.map?.dispose?.();
    child.material?.dispose?.();
  }
}

function calibrateXAxisFromCurrentHeading() {
  if (!calibration.origin) {
    console.warn('X axis calibration ignored: origin is not set');
    sendCalibration();
    return;
  }
  updateDroneVectors();
  calibration.xAxis.copy(droneDirection).normalize();
  calibration.xAxis.y = 0;
  if (calibration.xAxis.lengthSq() < 0.0001) return;
  calibration.xAxis.normalize();
  calibration.rightAxis.crossVectors(calibration.xAxis, calibration.upAxis).normalize();
  calibration.xAxisYaw = droneState.yaw;
  calibration.xAxisPoint = calibration.origin.clone().add(calibration.xAxis);
  calibration.ready = true;
  updateCalibrationMarker();
  if (currentRunningRouteData) drawRunningRoute(currentRunningRouteData);
  sendCalibration();
  saveCalibration();
}

async function loadSavedCalibration(url) {
  if (!url) return;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const result = await response.json();
    if (!result.exists || !result.calibration) {
      console.log('No saved calibration for point cloud:', currentPointCloudFile);
      return;
    }

    applySavedCalibration(result.calibration);
    sendCalibration();
    console.log('Loaded saved calibration:', currentPointCloudFile);
  } catch (error) {
    console.warn('Saved calibration load failed:', error.message || error);
  }
}

function applySavedCalibration(data) {
  calibration.origin = vectorFromPayload(data.origin);
  calibration.xAxisPoint = vectorFromPayload(data.xAxisPoint);
  calibration.xAxis.copy(vectorFromPayload(data.xAxis) || new THREE.Vector3(1, 0, 0)).normalize();
  calibration.xAxis.y = 0;
  if (calibration.xAxis.lengthSq() < 0.0001) calibration.xAxis.set(1, 0, 0);
  calibration.xAxis.normalize();
  calibration.rightAxis.crossVectors(calibration.xAxis, calibration.upAxis).normalize();
  calibration.xAxisYaw = THREE.MathUtils.degToRad(Number(data.xAxisYaw) || 0);
  calibration.ready = Boolean(data.ready && calibration.origin && calibration.xAxisPoint);

  if (calibration.ready) {
    droneState.position.copy(calibration.origin);
    droneState.yaw = calibration.xAxisYaw;
    updateDronePose();
  }
  updateCalibrationMarker();
  if (currentRunningRouteData) drawRunningRoute(currentRunningRouteData);
}

async function saveCalibration() {
  if (!calibration.ready || !currentCalibrationUrl) return;

  const payload = {
    pointCloudFile: currentPointCloudFile,
    origin: vectorPayload(calibration.origin),
    xAxisPoint: vectorPayload(calibration.xAxisPoint),
    xAxis: vectorPayload(calibration.xAxis),
    xAxisYaw: Number(THREE.MathUtils.radToDeg(calibration.xAxisYaw).toFixed(6)),
    ready: calibration.ready
  };

  try {
    const response = await fetch(currentCalibrationUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    console.log('Saved calibration:', currentPointCloudFile);
  } catch (error) {
    console.warn('Calibration save failed:', error.message || error);
  }
}

function applyRealtimeUavState(payload) {
  const data = payload?.data || payload;
  if (!data) return;

  const previousPosition = droneState.position.clone();
  const previousYaw = droneState.yaw;

  const horizontalX = toFiniteNumber(data.horizontalX);
  const horizontalY = toFiniteNumber(data.horizontalY);
  const horizontalZ = toFiniteNumber(data.horizontalZ);
  const uavYaw = toFiniteNumber(data.uavYawForBoard) ?? toFiniteNumber(data.uavYaw);
  const gimbalPitch = toFiniteNumber(data.gimbalPitch);

  if (horizontalX == null || horizontalY == null || horizontalZ == null) return;

  if (calibration.ready) {
    droneState.position.copy(calibration.origin)
      .addScaledVector(calibration.xAxis, horizontalX)
      .addScaledVector(calibration.rightAxis, -horizontalY)
      .addScaledVector(calibration.upAxis, horizontalZ);
    if (uavYaw != null) droneState.yaw = calibration.xAxisYaw + THREE.MathUtils.degToRad(uavYaw);
  } else {
    droneState.position.set(horizontalX, horizontalZ, horizontalY);
    if (uavYaw != null) droneState.yaw = THREE.MathUtils.degToRad(uavYaw - 90);
  }

  if (gimbalPitch != null) droneState.gimbalPitch = THREE.MathUtils.degToRad(gimbalPitch);
  if (previousPosition.distanceToSquared(droneState.position) > 0.000001 || Math.abs(previousYaw - droneState.yaw) > 0.000001) {
    markDroneMoving(2500);
  }
  updateDronePose();
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sendCalibration() {
  send({
    type: 'calibration',
    origin: vectorPayload(calibration.origin),
    xAxisPoint: vectorPayload(calibration.xAxisPoint),
    xAxis: vectorPayload(calibration.xAxis),
    xAxisYaw: Number(THREE.MathUtils.radToDeg(calibration.xAxisYaw).toFixed(1)),
    ready: calibration.ready
  });
}

function vectorPayload(vector) {
  if (!vector) return null;
  return {
    x: Number(vector.x.toFixed(3)),
    y: Number(vector.y.toFixed(3)),
    z: Number(vector.z.toFixed(3))
  };
}

function vectorFromPayload(value) {
  if (!value) return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return new THREE.Vector3(x, y, z);
}

function createDroneMarker() {
  const group = new THREE.Group();
  const body = new THREE.ConeGeometry(0.22, 0.7, 4);
  body.rotateX(Math.PI / 2);
  const material = new THREE.MeshStandardMaterial({
    color: 0x58ffd8,
    emissive: 0x1af0c8,
    emissiveIntensity: 1.8,
    metalness: 0.1,
    roughness: 0.25
  });
  const arrowHead = new THREE.Mesh(body, material);
  arrowHead.position.z = -0.34;
  group.add(arrowHead);

  const tail = new THREE.CylinderGeometry(0.045, 0.045, 0.65, 12);
  tail.rotateX(Math.PI / 2);
  const tailMesh = new THREE.Mesh(tail, material);
  tailMesh.position.z = 0.18;
  group.add(tailMesh);

  const ring = new THREE.TorusGeometry(0.34, 0.012, 8, 36);
  ring.rotateX(Math.PI / 2);
  const ringMaterial = new THREE.MeshBasicMaterial({ color: 0xf2c66d });
  group.add(new THREE.Mesh(ring, ringMaterial));

  const light = new THREE.PointLight(0x58ffd8, 1.8, 3);
  light.position.set(0, 0.15, 0);
  group.add(light);
  return group;
}

function loadDroneModel(url) {
  const loader = new GLTFLoader();
  loader.load(url, gltf => {
    droneMixer = null;
    droneAnimationActions = [];
    droneAnimationActive = false;

    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxSize = Math.max(size.x, size.y, size.z) || 1;

    model.position.sub(center);

    const modelPivot = new THREE.Group();
    modelPivot.scale.setScalar(0.9 / maxSize);
    modelPivot.rotation.y = Math.PI;
    modelPivot.add(model);

    model.traverse(child => {
      if (!child.isMesh) return;
      child.frustumCulled = true;
      if (child.material) child.material.needsUpdate = true;
    });

    drone.clear();
    drone.add(modelPivot);
    if (gltf.animations?.length) {
      droneMixer = new THREE.AnimationMixer(model);
      droneAnimationActions = gltf.animations.map(clip => {
        const action = droneMixer.clipAction(clip);
        action.enabled = true;
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.clampWhenFinished = false;
        return action;
      });
      setDroneAnimationActive(false);
      console.log('Drone GLB animations:', gltf.animations.map(clip => clip.name || '(unnamed)').join(', '));
    }
    console.log('Drone GLB loaded:', url);
    updateDronePose(false);
  }, undefined, error => {
    console.warn('Drone GLB load failed, fallback arrow is used:', error.message || error);
  });
}

function markDroneMoving(durationMs = 1200) {
  droneAnimationStopAt = Math.max(droneAnimationStopAt, performance.now() + durationMs);
  setDroneAnimationActive(true);
}

function setDroneAnimationActive(active) {
  if (droneAnimationActive === active) return;
  droneAnimationActive = active;

  for (const action of droneAnimationActions) {
    if (active) {
      action.paused = false;
      action.play();
    } else {
      action.stop();
    }
  }
}

function updateDroneAnimations(delta) {
  if (droneAnimationActive && performance.now() > droneAnimationStopAt) {
    setDroneAnimationActive(false);
  }
  droneMixer?.update(delta);
}

function updateDroneVectors() {
  droneDirection.set(-Math.sin(droneState.yaw), 0, -Math.cos(droneState.yaw)).normalize();
  droneRight.set(Math.cos(droneState.yaw), 0, -Math.sin(droneState.yaw)).normalize();
}

function updateDronePose(emit = true) {
  updateDroneVectors();
  drone.position.copy(droneState.position);
  drone.rotation.set(0, droneState.yaw, 0);

  const lookYaw = droneState.yaw + droneState.gimbalYaw;
  const lookPitch = droneState.pitch + droneState.gimbalPitch;
  const cp = Math.cos(lookPitch);
  const lookDirection = new THREE.Vector3(
    -Math.sin(lookYaw) * cp,
    Math.sin(lookPitch),
    -Math.cos(lookYaw) * cp
  ).normalize();

  droneCamera.position.copy(droneState.position).addScaledVector(lookDirection, 0.25);
  droneLookTarget.copy(droneCamera.position).addScaledVector(lookDirection, 10);
  droneCamera.lookAt(droneLookTarget);

  if (emit) sendTelemetry();
}

function sendTelemetry() {
  send({
    type: 'telemetry',
    position: {
      x: Number(droneState.position.x.toFixed(3)),
      y: Number(droneState.position.y.toFixed(3)),
      z: Number(droneState.position.z.toFixed(3))
    },
    yaw: Number(THREE.MathUtils.radToDeg(droneState.yaw).toFixed(1)),
    pitch: Number(THREE.MathUtils.radToDeg(droneState.pitch).toFixed(1)),
    gimbalYaw: Number(THREE.MathUtils.radToDeg(droneState.gimbalYaw).toFixed(1)),
    gimbalPitch: Number(THREE.MathUtils.radToDeg(droneState.gimbalPitch).toFixed(1))
  });
}

function updateCamera() {
  camera.position.setFromSpherical(spherical).add(target);
  camera.lookAt(target);
}

function animate() {
  requestAnimationFrame(animate);
  const delta = animationClock.getDelta();
  updateDroneAnimations(delta);
  updateFps();
  renderer.clear();
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, streamConfig.width, streamConfig.height);
  renderer.render(scene, camera);

  const insetWidth = Math.round(streamConfig.width * 0.28);
  const insetHeight = Math.round(insetWidth * 9 / 16);
  const insetX = streamConfig.width - insetWidth - 28;
  const insetY = 28;

  renderer.clearDepth();
  renderer.setScissorTest(true);
  renderer.setScissor(insetX, insetY, insetWidth, insetHeight);
  renderer.setViewport(insetX, insetY, insetWidth, insetHeight);
  drone.visible = false;
  renderer.render(scene, droneCamera);
  drone.visible = true;
  renderer.setScissorTest(false);

  renderer.clearDepth();
  renderer.setViewport(0, 0, streamConfig.width, streamConfig.height);
  renderer.render(overlayScene, overlayCamera);
}

function updateFps() {
  fpsFrameCount += 1;
  const now = performance.now();
  const elapsed = now - fpsLastTime;
  if (elapsed < 500) return;
  fpsValue = fpsFrameCount * 1000 / elapsed;
  fpsFrameCount = 0;
  fpsLastTime = now;
  drawFpsOverlay();
}

function drawFpsOverlay() {
  fpsContext.clearRect(0, 0, fpsCanvas.width, fpsCanvas.height);
  fpsContext.fillStyle = 'rgba(4, 16, 18, 0.78)';
  roundRect(fpsContext, 0, 0, fpsCanvas.width, fpsCanvas.height, 16);
  fpsContext.fill();
  fpsContext.strokeStyle = 'rgba(96, 240, 210, 0.65)';
  fpsContext.lineWidth = 3;
  fpsContext.stroke();
  fpsContext.fillStyle = '#60f0d2';
  fpsContext.font = '700 28px Consolas, monospace';
  fpsContext.fillText(`FPS ${fpsValue.toFixed(1)}`, 22, 42);
  fpsTexture.needsUpdate = true;
}

function roundRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}


