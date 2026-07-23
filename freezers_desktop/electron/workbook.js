import ExcelJS from 'exceljs'
import {
  normalizeSnapshot,
  parseLocationLabel,
  toIsoDate,
} from '../src/lib/snapshot.js'

const TOWER_BOXES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M']
const BOX_ROWS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']
const BOX_COLS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']
const TOWER_HEADERS = [
  'BOX',
  'Position',
  'Cell Line Name',
  'Base Line 1',
  'Base Line 2',
  'Split',
  'Date Frozen',
  'Date LN',
  'Flask',
  'Source',
  'Thaw in…',
  'Notes',
  'Mycoplasma?',
]

function normalizeHeader(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function asText(value) {
  if (value == null) return ''
  if (typeof value === 'object') {
    if ('result' in value && value.result != null) return asText(value.result)
    if ('text' in value && value.text != null) return asText(value.text)
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).trim()
}

function asDate(value) {
  if (!value) return null
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  const parsed = new Date(value)
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10)
  return asText(value) || null
}

function headerMap(sheet, rowNumber) {
  const row = sheet.getRow(rowNumber)
  const map = new Map()
  for (let col = 1; col <= Math.max(row.cellCount, sheet.columnCount); col += 1) {
    const key = normalizeHeader(row.getCell(col).value)
    if (key) {
      map.set(key, col)
    }
  }
  return map
}

function parseArchiveLocation(locationValue, positionValue) {
  const locationText = asText(locationValue)
  const positionText = asText(positionValue)
  const match = locationText.match(/^(\d+)\s*([A-Za-z])(?:\s*([A-Za-z]\d{1,2}))?$/)
  if (!match) {
    return {
      archivedTower: null,
      archivedBox: null,
      archivedPosition: positionText ? positionText.toUpperCase() : null,
    }
  }
  return {
    archivedTower: Number(match[1]),
    archivedBox: match[2].toUpperCase(),
    archivedPosition: (match[3] ?? positionText ?? '').toString().trim().toUpperCase() || null,
  }
}

function createBaseSnapshot() {
  const now = new Date().toISOString()
  return normalizeSnapshot({
    version: 1,
    labName: "Malitha's boxes",
    createdAt: now,
    updatedAt: now,
    aliquots: [],
    boxVerifications: [],
    thawUsers: [],
    events: [],
  })
}

