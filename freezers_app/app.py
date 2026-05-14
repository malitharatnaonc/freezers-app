from __future__ import annotations

from html import escape
import json
import os
import uuid
from datetime import date
from pathlib import Path
from typing import Optional
import tempfile

import pandas as pd
import streamlit as st
import streamlit.components.v1 as components

from db import (
    connect,
    clear_inventory_data,
    database_label,
    fetch_all,
    fetch_one,
    init_db,
    ensure_thaw_user,
    fetch_latest_box_verification,
    location_str,
    log_event,
    record_box_verification,
    upsert_aliquot,
)
from importer import import_from_excel


APP_DIR = Path(__file__).resolve().parent
DEFAULT_IMPORT_XLSX = (APP_DIR.parent / "Freezings_MR-IK2.xlsx").resolve()
BOX_ROWS = list("ABCDEFGHIJ")
BOX_COLS = list(range(1, 11))
BOX_POSITIONS = [f"{row}{col}" for row in BOX_ROWS for col in BOX_COLS]


def page_config() -> None:
    st.set_page_config(page_title="Freezers Inventory", page_icon="🧊", layout="wide")


def _qp_value(name: str, default: Optional[str] = None) -> Optional[str]:
    value = st.query_params.get(name)
    if value is None:
        return default
    if isinstance(value, list):
        return value[-1] if value else default
    return value


def _set_query_params(
    *, page: Optional[str] = None, tower: Optional[object] = None, box: Optional[str] = None, position: Optional[str] = None
) -> None:
    for key in list(st.query_params.keys()):
        del st.query_params[key]
    if page is not None:
        st.query_params["page"] = page
    if tower is not None:
        st.query_params["tower"] = str(tower)
    if box is not None:
        st.query_params["box"] = str(box)
    if position is not None:
        st.query_params["position"] = str(position)


def _jump_to_box_viewer(*, tower: int, box: str, position: Optional[str] = None) -> None:
    _set_query_params(page="Box Viewer", tower=tower, box=box, position=position)
    st.rerun()


def _position_sort_key(position: str) -> tuple[int, int]:
    row = position[0].upper()
    col = position[1:]
    return BOX_ROWS.index(row), int(col)


def _next_empty_position(occupied: dict[str, dict], *, after_position: Optional[str] = None) -> Optional[str]:
    start_index = 0
    if after_position and after_position.upper() in BOX_POSITIONS:
        start_index = BOX_POSITIONS.index(after_position.upper()) + 1
    for position in BOX_POSITIONS[start_index:]:
        if position not in occupied:
            return position
    return None


def _archive_user_options() -> list[str]:
    with connect() as conn:
        rows = fetch_all(
            conn,
            """
            SELECT DISTINCT user_name FROM (
              SELECT created_by AS user_name FROM aliquots WHERE created_by IS NOT NULL AND TRIM(created_by) != ''
              UNION
              SELECT thawed_by AS user_name FROM aliquots WHERE thawed_by IS NOT NULL AND TRIM(thawed_by) != ''
              UNION
              SELECT "user" AS user_name FROM events WHERE "user" IS NOT NULL AND TRIM("user") != ''
              UNION
              SELECT name AS user_name FROM thaw_users WHERE name IS NOT NULL AND TRIM(name) != ''
            )
            ORDER BY user_name
            """,
        )
        options = [str(row["user_name"]) for row in rows if row["user_name"] is not None]
    current_user = st.session_state.get("user")
    if current_user and current_user not in options:
        options = [current_user] + options
    for seed in ["Louise Martin", "Abimael Cruz-Migoni"]:
        if seed not in options:
            options.insert(0, seed)
    return options or ([current_user] if current_user else [])


def _thaw_user_picker(label: str = "Thawing user") -> str:
    options = _archive_user_options()
    choice = st.selectbox(label, options or [""], index=0 if options else 0)
    custom = st.text_input("Or type a new user", value="")
    if custom.strip():
        choice = custom.strip()
        with connect() as conn:
            ensure_thaw_user(conn, choice)
    return choice


