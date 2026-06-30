# Three.js Cloud Streaming Point Cloud Demo

This project is a cloud rendering / cloud streaming prototype for PLY and PCD point clouds.

The server starts a Chromium / Edge renderer with Puppeteer. That renderer loads the point cloud with Three.js, renders into a canvas, captures the canvas as a WebRTC video track, and streams it to the browser. The browser only plays the video stream and sends mouse / wheel input back through WebSocket signaling.

The currently verified deployments are:

- Windows rendering host on the LAN, using Edge / Chrome + ANGLE / Direct3D.
- Linux rendering host with NVIDIA GPU, using Xorg `:99` + NVIDIA GLX + Chrome ANGLE OpenGL. See `LINUX_DEPLOY.md` and `GPU系统排查.md`.

Cross-subnet clients should use the TURN page described below.

## Run

```bash
npm install
npm start
```

Open `http://127.0.0.1:3000`, then click `启动云渲染会话`.

## Startup Commands

### Windows

PowerShell, Edge renderer:

```powershell
cd D:\uav\dfe-patrol-indoorUav-all\three.js
$env:CHROME_PATH="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$env:HOST="0.0.0.0"
$env:PORT="3000"
$env:POINT_CLOUD_FILE="all_points_aligned_icp_baked.tiles/manifest.json"
npm start
```

PowerShell, Chrome renderer:

```powershell
cd D:\uav\dfe-patrol-indoorUav-all\three.js
$env:CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
$env:HOST="0.0.0.0"
$env:PORT="3000"
$env:POINT_CLOUD_FILE="all_points_aligned_icp_baked.tiles/manifest.json"
npm start
```

CMD shortcuts are also available:

```cmd
cd D:\uav\dfe-patrol-indoorUav-all\three.js
npm run start:edge
```

or:

```cmd
cd D:\uav\dfe-patrol-indoorUav-all\three.js
npm run start:chrome
```

If cross-subnet clients need TURN relay, start TURN in another terminal first:

```powershell
cd D:\uav\dfe-patrol-indoorUav-all\three.js
npm run turn
```

Then open:

```text
http://WINDOWS_HOST_IP:3000/turn.html
```

### Linux

Linux GPU startup depends on an NVIDIA-backed Xorg display. Start `Xorg :99` first as described in `LINUX_DEPLOY.md` / `GPU系统排查.md`, then run:

```bash
cd /home/df1500/xtj/three.js

DISPLAY=:99 \
__GLX_VENDOR_LIBRARY_NAME=nvidia \
__NV_PRIME_RENDER_OFFLOAD=1 \
HEADLESS=false \
CHROME_PATH=/home/df1500/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome \
HOST=0.0.0.0 \
PORT=3000 \
POINT_CLOUD_FILE=all_points_aligned_icp_baked.tiles/manifest.json \
STREAM_WIDTH=1280 \
STREAM_HEIGHT=720 \
STREAM_FPS=15 \
STREAM_BITRATE=4000000 \
npm start
```

Open from another machine:

```text
http://LINUX_SERVER_IP:3000/turn.html
```

For local LAN testing without TURN, `http://LINUX_SERVER_IP:3000` is also usable when ICE can connect directly.

## Point Cloud Splitting

Large PLY files should be converted to tiled binary format before Linux deployment, and it is also recommended on Windows for faster and safer loading.

Input file location:

```text
three.js/models/all_points_aligned_icp_baked.ply
```

Convert with 200,000 points per tile:

```bash
cd three.js
npm run convert:tiles -- all_points_aligned_icp_baked.ply 200000
```

Output:

```text
three.js/models/all_points_aligned_icp_baked.tiles/
  manifest.json
  tile_00000.bin
  tile_00001.bin
  ...
```

Use the converted model by setting:

```text
POINT_CLOUD_FILE=all_points_aligned_icp_baked.tiles/manifest.json
```

Do not include `models/` in `POINT_CLOUD_FILE`; paths are relative to `three.js/models`.

Use the `点云文件` selector on the page to switch between detected `.ply`, `.pcd`, and tiled `manifest.json` files in `models/`. The service also accepts `POINT_CLOUD_FILE=GlobalMap.pcd` or `POINT_CLOUD_FILE=all_points_aligned_icp_baked.tiles/manifest.json` as the default startup file.

For LAN access, start the service on the rendering server:

```bash
HOST=0.0.0.0 PORT=3000 npm start
```

