import { useEffect, useMemo, useState } from 'react'
import {
  archiveAliquot,
  buildBoxIndex,
  buildSearchChips,
  getBoxOccupancy,
  getBoxes,
  groupSearchResults,
  locationLabel,
  movePendingToLn,
  normalizeSnapshot,
  nextId,
  positionSort,
  recordBoxVerification,
  summarize,
  toIsoDate,
  updateAliquot,
} from './lib/snapshot'

const BOX_ROWS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']
const BOX_COLS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']
const DEFAULT_SELECTED = { tower: 24, box: 'A', position: 'A1' }

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function useFreezersApi() {
  return window.freezersAPI
}

function Slot({ slot, selected, onClick }) {
  const filled = Boolean(slot)
  return (
    <button
      className={`slot ${filled ? 'filled' : 'empty'} ${selected ? 'selected' : ''}`}
      onClick={onClick}
      type="button"
    >
      <span className="slot-position">{slot?.position ?? ''}</span>
      <span className="slot-label">{filled ? slot.cellLineName : 'Available'}</span>
      {filled ? (
        <span className="slot-meta">
          {slot.split || 'No passage'} · {slot.dateFrozen || 'No date'}
        </span>
      ) : null}
    </button>
  )
}

function SearchGroupCard({ group, onPickLocation }) {
  const chips = buildSearchChips(group)
  return (
    <div className="search-group-card">
      <div className="search-group-title">{group.cellLineName || 'Unnamed'}</div>
      <div className="search-group-meta">
        Passage: {group.split || '—'} · Date frozen: {group.dateFrozen || '—'} · Tubes: {group.aliquots.length}
      </div>
      <div className="search-chip-wall">
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className={`location-chip ${chip.status === 'IN_LN' ? 'filled' : chip.status === 'ARCHIVED' ? 'archived' : 'pending'}`}
            onClick={() =>
              onPickLocation({
                tower: chip.tower,
                box: chip.box,
                position: chip.position,
              })
            }
          >
            <span className="chip-top">
              <span className="chip-name">{chip.cellLineName}</span>
              <span className="chip-state">{chip.status.replace('_', ' ')}</span>
            </span>
            <span className="chip-loc">{chip.label}</span>
            <span className="chip-meta">
              {group.split || 'No passage'} · {chip.dateThawed ? `thawed ${chip.dateThawed}` : 'not thawed'}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function App() {
  const api = useFreezersApi()
  const [snapshot, setSnapshot] = useState(() => normalizeSnapshot())
  const [dataSource, setDataSource] = useState('Loading snapshot…')
  const [selectedBox, setSelectedBox] = useState(DEFAULT_SELECTED)
  const [selectedAction, setSelectedAction] = useState('details')
  const [searchQuery, setSearchQuery] = useState('')
  const [statusMessage, setStatusMessage] = useState('Loading snapshot…')
  const [operatorName, setOperatorName] = useState('')
  const [moveTubeId, setMoveTubeId] = useState('')
  const [moveDateLn, setMoveDateLn] = useState(todayIso())
  const [thawUser, setThawUser] = useState('')
  const [thawDate, setThawDate] = useState(todayIso())
  const [verificationOk, setVerificationOk] = useState(true)
  const [verificationBy, setVerificationBy] = useState('')
  const [verificationDate, setVerificationDate] = useState(todayIso())
  const [verificationNotes, setVerificationNotes] = useState('')

  useEffect(() => {
    let mounted = true
    async function load() {
      const result = await api.loadSnapshot()
      if (!mounted) return
      setSnapshot(normalizeSnapshot(result.snapshot))
      setDataSource(result.path)
      setStatusMessage(`Loaded ${result.path}`)
    }
    load()
    return () => {
      mounted = false
    }
  }, [api])

  const boxIndex = useMemo(() => buildBoxIndex(snapshot), [snapshot])
  const boxes = useMemo(() => getBoxes(snapshot), [snapshot])
  const summary = useMemo(() => summarize(snapshot), [snapshot])
  const searchGroups = useMemo(() => groupSearchResults(snapshot, searchQuery), [searchQuery, snapshot])
  const visibleSearchGroups = useMemo(
    () => (searchQuery.trim() ? searchGroups : searchGroups.slice(0, 8)),
    [searchGroups, searchQuery],
  )
  const pendingAliquots = useMemo(
    () =>
      snapshot.aliquots
        .filter((aliquot) => aliquot.status === 'IN_80')
        .slice()
        .sort((left, right) => {
          const leftLabel = `${left.cellLineName || ''} ${left.split || ''} ${left.dateFrozen || ''}`
          const rightLabel = `${right.cellLineName || ''} ${right.split || ''} ${right.dateFrozen || ''}`
          return leftLabel.localeCompare(rightLabel)
        }),
    [snapshot],
  )
  const currentOccupancy = useMemo(
    () => getBoxOccupancy(snapshot, selectedBox.tower, selectedBox.box),
    [snapshot, selectedBox.box, selectedBox.tower],
  )
  const activeSlot = useMemo(
    () => currentOccupancy.find((aliquot) => aliquot.position === selectedBox.position) ?? null,
    [currentOccupancy, selectedBox.position],
  )
  const latestVerification = useMemo(() => {
    const matches = snapshot.boxVerifications
      .filter(
        (verification) =>
          Number(verification.tower) === Number(selectedBox.tower) &&
          String(verification.box).toUpperCase() === String(selectedBox.box).toUpperCase(),
      )
      .slice()
      .sort((left, right) => Number(right.id || 0) - Number(left.id || 0))
    return matches[0] ?? null
  }, [selectedBox.box, selectedBox.tower, snapshot.boxVerifications])

  useEffect(() => {
    if (!pendingAliquots.length) {
      setMoveTubeId('')
      return
    }
    const found = pendingAliquots.some((aliquot) => String(aliquot.id) === String(moveTubeId))
    if (!found) {
      setMoveTubeId(String(pendingAliquots[0].id))
    }
  }, [moveTubeId, pendingAliquots])

  useEffect(() => {
    if (!verificationBy && snapshot.thawUsers.length) {
      setVerificationBy(snapshot.thawUsers[0])
    }
  }, [snapshot.thawUsers, verificationBy])

  useEffect(() => {
    if (!thawUser && snapshot.thawUsers.length) {
      setThawUser(snapshot.thawUsers[0])
    }
  }, [snapshot.thawUsers, thawUser])

  async function persistSnapshot(nextSnapshot, message) {
    const normalized = normalizeSnapshot(nextSnapshot)
    setSnapshot(normalized)
    const result = await api.saveSnapshot(normalized)
    setDataSource(result.path)
    setStatusMessage(message || `Saved to ${result.path}`)
  }

  function pickLocation(location) {
    if (!location?.tower || !location.box || !location.position) return
    setSelectedBox({
      tower: Number(location.tower),
      box: String(location.box).toUpperCase(),
      position: String(location.position).toUpperCase(),
    })
    setSelectedAction('details')
  }

  function selectBox(box) {
    const occupancy = boxIndex.get(box.key) ?? []
    const firstPosition =
      occupancy.slice().sort((left, right) => positionSort(left.position, right.position))[0]?.position ?? 'A1'
    setSelectedBox({ tower: box.tower, box: box.box, position: firstPosition })
    setSelectedAction('details')
  }

  async function openSnapshot() {
    const result = await api.openSnapshot()
    if (result.canceled) return
    setSnapshot(normalizeSnapshot(result.snapshot))
    setDataSource(result.path)
    setStatusMessage(`Opened ${result.path}`)
  }

  async function importWorkbook() {
    const result = await api.importWorkbook()
    if (result.canceled) return
    setSnapshot(normalizeSnapshot(result.snapshot))
    setDataSource(result.path)
    setSelectedBox(DEFAULT_SELECTED)
    setStatusMessage(`Imported workbook ${result.path}`)
  }

  async function exportWorkbook() {
    const result = await api.exportWorkbook(snapshot)
    if (result.canceled) return
    setStatusMessage(`Exported workbook to ${result.path}`)
  }

  async function saveSnapshotAs() {
    const result = await api.saveSnapshotAs(snapshot)
    if (result.canceled) return
    setDataSource(result.path)
    setStatusMessage(`Saved as ${result.path}`)
  }

  function saveSnapshot() {
    persistSnapshot(snapshot, 'Snapshot saved')
  }

  function updateSlotNotes(notes) {
    if (!activeSlot) return
    const next = {
      ...snapshot,
      aliquots: snapshot.aliquots.map((aliquot) =>
        Number(aliquot.id) === Number(activeSlot.id) ? { ...aliquot, notes } : aliquot,
      ),
    }
    persistSnapshot(next, 'Updated notes')
  }

  async function addPendingTube() {
    const next = {
      ...snapshot,
      aliquots: [
        ...snapshot.aliquots,
        {
          id: nextId(snapshot),
          batchId: null,
          batchIndex: null,
          cellLineName: 'New tube',
          baseLine1: '',
          baseLine2: '',
          split: 'P1',
          dateFrozen: todayIso(),
          dateLn: null,
          flask: '',
          source: '',
          thawIn: '',
          notes: '',
          mycoplasma: '',
          status: 'IN_80',
          tower: null,
          box: null,
          position: null,
          createdBy: operatorName || null,
          thawedBy: null,
          dateThawed: null,
          archivedTower: null,
          archivedBox: null,
          archivedPosition: null,
        },
      ],
    }
    await persistSnapshot(next, 'Added pending tube')
  }

  async function moveTubeIntoSelectedSlot() {
    if (!moveTubeId) return
    if (activeSlot) {
      setStatusMessage('Selected slot is already occupied')
      return
    }
    const next = movePendingToLn(snapshot, {
      aliquotId: Number(moveTubeId),
      tower: selectedBox.tower,
      box: selectedBox.box,
      position: selectedBox.position,
      dateLn: moveDateLn,
      user: operatorName || null,
    })
    await persistSnapshot(next, `Moved tube into ${selectedBox.tower}${selectedBox.box} ${selectedBox.position}`)
  }

  async function archiveSelectedTube() {
    if (!activeSlot) return
    const next = archiveAliquot(snapshot, {
      aliquotId: activeSlot.id,
      thawedBy: thawUser || operatorName || null,
      dateThawed: thawDate,
      user: operatorName || null,
    })
    await persistSnapshot(next, `Archived tube from ${selectedBox.tower}${selectedBox.box} ${selectedBox.position}`)
  }

  async function recordVerification() {
    const next = recordBoxVerification(snapshot, {
      tower: selectedBox.tower,
      box: selectedBox.box,
      verifiedOk: verificationOk,
      verifiedBy: verificationBy || operatorName || null,
      verifiedDate: verificationDate,
      notes: verificationNotes.trim() || null,
      user: operatorName || null,
    })
    await persistSnapshot(next, `Recorded verification for ${selectedBox.tower}${selectedBox.box}`)
  }

  const currentChipSummary = activeSlot
    ? {
        name: activeSlot.cellLineName || '',
        metadata: `${activeSlot.split || 'No passage'} · frozen ${activeSlot.dateFrozen || 'unknown'}`,
      }
    : null

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark">🧊</div>
          <div>
            <div className="brand-title">{snapshot.labName}</div>
            <div className="brand-subtitle">desktop inventory</div>
          </div>
        </div>

        <label className="sidebar-input">
          Operator
          <input value={operatorName} onChange={(event) => setOperatorName(event.target.value)} placeholder="Your name" />
        </label>

        <div className="sidebar-actions">
          <button type="button" onClick={openSnapshot}>
            Open JSON
          </button>
          <button type="button" onClick={saveSnapshotAs}>
            Save JSON as
          </button>
          <button type="button" onClick={importWorkbook}>
            Import Excel
          </button>
          <button type="button" onClick={exportWorkbook}>
            Export Excel
          </button>
          <button type="button" onClick={saveSnapshot}>
            Save
          </button>
        </div>

        <div className="metric-stack">
          <MetricCard label="Total" value={summary.total} />
          <MetricCard label="LN" value={summary.inLn} />
          <MetricCard label="-80" value={summary.in80} />
          <MetricCard label="Archived" value={summary.archived} />
        </div>

        <label className="sidebar-input">
          Search
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Cell line, passage, date, location"
          />
        </label>

        <div className="sidebar-list">
          <div className="sidebar-heading">Matching cell lines</div>
          {visibleSearchGroups.map((group) => (
            <SearchGroupCard key={`${group.cellLineName}|${group.split}|${group.dateFrozen}`} group={group} onPickLocation={pickLocation} />
          ))}
          {!visibleSearchGroups.length ? <div className="empty-note">No matching cell lines.</div> : null}
        </div>

        <div className="sidebar-list">
          <div className="sidebar-heading">Saved boxes</div>
          {boxes.slice(0, 8).map((box) => (
            <button key={box.key} type="button" className="box-card" onClick={() => selectBox(box)}>
              <div className="box-card-title">
                {box.tower}
                {box.box}
              </div>
              <div className="box-card-subtitle">{box.count} occupied slots</div>
            </button>
          ))}
          <button type="button" className="ghost-card" onClick={addPendingTube}>
            + Add pending tube
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>Box Viewer</h1>
            <p>Card-first freezer inventory with import/export and local snapshot storage.</p>
          </div>
          <div className="topbar-controls">
            <div className="status-pill">{statusMessage}</div>
            <div className="status-pill">Source: {dataSource}</div>
          </div>
        </header>

        <section className="main-grid">
          <div className="box-panel">
            <div className="panel-header">
              <div>
                <div className="panel-kicker">Tower {selectedBox.tower}</div>
                <div className="panel-title">
                  {selectedBox.tower}
                  {selectedBox.box}
                </div>
              </div>
              <div className="panel-chip">{currentOccupancy.length} occupied</div>
            </div>

            <div className="grid-wrap">
              <div className="grid-col-labels">
                <div />
                {BOX_COLS.map((col) => (
                  <div key={col}>{col}</div>
                ))}
              </div>
              {BOX_ROWS.map((row) => (
                <div key={row} className="grid-row">
                  <div className="grid-row-label">{row}</div>
                  {BOX_COLS.map((col) => {
                    const position = `${row}${col}`
                    const slot = currentOccupancy.find((aliquot) => aliquot.position === position) ?? null
                    return (
                      <Slot
                        key={position}
                        slot={slot}
                        selected={position === selectedBox.position}
                        onClick={() =>
                          setSelectedBox((current) => ({
                            ...current,
                            position,
                          }))
                        }
                      />
                    )
                  })}
                </div>
              ))}
            </div>
          </div>

          <aside className="inspector">
            <div className="inspector-tabs">
              <button type="button" className={selectedAction === 'details' ? 'active' : ''} onClick={() => setSelectedAction('details')}>
                Details
              </button>
              <button type="button" className={selectedAction === 'workflows' ? 'active' : ''} onClick={() => setSelectedAction('workflows')}>
                Workflows
              </button>
            </div>

            {selectedAction === 'details' ? (
              <>
                <Section title="Box details">
                  <DetailRow label="Title" value={`${selectedBox.tower}${selectedBox.box}`} />
                  <DetailRow label="Dimension" value="10 × 10" />
                  <DetailRow label="Selected slot" value={selectedBox.position} />
                  <DetailRow label="Storage" value="Liquid nitrogen" />
                  <DetailRow label="Latest check" value={latestVerification ? `${latestVerification.verifiedBy || 'n/a'} · ${latestVerification.verifiedDate || 'n/a'}` : 'No verification'} />
                </Section>

                <Section title="Selected tube">
                  {activeSlot ? (
                    <div className="tube-card">
                      <div className="tube-name">{activeSlot.cellLineName}</div>
                      <div className="tube-meta">
                        {activeSlot.split || 'No passage'} · frozen {activeSlot.dateFrozen || 'unknown'}
                      </div>
                      <div className="tube-meta">Status: {activeSlot.status}</div>
                      <div className="tube-meta">Location: {locationLabel(activeSlot)}</div>
                      <label className="notes-field">
                        Notes
                        <textarea value={activeSlot.notes || ''} onChange={(event) => updateSlotNotes(event.target.value)} />
                      </label>
                    </div>
                  ) : (
                    <div className="empty-state">This slot is empty.</div>
                  )}
                </Section>

                <Section title="Selection preview">
                  {currentChipSummary ? (
                    <div className="tube-card">
                      <div className="tube-name">{currentChipSummary.name}</div>
                      <div className="tube-meta">{currentChipSummary.metadata}</div>
                    </div>
                  ) : (
                    <div className="empty-state">No cell line selected.</div>
                  )}
                </Section>
              </>
            ) : (
              <>
                <Section title="Move from -80">
                  <label className="workflow-field">
                    Pending tube
                    <select value={moveTubeId} onChange={(event) => setMoveTubeId(event.target.value)}>
                      {pendingAliquots.map((aliquot) => (
                        <option key={aliquot.id} value={aliquot.id}>
                          #{aliquot.id} · {aliquot.cellLineName} · {aliquot.split || 'No passage'} · {aliquot.dateFrozen || 'No date'}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="workflow-field">
                    Date LN
                    <input value={moveDateLn} onChange={(event) => setMoveDateLn(event.target.value)} type="date" />
                  </label>
                  <button type="button" className="workflow-btn" onClick={moveTubeIntoSelectedSlot} disabled={!moveTubeId || Boolean(activeSlot)}>
                    Move into selected slot
                  </button>
                </Section>

                <Section title="Archive / thaw">
                  <label className="workflow-field">
                    Thawing user
                    <input value={thawUser} onChange={(event) => setThawUser(event.target.value)} placeholder="Name" />
                  </label>
                  <label className="workflow-field">
                    Thaw date
                    <input value={thawDate} onChange={(event) => setThawDate(event.target.value)} type="date" />
                  </label>
                  <button type="button" className="workflow-btn" onClick={archiveSelectedTube} disabled={!activeSlot}>
                    Archive selected tube
                  </button>
                </Section>

                <Section title="Record box verification">
                  <label className="workflow-field checkbox-row">
                    <input type="checkbox" checked={verificationOk} onChange={(event) => setVerificationOk(event.target.checked)} />
                    I confirm this box matches the database
                  </label>
                  <label className="workflow-field">
                    Verification date
                    <input value={verificationDate} onChange={(event) => setVerificationDate(event.target.value)} type="date" />
                  </label>
                  <label className="workflow-field">
                    Verified by
                    <input value={verificationBy} onChange={(event) => setVerificationBy(event.target.value)} placeholder="Name" />
                  </label>
                  <label className="workflow-field">
                    Notes
                    <textarea value={verificationNotes} onChange={(event) => setVerificationNotes(event.target.value)} />
                  </label>
                  <button type="button" className="workflow-btn" onClick={recordVerification}>
                    Record verification
                  </button>
                </Section>

                <Section title="Snapshot file">
                  <DetailRow label="Current file" value={dataSource} />
                  <DetailRow label="Updated" value={snapshot.updatedAt || 'n/a'} />
                </Section>
              </>
            )}
          </aside>
        </section>
      </main>
    </div>
  )
}

function MetricCard({ label, value }) {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <section className="section-card">
      <h2>{title}</h2>
      {children}
    </section>
  )
}

function DetailRow({ label, value }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

export default App
