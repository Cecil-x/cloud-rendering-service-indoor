import { execFileSync } from 'node:child_process';

const port = process.env.PORT || '3000';
const output = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
const pids = new Set();

for (const line of output.split(/\r?\n/)) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 5) continue;
  const [proto, localAddress,, state, pid] = parts;
  if (proto !== 'TCP' || state !== 'LISTENING') continue;
  if (localAddress.endsWith(`:${port}`)) pids.add(pid);
}

if (pids.size === 0) {
  console.log(`No process is listening on port ${port}.`);
  process.exit(0);
}

for (const pid of pids) {
  console.log(`Stopping process ${pid} on port ${port}...`);
  execFileSync('taskkill', ['/PID', pid, '/F'], { stdio: 'inherit' });
}

const processList = execFileSync('powershell', [
  '-NoProfile',
  '-Command',
  'Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq "node.exe" -and $_.CommandLine -match "server\\.js") -or ($_.Name -eq "chrome.exe" -and $_.CommandLine -match "puppeteer_dev_chrome_profile") } | Select-Object -ExpandProperty ProcessId'
], { encoding: 'utf8' });

for (const pid of processList.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
  console.log(`Stopping orphan renderer process ${pid}...`);
  execFileSync('taskkill', ['/PID', pid, '/F'], { stdio: 'inherit' });
}
