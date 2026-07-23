import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'

const SNAPSHOT_FILENAME = 'freezers.snapshot.json'

export function getDefaultSnapshotPath() {
  return path.join(app.getPath('userData'), SNAPSHOT_FILENAME)
}

export async function loadSnapshotFile(filePath) {
  const resolved = filePath ?? getDefaultSnapshotPath()
  try {
    const raw = await fs.readFile(resolved, 'utf8')
    return JSON.parse(raw)
  } catch (error) {
    return null
  }
}

export async function saveSnapshotFile(filePath, snapshot) {
  const resolved = filePath ?? getDefaultSnapshotPath()
  await fs.mkdir(path.dirname(resolved), { recursive: true })
  await fs.writeFile(resolved, JSON.stringify(snapshot, null, 2), 'utf8')
  return resolved
}
