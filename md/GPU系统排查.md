# GPU 系统排查

本文记录 Three.js 云渲染在 Linux GPU 环境上的排查过程、根因和最终解决方案，便于后续部署或复现。

## 背景

当前项目在 Windows 主机上通过 Edge / Puppeteer / ANGLE / Direct3D 路径可以稳定运行 Three.js 点云云渲染，并通过 TURN 支持跨网段 WebRTC 访问。

Linux 侧的目标是让 Chrome / Puppeteer 在服务器端使用 NVIDIA GPU 创建 WebGL2 上下文，从而完成 Three.js 服务端渲染和 WebRTC 推流。

## 已验证的 Windows 方案

- 渲染主机：Windows，IP `172.20.13.53`。
- 客户端入口：`http://172.20.13.53:3000/turn.html`。
- TURN：`turn:172.20.13.53:3478?transport=udp`。
- TURN 用户名：`cloudrender`。
- TURN 密码：`CloudRender@123456`。
- WebRTC 关键现象：客户端产生 `typ relay` candidate，renderer 产生 Windows 主机 `typ host` candidate，最终 `ICE: connected` / `WebRTC: connected`。
- 结论：Windows + Edge/ANGLE/D3D 是当前稳定可用路径。

## Linux 测试环境

### 旧服务器

- 系统：Ubuntu 20.04.6。
- GPU：RTX 2080 SUPER。
- NVIDIA 驱动：曾观察到 `580.95.05`。
- 结果：Xorg / NVIDIA 可被系统识别，但 Chrome / Puppeteer WebGL 仍无法稳定使用 NVIDIA，出现 SwiftShader、llvmpipe 或 WebGL2 创建失败。

### 新服务器

- 系统：Ubuntu 18.04.6 LTS。
- GPU：双 NVIDIA GeForce RTX 3090。
- NVIDIA 驱动：`525.147.05`。
- CUDA：`12.0`。
- 项目目录：`/home/df1500/xtj/three.js`。
- Puppeteer Chrome：`/home/df1500/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome`。
- 注意：机器上 GPU 同时被 Python / vLLM / CosyVoice / SenseVoice 等任务占用。

## Linux 已尝试操作

### Xorg / DISPLAY

- 尝试启动 Xorg `:99` 并绑定 NVIDIA GPU。
- 使用临时 Xorg 配置，例如 `/tmp/xorg-nvidia-gpu0.conf`。
- 通过 `nvidia-smi` 观察到 Xorg 进程可以出现在 NVIDIA GPU 上。
- 使用 `DISPLAY=:99` 启动 Node / Chrome。

### Chrome 启动参数

尝试过以下方向：

- `--enable-gpu`
- `--ignore-gpu-blocklist`
- `--disable-gpu-sandbox`
- `--ozone-platform=x11`
- `--use-gl=desktop`
- `--use-gl=egl`
- `--use-gl=angle`
- `--use-angle=vulkan`
- `--disable-software-rasterizer`
- `--enable-features=Vulkan`
- `--disable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan,WebRtcHideLocalIpsWithMdns`

也尝试设置环境变量：

```bash
DISPLAY=:99
__GLX_VENDOR_LIBRARY_NAME=nvidia
__NV_PRIME_RENDER_OFFLOAD=1
```

### Puppeteer / 项目侧修改

- 修改 `server.js` 的 Chrome args，避免继续使用旧的 `--use-gl=angle`。
- 将 `page.goto(..., { waitUntil: 'networkidle0' })` 改为 `waitUntil: 'domcontentloaded', timeout: 0`，避免 renderer 页面因 WebSocket / WebRTC 连接导致导航超时。
- 通过 `ps -ef | grep chrome | grep gpu-process` 检查实际 Chrome GPU 进程参数。
- 使用 `chrome://gpu` 最小化测试排除 Three.js 项目代码干扰。
- 最终确认可用路径为 NVIDIA Xorg `:99` + NVIDIA GLX + Chrome ANGLE OpenGL。

## 关键错误现象

### WebGL 上下文创建失败

Three.js renderer 侧报错：

```text
THREE.WebGLRenderer: A WebGL context could not be created.
Reason: Could not create a WebGL context,
VENDOR = 0xffff,
DEVICE = 0xffff,
GL_VENDOR = Disabled,
GL_RENDERER = Disabled,
Sandboxed = no,
ErrorMessage = BindToCurrentSequence failed: .
```

