export function normalizeSnapshot(rawSnapshot) {
  const snapshot = rawSnapshot ?? {}
  return {
    version: snapshot.version ?? 1,
    labName: snapshot.labName ?? "Malitha's boxes",
    createdAt: snapshot.createdAt ?? new Date().toISOString(),
    updatedAt: snapshot.updatedAt ?? new Date().toISOString(),
    aliquots: Array.isArray(snapshot.aliquots) ? snapshot.aliquots : [],
    boxVerifications: Array.isArray(snapshot.boxVerifications) ? snapshot.boxVerifications : [],
    thawUsers: Array.isArray(snapshot.thawUsers) ? snapshot.thawUsers : [],
    events: Array.isArray(snapshot.events) ? snapshot.events : [],
  }
}

export function cloneSnapshot(snapshot) {
  return normalizeSnapshot(structuredClone(snapshot))
}

export function getBoxKey(tower, box) {
  return `${tower}-${String(box).toUpperCase()}`
}

export function buildBoxIndex(snapshot) {
  const index = new Map()
  for (const aliquot of snapshot.aliquots) {
    if (aliquot.status !== 'IN_LN' || aliquot.tower == null || !aliquot.box || !aliquot.position) continue
    const key = getBoxKey(aliquot.tower, aliquot.box)
    if (!index.has(key)) index.set(key, [])
    index.get(key).push(aliquot)
  }
  return index
}

export function getBoxes(snapshot) {
  const boxIndex = buildBoxIndex(snapshot)
  return [...boxIndex.keys()]
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map((key) => {
      const [tower, box] = key.split('-')
      return {
        tower: Number(tower),
        box,
        key,
        count: boxIndex.get(key).length,
      }
    })
}

export function getBoxOccupancy(snapshot, tower, box) {
  return snapshot.aliquots.filter(
    (aliquot) =>
      aliquot.status === 'IN_LN' &&
      Number(aliquot.tower) === Number(tower) &&
      String(aliquot.box).toUpperCase() === String(box).toUpperCase(),
  )
}

export function summarize(snapshot) {
  const total = snapshot.aliquots.length
  const inLn = snapshot.aliquots.filter((aliquot) => aliquot.status === 'IN_LN').length
  const in80 = snapshot.aliquots.filter((aliquot) => aliquot.status === 'IN_80').length
  const archived = snapshot.aliquots.filter((aliquot) => aliquot.status === 'ARCHIVED').length
  return { total, inLn, in80, archived }
}

export function nextId(snapshot) {
  return snapshot.aliquots.reduce((max, aliquot) => Math.max(max, Number(aliquot.id) || 0), 0) + 1
}

export function nextEventId(snapshot) {
  return snapshot.events.reduce((max, event) => Math.max(max, Number(event.id) || 0), 0) + 1
}

export function nextVerificationId(snapshot) {
  return snapshot.boxVerifications.reduce(
    (max, verification) => Math.max(max, Number(verification.id) || 0),
    0,
  ) + 1
}

export function toIsoDate(value) {
  if (!value) return null
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toISOString().slice(0, 10)
}

export function locationLabel(aliquot) {
  if (!aliquot) return null
  if (aliquot.status === 'ARCHIVED') {
    if (aliquot.archivedTower == null || !aliquot.archivedBox || !aliquot.archivedPosition) return null
    return `${aliquot.archivedTower}${String(aliquot.archivedBox).toUpperCase()} ${String(aliquot.archivedPosition).toUpperCase()}`
  }
  if (aliquot.tower == null || !aliquot.box || !aliquot.position) return null
  return `${aliquot.tower}${String(aliquot.box).toUpperCase()} ${String(aliquot.position).toUpperCase()}`
}

export function parseLocationLabel(location) {
  if (!location) return null
  const match = String(location).trim().match(/^(\d+)\s*([A-Za-z])\s*([A-Za-z]\d{1,2})$/)
  if (!match) return null
  return {
    tower: Number(match[1]),
    box: match[2].toUpperCase(),
    position: match[3].toUpperCase(),
  }
}

export function pushEvent(snapshot, event) {
  snapshot.events.push({
    id: nextEventId(snapshot),
    ts: new Date().toISOString(),
    ...event,
  })
}

export function ensureThawUser(snapshot, name) {
  const cleaned = String(name ?? '').trim()
  if (!cleaned) return snapshot
  if (!snapshot.thawUsers.includes(cleaned)) {
    snapshot.thawUsers = [...snapshot.thawUsers, cleaned].sort((left, right) =>
      left.localeCompare(right),
    )
  }
  return snapshot
}

export function updateAliquot(snapshot, aliquotId, patch) {
  snapshot.aliquots = snapshot.aliquots.map((aliquot) =>
    Number(aliquot.id) === Number(aliquotId) ? { ...aliquot, ...patch } : aliquot,
  )
  return snapshot
}