Then open the page from another machine in the same LAN and fill the service address, for example `http://192.168.1.20:3000`. If you serve your own frontend page from a different host, the same address input can point to this rendering service because `/api/session` enables CORS and `/signal` uses WebSocket.

## Verified Windows LAN Setup

This version has been verified with the rendering service running on Windows and remote clients accessing it over the LAN / cross-subnet intranet.

Example verified topology:

```text
Windows rendering host: 172.20.13.53
Remote client host:     172.20.63.157
HTTP/WebSocket port:    3000/tcp
TURN port:              3478/udp
TURN relay ports:       49160-49200/udp
```

Start the TURN server in one PowerShell window:

```powershell
cd D:\uav\dfe-patrol-indoorUav-all\three.js
npm run turn
```

Expected output:

```text
TURN server listening on 0.0.0.0:3478
TURN relay IP: 172.20.13.53, relay ports: 49160-49200
TURN user: cloudrender
```

Start the cloud rendering service in another PowerShell window:

```powershell
cd D:\uav\dfe-patrol-indoorUav-all\three.js
npm start
```

Remote clients should open the TURN page, not the default page:

```text
http://172.20.13.53:3000/turn.html
```

The page's service address should also be:

```text
http://172.20.13.53:3000
```

For cache-sensitive testing, append any query string:

```text
http://172.20.13.53:3000/turn.html?x=1
```

The TURN mode is used because some browsers hide LAN addresses behind mDNS `.local` ICE candidates, and cross-subnet clients may not be able to resolve or connect to them directly.

Current Windows version updates:

```text
1. Point cloud assets are now read from models/ instead of the project root.
2. Large PLY files can be converted to *.tiles/manifest.json and loaded with the tiled binary loader.
3. Calibration is saved per model through /api/point-cloud-calibration.
4. The renderer can restore origin / X+ direction and show fluorescent origin markers.
5. The UAV GLB model can play its built-in flight / propeller animation while moving.
6. The renderer can poll /api/uav/running-route and draw task route overlays.
7. Session cleanup is faster through POST /api/session/:id/close and DELETE /api/session/:id.
```

Successful TURN/WebRTC logs look like this:

```text
ICE candidate from client: ... 172.20.13.53 ... typ relay ...
ICE candidate from renderer: ... 172.20.13.53 ... typ host ...
ICE: connected
WebRTC: connected
Loaded point cloud: map_aligned_icp_baked.ply, points: 15097408
```

If client ICE candidates are still `.local typ host`, the remote browser is using the old page or cached JavaScript. Use `/turn.html` and force refresh.

## TURN Configuration

The built-in TURN server is implemented by `turn-server.cjs` using `node-turn`.

Defaults:

```text
TURN_LISTENING_IP=0.0.0.0
TURN_RELAY_IP=172.20.13.53
TURN_PORT=3478
TURN_MIN_PORT=49160
TURN_MAX_PORT=49200
TURN_USERNAME=cloudrender
TURN_PASSWORD=CloudRender@123456
TURN_REALM=cloudrender
```

The browser TURN receiver page is `public/turn.html`, which loads `public/client-turn.js`. `client-turn.js` forces TURN relay mode for the remote client. The server-side renderer currently uses host candidates, with Edge launched using WebRTC flags that expose the rendering host's real LAN IP instead of mDNS `.local` names.

If the Windows rendering host IP changes, update these files or override the TURN server environment:

```text
turn-server.cjs
public/client-turn.js
```

Windows Firewall should allow:

```text
3000/tcp
3478/udp
3478/tcp
49160-49200/udp
```

Example administrator PowerShell commands:

```powershell
New-NetFirewallRule -DisplayName "Three Cloud TCP 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
New-NetFirewallRule -DisplayName "TURN UDP 3478" -Direction Inbound -Protocol UDP -LocalPort 3478 -Action Allow
New-NetFirewallRule -DisplayName "TURN TCP 3478" -Direction Inbound -Protocol TCP -LocalPort 3478 -Action Allow
New-NetFirewallRule -DisplayName "TURN Relay UDP 49160-49200" -Direction Inbound -Protocol UDP -LocalPort 49160-49200 -Action Allow
```

## Files

