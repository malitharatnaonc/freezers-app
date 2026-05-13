from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

import pandas as pd

from db import init_db, connect, log_event, upsert_aliquot, location_str


TOWER_SHEET_HEADER_ROW = 3  # based on the provided workbook


def _clean(v) -> Optional[str]:
    if v is None:
        return None
    if isinstance(v, float) and pd.isna(v):
        return None
    s = str(v).strip()
    if s == "" or s.lower() == "nan":
        return None
    return s


def _to_iso_date(v) -> Optional[str]:
    if v is None:
        return None
    try:
        ts = pd.to_datetime(v, errors="coerce")
        if pd.isna(ts):
            return _clean(v)
        return ts.date().isoformat()
    except Exception:
        return _clean(v)


def _parse_tower_sheet(xl: pd.ExcelFile, tower_sheet_name: str) -> pd.DataFrame:
    df_raw = xl.parse(tower_sheet_name, header=TOWER_SHEET_HEADER_ROW, dtype=object)
    df_raw = df_raw.loc[:, ~df_raw.columns.astype(str).str.match(r"^Unnamed")]
    df_raw.columns = [str(c).strip() for c in df_raw.columns]

    groups: dict[int, list[tuple[str, str]]] = {}
    for col in df_raw.columns:
        m = re.match(r"^(.*?)(?:\.(\d+))?$", col)
        base = m.group(1)
        idx = int(m.group(2) or 0)
        groups.setdefault(idx, []).append((base, col))

    long_parts = []
    wanted = [
        "BOX",
        "Position",
        "Cell Line Name",
        "Base Line 1",
        "Base Line 2",
        "Split",
        "Date Frozen",
        "Date LN",
        "Flask",
        "Source",
        "Thaw in…",
        "Notes",
        "Mycoplasma?",
    ]
    for _, cols in sorted(groups.items()):
        bases = {b: c for b, c in cols}
        if "BOX" not in bases or "Position" not in bases:
            continue
        use = [bases[k] for k in wanted if k in bases]
        sub = df_raw[use].copy()
        sub.columns = [k for k in wanted if k in bases]
        sub["tower"] = int(tower_sheet_name)
        long_parts.append(sub)

    out = pd.concat(long_parts, ignore_index=True)
    out = out[out["BOX"].notna() & out["Position"].notna() & out["Cell Line Name"].notna()].copy()
    out["BOX"] = out["BOX"].astype(str).str.strip()
    out["Position"] = out["Position"].astype(str).str.strip().str.upper()
    out["box_letter"] = out["BOX"].str.extract(r"(?:\d+)?\s*([A-Za-z]+)")[0].str.upper()
    out["box_letter"] = out["box_letter"].fillna("")
    return out