export function movePendingToLn(snapshot, { aliquotId, tower, box, position, dateLn, user }) {
  const source = snapshot.aliquots.find((aliquot) => Number(aliquot.id) === Number(aliquotId))
  if (!source) return snapshot
  const next = cloneSnapshot(snapshot)
  updateAliquot(next, aliquotId, {
    status: 'IN_LN',
    tower,
    box: String(box).toUpperCase(),
    position: String(position).toUpperCase(),
    dateLn: toIsoDate(dateLn) ?? source.dateLn ?? toIsoDate(new Date()),
  })
  pushEvent(next, {
    action: 'move_80_to_ln',
    user: user ?? null,
    aliquotId: Number(aliquotId),
    fromStatus: 'IN_80',
    toStatus: 'IN_LN',
    toLocation: locationLabel({ tower, box, position }),
  })
  return next
}

export function archiveAliquot(snapshot, { aliquotId, thawedBy, dateThawed, user }) {
  const source = snapshot.aliquots.find((aliquot) => Number(aliquot.id) === Number(aliquotId))
  if (!source) return snapshot
  const next = cloneSnapshot(snapshot)
  updateAliquot(next, aliquotId, {
    status: 'ARCHIVED',
    thawedBy: thawedBy ?? source.thawedBy ?? null,
    dateThawed: toIsoDate(dateThawed) ?? source.dateThawed ?? toIsoDate(new Date()),
    archivedTower: source.tower ?? source.archivedTower ?? null,
    archivedBox: source.box ?? source.archivedBox ?? null,
    archivedPosition: source.position ?? source.archivedPosition ?? null,
    tower: null,
    box: null,
    position: null,
  })
  ensureThawUser(next, thawedBy)
  pushEvent(next, {
    action: 'archive',
    user: user ?? null,
    aliquotId: Number(aliquotId),
    fromStatus: source.status,
    toStatus: 'ARCHIVED',
    fromLocation: locationLabel(source),
    note: `thawed_by=${thawedBy ?? ''}; date_thawed=${toIsoDate(dateThawed) ?? ''}`,
  })
  return next
}

export function recordBoxVerification(snapshot, { tower, box, verifiedOk, verifiedBy, verifiedDate, notes, user }) {
  const next = cloneSnapshot(snapshot)
  next.boxVerifications.push({
    id: nextVerificationId(next),
    tower: Number(tower),
    box: String(box).toUpperCase(),
    verifiedOk: Boolean(verifiedOk),
    verifiedBy: verifiedBy ?? null,
    verifiedDate: toIsoDate(verifiedDate),
    notes: notes ?? null,
    createdAt: new Date().toISOString(),
  })
  ensureThawUser(next, verifiedBy)
  pushEvent(next, {
    action: 'box_verify',
    user: user ?? null,
    note: `box=${Number(tower)}${String(box).toUpperCase()} verified_by=${verifiedBy ?? ''} date=${toIsoDate(verifiedDate) ?? ''}`,
  })
  return next
}

export function groupSearchResults(snapshot, query) {
  const needle = String(query ?? '').trim().toLowerCase()
  const rows = snapshot.aliquots.filter((aliquot) => {
    if (!needle) return aliquot.status !== 'ARCHIVED'
    return [aliquot.cellLineName, aliquot.split, aliquot.dateFrozen, locationLabel(aliquot)]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(needle))
  })

  const grouped = new Map()
  for (const aliquot of rows) {
    const key = [
      aliquot.cellLineName ?? '',
      aliquot.split ?? '',
      aliquot.dateFrozen ?? '',
    ].join('||')
    if (!grouped.has(key)) {
      grouped.set(key, {
        cellLineName: aliquot.cellLineName ?? '',
        split: aliquot.split ?? '',
        dateFrozen: aliquot.dateFrozen ?? '',
        aliquots: [],
      })
    }
    grouped.get(key).aliquots.push(aliquot)
  }

  return [...grouped.values()]
    .map((group) => ({
      ...group,
      aliquots: group.aliquots.sort((left, right) => {
        const leftLocation = locationLabel(left) ?? ''
        const rightLocation = locationLabel(right) ?? ''
        return leftLocation.localeCompare(rightLocation, undefined, { numeric: true })
      }),
    }))
    .sort((left, right) => left.cellLineName.localeCompare(right.cellLineName))
}

export function buildSearchChips(group) {
  return group.aliquots
    .map((aliquot) => ({
      id: aliquot.id,
      label: locationLabel(aliquot) ?? 'No location',
      status: aliquot.status,
      cellLineName: aliquot.cellLineName ?? '',
      split: aliquot.split ?? '',
      dateThawed: aliquot.dateThawed ?? '',
      tower: aliquot.status === 'ARCHIVED' ? aliquot.archivedTower : aliquot.tower,
      box: aliquot.status === 'ARCHIVED' ? aliquot.archivedBox : aliquot.box,
      position: aliquot.status === 'ARCHIVED' ? aliquot.archivedPosition : aliquot.position,
    }))
    .filter((chip) => chip.tower != null && chip.box && chip.position)
}

export function positionSort(a, b) {
  const rowA = a[0]?.toUpperCase() ?? 'A'
  const rowB = b[0]?.toUpperCase() ?? 'A'
  const colA = Number.parseInt(a.slice(1), 10) || 0
  const colB = Number.parseInt(b.slice(1), 10) || 0
  if (rowA === rowB) return colA - colB
  return rowA.localeCompare(rowB)
}