随后出现：

```text
THREE.WebGLRenderer: A WebGL context could not be created. Reason: Failed to create a WebGL2 context.
THREE.WebGLRenderer: Error creating WebGL context.
```

### Chrome GPU 进程失败

使用 Chrome 最小测试：

```bash
export DISPLAY=:99

/home/df1500/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome \
  --no-sandbox \
  --enable-gpu \
  --disable-gpu-sandbox \
  --ignore-gpu-blocklist \
  --ozone-platform=x11 \
  --use-gl=egl \
  --user-data-dir=/tmp/chrome-gpu-test \
  --enable-logging=stderr \
  --v=1 \
  --dump-dom chrome://gpu > /tmp/chrome-gpu.html 2>/tmp/chrome-gpu.log
```

日志中出现关键错误：

```text
libEGL warning: DRI3: Screen seems not DRI3 capable
libEGL warning: DRI2: failed to authenticate
FATAL:gpu_init.cc(591)] Passthrough is not supported, GL is egl, ANGLE is
ERROR:gpu_process_host.cc(1007)] GPU process exited unexpectedly: exit_code=5
WARNING:gpu_process_host.cc(1443)] The GPU process has crashed
ERROR:command_buffer_proxy_impl.cc(132)] ContextResult::kTransientFailure: Failed to send GpuControl.CreateCommandBuffer.
```

这说明失败点不在 Three.js 点云加载或 WebRTC，而在 Chrome GPU 进程 / WebGL 底层初始化。

### Xorg 回退到软件 GLX

后续发现 `Xorg :99` 虽然识别到了 RTX 3090，但没有正确加载 NVIDIA GLX server 模块，导致 Xorg 回退到 swrast / llvmpipe：

```text
Failed to load module "glxserver_nvidia" (module does not exist, 0)
Failed to initialize the GLX module
AIGLX: Screen 0 is not DRI2 capable
IGLX: Loaded and initialized swrast
GLX: Initialized DRISWRAST GL provider for screen 0
```

此时 Puppeteer WebGL 虽然可以创建，但 renderer 是 CPU 软件渲染：

```json
{
  "ok": true,
  "version": "WebGL 1.0 (OpenGL ES 2.0 Chromium)",
  "vendor": "Google Inc. (VMware, Inc.)",
  "renderer": "ANGLE (VMware Inc., llvmpipe (LLVM 10.0.0 256 bits), OpenGL 3.3)"
}
```

## 根因

Linux GPU 路径失败的根因不是 Three.js 代码，也不是 WebRTC 推流逻辑，而是 NVIDIA OpenGL / GLX 用户态组件缺失或 Xorg 模块路径未配置。

具体表现为：

- 系统最初缺少 `libnvidia-gl-525`，`ldconfig` 中没有 `libGLX_nvidia.so` / `libEGL_nvidia.so` / `libnvidia-glcore.so`。
- 安装 `libnvidia-gl-525` 后，`libglxserver_nvidia.so` 已存在，但 Xorg 默认模块路径仍只加载 `/usr/lib/xorg/modules/extensions/libglx.so`，找不到 NVIDIA 的 `glxserver_nvidia`。
- Xorg 因此回退到 `DRISWRAST`，Chrome / Puppeteer 最终只能拿到 `llvmpipe`。
- `--use-gl=egl` 还会触发 Chrome 127 的 `Passthrough is not supported, GL is egl, ANGLE is` 崩溃。

## 最终解决方案

### 1. 安装 NVIDIA GLX / EGL 用户态库

当前驱动版本是 `525.147.05`，对应安装：

```bash
sudo apt install libnvidia-gl-525
```

如果 apt 报缓存目录错误：

```text
E: 仓库目录 /var/cache/apt/archives/partial ... 没有那个文件或目录
```

先修复 apt 缓存目录或备份异常路径后重建：

```bash
sudo mv /var/cache/apt/archives /var/cache/apt/archives.bak.$(date +%s)
sudo mkdir -p /var/cache/apt/archives/partial
sudo chmod 755 /var/cache/apt/archives
sudo chmod 700 /var/cache/apt/archives/partial
```

安装完成后检查 NVIDIA GL 库：

```bash
sudo ldconfig
ldconfig -p | grep -iE "libGLX_nvidia|libEGL_nvidia|libnvidia-glcore"
```

也可以确认 Xorg GLX server 模块存在：