def import_from_excel(xlsx_path: Path, *, user: Optional[str] = None) -> dict[str, int]:
    init_db()
    xl = pd.ExcelFile(xlsx_path)

    imported_ln = 0
    imported_80 = 0
    imported_archive = 0

    with connect() as conn:
        # LN towers
        for s in xl.sheet_names:
            if not str(s).isdigit():
                continue
            df = _parse_tower_sheet(xl, str(s))
            for _, r in df.iterrows():
                cell_line = _clean(r.get("Cell Line Name"))
                if not cell_line:
                    continue
                tower = int(r["tower"])
                box = _clean(r.get("box_letter"))
                pos = _clean(r.get("Position"))
                aliquot_id = upsert_aliquot(
                    conn,
                    cell_line_name=cell_line,
                    base_line_1=_clean(r.get("Base Line 1")),
                    base_line_2=_clean(r.get("Base Line 2")),
                    split=_clean(r.get("Split")),
                    date_frozen=_to_iso_date(r.get("Date Frozen")),
                    date_ln=_to_iso_date(r.get("Date LN")),
                    flask=_clean(r.get("Flask")),
                    source=_clean(r.get("Source")),
                    thaw_in=_clean(r.get("Thaw in…")),
                    notes=_clean(r.get("Notes")),
                    mycoplasma=_clean(r.get("Mycoplasma?")),
                    status="IN_LN",
                    tower=tower,
                    box=box,
                    position=pos,
                    created_by=user,
                )
                imported_ln += 1
                log_event(
                    conn,
                    action="import_ln",
                    aliquot_id=aliquot_id,
                    user=user,
                    to_status="IN_LN",
                    to_location=location_str(tower, box, pos),
                    note=f"Imported from {xlsx_path.name} sheet {s}",
                )

        # In -80
        if "In -80" in xl.sheet_names:
            df80 = xl.parse("In -80", header=1, dtype=object)
            df80 = df80.loc[:, ~df80.columns.astype(str).str.match(r"^Unnamed")]
            df80.columns = [str(c).strip() for c in df80.columns]
            for _, r in df80.iterrows():
                cell_line = _clean(r.get("Cell Line Name"))
                if not cell_line:
                    continue
                n = _clean(r.get("Number Aliquots"))
                try:
                    n_int = int(float(n)) if n is not None else 1
                except Exception:
                    n_int = 1
                batch_id = str(uuid.uuid4())
                for i in range(1, max(n_int, 1) + 1):
                    aliquot_id = upsert_aliquot(
                        conn,
                        batch_id=batch_id,
                        batch_index=i,
                        cell_line_name=cell_line,
                        base_line_1=_clean(r.get("Base Line 1")),
                        base_line_2=_clean(r.get("Base Line 2")),
                        split=_clean(r.get("Split")),
                        date_frozen=_to_iso_date(r.get("Date Frozen")),
                        date_ln=_to_iso_date(r.get("Date LN")),
                        flask=_clean(r.get("Flask")),
                        source=_clean(r.get("Source")),
                        thaw_in=_clean(r.get("Thaw in…")),
                        notes=_clean(r.get("Notes")),
                        mycoplasma=_clean(r.get("Mycoplasma?")),
                        status="IN_80",
                        created_by=_clean(r.get("By")) or user,
                    )
                    imported_80 += 1
                    log_event(
                        conn,
                        action="import_80",
                        aliquot_id=aliquot_id,
                        user=_clean(r.get("By")) or user,
                        to_status="IN_80",
                        note=f"Imported from {xlsx_path.name} sheet In -80 (batch {batch_id} #{i}/{n_int})",
                    )

        # Archive
        if "Archive" in xl.sheet_names:
            dfA = xl.parse("Archive", header=1, dtype=object)
            dfA = dfA.loc[:, ~dfA.columns.astype(str).str.match(r"^Unnamed")]
            dfA.columns = [str(c).strip() for c in dfA.columns]
            for _, r in dfA.iterrows():
                cell_line = _clean(r.get("Cell Line Name"))
                if not cell_line:
                    continue
                loc = _clean(r.get("Location"))
                pos = _clean(r.get("Position"))
                tower = None
                box = None
                if loc:
                    m = re.match(r"^\s*(\d+)\s*([A-Za-z])", loc)
                    if m:
                        tower = int(m.group(1))
                        box = m.group(2).upper()
                aliquot_id = upsert_aliquot(
                    conn,
                    cell_line_name=cell_line,
                    base_line_1=_clean(r.get("Base Line 1")),
                    base_line_2=_clean(r.get("Base Line 2")),
                    split=_clean(r.get("Split")),
                    date_frozen=_to_iso_date(r.get("Date Frozen")),
                    date_ln=_to_iso_date(r.get("Date LN")),
                    flask=_clean(r.get("Flask")),
                    source=_clean(r.get("Source")),
                    thaw_in=_clean(r.get("Thaw in…")),
                    notes=_clean(r.get("Notes")),
                    mycoplasma=_clean(r.get("Mycoplasma?")),
                    status="ARCHIVED",
                    tower=None,
                    box=None,
                    position=None,
                    created_by=_clean(r.get("By")) or user,
                )
                imported_archive += 1
                log_event(
                    conn,
                    action="import_archive",
                    aliquot_id=aliquot_id,
                    user=_clean(r.get("By")) or user,
                    to_status="ARCHIVED",
                    from_location=location_str(tower, box, pos),
                    note=f"Imported from {xlsx_path.name} sheet Archive",
                )

    return {"ln": imported_ln, "in_80": imported_80, "archive": imported_archive}

