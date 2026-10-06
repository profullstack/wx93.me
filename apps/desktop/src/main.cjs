/**
 * wx93 Desktop.
 *
 * The window is wx93.me itself (the web app is the UI; one codebase). On top:
 *  - "Shorten clipboard" (Ctrl/Cmd+Shift+L while the app is focused, and in the
 *    menu): reads a URL from the clipboard, shortens it, puts the short link back.
 *  - the CLI rides inside the bundle (resources/cli/wx93.mjs), run on this app's
 *    own Node with ELECTRON_RUN_AS_NODE. The curl installer points `wx93` at it,
 *    and "Shorten clipboard" uses it too, so the desktop shares the CLI's sign-in
 *    (`wx93 login`) or API key.
 */
const { app, BrowserWindow, Menu, Notification, clipboard, shell } = require('electron');
const { execFile } = require('node:child_process');
const path = require('node:path');

const SITE = process.env.WX93_URL || 'https://wx93.me';
const CLI = app.isPackaged ? path.join(process.resourcesPath, 'cli', 'wx93.mjs') : path.join(__dirname, '..', '..', 'web', 'public', 'dl', 'wx93.mjs');
let win = null;

function cli(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim().split('\n').pop())) : resolve(stdout.trim()),
    );
  });
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

async function shortenClipboard() {
  const text = clipboard.readText().trim();
  const url = text.match(/https?:\/\/\S+/)?.[0];
  if (!url) return notify('wx93', 'The clipboard has no link in it.');
  try {
    const link = JSON.parse(await cli([url, '--json']));
    clipboard.writeText(link.short_url);
    notify('Copied', `${link.short_url}\n→ ${link.url}`);
  } catch (err) {
    notify('wx93 could not shorten that', err.message);
  }
}

function open(pathname = '/') {
  if (win && !win.isDestroyed()) {
    win.loadURL(`${SITE}${pathname}`);
    return win.focus();
  }
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    title: 'wx93',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.webContents.setUserAgent(`${win.webContents.getUserAgent()} wx93-desktop/${app.getVersion()}`);
  win.loadURL(`${SITE}${pathname}`);
  // Only wx93.me and CoinPay's checkout stay in the window; every other link opens in the browser.
  const stay = [new URL(SITE).origin, 'https://coinpayportal.com'];
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (ev, url) => {
    if (!stay.includes(new URL(url).origin)) {
      ev.preventDefault();
      shell.openExternal(url);
    }
  });
}

function menu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'Links',
      submenu: [
        { label: 'Shorten clipboard', accelerator: 'CmdOrCtrl+Shift+L', click: shortenClipboard },
        { type: 'separator' },
        { label: 'New link', click: () => open('/') },
        { label: 'Your links', click: () => open('/account') },
        { label: 'Pricing', click: () => open('/pricing') },
        { label: 'Docs', click: () => open('/docs') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// wx93://open/<path> deep links, e.g. from the CLI.
const deepLink = (argv) => argv.find((a) => a.startsWith('wx93://'))?.replace(/^wx93:\/\/(open)?/, '') || null;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_e, argv) => open(deepLink(argv) ?? '/'));
  app.whenReady().then(() => {
    app.setAsDefaultProtocolClient('wx93');
    menu();
    open(deepLink(process.argv) ?? '/');
    app.on('activate', () => BrowserWindow.getAllWindows().length || open('/'));
  });
  app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
}