export async function workbookToSnapshot(filePath) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)

  const snapshot = createBaseSnapshot()
  let nextId = 1

  for (const sheet of workbook.worksheets) {
    const sheetName = String(sheet.name ?? '').trim()
    if (/^\d+$/.test(sheetName)) {
      const tower = Number(sheetName)
      for (let start = 3; start <= sheet.columnCount; start += 14) {
        const boxTitle = asText(sheet.getRow(2).getCell(start).value)
        const positionHeader = asText(sheet.getRow(4).getCell(start + 1).value)
        const cellHeader = asText(sheet.getRow(4).getCell(start + 2).value)
        if (!boxTitle || !/^BOX$/i.test(asText(sheet.getRow(4).getCell(start).value)) || !/^Position$/i.test(positionHeader) || !/^Cell Line Name$/i.test(cellHeader)) {
          continue
        }

        const boxMatch = boxTitle.match(/^(\d+)\s*([A-Za-z])$/)
        const box = boxMatch ? boxMatch[2].toUpperCase() : boxTitle.replace(/^\d+/, '').trim().toUpperCase()
        if (!box) continue

        for (let row = 5; row <= sheet.rowCount; row += 1) {
          const position = asText(sheet.getRow(row).getCell(start + 1).value)
          const cellLineName = asText(sheet.getRow(row).getCell(start + 2).value)
          if (!cellLineName) continue

          snapshot.aliquots.push({
            id: nextId++,
            batchId: null,
            batchIndex: null,
            cellLineName,
            baseLine1: asText(sheet.getRow(row).getCell(start + 3).value) || null,
            baseLine2: asText(sheet.getRow(row).getCell(start + 4).value) || null,
            split: asText(sheet.getRow(row).getCell(start + 5).value) || null,
            dateFrozen: asDate(sheet.getRow(row).getCell(start + 6).value),
            dateLn: asDate(sheet.getRow(row).getCell(start + 7).value),
            flask: asText(sheet.getRow(row).getCell(start + 8).value) || null,
            source: asText(sheet.getRow(row).getCell(start + 9).value) || null,
            thawIn: asText(sheet.getRow(row).getCell(start + 10).value) || null,
            notes: asText(sheet.getRow(row).getCell(start + 11).value) || null,
            mycoplasma: asText(sheet.getRow(row).getCell(start + 12).value) || null,
            status: 'IN_LN',
            tower,
            box,
            position: position ? position.toUpperCase() : null,
            createdBy: null,
            thawedBy: null,
            dateThawed: null,
            archivedTower: null,
            archivedBox: null,
            archivedPosition: null,
          })
        }
      }
      continue
    }

    if (sheetName === 'In -80') {
      const headers = headerMap(sheet, 2)
      const cellLineCol = headers.get(normalizeHeader('Cell Line Name'))
      const baseLine1Col = headers.get(normalizeHeader('Base Line 1'))
      const baseLine2Col = headers.get(normalizeHeader('Base Line 2'))
      const splitCol = headers.get(normalizeHeader('Split'))
      const dateFrozenCol = headers.get(normalizeHeader('Date Frozen'))
      const dateLnCol = headers.get(normalizeHeader('Date LN'))
      const flaskCol = headers.get(normalizeHeader('Flask'))
      const sourceCol = headers.get(normalizeHeader('Source'))
      const thawInCol = headers.get(normalizeHeader('Thaw in…')) ?? headers.get(normalizeHeader('Thaw in'))
      const notesCol = headers.get(normalizeHeader('Notes'))
      const mycoCol = headers.get(normalizeHeader('Mycoplasma?'))
      const numberAliquotsCol = headers.get(normalizeHeader('Number Aliquots'))
      const byCol = headers.get(normalizeHeader('By'))

      for (let row = 3; row <= sheet.rowCount; row += 1) {
        const cellLineName = asText(sheet.getRow(row).getCell(cellLineCol ?? 2).value)
        if (!cellLineName) continue
        const aliquots = Number(asText(sheet.getRow(row).getCell(numberAliquotsCol ?? 14).value)) || 1
        const batchId = `batch-${nextId}-${Date.now()}`
        const createdBy = asText(sheet.getRow(row).getCell(byCol ?? 0).value) || null

        for (let index = 1; index <= aliquots; index += 1) {
          snapshot.aliquots.push({
            id: nextId++,
            batchId,
            batchIndex: index,
            cellLineName,
            baseLine1: baseLine1Col ? asText(sheet.getRow(row).getCell(baseLine1Col).value) || null : null,
            baseLine2: baseLine2Col ? asText(sheet.getRow(row).getCell(baseLine2Col).value) || null : null,
            split: splitCol ? asText(sheet.getRow(row).getCell(splitCol).value) || null : null,
            dateFrozen: dateFrozenCol ? asDate(sheet.getRow(row).getCell(dateFrozenCol).value) : null,
            dateLn: dateLnCol ? asDate(sheet.getRow(row).getCell(dateLnCol).value) : null,
            flask: flaskCol ? asText(sheet.getRow(row).getCell(flaskCol).value) || null : null,
            source: sourceCol ? asText(sheet.getRow(row).getCell(sourceCol).value) || null : null,
            thawIn: thawInCol ? asText(sheet.getRow(row).getCell(thawInCol).value) || null : null,
            notes: notesCol ? asText(sheet.getRow(row).getCell(notesCol).value) || null : null,
            mycoplasma: mycoCol ? asText(sheet.getRow(row).getCell(mycoCol).value) || null : null,
            status: 'IN_80',
            tower: null,
            box: null,
            position: null,
            createdBy,
            thawedBy: null,
            dateThawed: null,
            archivedTower: null,
            archivedBox: null,
            archivedPosition: null,
          })
        }
      }
      continue
    }

    if (sheetName === 'Archive') {
      const headers = headerMap(sheet, 2)
      const cellLineCol = headers.get(normalizeHeader('Cell Line Name'))
      const baseLine1Col = headers.get(normalizeHeader('Base Line 1'))
      const baseLine2Col = headers.get(normalizeHeader('Base Line 2'))
      const splitCol = headers.get(normalizeHeader('Split'))
      const dateFrozenCol = headers.get(normalizeHeader('Date Frozen'))
      const dateLnCol = headers.get(normalizeHeader('Date LN'))
      const flaskCol = headers.get(normalizeHeader('Flask'))
      const sourceCol = headers.get(normalizeHeader('Source'))
      const thawInCol = headers.get(normalizeHeader('Thaw in…')) ?? headers.get(normalizeHeader('Thaw in'))
      const notesCol = headers.get(normalizeHeader('Notes'))
      const mycoCol = headers.get(normalizeHeader('Mycoplasma?'))
      const locationCol = headers.get(normalizeHeader('Location'))
      const positionCol = headers.get(normalizeHeader('Position'))
      const dateThawedCol = headers.get(normalizeHeader('Date Thawed'))
      const byCol = headers.get(normalizeHeader('By'))

      for (let row = 3; row <= sheet.rowCount; row += 1) {
        const cellLineName = asText(sheet.getRow(row).getCell(cellLineCol ?? 2).value)
        if (!cellLineName) continue
        const { archivedTower, archivedBox, archivedPosition } = parseArchiveLocation(
          locationCol ? sheet.getRow(row).getCell(locationCol).value : null,
          positionCol ? sheet.getRow(row).getCell(positionCol).value : null,
        )
        snapshot.aliquots.push({
          id: nextId++,
          batchId: null,
          batchIndex: null,
          cellLineName,
          baseLine1: baseLine1Col ? asText(sheet.getRow(row).getCell(baseLine1Col).value) || null : null,
          baseLine2: baseLine2Col ? asText(sheet.getRow(row).getCell(baseLine2Col).value) || null : null,
          split: splitCol ? asText(sheet.getRow(row).getCell(splitCol).value) || null : null,
          dateFrozen: dateFrozenCol ? asDate(sheet.getRow(row).getCell(dateFrozenCol).value) : null,
          dateLn: dateLnCol ? asDate(sheet.getRow(row).getCell(dateLnCol).value) : null,
          flask: flaskCol ? asText(sheet.getRow(row).getCell(flaskCol).value) || null : null,
          source: sourceCol ? asText(sheet.getRow(row).getCell(sourceCol).value) || null : null,
          thawIn: thawInCol ? asText(sheet.getRow(row).getCell(thawInCol).value) || null : null,
          notes: notesCol ? asText(sheet.getRow(row).getCell(notesCol).value) || null : null,
          mycoplasma: mycoCol ? asText(sheet.getRow(row).getCell(mycoCol).value) || null : null,
          status: 'ARCHIVED',
          tower: null,
          box: null,
          position: null,
          createdBy: byCol ? asText(sheet.getRow(row).getCell(byCol).value) || null : null,
          thawedBy: byCol ? asText(sheet.getRow(row).getCell(byCol).value) || null : null,
          dateThawed: dateThawedCol ? asDate(sheet.getRow(row).getCell(dateThawedCol).value) : null,
          archivedTower,
          archivedBox,
          archivedPosition,
        })
      }
      continue
    }

    if (sheetName === 'Box verifications') {
      const headers = headerMap(sheet, 2)
      const towerCol = headers.get(normalizeHeader('Tower'))
      const boxCol = headers.get(normalizeHeader('Box'))
      const verifiedOkCol = headers.get(normalizeHeader('Verified OK'))
      const verifiedByCol = headers.get(normalizeHeader('Verified By'))
      const verifiedDateCol = headers.get(normalizeHeader('Verified Date'))
      const notesCol = headers.get(normalizeHeader('Notes'))
      const createdAtCol = headers.get(normalizeHeader('Created At'))
      for (let row = 3; row <= sheet.rowCount; row += 1) {
        const tower = asText(sheet.getRow(row).getCell(towerCol ?? 1).value)
        const box = asText(sheet.getRow(row).getCell(boxCol ?? 2).value)
        if (!tower || !box) continue
        snapshot.boxVerifications.push({
          id: nextId++,
          tower: Number(tower),
          box: box.toUpperCase(),
          verifiedOk: String(verifiedOkCol ? sheet.getRow(row).getCell(verifiedOkCol).value : '1') !== '0',
          verifiedBy: verifiedByCol ? asText(sheet.getRow(row).getCell(verifiedByCol).value) || null : null,
          verifiedDate: verifiedDateCol ? asDate(sheet.getRow(row).getCell(verifiedDateCol).value) : null,
          notes: notesCol ? asText(sheet.getRow(row).getCell(notesCol).value) || null : null,
          createdAt: createdAtCol ? asDate(sheet.getRow(row).getCell(createdAtCol).value) || new Date().toISOString() : new Date().toISOString(),
        })
      }
    }
  }

  return snapshot
}

