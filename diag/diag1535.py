"""#1535 diagnostic: time and profile Undo after Approve all. Numbers only.

usage: .venv/bin/python diag/diag1535.py <project_dir_or_json> [--skip-approve]   (run on a CLONE; it edits the project)
--skip-approve: the clone is already approved; time only one Undo of its current head.
"""
import cProfile, pstats, sys, time
from podcast_mcp.project_io import open_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import HistoryService
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.service import DocumentSyncService

path, project = open_project(sys.argv[1])
ws = ProjectWorkspace.open(path)
svc = DocumentSyncService(ws)
if "--skip-approve" not in sys.argv:
    ids = [e.id for e in ws.project.edit_decisions if not getattr(e, "approved", False)]
    print("pending ids", len(ids))
    t = time.time()
    r = svc.submit(DocumentCommand(type="ApproveEdits", payload={"ids": ids, "hold_blocked": True},
        client_id="diag", role="host", client_seq=1))
    print("approve s", round(time.time() - t, 1), "count", r.get("history_head_id") is not None)
head = HistoryService(ws).status()["head_id"]
pr = cProfile.Profile(); t = time.time(); pr.enable()
svc.submit(DocumentCommand(type="UndoHistory", payload={"expected_head_id": head},
    client_id="diag", role="host", client_seq=2))
pr.disable()
print("UNDO s", round(time.time() - t, 1))
pstats.Stats(pr).sort_stats("cumulative").print_stats(35)