def _search_results_html(df: pd.DataFrame, grouped_df: pd.DataFrame) -> str:
    summary_html = (
        "<div class='search-summary'>"
        f"<div class='search-card'><div class='label'>Groups</div><div class='value'>{len(grouped_df)}</div></div>"
        f"<div class='search-card'><div class='label'>Rows</div><div class='value'>{len(df)}</div></div>"
        f"<div class='search-card'><div class='label'>LN</div><div class='value'>{int((df['status'] == 'IN_LN').sum())}</div></div>"
        f"<div class='search-card'><div class='label'>-80</div><div class='value'>{int((df['status'] == 'IN_80').sum())}</div></div>"
        "</div>"
    )
    no_location_html = "<span style='color:#94a3b8;'>No location set</span>"
    cards = []
    for _, row in grouped_df.iterrows():
        cards.append(
            "<div class='result-card'>"
            f"<div class='title'>{escape(str(row['Cell Line Name'] or ''))}</div>"
            f"<div class='meta'>Passage: {escape(str(row['Passage'] or ''))} | Date frozen: {escape(str(row['Date Frozen'] or ''))} | Tubes: {int(row['Count'])}</div>"
            f"<div class='locations'>{row['Locations'] or no_location_html}</div>"
            "</div>"
        )
    styles = """
    <style>
    .search-summary {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 0.75rem;
        margin-bottom: 1rem;
    }
    .search-card {
        background: linear-gradient(180deg, #ffffff, #f8fafc);
        border: 1px solid rgba(15, 23, 42, 0.10);
        border-radius: 18px;
        padding: 0.9rem 1rem;
        box-shadow: 0 8px 20px rgba(15, 23, 42, 0.04);
    }
    .search-card .label { color: #64748b; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .search-card .value { color: #0f172a; font-size: 1.55rem; font-weight: 800; line-height: 1.05; margin-top: 0.2rem; }
    .results-wrap {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
        gap: 0.75rem;
    }
    .result-card {
        background: #ffffff;
        border: 1px solid rgba(15, 23, 42, 0.10);
        border-radius: 18px;
        padding: 0.78rem 0.82rem;
        box-shadow: 0 10px 20px rgba(15, 23, 42, 0.04);
    }
    .result-card .title { font-size: 1rem; font-weight: 800; color: #0f172a; }
    .result-card .meta { margin-top: 0.25rem; color: #64748b; font-size: 0.84rem; }
    .result-card .locations {
        margin-top: 0.7rem;
        display: flex;
        flex-wrap: wrap;
        gap: 0.06rem;
    }
    .location-chip {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        justify-content: center;
        flex: 1 1 150px;
        min-width: 150px;
        min-height: 68px;
        padding: 0.42rem 0.5rem;
        border-radius: 14px;
        border: 1px solid rgba(15, 23, 42, 0.12);
        text-decoration: none !important;
        color: #0f172a !important;
        box-shadow: 0 6px 14px rgba(15, 23, 42, 0.04);
    }
    .location-chip.filled {
        background: linear-gradient(180deg, #dcfce7, #bbf7d0);
        border-color: rgba(34, 197, 94, 0.35);
    }
    .location-chip.empty {
        background: linear-gradient(180deg, #f8fafc, #e2e8f0);
        border-color: rgba(100, 116, 139, 0.22);
        color: #475569 !important;
    }
    .chip-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        width: 100%;
    }
    .chip-name {
        font-size: 0.85rem;
        font-weight: 800;
        line-height: 1.08;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .chip-state {
        font-size: 0.64rem;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #0f766e;
        white-space: nowrap;
    }
    .location-chip.empty .chip-state { color: #475569; }
    .chip-loc {
        margin-top: 0.18rem;
        font-size: 0.74rem;
        font-weight: 700;
        color: inherit;
    }
    .chip-meta {
        margin-top: 0.14rem;
        font-size: 0.66rem;
        color: inherit;
        opacity: 0.75;
    }
    </style>
    """
    return styles + summary_html + f"<div class='results-wrap'>{''.join(cards)}</div>"


def _copy_location_button(location: str) -> None:
    payload = json.dumps(location)
    components.html(
        f"""
        <div style="display:flex; justify-content:flex-start; margin: 0.2rem 0 0.6rem 0;">
          <button
            id="copy-location-btn"
            style="
              border: 1px solid rgba(15, 23, 42, 0.14);
              background: #ffffff;
              color: #0f172a;
              border-radius: 999px;
              padding: 0.22rem 0.72rem;
              font-size: 0.78rem;
              font-weight: 700;
              cursor: pointer;
              box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
            "
          >Copy location</button>
        </div>
        <script>
        const button = document.getElementById('copy-location-btn');
        if (button) {{
          button.addEventListener('click', async () => {{
            const value = {payload};
            try {{
              await navigator.clipboard.writeText(value);
              button.textContent = 'Copied';
              setTimeout(() => button.textContent = 'Copy location', 1200);
            }} catch (error) {{
              button.textContent = 'Copy failed';
              setTimeout(() => button.textContent = 'Copy location', 1200);
            }}
          }});
        }}
        </script>
        """,
        height=56,
    )


