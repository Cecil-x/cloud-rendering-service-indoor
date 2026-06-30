import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${PORT}`;
const POINT_CLOUD_FILE = process.env.POINT_CLOUD_FILE || process.env.PLY_FILE || 'map_aligned_icp_baked.ply';
const MODEL_DIR = path.join(__dirname, 'models');
const STREAM_WIDTH = Number(process.env.STREAM_WIDTH || 1920);
const STREAM_HEIGHT = Number(process.env.STREAM_HEIGHT || 1080);
const STREAM_FPS = Number(process.env.STREAM_FPS || 30);
const STREAM_BITRATE = Number(process.env.STREAM_BITRATE || 8_000_000);
const SESSION_IDLE_TIMEOUT_MS = Number(process.env.SESSION_IDLE_TIMEOUT_MS || 5_000);
const UAV_API_BASE = process.env.UAV_API_BASE || 'http://114.116.235.66/indoorUavFlightControlBackend';
const UAV_API_USERNAME = process.env.UAV_API_USERNAME || 'YmfDemo';
const UAV_API_PASSWORD = process.env.UAV_API_PASSWORD || '888888';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/signal' });

const sessions = new Map();
let browserPromise;
let uavTokenCache = { token: '', expiresAt: 0 };
const supportedPointCloudExtensions = new Set(['.ply', '.pcd', '.json']);

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOW_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: res => {
    res.setHeader('Cache-Control', 'no-store');
  }
}));

app.use('/assets', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/assets/pointcloud.ply', (req, res) => {
  res.sendFile(getPointCloudPath(req.query.file));
});

app.get('/assets/pointcloud', (req, res) => {
  res.sendFile(getPointCloudPath(req.query.file));
});

app.get('/assets/pointcloud/*', (req, res) => {
  res.sendFile(getPointCloudAssetPath(req.params[0]));
});

app.get('/assets/pointcloud/:file', (req, res) => {
  res.sendFile(getPointCloudPath(req.params.file));
});

app.get('/api/point-clouds', (_req, res) => {
  res.json({
    current: POINT_CLOUD_FILE,
    files: listPointCloudFiles()
  });
});

app.get('/api/point-cloud-calibration', (req, res) => {
  const calibrationPath = getCalibrationPath(req.query.file);
  if (!fs.existsSync(calibrationPath)) {
    res.json({ ok: true, exists: false, calibration: null });
    return;
  }

  try {
    const calibration = JSON.parse(fs.readFileSync(calibrationPath, 'utf8'));
    res.json({ ok: true, exists: true, calibration });
  } catch (error) {
    res.status(500).json({ ok: false, error: `Failed to read calibration: ${error.message}` });
  }
});

app.post('/api/point-cloud-calibration', (req, res) => {
  const pointCloudFile = resolvePointCloudFile(req.query.file || req.body?.pointCloudFile);
  const calibrationPath = getCalibrationPath(pointCloudFile);
  const calibration = normalizeCalibration(req.body, pointCloudFile);

  if (!calibration) {
    res.status(400).json({ ok: false, error: 'Invalid calibration payload' });
    return;
  }

  fs.mkdirSync(path.dirname(calibrationPath), { recursive: true });
  fs.writeFileSync(calibrationPath, JSON.stringify(calibration, null, 2));
  console.log(`Calibration saved: ${path.relative(MODEL_DIR, calibrationPath)}`);
  res.json({ ok: true, file: path.relative(MODEL_DIR, calibrationPath), calibration });
});

app.get('/api/uav/running-route', async (_req, res) => {
  try {
    const route = await getRunningUavRoute(_req.query?.missionId || _req.query?.flightStrategyId);
    res.json({ ok: true, ...route });
  } catch (error) {
    console.error('Running route fetch failed:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/uav/available-routes', async (_req, res) => {
  try {
    const routes = await getAvailableUavRoutes();
    res.json({ ok: true, routes });
  } catch (error) {
    console.error('Available routes fetch failed:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/session', async (req, res) => {
  const id = randomUUID();
  const pointCloudFile = resolvePointCloudFile(req.body?.pointCloudFile);
  const session = { id, pointCloudFile, clients: new Set(), renderer: null, page: null, cleanupTimer: null, createdAt: Date.now() };
  sessions.set(id, session);
  console.log(`Session ${id} point cloud: ${pointCloudFile}`);
  res.json({ id, pointCloudFile });

  try {
    session.page = await openRenderer(id);
  } catch (error) {
    console.error(`Session ${id} renderer failed:`, error.message);
    sessions.delete(id);
  }
});

app.post('/api/session/:id/close', async (req, res) => {
  const closed = await cleanupSession(req.params.id, { force: true, reason: 'client requested close' });
  res.json({ ok: true, closed });
});

app.delete('/api/session/:id', async (req, res) => {
  const closed = await cleanupSession(req.params.id, { force: true, reason: 'client requested delete' });
  res.json({ ok: true, closed });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, sessions: sessions.size });
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, PUBLIC_ORIGIN);
  const sessionId = url.searchParams.get('session');
  const role = url.searchParams.get('role');
  const session = sessions.get(sessionId);

  if (!session || !['client', 'renderer'].includes(role)) {
    ws.close(1008, 'Invalid session or role');
    return;
  }

  ws.role = role;
  ws.sessionId = sessionId;

  if (role === 'renderer') {
    session.renderer = ws;
    send(ws, {
      type: 'config',
      pointCloudUrl: `/assets/pointcloud/${encodePointCloudPath(session.pointCloudFile)}?v=${Date.now()}`,
      pointCloudFile: session.pointCloudFile,
      calibrationUrl: `/api/point-cloud-calibration?file=${encodeURIComponent(session.pointCloudFile)}`,
      runningRouteUrl: '/api/uav/running-route',
      stream: {
        width: STREAM_WIDTH,
        height: STREAM_HEIGHT,
        fps: STREAM_FPS,
        bitrate: STREAM_BITRATE
      }
    });
    for (const client of session.clients) send(client, { type: 'renderer-ready' });
  } else {
    clearCleanupTimer(session);
    session.clients.add(ws);
    if (session.renderer?.readyState === ws.OPEN) send(ws, { type: 'renderer-ready' });
  }

  ws.on('message', data => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    console.log('Signal ' + role + ' -> ' + (role === 'client' ? 'renderer' : 'client') + ': ' + message.type);
    if (message.type === 'ice' && message.candidate) {
      console.log('ICE candidate from ' + role + ': ' + message.candidate.candidate);
    }

    if (role === 'client') {
      if (session.renderer?.readyState === ws.OPEN) send(session.renderer, message);
      return;
    }

    for (const client of session.clients) {
      if (client.readyState === ws.OPEN) send(client, message);
    }
  });

  ws.on('close', async () => {
    if (role === 'client') session.clients.delete(ws);
    if (role === 'renderer' && session.renderer === ws) session.renderer = null;

    if (session.clients.size === 0) scheduleCleanup(sessionId, role === 'client' ? 'last client disconnected' : 'renderer disconnected');
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Cloud streaming server: http://127.0.0.1:${PORT}`);
  console.log(`Process PID: ${process.pid}`);
  console.log(`Point cloud source: ${getPointCloudPath(POINT_CLOUD_FILE)}`);
  console.log(`Available point clouds: ${listPointCloudFiles().join(', ') || 'none'}`);
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Run "npm run stop" or start with another port: set PORT=3100&& npm start`);
  }
  process.exit(1);
});

async function openRenderer(sessionId) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  page.on('console', msg => console.log(`[renderer:${sessionId}] ${msg.type()}: ${msg.text()}`));
  page.on('pageerror', error => console.error(`[renderer:${sessionId}]`, error));
  page.on('close', () => {
    const session = sessions.get(sessionId);
    if (session) {
      session.page = null;
      if (session.clients.size === 0) scheduleCleanup(sessionId, 'renderer page closed');
    }
  });
  await page.goto(`${PUBLIC_ORIGIN}/renderer.html?session=${sessionId}`, { waitUntil: 'networkidle0' });
  return page;
}

async function getBrowser() {
  if (!browserPromise) {
    const executablePath = getChromeExecutablePath();
    if (!executablePath) {
      console.warn('No local Chrome / Edge executable found. Set CHROME_PATH or run: npx puppeteer browsers install chrome');
    }
    browserPromise = puppeteer.launch({
      headless: process.env.HEADLESS === 'false' ? false : 'new',
      ...(executablePath ? { executablePath } : {}),
      defaultViewport: { width: STREAM_WIDTH, height: STREAM_HEIGHT, deviceScaleFactor: 1 },
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--disable-dev-shm-usage',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--use-gl=angle',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
        '--force-webrtc-ip-handling-policy=default_public_and_private_interfaces',
        '--no-sandbox'
      ]
    });
  }
  try {
    return await browserPromise;
  } catch (error) {
    browserPromise = null;
    throw error;
  }
}

function getChromeExecutablePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const candidates = os.platform() === 'win32' ? [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Users/XTJ/AppData/Local/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Users/XTJ/AppData/Local/Microsoft/Edge/Application/msedge.exe',
    path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe')
  ] : [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ];

  const executablePath = candidates.find(candidate => candidate && fs.existsSync(candidate));
  if (executablePath) console.log(`Browser executable: ${executablePath}`);
  return executablePath;
}

function listPointCloudFiles() {
  if (!fs.existsSync(MODEL_DIR)) return [];
  const rootFiles = fs.readdirSync(MODEL_DIR)
    .filter(file => supportedPointCloudExtensions.has(path.extname(file).toLowerCase()));
  const tileManifests = fs.readdirSync(MODEL_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.endsWith('.tiles'))
    .map(entry => path.join(entry.name, 'manifest.json'))
    .filter(file => fs.existsSync(path.join(MODEL_DIR, file)));
  return [...rootFiles, ...tileManifests]
    .sort((a, b) => a.localeCompare(b));
}

function resolvePointCloudFile(fileName) {
  if (!fileName) return POINT_CLOUD_FILE;
  const normalized = normalizePointCloudPath(fileName);
  const extension = path.extname(normalized).toLowerCase();
  const fullPath = path.join(MODEL_DIR, normalized);

  if (!normalized || !supportedPointCloudExtensions.has(extension) || !isInsideModelDir(fullPath) || !fs.existsSync(fullPath)) {
    return POINT_CLOUD_FILE;
  }

  return normalized;
}

function getPointCloudPath(fileName) {
  return path.join(MODEL_DIR, resolvePointCloudFile(fileName));
}

function getCalibrationPath(fileName) {
  const pointCloudFile = resolvePointCloudFile(fileName);
  const pointCloudPath = path.join(MODEL_DIR, pointCloudFile);

  if (path.basename(pointCloudPath).toLowerCase() === 'manifest.json' && path.basename(path.dirname(pointCloudPath)).endsWith('.tiles')) {
    return path.join(path.dirname(pointCloudPath), 'origin.txt');
  }

  return path.join(path.dirname(pointCloudPath), `${path.basename(pointCloudPath, path.extname(pointCloudPath))}.origin.txt`);
}

function getPointCloudAssetPath(fileName) {
  const normalized = normalizePointCloudPath(fileName);
  const extension = path.extname(normalized).toLowerCase();
  const fullPath = path.join(MODEL_DIR, normalized);

  if (!normalized || !isInsideModelDir(fullPath) || !fs.existsSync(fullPath)) {
    return getPointCloudPath(POINT_CLOUD_FILE);
  }

  if (supportedPointCloudExtensions.has(extension)) return fullPath;

  const parts = normalized.split('/');
  if (extension === '.bin' && parts.length >= 2 && parts[0].endsWith('.tiles')) {
    return fullPath;
  }

  return getPointCloudPath(POINT_CLOUD_FILE);
}

function normalizePointCloudPath(fileName) {
  const normalized = String(fileName || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(part => part && part !== '.' && part !== '..')
    .join('/');
  return normalized;
}

function encodePointCloudPath(fileName) {
  return normalizePointCloudPath(fileName).split('/').map(encodeURIComponent).join('/');
}

function isInsideModelDir(filePath) {
  const relative = path.relative(MODEL_DIR, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeCalibration(payload, pointCloudFile) {
  const origin = normalizeVector(payload?.origin);
  const xAxisPoint = normalizeVector(payload?.xAxisPoint);
  const xAxis = normalizeVector(payload?.xAxis);
  const xAxisYaw = Number(payload?.xAxisYaw);

  if (!origin || !xAxisPoint || !xAxis || !Number.isFinite(xAxisYaw) || payload?.ready !== true) {
    return null;
  }

  return {
    version: 1,
    pointCloudFile,
    updatedAt: new Date().toISOString(),
    ready: true,
    origin,
    xAxisPoint,
    xAxis,
    xAxisYaw
  };
}

function normalizeVector(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  const z = Number(value?.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
}

async function getRunningUavRoute(selectedId = '') {
  const token = await getUavToken();
  console.log('[UAV] Fetch running route start');
  const missions = await getUavMissionCandidates(token);
  let runningMission = selectedId ? findMissionBySelectedId(missions, selectedId) : findRunningMission(missions);

  logMissionCandidates(missions);

  if (!runningMission) {
    console.log('[UAV] No running mission selected. Known state fields:', missions.slice(0, 10).map(mission => pickMissionDebugFields(mission)));
    return { mission: null, strategy: null, horizontalPoints: [], verticalPoints: [] };
  }

  console.log('[UAV] Running mission selected:', pickMissionDebugFields(runningMission));

  const strategyId = runningMission.flightStrategyId || runningMission.strategyId || runningMission.flightHorizontalStrategyId;
  if (!strategyId) throw new Error('Running mission has no flightStrategyId');

  const strategyResult = await callUavApi('/flightHorizontalStrategy/getFlightHorizontalStrategyDetail', { id: strategyId }, token);
  const strategy = strategyResult?.data || {};
  const horizontalPoints = Array.isArray(strategy.horizontalPointList) ? strategy.horizontalPointList : [];
  const verticalPoints = Array.isArray(strategy.verticalStrategy?.verticalPointList) ? strategy.verticalStrategy.verticalPointList : [];
  console.log('[UAV] Strategy detail:', {
    errorCode: strategyResult?.errorCode,
    dataKeys: Object.keys(strategy),
    takeOffAltitude: strategy.takeOffAltitude,
    horizontalPoints: horizontalPoints.length,
    verticalPoints: verticalPoints.length,
    firstHorizontalPoint: summarizeObject(horizontalPoints[0]),
    firstVerticalPoint: summarizeObject(verticalPoints[0])
  });

  return {
    mission: {
      id: runningMission.id,
      flightStrategyId: strategyId,
      missionName: runningMission.missionName,
      historyState: runningMission.historyState,
      historyStateDescription: runningMission.historyStateDescription
    },
    strategy: {
      takeOffAltitude: strategy.takeOffAltitude
    },
    horizontalPoints,
    verticalPoints
  };
}

async function getAvailableUavRoutes() {
  const token = await getUavToken();
  const missions = await getUavMissionCandidates(token);
  return missions
    .filter(mission => String(mission.missionState ?? '') === '1')
    .filter(mission => mission.flightStrategyId || mission.strategyId || mission.flightHorizontalStrategyId)
    .map(mission => ({
      id: mission.id,
      value: String(mission.id || mission.flightStrategyId || mission.strategyId || mission.flightHorizontalStrategyId),
      flightStrategyId: mission.flightStrategyId || mission.strategyId || mission.flightHorizontalStrategyId,
      missionName: mission.missionName || mission.name || mission.taskName || `航线-${mission.id || mission.flightStrategyId}`,
      missionState: mission.missionState,
      historyState: mission.historyState,
      historyStateDescription: mission.historyStateDescription,
      state: mission.state,
      status: mission.status
    }));
}

async function getUavMissionCandidates(token) {
  const missionResult = await callUavApi('/flightMission/getFlightMissionPagingList', {
    current: 1,
    pageSize: 100,
    missionType: 1
  }, token);

  let missions = extractMissionList(missionResult);
  logMissionQuery('missionType=1', missionResult, missions);

  if (!findRunningMission(missions)) {
    console.log('[UAV] No running mission with missionType=1, retry without missionType');
    const fallbackResult = await callUavApi('/flightMission/getFlightMissionPagingList', {
      current: 1,
      pageSize: 100
    }, token);
    const fallbackMissions = extractMissionList(fallbackResult);
    logMissionQuery('without missionType', fallbackResult, fallbackMissions);
    missions = fallbackMissions.length ? fallbackMissions : missions;
  }

  logMissionCandidates(missions);
  return missions;
}

function findMissionBySelectedId(missions, selectedId) {
  const id = String(selectedId);
  return missions.find(mission => [
    mission.id,
    mission.flightStrategyId,
    mission.strategyId,
    mission.flightHorizontalStrategyId
  ].some(value => String(value ?? '') === id));
}

function extractMissionList(result) {
  const data = result?.data || {};
  const list = data.list || data.records || data.rows || data.data || [];
  return Array.isArray(list) ? list : [];
}

function findRunningMission(missions) {
  const strictRunning = missions.find(mission => {
    const state = String(mission.historyState ?? mission.state ?? mission.status ?? mission.missionState ?? '');
    const text = String(mission.historyStateDescription ?? mission.stateDescription ?? mission.statusDescription ?? '');
    return state === '4' || /执行中|飞行中|运行中|正在执行/.test(text);
  });

  if (strictRunning) return strictRunning;

  const missionStateRunning = missions.find(mission => String(mission.missionState ?? '') === '1' && mission.flightStrategyId);
  if (missionStateRunning) {
    console.log('[UAV] Fallback selected missionState=1 as running mission:', pickMissionDebugFields(missionStateRunning));
  }
  return missionStateRunning;
}

function logMissionQuery(label, result, missions) {
  console.log(`[UAV] Mission query ${label}:`, {
    errorCode: result?.errorCode,
    errorMessage: result?.errorMessage,
    dataKeys: Object.keys(result?.data || {}),
    listLength: missions.length,
    pagination: result?.data?.pagination || result?.data?.page || null
  });
}

function logMissionCandidates(missions) {
  console.log('[UAV] Mission candidates:', missions.slice(0, 20).map(pickMissionDebugFields));
}

function pickMissionDebugFields(mission = {}) {
  return {
    keys: Object.keys(mission),
    id: mission.id,
    missionName: mission.missionName,
    flightStrategyId: mission.flightStrategyId,
    strategyId: mission.strategyId,
    flightHorizontalStrategyId: mission.flightHorizontalStrategyId,
    historyState: mission.historyState,
    state: mission.state,
    status: mission.status,
    missionState: mission.missionState,
    historyStateDescription: mission.historyStateDescription,
    stateDescription: mission.stateDescription,
    statusDescription: mission.statusDescription
  };
}

function summarizeObject(value) {
  if (!value || typeof value !== 'object') return value || null;
  const summary = {};
  for (const key of Object.keys(value).slice(0, 30)) summary[key] = value[key];
  return summary;
}

async function getUavToken() {
  const now = Date.now();
  if (uavTokenCache.token && uavTokenCache.expiresAt > now + 60_000) {
    console.log('[UAV] Using cached token');
    return uavTokenCache.token;
  }

  console.log('[UAV] Login start:', { base: UAV_API_BASE, username: UAV_API_USERNAME });
  const result = await callUavApi('/system/thirdPartyLogin', {
    username: UAV_API_USERNAME,
    password: UAV_API_PASSWORD
  });

  const token = result?.data?.token;
  if (!token) throw new Error('UAV login did not return data.token');
  console.log('[UAV] Login ok:', { tokenPrefix: `${String(token).slice(0, 8)}...`, errorCode: result.errorCode });

  uavTokenCache = {
    token,
    expiresAt: now + 6 * 24 * 60 * 60 * 1000
  };
  return token;
}

async function callUavApi(apiPath, body, token = '') {
  const startedAt = Date.now();
  const response = await fetch(`${UAV_API_BASE}${apiPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token } : {})
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) throw new Error(`UAV API ${apiPath} failed: ${response.status} ${response.statusText}`);
  const result = await response.json();
  console.log('[UAV] API response:', {
    path: apiPath,
    status: response.status,
    ms: Date.now() - startedAt,
    errorCode: result?.errorCode,
    errorMessage: result?.errorMessage,
    dataKeys: Object.keys(result?.data || {})
  });
  if (result.errorCode && result.errorCode !== '00000') {
    throw new Error(`UAV API ${apiPath} error ${result.errorCode}: ${result.errorMessage || 'unknown error'}`);
  }
  return result;
}

function scheduleCleanup(sessionId, reason) {
  const session = sessions.get(sessionId);
  if (!session || session.cleanupTimer) return;
  session.cleanupTimer = setTimeout(() => {
    cleanupSession(sessionId, { reason }).catch(error => console.error(`Session ${sessionId} cleanup failed:`, error));
  }, SESSION_IDLE_TIMEOUT_MS);
  session.cleanupTimer.unref?.();
}

function clearCleanupTimer(session) {
  if (!session?.cleanupTimer) return;
  clearTimeout(session.cleanupTimer);
  session.cleanupTimer = null;
}

async function cleanupSession(sessionId, options = {}) {
  const { force = false, reason = 'idle' } = options;
  const session = sessions.get(sessionId);
  if (!session || (!force && session.clients.size > 0)) return false;
  clearCleanupTimer(session);
  sessions.delete(sessionId);
  console.log(`Session ${sessionId} cleanup: ${reason}`);

  for (const client of session.clients) {
    try { client.close(1000, 'Session closed'); } catch {}
  }
  try { session.renderer?.close(1000, 'Session closed'); } catch {}
  try { await session.page?.close({ runBeforeUnload: false }); } catch {}
  return true;
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}



