import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDefaultSnapshotPath, loadSnapshotFile, saveSnapshotFile } from './storage.js'
import { snapshotToWorkbook, workbookToSnapshot } from './workbook.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let mainWindow
let currentSnapshotPath = getDefaultSnapshotPath()

function createSeedSnapshot() {
  const now = new Date().toISOString()
  return {
    version: 1,
    labName: "Malitha's boxes",
    updatedAt: now,
    createdAt: now,
    aliquots: [
      {
        id: 1,
        cellLineName: 'HAP1 WT',
        split: 'P7',
        dateFrozen: '2026-05-01',
        dateThawed: null,
        status: 'IN_LN',
        tower: 24,
        box: 'A',
        position: 'A1',
        notes: 'Reference clone',
        createdBy: 'Malitha',
      },
      {
        id: 2,
        cellLineName: 'HAP1 2C10',
        split: 'P7',
        dateFrozen: '2026-05-01',
        dateThawed: null,
        status: 'IN_LN',
        tower: 24,
        box: 'A',
        position: 'A2',
        notes: '',
        createdBy: 'Malitha',
      },
      {
        id: 3,
        cellLineName: 'HAP1 1B4',
        split: 'P6',
        dateFrozen: '2026-05-10',
        dateThawed: null,
        status: 'IN_80',
        tower: null,
        box: null,
        position: null,
        notes: 'Pending LN transfer',
        createdBy: 'Louise Martin',
      },
      {
        id: 4,
        cellLineName: 'U2OS Cas9',
        split: 'P12',
        dateFrozen: '2026-05-08',
        dateThawed: '2026-05-14',
        status: 'ARCHIVED',
        tower: 24,
        box: 'D',
        position: 'D3',
        notes: 'Archived after thaw',
        createdBy: 'Abimael Cruz-Migoni',
      },
    ],
    boxVerifications: [
      {
        id: 1,
        tower: 24,
        box: 'A',
        verifiedOk: true,
        verifiedBy: 'Malitha',
        verifiedDate: '2026-07-23',
        notes: 'Checked against database',
        createdAt: now,
      },
    ],
    thawUsers: ['Malitha', 'Louise Martin', 'Abimael Cruz-Migoni'],
    events: [],
  }
}

async function loadCurrentSnapshot() {
  const loaded = await loadSnapshotFile(currentSnapshotPath)
  if (loaded) {
    return loaded
  }
  const seed = createSeedSnapshot()
  await saveSnapshotFile(currentSnapshotPath, seed)
  return seed
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1020,
    backgroundColor: '#f7f3fb',
    title: 'Freezers Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (!app.isPackaged) {
    mainWindow.loadURL('http://127.0.0.1:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

app.whenReady().then(async () => {
  ipcMain.handle('snapshot:load', async (_event, requestedPath) => {
    if (requestedPath) {
      currentSnapshotPath = requestedPath
    }
    const snapshot = await loadCurrentSnapshot()
    return { snapshot, path: currentSnapshotPath }
  })

  ipcMain.handle('snapshot:save', async (_event, snapshot) => {
    snapshot.updatedAt = new Date().toISOString()
    const savedPath = await saveSnapshotFile(currentSnapshotPath, snapshot)
    return { path: savedPath }
  })

  ipcMain.handle('snapshot:saveAs', async (_event, snapshot) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Save freezer snapshot',
      defaultPath: currentSnapshotPath,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (canceled || !filePath) {
      return { canceled: true }
    }
    snapshot.updatedAt = new Date().toISOString()
    currentSnapshotPath = filePath
    const savedPath = await saveSnapshotFile(filePath, snapshot)
    return { canceled: false, path: savedPath }
  })

  ipcMain.handle('snapshot:open', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Open freezer snapshot',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (canceled || !filePaths?.length) {
      return { canceled: true }
    }
    currentSnapshotPath = filePaths[0]
    const snapshot = await loadCurrentSnapshot()
    return { canceled: false, snapshot, path: currentSnapshotPath }
  })

  ipcMain.handle('workbook:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Import freezer workbook',
      properties: ['openFile'],
      filters: [{ name: 'Excel workbooks', extensions: ['xlsx'] }],
    })
    if (canceled || !filePaths?.length) {
      return { canceled: true }
    }
    const snapshot = await workbookToSnapshot(filePaths[0])
    return { canceled: false, snapshot, path: filePaths[0] }
  })

  ipcMain.handle('workbook:export', async (_event, snapshot) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export freezer workbook',
      defaultPath: path.join(app.getPath('documents'), 'Freezings_snapshot.xlsx'),
      filters: [{ name: 'Excel workbooks', extensions: ['xlsx'] }],
    })
    if (canceled || !filePath) {
      return { canceled: true }
    }
    await snapshotToWorkbook(snapshot, filePath)
    return { canceled: false, path: filePath }
  })

  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