```bash
sudo find /usr /lib -name "libglxserver_nvidia.so*" -o -name "libGLX_nvidia.so*" -o -name "libEGL_nvidia.so*"
```

预期包含：

```text
/usr/lib/x86_64-linux-gnu/nvidia/xorg/libglxserver_nvidia.so
/usr/lib/x86_64-linux-gnu/nvidia/xorg/libglxserver_nvidia.so.525.147.05
/usr/lib/x86_64-linux-gnu/libGLX_nvidia.so.0
```

### 2. 配置 NVIDIA Dummy Xorg

`/tmp/xorg-nvidia-gpu0.conf` 最终可用配置如下，重点是 `Section "Files"` 中的 NVIDIA ModulePath：

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
    BusID "PCI:2:0:0"
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

如果 `/tmp/xorg-nvidia-gpu0.conf` 权限异常，先写到用户目录再用 `sudo cp` 覆盖：

```bash
cat > ~/xorg-nvidia-gpu0.conf <<'EOF'
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
    BusID "PCI:2:0:0"
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
EOF

sudo cp ~/xorg-nvidia-gpu0.conf /tmp/xorg-nvidia-gpu0.conf
```

### 3. 启动 Xorg :99

停止旧服务和旧 Xorg：

```bash
pkill -f "chrome-linux64/chrome"
pkill -f "node server.js"
sudo pkill -f "Xorg :99"
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
```

启动 NVIDIA Xorg：

```bash
sudo Xorg :99 -config /tmp/xorg-nvidia-gpu0.conf -noreset +extension GLX +extension RANDR +extension RENDER -logfile /var/log/Xorg.99.log >/tmp/xorg99.out 2>&1 &
```

检查 NVIDIA GLX 是否加载成功：

```bash
grep -iE "glxserver_nvidia|swrast|DRISWRAST|Failed to initialize the GLX|NVIDIA GLX|libglx" /var/log/Xorg.99.log | tail -100
```

成功日志应包含：

```text
Loading /usr/lib/x86_64-linux-gnu/nvidia/xorg/libglxserver_nvidia.so
Module glxserver_nvidia: vendor="NVIDIA Corporation"
NVIDIA GLX Module  525.147.05
```

并且不应再出现：

```text
Failed to load module "glxserver_nvidia"
DRISWRAST
swrast
```

### 4. 验证 Puppeteer WebGL 是否使用 NVIDIA

在项目目录执行：

```bash
cd ~/xtj/three.js

DISPLAY=:99 \
__GLX_VENDOR_LIBRARY_NAME=nvidia \
__NV_PRIME_RENDER_OFFLOAD=1 \
timeout 25s node - <<'NODE'
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: '/home/df1500/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome',
    args: [
      '--no-sandbox',
      '--enable-gpu',
      '--disable-gpu-sandbox',
      '--ignore-gpu-blocklist',
      '--disable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan',
      '--use-gl=angle',
      '--use-angle=gl'
    ]
  });

  const page = await browser.newPage();

  const result = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return { ok: false, error: 'WEBGL_FAILED' };

    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      ok: true,
      version: gl.getParameter(gl.VERSION),
      vendor: info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
    };
  });

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE
```

最终成功结果：

```json
{
  "ok": true,
  "version": "WebGL 2.0 (OpenGL ES 3.0 Chromium)",
  "vendor": "Google Inc. (NVIDIA Corporation)",
  "renderer": "ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3090/PCIe/SSE2, OpenGL 4.5.0)"
}
```

### 5. 项目 Chrome 参数

`server.js` 中 Puppeteer Chrome args 建议使用：

```js
[
  '--autoplay-policy=no-user-gesture-required',
  '--disable-dev-shm-usage',
  '--enable-webgl',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--disable-gpu-sandbox',
  '--disable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan,WebRtcHideLocalIpsWithMdns',
  '--use-gl=angle',
  '--use-angle=gl',
  '--force-webrtc-ip-handling-policy=default_public_and_private_interfaces',
  '--no-sandbox'
]
```

不建议再使用：

```text
--use-gl=egl
--use-gl=desktop
--disable-software-rasterizer
--ozone-platform=x11
```

### 6. 启动项目

当前 Linux 版本推荐启动命令：