def _render_box_html(*, tower: int, box: str, occupied: dict[str, dict], selected_position: Optional[str]) -> None:
    st.markdown(
        """
        <style>
        div[data-testid="column"] { padding-right: 0.14rem; padding-left: 0.14rem; }
        .slotgrid {
            margin-bottom: 0.08rem;
        }
        .slotgrid button {
            width: 100%;
            height: 52px;
            padding: 0.12rem 0.22rem;
            font-size: 0.75rem;
            line-height: 1.05;
            border-radius: 12px;
            white-space: normal !important;
            transition: transform 0.12s ease, box-shadow 0.12s ease;
        }
        .slotgrid.filled button {
            background: linear-gradient(180deg, #dcfce7, #bbf7d0) !important;
            color: #14532d !important;
            border: 1px solid rgba(34, 197, 94, 0.45) !important;
            box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.18) inset !important;
        }
        .slotgrid.empty button {
            background: linear-gradient(180deg, #f8fafc, #e2e8f0) !important;
            color: #334155 !important;
            border: 1px solid rgba(100, 116, 139, 0.25) !important;
        }
        .slotgrid.selected button {
            box-shadow: 0 0 0 3px #0ea5e9 inset !important;
        }
        .slotgrid:hover button { transform: translateY(-1px); }
        </style>
        """,
        unsafe_allow_html=True,
    )
    header = st.columns([0.45] + [1] * 10)
    header[0].markdown("&nbsp;", unsafe_allow_html=True)
    for idx, col in enumerate(BOX_COLS, start=1):
        header[idx].markdown(f"<div style='text-align:center; font-weight:700; color:#475569'>{col}</div>", unsafe_allow_html=True)

    for row in BOX_ROWS:
        cols = st.columns([0.45] + [1] * 10)
        cols[0].markdown(f"<div style='text-align:center; font-weight:700; color:#475569'>{row}</div>", unsafe_allow_html=True)
        for idx, col in enumerate(BOX_COLS, start=1):
            position = f"{row}{col}"
            occ = occupied.get(position)
            is_selected = bool(selected_position and selected_position.upper() == position)
            label = position
            btn_type = "secondary"
            help_text = None
            if occ:
                cell_line = str(occ.get("cell_line_name") or position)
                label = f"{position}\n{cell_line[:18]}"
                help_text = cell_line
            btn_type = "secondary"

            with cols[idx]:
                state_class = "filled" if occ else "empty"
                selected_class = "selected" if is_selected else ""
                st.markdown(f"<div class='slotgrid {state_class} {selected_class}'>", unsafe_allow_html=True)
                if st.button(label, key=f"slot_{tower}_{box}_{position}", help=help_text, type=btn_type, use_container_width=True):
                    _set_query_params(page="Box Viewer", tower=tower, box=box, position=position)
                    st.rerun()
                st.markdown("</div>", unsafe_allow_html=True)


def nav() -> str:
    with st.sidebar:
        st.markdown("## Freezers")
        st.caption(f"DB: `{database_label()}`")
        user = st.text_input("User (audit log)", value=os.environ.get("FREEZERS_USER", ""))
        st.session_state["user"] = user.strip() or None
    pages = ["Home", "Search", "Box Viewer", "Thawed", "In -80", "Actions", "Admin"]
    current_page = _qp_value("page") or st.session_state.get("nav_page") or "Home"
    if current_page not in pages:
        current_page = "Home"
    st.session_state["nav_page"] = current_page

    st.markdown(
        """
        <style>
        .navrow button {
            border-radius: 999px !important;
            padding: 0.38rem 0.7rem !important;
            min-height: 2.05rem !important;
            font-weight: 700 !important;
        }
        </style>
        """,
        unsafe_allow_html=True,
    )
    cols = st.columns(len(pages))
    for idx, page_name in enumerate(pages):
        with cols[idx]:
            clicked = st.button(
                page_name,
                key=f"nav_{page_name}",
                type="primary" if page_name == current_page else "secondary",
                use_container_width=True,
            )
            if clicked and page_name != current_page:
                _set_query_params(page=page_name)
                st.session_state["nav_page"] = page_name
                st.rerun()
    return current_page


def _aliquot_df(rows) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame([dict(r) for r in rows])
    cols = [
        "id",
        "status",
        "cell_line_name",
        "base_line_1",
        "base_line_2",
        "split",
        "date_frozen",
        "date_ln",
        "tower",
        "box",
        "position",
        "flask",
        "source",
        "thaw_in",
        "mycoplasma",
        "created_by",
        "thawed_by",
        "date_thawed",
        "created_at",
        "updated_at",
        "notes",
    ]
    df = df[[c for c in cols if c in df.columns]]
    df["location"] = df.apply(lambda r: location_str(r.get("tower"), r.get("box"), r.get("position")), axis=1)
    return df


def _archived_df(rows) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame([dict(r) for r in rows])
    df["archived_location"] = df.apply(
        lambda r: location_str(r.get("archived_tower"), r.get("archived_box"), r.get("archived_position")),
        axis=1,
    )
    columns = [
        "id",
        "cell_line_name",
        "split",
        "date_frozen",
        "date_thawed",
        "thawed_by",
        "archived_location",
        "notes",
        "source",
        "updated_at",
    ]
    return df[[c for c in columns if c in df.columns]]


def _box_verifications_df(rows) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame([dict(r) for r in rows])
    df["location"] = df.apply(lambda r: location_str(r.get("tower"), r.get("box"), None), axis=1)
    columns = [
        "id",
        "location",
        "verified_ok",
        "verified_by",
        "verified_date",
        "notes",
        "created_at",
    ]
    return df[[c for c in columns if c in df.columns]]


def home() -> None:
    st.title("Freezers Inventory")
    st.caption("Single source of truth + interactive box viewing + audit trail.")

    with connect() as conn:
        n_ln = fetch_one(conn, "SELECT COUNT(*) AS n FROM aliquots WHERE status='IN_LN'")["n"]
        n_80 = fetch_one(conn, "SELECT COUNT(*) AS n FROM aliquots WHERE status='IN_80'")["n"]
        n_arch = fetch_one(conn, "SELECT COUNT(*) AS n FROM aliquots WHERE status='ARCHIVED'")["n"]
        n_towers = fetch_one(
            conn, "SELECT COUNT(DISTINCT tower) AS n FROM aliquots WHERE status='IN_LN' AND tower IS NOT NULL"
        )["n"]
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("In LN", int(n_ln))
    c2.metric("In -80 (pending)", int(n_80))
    c3.metric("Archived", int(n_arch))
    c4.metric("Towers in use", int(n_towers))


