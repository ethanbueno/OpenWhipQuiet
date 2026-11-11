const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

// ── Win32 FFI (Windows only) ────────────────────────────────────────────────
let keybd_event;
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    keybd_event = user32.func('void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)');
  } catch (e) {
    console.warn('koffi not available – focus restore disabled', e.message);
  }
}

const VK_MENU = 0x12; // Alt
const VK_TAB  = 0x09;
const KEYUP   = 0x0002;

/**
 * One Alt+Tab / Cmd+Tab so focus returns to the previously active app after a tray click.
 * Without it, focus stays on the taskbar and the tray popup stays open.
 */
function refocusPreviousApp() {
  const delayMs = 80;
  const run = () => {
    if (process.platform === 'win32') {
      if (!keybd_event) return;
      keybd_event(VK_MENU, 0, 0, 0);
      keybd_event(VK_TAB, 0, 0, 0);
      keybd_event(VK_TAB, 0, KEYUP, 0);
      keybd_event(VK_MENU, 0, KEYUP, 0);
    } else if (process.platform === 'darwin') {
      const script = [
        'tell application "System Events"',
        '  key down command',
        '  key code 48', // Tab
        '  key up command',
        'end tell',
      ].join('\n');
      execFile('osascript', ['-e', script], err => {
        if (err) {
          console.warn('refocus previous app (Cmd+Tab) failed:', err.message);
        }
      });
    } else if (process.platform === 'linux') {
      execFile('xdotool', ['key', '--clearmodifiers', 'alt+Tab'], err => {
        if (err) {
          console.warn('refocus previous app (Alt+Tab) failed. Install xdotool:', err.message);
        }
      });
    }
  };
  setTimeout(run, delayMs);
}

// ── Globals ─────────────────────────────────────────────────────────────────
let tray, overlay;
let overlayReady = false;
let spawnQueued = false;
let refocusQueued = false;

function createTrayIconFallback() {
  const p = path.join(__dirname, 'icon', 'Template.png');
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) {
      if (process.platform === 'darwin') img.setTemplateImage(true);
      return img;
    }
  }
  console.warn('openwhip: icon/Template.png missing or invalid');
  return nativeImage.createEmpty();
}

async function tryIcnsTrayImage(icnsPath) {
  const size = { width: 64, height: 64 };
  const thumb = await nativeImage.createThumbnailFromPath(icnsPath, size);
  if (!thumb.isEmpty()) return thumb;
  return null;
}

// macOS: createFromPath does not decode .icns (Electron only loads PNG/JPEG there, ICO on Windows).
// Quick Look thumbnails handle .icns; copy to temp if the file is inside ASAR (QL needs a real path).
async function getTrayIcon() {
  const iconDir = path.join(__dirname, 'icon');
  if (process.platform === 'win32') {
    const file = path.join(iconDir, 'icon.ico');
    if (fs.existsSync(file)) {
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) return img;
    }
    return createTrayIconFallback();
  }
  if (process.platform === 'darwin') {
    const file = path.join(iconDir, 'AppIcon.icns');
    if (fs.existsSync(file)) {
      const fromPath = nativeImage.createFromPath(file);
      if (!fromPath.isEmpty()) return fromPath;
      try {
        const t = await tryIcnsTrayImage(file);
        if (t) return t;
      } catch (e) {
        console.warn('AppIcon.icns Quick Look thumbnail failed:', e?.message || e);
      }
      const tmp = path.join(os.tmpdir(), 'openwhip-tray.icns');
      try {
        fs.copyFileSync(file, tmp);
        const t = await tryIcnsTrayImage(tmp);
        if (t) return t;
      } catch (e) {
        console.warn('AppIcon.icns temp copy + thumbnail failed:', e?.message || e);
      }
    }
    return createTrayIconFallback();
  }
  return createTrayIconFallback();
}

// ── Overlay window ──────────────────────────────────────────────────────────
function createOverlay() {
  const { bounds } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    x: bounds.x, y: bounds.y,
    width: bounds.width, height: bounds.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlayReady = false;
  overlay.loadFile('overlay.html');
  overlay.webContents.on('did-finish-load', () => {
    overlayReady = true;
    if (spawnQueued && overlay && overlay.isVisible()) {
      spawnQueued = false;
      overlay.webContents.send('spawn-whip');
      if (refocusQueued) refocusPreviousApp();
    }
  });
  overlay.on('closed', () => {
    overlay = null;
    overlayReady = false;
    spawnQueued = false;
  });
}