```bash
cd ~/xtj/three.js

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

如果需要快速验证小点云，可临时改为：

```bash
POINT_CLOUD_FILE=GlobalMap.pcd
```

可用 `nvidia-smi` 和 Chrome GPU 进程确认运行时占用：

```bash
nvidia-smi
ps -ef | grep chrome | grep -v grep | grep "gpu-process"
```

## 大点云分块加载方案

1500 万点级别的 PLY 在 Linux Puppeteer 中可能触发 `PLYLoader` 的 JS 数组限制：

```text
RangeError: Invalid array length
at Array.push
at PLYLoader.js parseBinary
```

这类错误发生在 PLY 解析阶段，不是 GPU 渲染阶段。为避免官方 `PLYLoader` 一次性解析超大 PLY，新增了离线分块格式 `points-tiles-v1`。

### 1. 转换 PLY 为 tiles

在项目目录执行。当前点云资产统一放在 `models/` 下，转换脚本会从 `models/` 查找输入文件并在同目录生成 tiles：

```bash
cd ~/xtj/three.js
npm run convert:tiles -- all_points_aligned_icp_baked.ply 200000
```

Windows 侧同样可以先转换再同步到 Linux：

```powershell
cd D:\uav\dfe-patrol-indoorUav-all\three.js
npm run convert:tiles -- all_points_aligned_icp_baked.ply 200000
```

第二个参数是每个 tile 的点数，当前常用值：

```text
200000
```

点数更小会生成更多文件，单块加载更轻；点数更大会减少文件数量，但单块内存压力更高。

也可以直接执行：

```bash
node scripts/convert-ply-to-tiles.js all_points_aligned_icp_baked.ply 200000
```

转换后会生成：

```text
models/all_points_aligned_icp_baked.tiles/
  manifest.json
  tile_00000.bin
  tile_00001.bin
  ...
```

每个 tile 默认约 20 万点，二进制布局为：

```text
positions: float32 x 3
colors:    uint8 x 3, optional, normalized
```

### 2. 使用 tiles 启动项目

```bash
cd ~/xtj/three.js

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

renderer 日志应出现：

```text
Loading point cloud: ... with tiled binary loader
Tile manifest: source=..., totalPoints=15000000, tiles=...
Loaded point tiles: ...
Loaded tiled point cloud: ..., points=...
```

### 3. 临时限制加载块数

调试时可以在 renderer URL 上加 `tileLimit`，例如：

```text
renderer.html?session=<id>&tileLimit=10
```

这会只加载前 10 个 tile，方便快速验证。正式使用时不传该参数即可加载全部 tile。

### 4. 注意事项

- 当前是固定点数分块，不是空间八叉树 LOD。
- 优点是绕开 `PLYLoader` 的 `Array.push` 爆数组问题，并且可以边加载边显示。
- `POINT_CLOUD_FILE` 应填写相对 `models/` 的路径，例如 `all_points_aligned_icp_baked.tiles/manifest.json`，不要再写成 `models/...`。
- tiled 点云的标定文件保存为 `models/<name>.tiles/origin.txt`。
- 后续可以在 manifest 中基于 tile `bounds` 做视锥裁剪、按距离加载和无人机附近优先加载。

## Windows / Linux 同步更新内容

除 Linux GPU 路径外，当前 Windows 和 Linux 版本还共享以下业务功能更新：

```text
1. 点云资产目录统一为 three.js/models。
2. server.js 自动列出 .ply / .pcd / *.tiles/manifest.json。
3. renderer.js 支持 tiled binary loader，避免 1500 万点级 PLY 在 Linux PLYLoader 中触发 RangeError。
4. 点云标定结果通过 /api/point-cloud-calibration 保存和读取。
5. .ply / .pcd 标定文件为 <model>.origin.txt，tiles 标定文件为 <model>.tiles/origin.txt。
6. renderer 进入场景后自动恢复原点和 X 正方向，并绘制荧光原点 / X+ 标志。
7. 无人机 GLB 模型加载后接入内置动画，移动时播放，停止后暂停。
8. server.js 增加 /api/uav/running-route，renderer 定时拉取并绘制任务航线和航点。
9. 会话关闭接口和 SESSION_IDLE_TIMEOUT_MS 用于减少客户端断开后的 GPU 占用。
```

当前航线状态判断仍需注意：

```text
missionState = 1 已确认是“已启用任务”，不是“正在执行任务”。
```

因此 Linux 同步部署时，不应把第一个 `missionState = 1` 的任务视为当前飞行任务。需要后续根据飞控平台真实执行状态字段继续修正。

## Linux 完整部署与排障流程