def search() -> None:
    st.title("Search")
    q = st.text_input("Cell line contains", value="")
    status = st.multiselect("Status", ["IN_LN", "IN_80", "ARCHIVED"], default=["IN_LN", "IN_80"])
    tower = st.text_input("Tower (optional)", value="")

    with connect() as conn:
        sql = "SELECT * FROM aliquots WHERE 1=1"
        params: list[object] = []
        if q.strip():
            sql += " AND LOWER(cell_line_name) LIKE ?"
            params.append(f"%{q.strip().lower()}%")
        if status:
            sql += " AND status IN (%s)" % ",".join(["?"] * len(status))
            params.extend(status)
        if tower.strip().isdigit():
            sql += " AND tower = ?"
            params.append(int(tower.strip()))
        sql += " ORDER BY cell_line_name, split, date_frozen, tower, box, position, updated_at DESC"
        rows = fetch_all(conn, sql, params)
    if not rows:
        st.info("No matching rows.")
        return

    df = pd.DataFrame([dict(r) for r in rows])
    group_cols = ["cell_line_name", "split", "date_frozen"]
    grouped = []
    for _, group in df.groupby(group_cols, dropna=False, sort=False):
        first = group.iloc[0]
        location_items = []
        for _, row in group.sort_values(["tower", "box", "position"], na_position="last").iterrows():
            tower_val = row.get("tower")
            box_val = row.get("box")
            position_val = row.get("position")
            if tower_val is None or pd.isna(tower_val) or box_val is None or pd.isna(box_val) or position_val is None or pd.isna(position_val):
                continue
            tower_int = int(tower_val)
            box_str = str(box_val).upper()
            position_str = str(position_val).upper()
            label = f"{tower_int}{box_str} {position_str}"
            link = f"?page=Box%20Viewer&tower={tower_int}&box={box_str}&position={position_str}"
            state = "filled" if str(row.get("status") or "") == "IN_LN" else "empty"
            state_label = "Filled" if state == "filled" else "Empty"
            passage_label = escape(str(row.get("split") or "No passage"))
            date_thawed_label = escape(str(row.get("date_thawed") or "No thaw date"))
            location_items.append(
                f'<a class="location-chip {state}" href="{link}">'
                f'<span class="chip-top">'
                f'<span class="chip-name">{escape(str(first.get("cell_line_name") or ""))}</span>'
                f'<span class="chip-state">{state_label}</span>'
                f'</span>'
                f'<span class="chip-loc">{escape(label)}</span>'
                f'<span class="chip-meta">{passage_label} &middot; thawed {date_thawed_label}</span>'
                f'</a>'
            )
        grouped.append(
            {
                "Cell Line Name": first.get("cell_line_name"),
                "Passage": first.get("split"),
                "Date Frozen": first.get("date_frozen"),
                "Count": int(len(group)),
                "Locations": "".join(location_items) if location_items else "",
            }
        )

    grouped_df = pd.DataFrame(grouped)
    search_html = _search_results_html(df, grouped_df)
    st.markdown(
        """
        <style>
        .search-summary {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 0.75rem;
            margin-bottom: 1rem;
        }
        .search-card {
            background: linear-gradient(180deg, #ffffff, #f8fafc);
            border: 1px solid rgba(15, 23, 42, 0.10);
            border-radius: 18px;
            padding: 0.9rem 1rem;
            box-shadow: 0 8px 20px rgba(15, 23, 42, 0.04);
        }
        .search-card .label { color: #64748b; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; }
        .search-card .value { color: #0f172a; font-size: 1.55rem; font-weight: 800; line-height: 1.05; margin-top: 0.2rem; }
        .results-wrap {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
            gap: 0.9rem;
        }
        .result-card {
            background: #ffffff;
            border: 1px solid rgba(15, 23, 42, 0.10);
            border-radius: 18px;
            padding: 0.78rem 0.82rem;
            box-shadow: 0 10px 20px rgba(15, 23, 42, 0.04);
        }
        .result-card .title { font-size: 1rem; font-weight: 800; color: #0f172a; }
        .result-card .meta { margin-top: 0.25rem; color: #64748b; font-size: 0.84rem; }
        .result-card .locations {
            margin-top: 0.7rem;
            display: flex;
            flex-wrap: wrap;
            gap: 0.06rem;
        }
        .location-chip {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            justify-content: center;
            flex: 1 1 150px;
            min-width: 150px;
            min-height: 68px;
            padding: 0.42rem 0.5rem;
            border-radius: 14px;
            border: 1px solid rgba(15, 23, 42, 0.12);
            text-decoration: none !important;
            color: #0f172a !important;
            box-shadow: 0 6px 14px rgba(15, 23, 42, 0.04);
        }
        .location-chip.filled {
            background: linear-gradient(180deg, #dcfce7, #bbf7d0);
            border-color: rgba(34, 197, 94, 0.35);
        }
        .location-chip.empty {
            background: linear-gradient(180deg, #f8fafc, #e2e8f0);
            border-color: rgba(100, 116, 139, 0.22);
            color: #475569 !important;
        }
        .location-chip:hover { transform: translateY(-1px); }
        .chip-top {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.5rem;
            width: 100%;
        }
        .chip-name {
            font-size: 0.85rem;
            font-weight: 800;
            line-height: 1.08;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .chip-state {
            font-size: 0.64rem;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            color: #0f766e;
            white-space: nowrap;
        }
        .location-chip.empty .chip-state { color: #475569; }
        .chip-loc {
            margin-top: 0.18rem;
            font-size: 0.74rem;
            font-weight: 700;
            color: inherit;
        }
        .chip-meta {
            margin-top: 0.14rem;
            font-size: 0.66rem;
            color: inherit;
            opacity: 0.75;
        }
        </style>
        """,
        unsafe_allow_html=True,
    )
    components.html(
        f"""
        <div style="font-family: system-ui, sans-serif;">
        {search_html}
        </div>
        """,
        height=max(700, 140 + 150 * min(len(grouped_df), 10)),
        scrolling=True,
    )