function writeListSheet(workbook, name, rows, columns) {
  const sheet = workbook.addWorksheet(name)
  sheet.addRow(columns)
  sheet.getRow(1).font = { bold: true }
  for (const row of rows) {
    sheet.addRow(columns.map((column) => row[column.key] ?? null))
  }
  sheet.columns = columns.map((column) => ({ header: column.label, key: column.key, width: column.width ?? 18 }))
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
  return sheet
}

function groupedPendingRows(snapshot) {
  const groups = new Map()
  for (const aliquot of snapshot.aliquots.filter((entry) => entry.status === 'IN_80')) {
    const key = [
      aliquot.cellLineName ?? '',
      aliquot.baseLine1 ?? '',
      aliquot.baseLine2 ?? '',
      aliquot.split ?? '',
      aliquot.dateFrozen ?? '',
      aliquot.dateLn ?? '',
      aliquot.flask ?? '',
      aliquot.source ?? '',
      aliquot.thawIn ?? '',
      aliquot.notes ?? '',
      aliquot.mycoplasma ?? '',
      aliquot.createdBy ?? '',
    ].join('||')
    if (!groups.has(key)) {
      groups.set(key, {
        cellLineName: aliquot.cellLineName ?? '',
        baseLine1: aliquot.baseLine1 ?? '',
        baseLine2: aliquot.baseLine2 ?? '',
        split: aliquot.split ?? '',
        dateFrozen: aliquot.dateFrozen ?? '',
        dateLn: aliquot.dateLn ?? '',
        flask: aliquot.flask ?? '',
        source: aliquot.source ?? '',
        thawIn: aliquot.thawIn ?? '',
        notes: aliquot.notes ?? '',
        mycoplasma: aliquot.mycoplasma ?? '',
        createdBy: aliquot.createdBy ?? '',
        numberAliquots: 0,
      })
    }
    groups.get(key).numberAliquots += 1
  }
  return [...groups.values()]
}

