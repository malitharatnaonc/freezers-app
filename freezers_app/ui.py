from __future__ import annotations

import string
from typing import Optional

import streamlit as st


ROWS = list(string.ascii_uppercase[:10])  # A–J
COLS = list(range(1, 11))  # 1–10


def pos_label(row: str, col: int) -> str:
    return f"{row}{col}"


def render_box_grid(
    *,
    occupied: dict[str, dict],
    key_prefix: str,
    selected: Optional[str] = None,
) -> Optional[str]:
    """
    Render a 10×10 clickable grid (A–J × 1–10) using Streamlit buttons.
    Returns the clicked position label (e.g. "B7") or None.
    """
    st.markdown(
        """
        <style>
        div[data-testid="column"] { padding-right: 0.25rem; padding-left: 0.25rem; }
        .slotbtn button { width: 100%; height: 46px; padding: 0.15rem 0.25rem; }
        </style>
        """,
        unsafe_allow_html=True,
    )

    header_cols = st.columns([1] + [1] * 10)
    header_cols[0].markdown("&nbsp;", unsafe_allow_html=True)
    for i, c in enumerate(COLS, start=1):
        header_cols[i].markdown(
            f"<div style='text-align:center; font-weight:700'>{c}</div>", unsafe_allow_html=True
        )

    clicked = None
    for r in ROWS:
        cols = st.columns([1] + [1] * 10)
        cols[0].markdown(f"<div style='text-align:center; font-weight:700'>{r}</div>", unsafe_allow_html=True)
        for i, c in enumerate(COLS, start=1):
            pos = pos_label(r, c)
            occ = occupied.get(pos)
            label = pos
            help_text = None
            if occ:
                name = str(occ.get("cell_line_name") or "")
                short = name[:14] + ("…" if len(name) > 14 else "")
                label = short or pos
                help_text = name or None

            btn_type = "primary" if selected == pos else "secondary"
            with cols[i]:
                st.markdown('<div class="slotbtn">', unsafe_allow_html=True)
                if st.button(label, key=f"{key_prefix}_slot_{pos}", help=help_text, type=btn_type):
                    clicked = pos
                st.markdown("</div>", unsafe_allow_html=True)

    return clicked