def _archive_aliquot(
    aliquot_id: int,
    *,
    user: Optional[str],
    thawed_by: Optional[str] = None,
    date_thawed: Optional[str] = None,
) -> None:
    with connect() as conn:
        row = fetch_one(conn, "SELECT * FROM aliquots WHERE id=?", (aliquot_id,))
        if not row:
            return
        from_loc = location_str(row["tower"], row["box"], row["position"])
        upsert_aliquot(
            conn,
            aliquot_id=aliquot_id,
            cell_line_name=row["cell_line_name"],
            base_line_1=row["base_line_1"],
            base_line_2=row["base_line_2"],
            split=row["split"],
            date_frozen=row["date_frozen"],
            date_ln=row["date_ln"],
            flask=row["flask"],
            source=row["source"],
            thaw_in=row["thaw_in"],
            notes=row["notes"],
            mycoplasma=row["mycoplasma"],
            status="ARCHIVED",
            tower=None,
            box=None,
            position=None,
            thawed_by=thawed_by,
            date_thawed=date_thawed,
            archived_tower=row["tower"],
            archived_box=row["box"],
            archived_position=row["position"],
        )
        log_event(
            conn,
            action="archive",
            aliquot_id=aliquot_id,
            user=user,
            from_status=row["status"],
            to_status="ARCHIVED",
            from_location=from_loc,
            note=f"thawed_by={thawed_by or ''}; date_thawed={date_thawed or ''}",
        )


def _edit_aliquot_form(aliquot_id: int, *, user: Optional[str]) -> None:
    with connect() as conn:
        row = fetch_one(conn, "SELECT * FROM aliquots WHERE id=?", (aliquot_id,))
    if not row:
        st.session_state.pop("edit_id", None)
        st.info("Tube no longer available.")
        return

    with st.form(f"edit_{aliquot_id}"):
        cell_line_name = st.text_input("Cell line name", value=row["cell_line_name"] or "")
        base_line_1 = st.text_input("Base line 1", value=row["base_line_1"] or "")
        base_line_2 = st.text_input("Base line 2", value=row["base_line_2"] or "")
        split = st.text_input("Split", value=row["split"] or "")
        date_frozen = st.text_input("Date frozen", value=row["date_frozen"] or "")
        date_ln = st.text_input("Date LN", value=row["date_ln"] or "")
        flask = st.text_input("Flask", value=row["flask"] or "")
        source = st.text_input("Source", value=row["source"] or "")
        thaw_in = st.text_input("Thaw in…", value=row["thaw_in"] or "")
        myco = st.text_input("Mycoplasma?", value=row["mycoplasma"] or "")
        notes = st.text_area("Notes", value=row["notes"] or "")

        save = st.form_submit_button("Save", type="primary")
        close = st.form_submit_button("Close")

    if close:
        st.session_state.pop("edit_id", None)
        st.rerun()

    if save:
        with connect() as conn:
            upsert_aliquot(
                conn,
                aliquot_id=aliquot_id,
                cell_line_name=cell_line_name.strip() or row["cell_line_name"],
                base_line_1=base_line_1.strip() or None,
                base_line_2=base_line_2.strip() or None,
                split=split.strip() or None,
                date_frozen=date_frozen.strip() or None,
                date_ln=date_ln.strip() or None,
                flask=flask.strip() or None,
                source=source.strip() or None,
                thaw_in=thaw_in.strip() or None,
                notes=notes.strip() or None,
                mycoplasma=myco.strip() or None,
                status=row["status"],
                tower=row["tower"],
                box=row["box"],
                position=row["position"],
            )
            log_event(conn, action="edit", aliquot_id=aliquot_id, user=user, note="Edited metadata")
        st.success("Saved.")
        st.session_state.pop("edit_id", None)
        st.rerun()