function groupedArchiveRows(snapshot) {
  return snapshot.aliquots
    .filter((entry) => entry.status === 'ARCHIVED')
    .map((aliquot) => ({
      cellLineName: aliquot.cellLineName ?? '',
      baseLine1: aliquot.baseLine1 ?? '',
      baseLine2: aliquot.baseLine2 ?? '',
      split: aliquot.split ?? '',
      dateFrozen: aliquot.dateFrozen ?? '',
      dateLn: aliquot.dateLn ?? '',
      dateThawed: aliquot.dateThawed ?? '',
      thawedBy: aliquot.thawedBy ?? '',
      flask: aliquot.flask ?? '',
      source: aliquot.source ?? '',
      thawIn: aliquot.thawIn ?? '',
      notes: aliquot.notes ?? '',
      mycoplasma: aliquot.mycoplasma ?? '',
      location: aliquot.archivedTower != null && aliquot.archivedBox ? `${aliquot.archivedTower}${aliquot.archivedBox}` : '',
      position: aliquot.archivedPosition ?? '',
    }))
}

function groupedVerificationRows(snapshot) {
  return snapshot.boxVerifications.map((verification) => ({
    tower: verification.tower ?? '',
    box: verification.box ?? '',
    verifiedOk: verification.verifiedOk ? 1 : 0,
    verifiedBy: verification.verifiedBy ?? '',
    verifiedDate: verification.verifiedDate ?? '',
    notes: verification.notes ?? '',
    createdAt: verification.createdAt ?? '',
  }))
}

