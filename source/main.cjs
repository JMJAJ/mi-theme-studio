const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const MAX_PACKAGE_BYTES = 300 * 1024 * 1024;
const MAX_ASSET_BYTES = 100 * 1024 * 1024;

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    title: 'Mi Theme Studio',
    backgroundColor: '#f5f6f8',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('theme:open', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Open a Xiaomi theme package',
    properties: ['openFile'],
    filters: [
      { name: 'MIUI theme packages', extensions: ['mtz', 'zip'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });

  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_PACKAGE_BYTES) {
    throw new Error('This package is larger than the 300 MB import limit.');
  }

  return {
    name: path.basename(filePath),
    data: new Uint8Array(fs.readFileSync(filePath))
  };
});

ipcMain.handle('theme:pick-assets', async (_event, multiple) => {
  const result = await dialog.showOpenDialog({
    title: multiple ? 'Add files to the theme' : 'Replace the selected file',
    properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: [{ name: 'All files', extensions: ['*'] }]
  });

  if (result.canceled) return [];
  return result.filePaths.map((filePath) => {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_ASSET_BYTES) {
      throw new Error(`${path.basename(filePath)} is larger than the 100 MB per-file limit.`);
    }
    return {
      name: path.basename(filePath),
      data: new Uint8Array(fs.readFileSync(filePath))
    };
  });
});

ipcMain.handle('theme:save', async (_event, suggestedName, data) => {
  const result = await dialog.showSaveDialog({
    title: 'Export MIUI theme package',
    defaultPath: suggestedName || 'MyTheme.mtz',
    filters: [{ name: 'MIUI theme package', extensions: ['mtz'] }]
  });

  if (result.canceled || !result.filePath) return false;
  fs.writeFileSync(result.filePath, Buffer.from(data));
  return result.filePath;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