def _move_from_80_form(*, tower: int, box: str, position: str, user: Optional[str]) -> None:
    with connect() as conn:
        pending = fetch_all(
            conn,
            "SELECT id, cell_line_name, split, date_frozen, batch_id, batch_index FROM aliquots WHERE status='IN_80' ORDER BY updated_at DESC LIMIT 2000",
        )
    if not pending:
        st.info("No tubes in -80. Add a batch in the In -80 page.")
        return

    options = []
    for r in pending:
        label = (
            f"#{r['id']} | {r['cell_line_name']} | {r['split'] or ''} | {r['date_frozen'] or ''} | "
            f"{(r['batch_id'] or '')} {(r['batch_index'] or '')}"
        ).strip()
        options.append((label, int(r["id"])))

    with st.form(f"move_80_to_ln_{tower}{box}_{position}"):
        choice = st.selectbox("Select tube from -80", options=options, format_func=lambda x: x[0])
        date_ln = st.text_input("Date LN (YYYY-MM-DD)", value="")
        submit = st.form_submit_button(f"Move into {tower}{box} {position}", type="primary")

    if submit:
        tube_id = int(choice[1])
        with connect() as conn:
            row = fetch_one(conn, "SELECT * FROM aliquots WHERE id=?", (tube_id,))
            if not row:
                st.error("Tube not found.")
                return
            upsert_aliquot(
                conn,
                aliquot_id=tube_id,
                cell_line_name=row["cell_line_name"],
                base_line_1=row["base_line_1"],
                base_line_2=row["base_line_2"],
                split=row["split"],
                date_frozen=row["date_frozen"],
                date_ln=(date_ln.strip() or row["date_ln"]),
                flask=row["flask"],
                source=row["source"],
                thaw_in=row["thaw_in"],
                notes=row["notes"],
                mycoplasma=row["mycoplasma"],
                status="IN_LN",
                tower=tower,
                box=box,
                position=position,
            )
            log_event(
                conn,
                action="move_80_to_ln",
                aliquot_id=tube_id,
                user=user,
                from_status="IN_80",
                to_status="IN_LN",
                to_location=location_str(tower, box, position),
            )
        st.success("Moved.")
        st.rerun()


def box_viewer() -> None:
    st.title("Box Viewer")
    with connect() as conn:
        towers = [
            r["tower"]
            for r in fetch_all(
                conn,
                "SELECT DISTINCT tower FROM aliquots WHERE status='IN_LN' AND tower IS NOT NULL ORDER BY tower",
            )
        ]
    if not towers:
        st.info("No LN entries yet. Import from Excel in Admin, or move something from -80 to LN.")
        return

    selected_tower = _qp_value("tower")
    selected_box = _qp_value("box")
    selected_position = _qp_value("position")

    if selected_tower and str(selected_tower).isdigit():
        tower_default = towers.index(int(selected_tower)) if int(selected_tower) in towers else 0
    else:
        tower_default = 0
    box_default = list("ABCDEFGHIJKLM").index(str(selected_box).upper()) if selected_box and str(selected_box).upper() in list("ABCDEFGHIJKLM") else 0

    left, right = st.columns([3.2, 1.4], gap="large")
    with left:
        c1, c2 = st.columns([1, 1])
        with c1:
            tower = st.selectbox("Tower", towers, index=tower_default)
        with c2:
            box = st.selectbox("Box", list("ABCDEFGHIJKLM"), index=box_default)

        if str(tower) != str(selected_tower or "") or str(box).upper() != str(selected_box or "").upper():
            _set_query_params(tower=int(tower), box=str(box).upper())
            st.rerun()

        with connect() as conn:
            rows = fetch_all(
                conn,
                "SELECT * FROM aliquots WHERE status='IN_LN' AND tower=? AND box=?",
                (int(tower), box.upper()),
            )
            latest_verification = fetch_latest_box_verification(conn, tower=int(tower), box=str(box).upper())
        occupied = {
            str(r["position"]).upper(): dict(r)
            for r in rows
            if r["position"] is not None and str(r["position"]).strip() != ""
        }

        if latest_verification:
            verified_ok_flag = int(latest_verification["verified_ok"]) == 1
            pill_color = "#dcfce7" if verified_ok_flag else "#fee2e2"
            pill_text = "#166534" if verified_ok_flag else "#7f1d1d"
            status_text = "verified" if verified_ok_flag else "flagged"
            st.markdown(
                f"""
                <div style="
                    border: 1px solid rgba(15, 23, 42, 0.12);
                    border-radius: 14px;
                    padding: 0.55rem 0.7rem;
                    margin-bottom: 0.6rem;
                    background: #ffffff;
                ">
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:0.75rem;">
                        <div style="font-size:0.82rem; color:#475569;">
                            Last checked by <strong>{escape(str(latest_verification['verified_by'] or 'n/a'))}</strong>
                            on <strong>{escape(str(latest_verification['verified_date'] or 'n/a'))}</strong>
                        </div>
                        <div style="
                            padding: 0.18rem 0.5rem;
                            border-radius: 999px;
                            background: {pill_color};
                            color: {pill_text};
                            font-size: 0.68rem;
                            font-weight: 800;
                            text-transform: uppercase;
                            letter-spacing: 0.04em;
                        ">{status_text}</div>
                    </div>
                </div>
                """,
                unsafe_allow_html=True,
            )
        else:
            st.markdown(
                """
                <div style="
                    border: 1px dashed rgba(15, 23, 42, 0.18);
                    border-radius: 14px;
                    padding: 0.55rem 0.7rem;
                    margin-bottom: 0.6rem;
                    background: #ffffff;
                    color: #64748b;
                    font-size: 0.82rem;
                ">
                    No verification recorded yet for this box.
                </div>
                """,
                unsafe_allow_html=True,
            )

        with st.expander("Record box verification", expanded=False):
            with st.form(f"verify_box_{tower}_{box}"):
                verified_ok = st.checkbox("I confirm this box matches the database", value=True)
                verified_date = st.date_input("Verification date", value=date.today())
                verified_by = _thaw_user_picker("Verified by")
                notes = st.text_input("Notes (optional)", value="")
                submit_verify = st.form_submit_button("Record verification", type="primary")
            if submit_verify:
                if not verified_ok:
                    st.error("Tick the confirmation box to record a positive verification.")
                else:
                    with connect() as conn:
                        record_box_verification(
                            conn,
                            tower=int(tower),
                            box=str(box).upper(),
                            verified_ok=True,
                            verified_by=verified_by or None,
                            verified_date=verified_date.isoformat(),
                            notes=notes.strip() or None,
                        )
                        log_event(
                            conn,
                            action="box_verify",
                            user=st.session_state.get("user"),
                            note=f"box={tower}{str(box).upper()} verified_by={verified_by or ''} date={verified_date.isoformat()}",
                        )
                    st.success("Verification recorded.")
                    st.rerun()

        st.caption("Green cells are occupied. Gray cells are empty. The blue outline marks the selected slot.")
        _render_box_html(
            tower=int(tower),
            box=str(box).upper(),
            occupied=occupied,
            selected_position=str(selected_position).upper() if selected_position else None,
        )

    with right:
        st.subheader(f"Selection: {int(tower)}{str(box).upper()} {selected_position or '(none)'}")
        if st.button("Jump to next empty slot", use_container_width=True):
            target = _next_empty_position(occupied, after_position=selected_position)
            if target is None:
                st.info("No empty slots left in this box.")
            else:
                _set_query_params(page="Box Viewer", tower=int(tower), box=str(box).upper(), position=target)
                st.rerun()
        if selected_position:
            selected_occ = occupied.get(str(selected_position).upper())
            if selected_occ:
                st.markdown("### Occupied")
                st.dataframe(_aliquot_df([selected_occ]), use_container_width=True, hide_index=True)
                location = location_str(int(tower), str(box).upper(), str(selected_position).upper())
                if location:
                    st.caption(f"Location: {location}")
                    _copy_location_button(location)

                thaw_user = _thaw_user_picker()
                thaw_date = st.date_input("Thaw date", value=date.today())

                col1, col2 = st.columns(2)
                with col1:
                    if st.button("Thaw / Archive", type="primary", use_container_width=True):
                        _archive_aliquot(
                            int(selected_occ["id"]),
                            user=st.session_state.get("user"),
                            thawed_by=thaw_user or None,
                            date_thawed=thaw_date.isoformat(),
                        )
                        st.success("Archived.")
                        st.rerun()
                with col2:
                    if st.button("Edit", use_container_width=True):
                        st.session_state["edit_id"] = int(selected_occ["id"])
                        st.rerun()
            else:
                st.markdown("### Empty slot")
                st.caption("This slot is available.")
                _move_from_80_form(tower=int(tower), box=str(box).upper(), position=str(selected_position).upper(), user=st.session_state.get("user"))
        else:
            st.caption("Click a slot in the box to load its details here.")

        edit_id = st.session_state.get("edit_id")
        if edit_id:
            st.divider()
            st.markdown("### Edit tube")
            _edit_aliquot_form(edit_id, user=st.session_state.get("user"))