function groupedEventRows(snapshot) {
  return snapshot.events.map((event) => ({
    ts: event.ts ?? '',
    user: event.user ?? '',
    action: event.action ?? '',
    aliquotId: event.aliquotId ?? '',
    fromStatus: event.fromStatus ?? '',
    toStatus: event.toStatus ?? '',
    fromLocation: event.fromLocation ?? '',
    toLocation: event.toLocation ?? '',
    note: event.note ?? '',
  }))
}

function towerRows(snapshot, tower) {
  const rows = []
  const aliquots = snapshot.aliquots.filter((entry) => entry.status === 'IN_LN' && Number(entry.tower) === Number(tower))
  for (const box of TOWER_BOXES) {
    for (const row of BOX_ROWS) {
      for (const column of BOX_COLS) {
        const position = `${row}${column}`
        const aliquot = aliquots.find((entry) => String(entry.box).toUpperCase() === box && String(entry.position).toUpperCase() === position)
        rows.push({
          boxTitle: `${tower}${box}`,
          position,
          cellLineName: aliquot?.cellLineName ?? '',
          baseLine1: aliquot?.baseLine1 ?? '',
          baseLine2: aliquot?.baseLine2 ?? '',
          split: aliquot?.split ?? '',
          dateFrozen: aliquot?.dateFrozen ?? '',
          dateLn: aliquot?.dateLn ?? '',
          flask: aliquot?.flask ?? '',
          source: aliquot?.source ?? '',
          thawIn: aliquot?.thawIn ?? '',
          notes: aliquot?.notes ?? '',
          mycoplasma: aliquot?.mycoplasma ?? '',
        })
      }
    }
  }
  return rows
}

