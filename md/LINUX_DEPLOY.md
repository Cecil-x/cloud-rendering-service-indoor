# Linux Server Deployment Guide

This document explains how to run the Three.js cloud rendering / cloud streaming point cloud service on a Linux server.

## 1. Architecture

The service works like this:

```text
Client browser
  -> opens web page
  -> receives WebRTC video stream
  -> sends mouse / wheel input through WebSocket

Linux server
  -> runs Node.js service
  -> starts Chrome / Chromium through Puppeteer
  -> loads Three.js renderer page
  -> loads PLY / PCD / tiled point cloud
  -> renders with WebGL
  -> streams canvas video through WebRTC
```

The client does not render the point cloud locally. The heavy rendering work is done by the server-side Chrome instance.

## 2. Recommended Server

Recommended:

- Ubuntu 22.04 / 24.04
- Node.js 20+
- Google Chrome stable
- NVIDIA GPU server if possible
- Open port `3000` or your chosen service port

For large point clouds, a GPU server is strongly recommended. CPU-only servers may start the service, but WebGL rendering and video encoding can be slow or unstable.

## 3. Upload Project

Upload the project directory to the Linux server, for example:

```bash
/opt/three-cloud-streaming
```

Make sure your point cloud files are in the `models/` directory:

```text
server.js
package.json
public/
models/
  map_aligned_icp_baked.ply
  GlobalMap.pcd
  all_points_aligned_icp_baked.tiles/
    manifest.json
    tile_00000.bin
```

## 4. Install Node.js

Check Node.js:

```bash
node -v
npm -v
```

If Node.js is not installed, install Node.js 20 LTS:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

## 5. Install Chrome Dependencies

Ubuntu 24.04:

```bash
sudo apt update
sudo apt install -y \
  ca-certificates fonts-liberation libasound2t64 libatk-bridge2.0-0 \
  libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 \
  libglib2.0-0 libgtk-3-0 libnss3 libx11-6 libx11-xcb1 libxcb1 \
  libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 \
  libxrandr2 wget xdg-utils
```

Ubuntu 22.04 may not have `libasound2t64`. Use `libasound2` instead:

```bash
sudo apt update
sudo apt install -y \
  ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
  libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 \
  libglib2.0-0 libgtk-3-0 libnss3 libx11-6 libx11-xcb1 libxcb1 \
  libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 \
  libxrandr2 wget xdg-utils
```

## 6. Install Google Chrome

```bash
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y ./google-chrome-stable_current_amd64.deb
```

Check Chrome path:

```bash
which google-chrome
which google-chrome-stable
```

Usually the path is:

```text
/usr/bin/google-chrome
```

## 7. Install Project Dependencies

In the project directory:

```bash
cd /opt/three-cloud-streaming
npm install
```

If you prefer Puppeteer's managed Chrome instead of system Chrome:

```bash
npx puppeteer browsers install chrome
```

Using system Chrome is usually simpler for basic tests. For the NVIDIA WebGL2 production path, prefer Puppeteer's managed Chrome 127 because newer system Chrome versions may behave differently with ANGLE, NVIDIA drivers, and dummy Xorg displays.

## 8. Start Service

Basic start:

```bash
CHROME_PATH=/usr/bin/google-chrome HOST=0.0.0.0 PORT=3000 npm start
```

For the verified NVIDIA GPU path, start the service from an NVIDIA-backed Xorg display:

```bash
DISPLAY=:99 \
__GLX_VENDOR_LIBRARY_NAME=nvidia \
__NV_PRIME_RENDER_OFFLOAD=1 \
HEADLESS=false \
CHROME_PATH=/home/df1500/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome \
HOST=0.0.0.0 \
PORT=3000 \
npm start
```

See `GPU系统排查.md` for the full `Xorg :99` and NVIDIA GLX setup.

Important Linux GPU notes:

- Use an NVIDIA-backed Xorg display before starting Node. Do not rely on a pure headless browser when WebGL2 rendering is required.
- `CHROME_PATH` should point to a verified Puppeteer Chrome, for example Chrome `127.0.6533.88`.
- Avoid very new system Chrome versions unless WebGL2 has been tested. One server with system Chrome `149.0.7827.114` only created NVIDIA WebGL1, while Puppeteer Chrome 127 created NVIDIA WebGL2 after permissions were fixed.
- `public/renderer.js` should not force `powerPreference: 'high-performance'` on Linux. On an RTX 2080 SUPER server it caused `Could not create a WebGL2 context`, while the default path still used NVIDIA.

Recommended full startup command for the current Linux RTX 3090 server:

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

If a smaller PCD is needed for quick testing:

```bash
cd /home/df1500/xtj/three.js

DISPLAY=:99 \
__GLX_VENDOR_LIBRARY_NAME=nvidia \
__NV_PRIME_RENDER_OFFLOAD=1 \
HEADLESS=false \
CHROME_PATH=/home/df1500/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome \
HOST=0.0.0.0 \
PORT=3000 \
POINT_CLOUD_FILE=GlobalMap.pcd \
STREAM_WIDTH=1280 \
STREAM_HEIGHT=720 \
STREAM_FPS=15 \
STREAM_BITRATE=4000000 \
npm start
```

Then open from another machine in the same LAN:

```text
http://SERVER_IP:3000
```

Example:

```text
http://192.168.1.20:3000
```

## 9. Select Point Cloud File

The page supports entering the point cloud file name. Paths are relative to `models/`.

PLY:

```text
map_aligned_icp_baked.ply
```

PCD:

```text
GlobalMap.pcd
```

You can also choose the default file when starting the service:

```bash
POINT_CLOUD_FILE=GlobalMap.pcd CHROME_PATH=/usr/bin/google-chrome HOST=0.0.0.0 PORT=3000 npm start
```

Large tiled point cloud:

```text
all_points_aligned_icp_baked.tiles/manifest.json
```

Start with a tiled model:

```bash
POINT_CLOUD_FILE=all_points_aligned_icp_baked.tiles/manifest.json \
CHROME_PATH=/usr/bin/google-chrome HOST=0.0.0.0 PORT=3000 npm start
```

Convert a large PLY to the tiled binary format before deployment or directly on the server:

```bash
npm run convert:tiles -- all_points_aligned_icp_baked.ply 200000
```

Windows PowerShell conversion command:

```powershell
cd D:\uav\dfe-patrol-indoorUav-all\three.js
npm run convert:tiles -- all_points_aligned_icp_baked.ply 200000
```

Linux conversion command:

```bash
cd /home/df1500/xtj/three.js
npm run convert:tiles -- all_points_aligned_icp_baked.ply 200000
```

The converter reads from `models/` and creates:

```text
models/all_points_aligned_icp_baked.tiles/
  manifest.json
  tile_00000.bin
  tile_00001.bin
```

## 10. Quality Settings

Default stream settings:

```text
STREAM_WIDTH=1920
STREAM_HEIGHT=1080
STREAM_FPS=30
STREAM_BITRATE=8000000
```

Sharper LAN stream:

```bash
STREAM_WIDTH=2560 STREAM_HEIGHT=1440 STREAM_BITRATE=16000000 \
CHROME_PATH=/usr/bin/google-chrome HOST=0.0.0.0 PORT=3000 npm start
```

4K test, only if the GPU and network are strong enough:

```bash
STREAM_WIDTH=3840 STREAM_HEIGHT=2160 STREAM_BITRATE=30000000 \
CHROME_PATH=/usr/bin/google-chrome HOST=0.0.0.0 PORT=3000 npm start
```

## 11. GPU Check

For NVIDIA servers:

```bash
nvidia-smi
```

If `nvidia-smi` is unavailable or shows no GPU, the service may still run, but performance can be poor.

For a production Linux GPU deployment, also verify the full browser WebGL2 path.

### 11.1 NVIDIA Xorg Checklist

Find the GPU BusID:

```bash
nvidia-xconfig --query-gpu-info
```

Create an Xorg config such as `/etc/X11/xorg-nvidia-gpu0.conf`. Replace `PCI:129:0:0` with the real BusID:

```conf
Section "Files"
    ModulePath "/usr/lib/x86_64-linux-gnu/nvidia/xorg"
    ModulePath "/usr/lib/xorg/modules"
EndSection
Section "ServerLayout"
    Identifier "Layout0"
    Screen 0 "Screen0"
EndSection
Section "Module"
    Load "glx"
EndSection
Section "Device"
    Identifier "GPU0"
    Driver "nvidia"
    BusID "PCI:129:0:0"
    Option "AllowEmptyInitialConfiguration" "true"
EndSection
Section "Screen"
    Identifier "Screen0"
    Device "GPU0"
    DefaultDepth 24
    Option "AllowEmptyInitialConfiguration" "true"
    SubSection "Display"
        Depth 24
        Virtual 1920 1080
    EndSubSection
EndSection
```

If `/usr/lib/x86_64-linux-gnu/nvidia/xorg` is missing but `libglxserver_nvidia.so*` exists under `/usr/lib/xorg/modules/extensions`, create the compatibility directory:

```bash
mkdir -p /usr/lib/x86_64-linux-gnu/nvidia/xorg
ln -sf /usr/lib/xorg/modules/extensions/libglxserver_nvidia.so \
  /usr/lib/x86_64-linux-gnu/nvidia/xorg/libglxserver_nvidia.so
ln -sf /usr/lib/xorg/modules/extensions/libglxserver_nvidia.so.* \
  /usr/lib/x86_64-linux-gnu/nvidia/xorg/
```

Start Xorg:

```bash
pkill -f "Xorg :99"
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

Xorg :99 \
  -config /etc/X11/xorg-nvidia-gpu0.conf \
  -noreset \
  +extension GLX \
  +extension RANDR \
  +extension RENDER \
  -logfile /var/log/Xorg.99.log \
  >/tmp/xorg99.out 2>&1 &
```

Verify that NVIDIA GLX is active and that Xorg did not fall back to software GL:

```bash
grep -iE "Using config|ModulePath|NVIDIA\(0\)|NVIDIA GLX|DRISWRAST|swrast|Another vendor" /var/log/Xorg.99.log
```

Expected:

```text
ModulePath set to "/usr/lib/x86_64-linux-gnu/nvidia/xorg,/usr/lib/xorg/modules"
NVIDIA GLX Module
NVIDIA(0): NVIDIA GPU ...
NVIDIA(0): [DRI2] Setup complete
```

Bad signs:

```text
swrast
DRISWRAST
```

### 11.2 Chrome and Library Checklist

Install Puppeteer Chrome 127 if needed:

```bash
cd /home/CloudRendering/three.js
npx puppeteer browsers install chrome@127.0.6533.88
find /root/.cache/puppeteer /home -path "*chrome-linux64/chrome" -type f 2>/dev/null
```

Check versions:

```bash
/usr/bin/google-chrome --version
/home/cloudrender/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome --version
```

Check missing libraries:

```bash
ldd /home/cloudrender/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome | grep "not found"
ldconfig -p | grep -iE "libGLX_nvidia|libEGL_nvidia|libnvidia-glcore"
```

If NVIDIA GL libraries exist but are not in `ldconfig`, add the relevant directories and refresh:

```bash
cat > /etc/ld.so.conf.d/nvidia-manual.conf <<'EOF'
/usr/lib/x86_64-linux-gnu
/usr/lib/xorg/modules/extensions
EOF

ldconfig
```

If Puppeteer Chrome logs show `libGLESv2.so: 权限不够` or `Permission denied`, fix permissions:

```bash
chmod -R a+rX /home/cloudrender/.cache/puppeteer/chrome/linux-127.0.6533.88
chmod +x /home/cloudrender/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome
chmod o+x /home/cloudrender /home/cloudrender/.cache /home/cloudrender/.cache/puppeteer /home/cloudrender/.cache/puppeteer/chrome
```

### 11.3 WebGL2 Verification

Run this before starting the service:

```bash
cd /home/CloudRendering/three.js

DISPLAY=:99 \
__GLX_VENDOR_LIBRARY_NAME=nvidia \
__NV_PRIME_RENDER_OFFLOAD=1 \
node - <<'NODE'
const puppeteer = require('puppeteer');
const chromePath = '/home/cloudrender/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome';

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: chromePath,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-dev-shm-usage',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--use-gl=angle',
      '--force-webrtc-ip-handling-policy=default_public_and_private_interfaces',
      '--no-sandbox'
    ]
  });

  const page = await browser.newPage();
  const result = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl2 = canvas.getContext('webgl2');
    if (!gl2) return { ok: false, webgl2: null };
    const debug = gl2.getExtension('WEBGL_debug_renderer_info');
    return {
      ok: true,
      version: gl2.getParameter(gl2.VERSION),
      vendor: debug ? gl2.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl2.getParameter(gl2.VENDOR),
      renderer: debug ? gl2.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl2.getParameter(gl2.RENDERER)
    };
  });

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
```

Expected output must contain `WebGL 2.0` and `NVIDIA`. If it does not, do not start the streaming service yet; fix Xorg, Chrome, library, or permission issues first.

### 11.4 Renderer Attribute Compatibility

On some Linux NVIDIA stacks, this Three.js renderer option fails even when normal NVIDIA WebGL2 works:

```js
powerPreference: 'high-performance'
```

Use this safer renderer setup:

```js
new THREE.WebGLRenderer({ canvas, antialias: true })
```

The default browser choice can still use NVIDIA. Confirm with the WebGL2 verification renderer string.

## 12. Firewall

Open the service port.

For UFW:

```bash
sudo ufw allow 3000/tcp
sudo ufw status
```

For cloud servers, also open the port in the cloud provider security group.

## 13. Run With PM2

For testing, running in the terminal is enough. For longer runs, use PM2:

```bash
sudo npm install -g pm2
```

Start:

```bash
CHROME_PATH=/usr/bin/google-chrome HOST=0.0.0.0 PORT=3000 \
pm2 start server.js --name three-cloud-streaming
```

View logs:

```bash
pm2 logs three-cloud-streaming
```

Stop:

```bash
pm2 stop three-cloud-streaming
```

Delete:

```bash
pm2 delete three-cloud-streaming
```

## 14. Verify Service

Health check:

```bash
curl http://127.0.0.1:3000/health
```

Expected:

```json
{"ok":true,"sessions":0}
```

Point cloud list:

```bash
curl http://127.0.0.1:3000/api/point-clouds
```

Expected example:

```json
{"current":"map_aligned_icp_baked.ply","files":["GlobalMap.pcd","all_points_aligned_icp_baked.tiles/manifest.json","map_aligned_icp_baked.ply"]}
```

Check PCD asset:

```bash
curl -I http://127.0.0.1:3000/assets/pointcloud/GlobalMap.pcd
```

Expected:

```text
HTTP/1.1 200 OK
```

Check calibration and route APIs:

```bash
curl "http://127.0.0.1:3000/api/point-cloud-calibration?file=all_points_aligned_icp_baked.tiles/manifest.json"
curl http://127.0.0.1:3000/api/uav/running-route
```

Calibration may return `exists:false` before the first manual calibration. The route API may return no mission if the UAV platform has no confirmed running task.

## 15. Current Feature Notes

Recent Windows/Linux shared updates:

```text
1. Point cloud assets are resolved from models/.
2. Large PLY files can use *.tiles/manifest.json to avoid PLYLoader array limits.
3. Calibration is persisted per model through origin files.
4. The renderer restores calibration and shows origin / X+ fluorescent markers.
5. The UAV GLB model plays its built-in animation while moving.
6. The renderer polls /api/uav/running-route and draws task routes in the calibrated scene.
7. Session cleanup is controlled by SESSION_IDLE_TIMEOUT_MS and close/delete session APIs.
```

Calibration files:

```text
models/<name>.origin.txt                 # for .ply / .pcd
models/<name>.tiles/origin.txt           # for tiled manifest
```

UAV platform environment variables:

```bash
UAV_API_BASE=http://114.116.235.66/indoorUavFlightControlBackend
UAV_API_USERNAME=YmfDemo
UAV_API_PASSWORD=888888
```

Keep UAV credentials on the server side. The browser should only call the local `/api/uav/running-route` proxy.

Important route-state note:

```text
missionState = 1 means enabled task, not necessarily the currently executing task.
```

Do not use `missionState = 1` alone as the running-route condition. Confirm the real execution state field from the UAV API before enabling strict current-task route selection.

## 16. Common Problems

### Could not find Chrome

Set `CHROME_PATH` explicitly:

```bash
CHROME_PATH=/usr/bin/google-chrome npm start
```

Or install Puppeteer's managed Chrome:

```bash
npx puppeteer browsers install chrome
```

### Address already in use

Find the process:

```bash
sudo lsof -i :3000
```

Kill it:

```bash
sudo kill -9 PID
```

Or use another port:

```bash
PORT=3100 npm start
```

### Page opens but no video

Check server logs first. Common causes:

- Chrome failed to start.
- WebGL failed in server-side Chrome.
- GPU driver is not available.
- Browser and server are not in the same reachable network.
- Public internet access needs STUN / TURN.

### LAN works, public internet does not

The current demo is mainly for LAN or direct reachable networks. For public internet deployment, add:

- HTTPS / WSS
- STUN server
- TURN server
- Authentication
- Session cleanup and resource limits

## 17. Public Internet WebRTC Note

Current client and renderer use:

```js
new RTCPeerConnection({ iceServers: [] })
```

This is fine for many LAN tests. For public internet or strict NAT, configure STUN / TURN:

```js
new RTCPeerConnection({
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:YOUR_TURN_SERVER:3478',
      username: 'YOUR_USERNAME',
      credential: 'YOUR_PASSWORD'
    }
  ]
})
```

The same ICE configuration must be used on both browser client and server-side renderer page.

## 18. Recommended First Test

On the server:

```bash
cd /opt/three-cloud-streaming
npm install
CHROME_PATH=/usr/bin/google-chrome HOST=0.0.0.0 PORT=3000 npm start
```

On a LAN client browser:

```text
http://SERVER_IP:3000
```

First test PLY:

```text
map_aligned_icp_baked.ply
```

Then test PCD:

```text
GlobalMap.pcd
```

Then test tiled point cloud:

```text
all_points_aligned_icp_baked.tiles/manifest.json
```