def in_80() -> None:
    st.title("In -80 (Pending LN)")
    st.caption("Tubes you’ve frozen and plan to transfer into LN.")

    with connect() as conn:
        rows = fetch_all(conn, "SELECT * FROM aliquots WHERE status='IN_80' ORDER BY updated_at DESC LIMIT 2000")
    st.dataframe(_aliquot_df(rows), use_container_width=True, hide_index=True)

    st.divider()
    st.subheader("Add a new batch to -80")
    with st.form("add_batch_80"):
        cell_line_name = st.text_input("Cell line name", value="")
        base_line_1 = st.text_input("Base line 1", value="")
        base_line_2 = st.text_input("Base line 2", value="")
        split = st.text_input("Split (e.g. P7)", value="")
        date_frozen = st.text_input("Date frozen (YYYY-MM-DD)", value="")
        flask = st.text_input("Flask", value="")
        source = st.text_input("Source", value="")
        thaw_in = st.text_input("Thaw in…", value="")
        myco = st.text_input("Mycoplasma?", value="")
        notes = st.text_area("Notes", value="")
        n = st.number_input("Number aliquots", min_value=1, max_value=100, value=3, step=1)
        submit = st.form_submit_button("Create tubes", type="primary")

    if submit:
        if not cell_line_name.strip():
            st.error("Cell line name is required.")
            return
        batch_id = str(uuid.uuid4())
        with connect() as conn:
            for i in range(1, int(n) + 1):
                aliquot_id = upsert_aliquot(
                    conn,
                    batch_id=batch_id,
                    batch_index=i,
                    cell_line_name=cell_line_name.strip(),
                    base_line_1=base_line_1.strip() or None,
                    base_line_2=base_line_2.strip() or None,
                    split=split.strip() or None,
                    date_frozen=date_frozen.strip() or None,
                    date_ln=None,
                    flask=flask.strip() or None,
                    source=source.strip() or None,
                    thaw_in=thaw_in.strip() or None,
                    notes=notes.strip() or None,
                    mycoplasma=myco.strip() or None,
                    status="IN_80",
                    created_by=st.session_state.get("user"),
                )
                log_event(
                    conn,
                    action="create_in_80",
                    aliquot_id=aliquot_id,
                    user=st.session_state.get("user"),
                    to_status="IN_80",
                    note=f"batch {batch_id} #{i}/{n}",
                )
        st.success(f"Created {int(n)} tubes in -80 (batch {batch_id}).")
        st.rerun()