export async function snapshotToWorkbook(snapshotInput, filePath) {
  const snapshot = normalizeSnapshot(snapshotInput)
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Freezers Desktop'
  workbook.created = new Date()
  workbook.modified = new Date()

  const appendSheet = workbook.addWorksheet('Append')
  appendSheet.columns = [
    { header: 'Cell Line Name', key: 'cellLineName', width: 28 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Location', key: 'location', width: 16 },
    { header: 'Position', key: 'position', width: 12 },
    { header: 'Split', key: 'split', width: 12 },
    { header: 'Date Frozen', key: 'dateFrozen', width: 14 },
    { header: 'Date Thawed', key: 'dateThawed', width: 14 },
    { header: 'Thawed By', key: 'thawedBy', width: 20 },
    { header: 'Created By', key: 'createdBy', width: 20 },
    { header: 'Notes', key: 'notes', width: 30 },
  ]
  appendSheet.addRow([
    'Cell Line Name',
    'Status',
    'Location',
    'Position',
    'Split',
    'Date Frozen',
    'Date Thawed',
    'Thawed By',
    'Created By',
    'Notes',
  ])
  appendSheet.getRow(1).font = { bold: true }
  for (const aliquot of snapshot.aliquots) {
    appendSheet.addRow({
      cellLineName: aliquot.cellLineName ?? '',
      status: aliquot.status ?? '',
      location:
        aliquot.status === 'ARCHIVED'
          ? aliquot.archivedTower != null && aliquot.archivedBox
            ? `${aliquot.archivedTower}${aliquot.archivedBox}`
            : ''
          : aliquot.tower != null && aliquot.box
            ? `${aliquot.tower}${aliquot.box}`
            : '',
      position: aliquot.status === 'ARCHIVED' ? aliquot.archivedPosition ?? '' : aliquot.position ?? '',
      split: aliquot.split ?? '',
      dateFrozen: aliquot.dateFrozen ?? '',
      dateThawed: aliquot.dateThawed ?? '',
      thawedBy: aliquot.thawedBy ?? '',
      createdBy: aliquot.createdBy ?? '',
      notes: aliquot.notes ?? '',
    })
  }
  appendSheet.views = [{ state: 'frozen', ySplit: 1 }]

  const towers = [...new Set(snapshot.aliquots.filter((entry) => entry.status === 'IN_LN' && entry.tower != null).map((entry) => Number(entry.tower)))].sort((left, right) => left - right)
  for (const tower of towers) {
    const sheet = workbook.addWorksheet(String(tower))
    for (let index = 0; index < TOWER_BOXES.length; index += 1) {
      const start = 3 + index * 14
      sheet.getRow(2).getCell(start).value = `${tower}${TOWER_BOXES[index]}`
      sheet.getRow(4).getCell(start).value = 'BOX'
      TOWER_HEADERS.forEach((header, headerIndex) => {
        sheet.getRow(4).getCell(start + headerIndex).value = header
      })
      for (let rowIndex = 0; rowIndex < BOX_ROWS.length; rowIndex += 1) {
        for (let columnIndex = 0; columnIndex < BOX_COLS.length; columnIndex += 1) {
          const rowNumber = 5 + rowIndex * 10 + columnIndex
          const position = `${BOX_ROWS[rowIndex]}${BOX_COLS[columnIndex]}`
          const aliquot = snapshot.aliquots.find(
            (entry) =>
              entry.status === 'IN_LN' &&
              Number(entry.tower) === Number(tower) &&
              String(entry.box).toUpperCase() === TOWER_BOXES[index] &&
              String(entry.position).toUpperCase() === position,
          )
          sheet.getRow(rowNumber).getCell(start + 1).value = position
          if (aliquot) {
            sheet.getRow(rowNumber).getCell(start + 2).value = aliquot.cellLineName ?? ''
            sheet.getRow(rowNumber).getCell(start + 3).value = aliquot.baseLine1 ?? ''
            sheet.getRow(rowNumber).getCell(start + 4).value = aliquot.baseLine2 ?? ''
            sheet.getRow(rowNumber).getCell(start + 5).value = aliquot.split ?? ''
            sheet.getRow(rowNumber).getCell(start + 6).value = aliquot.dateFrozen ?? ''
            sheet.getRow(rowNumber).getCell(start + 7).value = aliquot.dateLn ?? ''
            sheet.getRow(rowNumber).getCell(start + 8).value = aliquot.flask ?? ''
            sheet.getRow(rowNumber).getCell(start + 9).value = aliquot.source ?? ''
            sheet.getRow(rowNumber).getCell(start + 10).value = aliquot.thawIn ?? ''
            sheet.getRow(rowNumber).getCell(start + 11).value = aliquot.notes ?? ''
            sheet.getRow(rowNumber).getCell(start + 12).value = aliquot.mycoplasma ?? ''
          }
        }
      }
    }
  }

  const in80Sheet = workbook.addWorksheet('In -80')
  in80Sheet.columns = [
    { header: 'Cell Line Name', key: 'cellLineName', width: 28 },
    { header: 'Base Line 1', key: 'baseLine1', width: 16 },
    { header: 'Base Line 2', key: 'baseLine2', width: 16 },
    { header: 'Split', key: 'split', width: 12 },
    { header: 'Date Frozen', key: 'dateFrozen', width: 14 },
    { header: 'Date LN', key: 'dateLn', width: 14 },
    { header: 'Flask', key: 'flask', width: 14 },
    { header: 'Source', key: 'source', width: 16 },
    { header: 'Thaw in…', key: 'thawIn', width: 16 },
    { header: 'Notes', key: 'notes', width: 30 },
    { header: 'Mycoplasma?', key: 'mycoplasma', width: 14 },
    { header: 'Column1', key: 'column1', width: 14 },
    { header: 'Number Aliquots', key: 'numberAliquots', width: 15 },
    { header: 'By', key: 'by', width: 18 },
  ]
  in80Sheet.addRow(in80Sheet.columns.map((column) => column.header))
  in80Sheet.getRow(1).font = { bold: true }
  for (const row of groupedPendingRows(snapshot)) {
    in80Sheet.addRow({
      ...row,
      column1: '',
      numberAliquots: row.numberAliquots,
    })
  }
  in80Sheet.views = [{ state: 'frozen', ySplit: 1 }]

  const archiveSheet = workbook.addWorksheet('Archive')
  archiveSheet.columns = [
    { header: 'Cell Line Name', key: 'cellLineName', width: 28 },
    { header: 'Base Line 1', key: 'baseLine1', width: 16 },
    { header: 'Base Line 2', key: 'baseLine2', width: 16 },
    { header: 'Split', key: 'split', width: 12 },
    { header: 'Date Frozen', key: 'dateFrozen', width: 14 },
    { header: 'Date LN', key: 'dateLn', width: 14 },
    { header: 'Flask', key: 'flask', width: 14 },
    { header: 'Source', key: 'source', width: 16 },
    { header: 'Thaw in…', key: 'thawIn', width: 16 },
    { header: 'Notes', key: 'notes', width: 30 },
    { header: 'Mycoplasma?', key: 'mycoplasma', width: 14 },
    { header: 'Location', key: 'location', width: 14 },
    { header: 'Position', key: 'position', width: 12 },
    { header: 'Date Thawed', key: 'dateThawed', width: 14 },
    { header: 'By', key: 'thawedBy', width: 18 },
  ]
  archiveSheet.addRow(archiveSheet.columns.map((column) => column.header))
  archiveSheet.getRow(1).font = { bold: true }
  for (const row of groupedArchiveRows(snapshot)) {
    archiveSheet.addRow(row)
  }
  archiveSheet.views = [{ state: 'frozen', ySplit: 1 }]

  const verificationSheet = workbook.addWorksheet('Box verifications')
  verificationSheet.columns = [
    { header: 'Tower', key: 'tower', width: 10 },
    { header: 'Box', key: 'box', width: 10 },
    { header: 'Verified OK', key: 'verifiedOk', width: 12 },
    { header: 'Verified By', key: 'verifiedBy', width: 18 },
    { header: 'Verified Date', key: 'verifiedDate', width: 14 },
    { header: 'Notes', key: 'notes', width: 30 },
    { header: 'Created At', key: 'createdAt', width: 24 },
  ]
  verificationSheet.addRow(verificationSheet.columns.map((column) => column.header))
  verificationSheet.getRow(1).font = { bold: true }
  for (const row of groupedVerificationRows(snapshot)) {
    verificationSheet.addRow(row)
  }
  verificationSheet.views = [{ state: 'frozen', ySplit: 1 }]

  const eventSheet = workbook.addWorksheet('Events')
  eventSheet.columns = [
    { header: 'Timestamp', key: 'ts', width: 24 },
    { header: 'User', key: 'user', width: 18 },
    { header: 'Action', key: 'action', width: 20 },
    { header: 'Aliquot ID', key: 'aliquotId', width: 12 },
    { header: 'From Status', key: 'fromStatus', width: 14 },
    { header: 'To Status', key: 'toStatus', width: 14 },
    { header: 'From Location', key: 'fromLocation', width: 18 },
    { header: 'To Location', key: 'toLocation', width: 18 },
    { header: 'Note', key: 'note', width: 40 },
  ]
  eventSheet.addRow(eventSheet.columns.map((column) => column.header))
  eventSheet.getRow(1).font = { bold: true }
  for (const row of groupedEventRows(snapshot)) {
    eventSheet.addRow(row)
  }
  eventSheet.views = [{ state: 'frozen', ySplit: 1 }]

  await workbook.xlsx.writeFile(filePath)
  return filePath
}
