"""Hermes's own ACP listing (SessionManager.list_sessions) against a DB copy."""
import json
import sys
from pathlib import Path

from hermes_state import SessionDB
from acp_adapter.session import SessionManager

db = SessionDB(db_path=Path(sys.argv[1]))
rows = SessionManager(db=db).list_sessions(cwd=sys.argv[2])
print(json.dumps([{k: r[k] for k in ("session_id", "cwd", "title", "updated_at", "history_len")} for r in rows]))