本节整理 Windows 代码迁移到 Linux GPU 服务器时的完整检查流程。实际遇到的问题包括：Chrome 路径不存在、NVIDIA GL 用户态库未进 `ldconfig`、Xorg `ModulePath` 不一致、Puppeteer Chrome 文件权限不足、系统 Chrome 版本过新、以及 WebGL context attributes 与旧服务器图形栈不兼容。

### 1. 推荐基线

优先复刻已验证成功的新服务器配置：

```text
Xorg: :99
Xorg config: /tmp/xorg-nvidia-gpu0.conf 或 /etc/X11/xorg-nvidia-gpu0.conf
Chrome: Puppeteer Chrome 127.0.6533.88
Chrome args: --enable-webgl --ignore-gpu-blocklist --use-gl=angle
Node env: DISPLAY=:99, __GLX_VENDOR_LIBRARY_NAME=nvidia, __NV_PRIME_RENDER_OFFLOAD=1
```

注意：系统 Chrome 版本过新可能只提供 WebGL1 或触发 ANGLE/Skia 兼容问题。旧服务器曾出现 `/usr/bin/google-chrome 149` 只能创建 NVIDIA WebGL1，不能创建 WebGL2；因此推荐固定使用 Puppeteer Chrome 127。

### 2. 安装和定位 Chrome

如果 `CHROME_PATH` 指向的浏览器不存在，会出现：

```text
Browser was not found at the configured executablePath
```

先查系统 Chrome：

```bash
which google-chrome
which google-chrome-stable
which chromium
which chromium-browser
```

推荐安装 Puppeteer 固定版本 Chrome：

```bash
cd /home/CloudRendering/three.js
npx puppeteer browsers install chrome@127.0.6533.88
find /root/.cache/puppeteer /home -path "*chrome-linux64/chrome" -type f 2>/dev/null
```

启动项目时显式指定：

```bash
CHROME_PATH=/home/cloudrender/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome
```

### 3. 检查 NVIDIA 驱动和用户态库

先确认驱动：

```bash
nvidia-smi
```

如果是 apt 安装的驱动，应安装匹配版本的 GL 包，例如：

```bash
sudo apt install libnvidia-gl-525
```

如果 apt 源没有对应包，例如 `libnvidia-gl-580` 无法定位，说明驱动可能来自 `.run` 安装包或手工安装。此时先查库是否实际存在：

```bash
find /usr /lib /opt -name "libGLX_nvidia.so*" -o -name "libEGL_nvidia.so*" -o -name "libnvidia-glcore.so*" -o -name "libglxserver_nvidia.so*" 2>/dev/null
```

如果能找到 64 位库，但 `ldconfig` 查不到：

```bash
ldconfig -p | grep -iE "libGLX_nvidia|libEGL_nvidia|libnvidia-glcore"
```

则写入动态链接配置：

```bash
cat > /etc/ld.so.conf.d/nvidia-manual.conf <<'EOF'
/usr/lib/x86_64-linux-gnu
/usr/lib/xorg/modules/extensions
EOF

ldconfig
ldconfig -p | grep -iE "libGLX_nvidia|libEGL_nvidia|libnvidia-glcore"
```

### 4. 补齐 Chrome 通用依赖

系统 Chrome 或 Puppeteer Chrome 可能因依赖缺失无法正常启动 GPU 进程，先安装常见依赖：

```bash
apt update
apt install -y \
  libgbm1 \
  libdrm2 \
  libxshmfence1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  libxcomposite1 \
  libxi6 \
  libxtst6 \
  libxkbcommon0 \
  libgtk-3-0 \
  libnss3 \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdbus-1-3 \
  libx11-xcb1 \
  libxcb-dri3-0 \
  libxcb-dri2-0 \
  libxcb-glx0 \
  libgl1 \
  libegl1
```

如果 `libasound2` 不存在，换成：

```bash
apt install -y libasound2t64
```

检查 Chrome 缺库：

```bash
ldd /opt/google/chrome/chrome | grep "not found"
ldd /home/cloudrender/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome | grep "not found"
```

### 5. 创建 NVIDIA Xorg 配置

先查真实 BusID：

```bash
nvidia-xconfig --query-gpu-info
```

例如旧服务器 RTX 2080 SUPER 为：

```text
PCI BusID : PCI:129:0:0
```

新服务器成功配置使用 NVIDIA 专用 `ModulePath`：

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