def actions() -> None:
    st.title("Actions")
    st.caption("Quick actions without going through the box viewer.")

    with connect() as conn:
        ln = fetch_all(
            conn,
            "SELECT id, cell_line_name, tower, box, position, updated_at FROM aliquots WHERE status='IN_LN' ORDER BY updated_at DESC LIMIT 1000",
        )
    if not ln:
        st.info("No LN tubes yet.")
        return

    st.subheader("Thaw / archive")
    options = [
        (f"#{r['id']} | {r['cell_line_name']} | {location_str(r['tower'], r['box'], r['position'])}", int(r["id"]))
        for r in ln
    ]
    pick = st.selectbox("Select LN tube", options=options, format_func=lambda x: x[0])
    thaw_user = _thaw_user_picker()
    thaw_date = st.date_input("Thaw date", value=date.today())
    if st.button("Archive selected tube", type="primary"):
        _archive_aliquot(
            int(pick[1]),
            user=st.session_state.get("user"),
            thawed_by=thaw_user or None,
            date_thawed=thaw_date.isoformat(),
        )
        st.success("Archived.")
        st.rerun()


def thawed() -> None:
    st.title("Thawed / Archive Log")
    st.caption("Archived tubes keep their thaw metadata and last LN location here.")

    with connect() as conn:
        rows = fetch_all(
            conn,
            """
            SELECT *
            FROM aliquots
            WHERE status='ARCHIVED'
            ORDER BY COALESCE(date_thawed, updated_at) DESC, updated_at DESC
            LIMIT 5000
            """,
        )
    df = _archived_df(rows)
    if df.empty:
        st.info("No archived tubes yet.")
        return
    st.dataframe(df, use_container_width=True, hide_index=True)


def admin() -> None:
    st.title("Admin")

    st.subheader("Initialize DB")
    if st.button("Initialize / migrate DB schema", type="primary"):
        init_db()
        st.success(f"Initialized: {database_label()}")

    st.divider()
    st.subheader("Import from Excel")
    uploaded = st.file_uploader("Browse for workbook", type=["xlsx"])
    xlsx = st.text_input("Or Excel path", value=str(DEFAULT_IMPORT_XLSX))
    start_fresh = st.checkbox(
        "Start fresh before import",
        value=True,
        help="Clears existing aliquots, audit events, and box verifications before importing.",
    )
    if st.button("Import now", type="primary"):
        temp_path = None
        if uploaded is not None:
            suffix = Path(uploaded.name).suffix or ".xlsx"
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                tmp.write(uploaded.getbuffer())
                temp_path = Path(tmp.name)
            p = temp_path
        else:
            p = Path(xlsx)
        if not p.exists():
            st.error("File not found.")
            return
        with connect() as conn:
            if start_fresh:
                clear_inventory_data(conn)
        out = import_from_excel(p, user=st.session_state.get("user"))
        if temp_path is not None:
            try:
                temp_path.unlink(missing_ok=True)
            except Exception:
                pass
        st.success(f"Imported: LN={out['ln']}, In-80={out['in_80']}, Archive={out['archive']}")

    st.divider()
    st.subheader("Audit log (latest 200)")
    with connect() as conn:
        rows = fetch_all(conn, "SELECT * FROM events ORDER BY id DESC LIMIT 200")
    if rows:
        st.dataframe(pd.DataFrame([dict(r) for r in rows]), use_container_width=True, hide_index=True)
    else:
        st.caption("No events yet.")

    st.divider()
    st.subheader("Box verifications")
    with connect() as conn:
        verifications = fetch_all(
            conn,
            """
            SELECT *
            FROM box_verifications
            ORDER BY id DESC
            LIMIT 500
            """,
        )
    vdf = _box_verifications_df(verifications)
    if vdf.empty:
        st.caption("No box verifications yet.")
    else:
        st.dataframe(vdf, use_container_width=True, hide_index=True)


def main() -> None:
    page_config()
    try:
        init_db()
    except Exception as exc:
        st.error(
            "Could not connect to the database. Check `FREEZERS_DATABASE_URL` in Streamlit secrets and make sure it uses Supabase session pooler details."
        )
        st.caption(f"Database target: `{database_label()}`")
        st.exception(exc)
        return

    page = nav()
    if page == "Home":
        home()
    elif page == "Search":
        search()
    elif page == "Box Viewer":
        box_viewer()
    elif page == "Thawed":
        thawed()
    elif page == "In -80":
        in_80()
    elif page == "Actions":
        actions()
    elif page == "Admin":
        admin()


if __name__ == "__main__":
    main()