/** Show the whip. `refocus` sends the Alt+Tab that a tray click needs; a launcher click doesn't. */
function showWhip(refocus) {
  if (overlay && overlay.isVisible()) return;
  if (!overlay) createOverlay();
  overlay.show();
  if (overlayReady) {
    overlay.webContents.send('spawn-whip');
    if (refocus) refocusPreviousApp();
  } else {
    spawnQueued = true;
    refocusQueued = refocus;
  }
}

function toggleOverlay() {
  if (overlay && overlay.isVisible()) {
    overlay.webContents.send('drop-whip');
    return;
  }
  showWhip(true);
}

// ── IPC ─────────────────────────────────────────────────────────────────────
ipcMain.on('hide-overlay', () => { if (overlay) overlay.hide(); });

// ── Uninstall ───────────────────────────────────────────────────────────────
async function uninstallApp() {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Uninstall', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Uninstall OpenWhip',
    message: 'Uninstall OpenWhip?',
  });
  if (response !== 0) return;

  // Ask before the uninstall starts: its 3 second head start assumes the app quits right away.
  const repos = [
    'https://github.com/GitFrog1111/OpenWhip',
    'https://github.com/ethanbueno/OpenWhipQuiet',
  ];
  const { response: repoChoice } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Original OpenWhip', 'OpenWhipQuiet', 'Close'],
    defaultId: 2,
    cancelId: 2,
    title: 'Uninstall OpenWhip',
    message: 'Open a GitHub page?',
  });
  const openRepo = () => {
    if (repos[repoChoice]) shell.openExternal(repos[repoChoice]).catch(() => {});
  };

  if (app.isPackaged) {
    // Installed from the setup exe: hand off to its uninstaller, which also removes the shortcuts.
    const uninstaller = path.join(path.dirname(process.execPath), 'Uninstall OpenWhip.exe');
    if (!fs.existsSync(uninstaller)) {
      dialog.showErrorBox('Uninstall OpenWhip', 'Could not find the uninstaller. Remove OpenWhip from Windows Settings > Apps instead.');
      return;
    }
    // Start it a few seconds after the app quits, so the app's files aren't in use.
    const child = spawn('cmd.exe', ['/c', `timeout /t 2 /nobreak >nul & "${uninstaller}" /S`],
      { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    child.on('error', err => console.warn('uninstall failed:', err.message));
    child.unref();
    openRepo();
    app.quit();
    return;
  }

  // Remove the launcher script, plus any copy or shortcut on the Desktop or in Startup.
  if (process.platform === 'win32') {
    const startup = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    for (const dir of [__dirname, app.getPath('desktop'), startup]) {
      for (const name of ['OpenWhip.vbs', 'OpenWhip.lnk', 'OpenWhip.vbs - Shortcut.lnk']) {
        try {
          fs.rmSync(path.join(dir, name), { force: true });
        } catch (err) {
          console.warn('could not remove launcher:', err.message);
        }
      }
    }
  }

  // Wait a few seconds so the app has fully exited and released its files.
  const child = process.platform === 'win32'
    ? spawn('cmd.exe', ['/c', 'timeout /t 3 /nobreak >nul & npm uninstall -g openwhip'],
        { stdio: 'ignore', windowsHide: true })
    : spawn('sh', ['-c', 'sleep 3; npm uninstall -g openwhip'],
        { detached: true, stdio: 'ignore' });
  child.on('error', err => console.warn('uninstall failed:', err.message));
  child.unref();
  openRepo();
  app.quit();
}

// ── App lifecycle ───────────────────────────────────────────────────────────
// Opening the app from a shortcut brings the whip out right away: the installed exe always does,
// and the dev launcher (OpenWhip.vbs) passes --whip.
const wantsWhip = argv => app.isPackaged || argv.includes('--whip');

// One instance only: launching again hands its arguments to the running app.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on('second-instance', (_event, argv) => {
  if (wantsWhip(argv)) showWhip(false);
});

app.whenReady().then(async () => {
  if (wantsWhip(process.argv)) showWhip(false);
  tray = new Tray(await getTrayIcon());
  tray.setToolTip('OpenWhip - click for whip');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Quit', click: () => app.quit() },
      { type: 'separator' },
      { label: 'Uninstall', click: uninstallApp },
    ])
  );
  tray.on('click', () => toggleOverlay());
});

app.on('window-all-closed', e => e.preventDefault()); // keep alive in tray