如果旧服务器没有 `/usr/lib/x86_64-linux-gnu/nvidia/xorg`，但存在 `/usr/lib/xorg/modules/extensions/libglxserver_nvidia.so*`，可建立兼容目录：

```bash
mkdir -p /usr/lib/x86_64-linux-gnu/nvidia/xorg

ln -sf /usr/lib/xorg/modules/extensions/libglxserver_nvidia.so \
  /usr/lib/x86_64-linux-gnu/nvidia/xorg/libglxserver_nvidia.so

ln -sf /usr/lib/xorg/modules/extensions/libglxserver_nvidia.so.* \
  /usr/lib/x86_64-linux-gnu/nvidia/xorg/
```

写入配置：

```bash
cat > /etc/X11/xorg-nvidia-gpu0.conf <<'EOF'
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
EOF
```

注意：旧服务器排障中曾加入 `Option "UseDisplayDevice" "none"`，最终为了复刻新服务器配置已移除。推荐只保留 `AllowEmptyInitialConfiguration`。

### 6. 启动并验证 Xorg :99

```bash
pkill -f "node server.js"
pkill -f "google-chrome"
pkill -f "chrome"
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

检查日志：

```bash
grep -iE "Using config|ModulePath|NVIDIA\(0\)|NVIDIA GLX|DRISWRAST|swrast|Another vendor" /var/log/Xorg.99.log
```

正确特征：

```text
ModulePath set to "/usr/lib/x86_64-linux-gnu/nvidia/xorg,/usr/lib/xorg/modules"
NVIDIA GLX Module
NVIDIA(0): NVIDIA GPU ...
NVIDIA(0): [DRI2] Setup complete
```

错误特征：

```text
IGLX: Loaded and initialized swrast
GLX: Initialized DRISWRAST GL provider for screen 0
```

`GLX: Another vendor is already registered for screen 0` 可作为警告观察，只要没有 `swrast / DRISWRAST`，且后续 WebGL2 验证通过即可。

### 7. 修复 Puppeteer Chrome 权限

旧服务器曾出现 Chrome 127 GPU 进程无法加载自己的 GLES 库：

```text
Failed to load GLES library: .../chrome-linux64/libGLESv2.so: 权限不够
gl::init::InitializeStaticGLBindingsOneOff failed
Exiting GPU process due to errors during initialization
```

修复：

```bash
chmod -R a+rX /home/cloudrender/.cache/puppeteer/chrome/linux-127.0.6533.88
chmod +x /home/cloudrender/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome

chmod o+x /home/cloudrender
chmod o+x /home/cloudrender/.cache
chmod o+x /home/cloudrender/.cache/puppeteer
chmod o+x /home/cloudrender/.cache/puppeteer/chrome
```

### 8. WebGL2 最小验证

在启动项目之前必须先验证 WebGL2。使用与项目相同的 Chrome 参数：

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

期望输出包含：

```text
WebGL 2.0
NVIDIA
```

如果只看到 WebGL1，说明 Chrome 版本或 ANGLE 后端不兼容；如果 WebGL1/WebGL2 都是 `null`，优先查看 `/tmp/chrome*-gpu.log` 是否有 `libGLESv2.so 权限不够` 或 GPU 初始化失败。

### 9. WebGL attributes 兼容性

旧服务器曾出现普通 NVIDIA WebGL2 成功，但项目仍报：

```text
Could not create a WebGL2 context.
Error creating WebGL context with your selected attributes.
```

最终验证是 `powerPreference: 'high-performance'` 导致：

```text
default: ok
antialias true: ok
high performance: failed
project attrs: failed
```

因此 Linux 兼容性推荐：

```js
new THREE.WebGLRenderer({ canvas, antialias: true })
```

不要强制：

```js
powerPreference: 'high-performance'
```

去掉该选项不会导致掉到 CPU；如果 WebGL2 最小验证中的 renderer 已经显示 `NVIDIA`，默认路径仍使用 NVIDIA GPU。

### 10. 最终启动命令

确认 Xorg 和 WebGL2 验证通过后再启动项目：

```bash
cd /home/CloudRendering/three.js

