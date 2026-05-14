# Freezers App (Streamlit)

Shared inventory app for lab liquid nitrogen freezings with:

- Single source of truth (SQLite by default, Postgres for shared hosting)
- Search + filter inventory
- Interactive 10×10 box viewer (A–J × 1–10)
- Simple workflows: add to **-80**, move to **LN**, thaw/archive
- Import from existing Excel workbook

## Quick start

From this folder:

```bash
cd /Users/ratnawm/projects/freezers/freezers_app
python3 -m streamlit run app.py
```

The app creates a local SQLite database at `freezers.sqlite3` by default.

If you want the app to run on one lab machine and be reachable from other machines on the same network, use:

```bash
cd /Users/ratnawm/projects/freezers/freezers_app
./run_local.sh
```

Then other users can open:

```text
http://<lab-machine-ip>:8501
```

This is browser access, not a static HTML file. The app still runs as Python on the host machine, but everyone can use it through a normal web page.

To use Postgres instead, set `FREEZERS_DATABASE_URL`, for example:

```bash
export FREEZERS_DATABASE_URL="postgresql://user:password@host:5432/freezers"
```

The app will then use that shared database for all edits and reload previous state when anyone opens the app.

On Streamlit Community Cloud, put `FREEZERS_DATABASE_URL` in the app secrets instead of an environment variable.

## First-time import (from your Excel file)

1) Put the Excel workbook in the parent folder (already present as `../Freezings_MR-IK2.xlsx`).
2) Run the app and go to **Admin → Import**.

## Notes

- Locations are uniquely enforced for **LN** storage: only one tube can occupy a given `(tower, box, position)`.
- When thawed/archived, the tube’s LN location is cleared so the slot becomes available again.
- The audit log, thaw/archive log, thaw-user list, and box verification records are all stored in the same database.
