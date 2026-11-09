const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});

console.log('Capture script starting...');

try {
  const { registerIpcHandlers } = require('../src/main/ipc/handlers');
  console.log('Required handlers successfully.');
} catch (e) {
  console.error('Error requiring handlers:', e);
}

const ARTIFACT_DIR = 'C:/Users/Divyanshu/.gemini/antigravity/brain/7acbe315-66d5-475d-9ebe-8507dc33426a';
const ASSETS_DIR = path.join(__dirname, '../assets');

app.whenReady().then(async () => {
  console.log('App ready in capture script');
  try {
    const { registerIpcHandlers } = require('../src/main/ipc/handlers');
    const win = new BrowserWindow({
      width: 440,
      height: 600,
      frame: false,
      show: true,
      backgroundColor: '#101012',
      webPreferences: {
        preload: path.join(__dirname, '../src/preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    console.log('Registering IPC handlers...');
    registerIpcHandlers(win);

    const prodHtml = path.join(__dirname, '../dist/renderer/index.html');
    console.log('Loading prodHtml:', prodHtml);
    await win.loadFile(prodHtml);
    console.log('Loaded file successfully.');

    await new Promise((r) => setTimeout(r, 1500));

    const mainImage = await win.capturePage();
    const mainBuffer = mainImage.toPNG();
    fs.writeFileSync(path.join(ASSETS_DIR, 'screenshot-main.png'), mainBuffer);
    if (fs.existsSync(ARTIFACT_DIR)) {
      fs.writeFileSync(path.join(ARTIFACT_DIR, 'screenshot-main.png'), mainBuffer);
    }
    console.log('[CAPTURE] Captured screenshot-main.png successfully.');

    await win.webContents.executeJavaScript(`
      const btn = document.querySelector('button[title="Settings"]');
      if (btn) btn.click();
    `);

    await new Promise((r) => setTimeout(r, 600));

    const settingsImage = await win.capturePage();
    const settingsBuffer = settingsImage.toPNG();
    fs.writeFileSync(path.join(ASSETS_DIR, 'screenshot-settings.png'), settingsBuffer);
    if (fs.existsSync(ARTIFACT_DIR)) {
      fs.writeFileSync(path.join(ARTIFACT_DIR, 'screenshot-settings.png'), settingsBuffer);
    }
    console.log('[CAPTURE] Captured screenshot-settings.png successfully.');

    app.quit();
  } catch (err) {
    console.error('Error inside whenReady:', err);
    app.quit();
  }
});