DISPLAY=:99 \
__GLX_VENDOR_LIBRARY_NAME=nvidia \
__NV_PRIME_RENDER_OFFLOAD=1 \
HEADLESS=false \
CHROME_PATH=/home/cloudrender/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome \
HOST=0.0.0.0 \
PORT=3000 \
POINT_CLOUD_FILE=all_points_aligned_icp_baked.tiles/manifest.json \
STREAM_WIDTH=1280 \
STREAM_HEIGHT=720 \
STREAM_FPS=15 \
STREAM_BITRATE=4000000 \
npm start
```

小点云快速验证：

```bash
POINT_CLOUD_FILE=GlobalMap.pcd
```

### 11. 常见症状与结论

```text
Browser was not found at configured executablePath
  -> CHROME_PATH 不存在，改用系统 Chrome 或安装 Puppeteer Chrome。

GL_VENDOR = Disabled / GL_RENDERER = Disabled
  -> Chrome GPU 初始化失败，检查 Xorg、NVIDIA GL 库、Chrome 权限和 Chrome 参数。

Xorg 日志出现 swrast / DRISWRAST
  -> Xorg 没有真正绑定 NVIDIA，检查 BusID 和 ModulePath。

ldconfig 查不到 libGLX_nvidia / libEGL_nvidia / libnvidia-glcore
  -> NVIDIA 用户态库未进动态链接缓存，补 /etc/ld.so.conf.d/nvidia-manual.conf 后 ldconfig。

Chrome 127 日志提示 libGLESv2.so 权限不够
  -> 修复 Puppeteer Chrome 目录 a+rX 和上层目录 o+x。

系统 Chrome 只能 WebGL1，WebGL2 为 null
  -> 系统 Chrome 版本可能过新或与驱动组合不兼容，优先使用 Puppeteer Chrome 127。

普通 WebGL2 成功，但 Three.js WebGLRenderer 失败 selected attributes
  -> 检查 renderer 创建参数，Linux 上不要强制 powerPreference: 'high-performance'。
```

## 最终判断

- Linux 上 Xorg 能绑定 NVIDIA，但必须安装并加载 NVIDIA GLX server 模块，否则会回退到 swrast / llvmpipe。
- `--use-gl=egl` 在当前 Chrome 127 / NVIDIA 525 / Ubuntu 18.04 环境下会触发 GPU 进程崩溃，不作为最终方案。
- `--use-gl=desktop` 在 Puppeteer Chrome 127 中不可用，会出现 GL implementation 不允许的问题。
- 当前优先可用方案是 NVIDIA Dummy Xorg `:99` + NVIDIA GLX Module + Puppeteer Chrome 127 + Chrome `--use-gl=angle`。
- 部分旧服务器上 `powerPreference: 'high-performance'` 会导致 WebGL2 context 创建失败，应移除该 renderer attribute。
- 已验证 Puppeteer WebGL2 renderer 为 `ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3090/PCIe/SSE2, OpenGL 4.5.0)`。

## 当前结论

Windows + Edge / Puppeteer / ANGLE / Direct3D 仍是稳定可用方案。

Linux + Chrome / Puppeteer / Three.js 服务端 WebGL 已在 Ubuntu 18.04 + NVIDIA 525 + RTX 3090 环境跑通，关键是补齐 `libnvidia-gl-525` 并让 Xorg 从 NVIDIA ModulePath 加载 `glxserver_nvidia`。

后续如果迁移到其他 Linux 机器，应优先检查：

1. `libnvidia-gl-<driver>` 是否安装。
2. Xorg 日志是否包含 `NVIDIA GLX Module`。
3. Xorg 是否回退到 `swrast` / `DRISWRAST`。
4. Puppeteer WebGL renderer 是否包含 `NVIDIA Corporation`。

## 后续待办

- 将 `/tmp/xorg-nvidia-gpu0.conf` 固化到更稳定的位置，例如 `/etc/X11/xorg-nvidia-gpu0.conf`。
- 增加开机启动脚本或 systemd service，确保服务器重启后先启动 `Xorg :99`，再启动 Node 服务。
- 将 `server.js` 的 Chrome args 保持为 `--use-gl=angle --use-angle=gl`，不要回退到 EGL / desktop GL。
- 如更换驱动版本，重新安装匹配版本的 `libnvidia-gl-<driver>` 并复测 Puppeteer WebGL renderer。
- Windows 本地修改同步到 Linux 后，优先检查 `models/`、`scripts/convert-ply-to-tiles.js`、`server.js`、`public/renderer.js` 是否一致。
- 同步后分别验证 `/api/point-clouds`、tiled manifest 加载、标定恢复、无人机动画和 `/api/uav/running-route`。