- `models/`: local point cloud asset directory.
- `models/*.ply`: local PLY point cloud sources.
- `models/*.pcd`: local PCD point cloud sources.
- `models/*.tiles/manifest.json`: tiled binary point cloud manifests for large PLY files.
- `models/*.origin.txt` or `models/*.tiles/origin.txt`: per-model calibration files.
- `server.js`: Express server, WebSocket signaling, and Puppeteer renderer lifecycle.
- `scripts/convert-ply-to-tiles.js`: offline PLY-to-tiles converter.
- `public/renderer.js`: server-side Three.js scene that loads point clouds, renders the UAV model, handles calibration, and draws route overlays.
- `public/client.js`: browser-side WebRTC receiver and interaction forwarder.
- `public/client-turn.js`: TURN-relay browser receiver for cross-subnet clients.
- `public/index.html`: browser UI.
- `public/turn.html`: browser UI that always loads the TURN-relay client.
- `turn-server.cjs`: local STUN/TURN server for intranet relay mode.

## Configuration

- `PORT=3000`: HTTP and WebSocket port.
- `HOST=0.0.0.0`: listening host.
- `PUBLIC_ORIGIN=http://127.0.0.1:3000`: URL used by Puppeteer to open the renderer page.
- `POINT_CLOUD_FILE=map_aligned_icp_baked.ply`: point cloud file path relative to `models/`. Supports `.ply`, `.pcd`, and `.tiles/manifest.json`.
- `HEADLESS=false`: show the Chromium renderer window for debugging.
- `CHROME_PATH=C:/Program Files/Google/Chrome/Application/chrome.exe`: force a Chrome / Edge executable path when Puppeteer cannot find one.
- `STREAM_WIDTH=1920`, `STREAM_HEIGHT=1080`: server render and video stream resolution.
- `STREAM_FPS=30`: canvas capture frame rate.
- `STREAM_BITRATE=8000000`: target WebRTC video bitrate in bps.
- `SESSION_IDLE_TIMEOUT_MS=5000`: idle cleanup delay after the last client disconnects.
- `UAV_API_BASE=http://114.116.235.66/indoorUavFlightControlBackend`: UAV platform API base URL.
- `UAV_API_USERNAME=YmfDemo`, `UAV_API_PASSWORD=888888`: UAV platform login used only by `server.js`.
- `TURN_RELAY_IP=172.20.13.53`: relay IP used by the built-in TURN server.
- `TURN_PORT=3478`: TURN listener port.
- `TURN_MIN_PORT=49160`, `TURN_MAX_PORT=49200`: relay UDP port range.
- `TURN_USERNAME=cloudrender`, `TURN_PASSWORD=CloudRender@123456`: TURN credentials.

Example:

```bash
PORT=8080 POINT_CLOUD_FILE=map_aligned_icp_baked.ply npm start
```

Switch to the PCD file in the project root:

```bash
POINT_CLOUD_FILE=GlobalMap.pcd npm start
```

Switch to a tiled large point cloud:

```bash
POINT_CLOUD_FILE=all_points_aligned_icp_baked.tiles/manifest.json npm start
```

Convert a large PLY to tiled binary format:

```bash
npm run convert:tiles -- all_points_aligned_icp_baked.ply 200000
```

For a sharper LAN stream, use a higher resolution and bitrate:

```bash
STREAM_WIDTH=2560 STREAM_HEIGHT=1440 STREAM_BITRATE=16000000 npm start
```

## Notes

- This is a practical local-area-network prototype. For internet deployment, add HTTPS, production-grade TURN, authentication, session quotas, and GPU-capable server infrastructure.
- Headless Chromium WebGL support depends on the server GPU and driver. If rendering fails on a Linux server, install the required graphics libraries or run with a proper GPU container runtime.
- The demo uses WebRTC for low-latency video and WebSocket for signaling and input events.
- Firefox may behave differently as a WebRTC client. Chrome / Edge / Chromium are the preferred client browsers for this prototype.
- A 404 for `favicon.ico` in renderer logs is harmless.
- `missionState = 1` from the UAV platform means the task is enabled, not necessarily running. Do not use it alone as the currently executing route state.

## Troubleshooting

If session creation returns `Could not find Chrome`, install Puppeteer's managed browser:

```bash
npx puppeteer browsers install chrome
```

Alternatively, install Google Chrome or Microsoft Edge locally. The server now automatically tries common Windows Chrome / Edge paths. You can also set `CHROME_PATH` explicitly:

```bash
CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" npm start
```

On Windows CMD, you can use the included scripts:

```cmd
npm run start:chrome
```

or:

```cmd
npm run start:edge
```
