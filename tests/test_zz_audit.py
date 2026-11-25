import json, threading
from pathlib import Path
from fastapi.testclient import TestClient
from podcast_mcp.gui.server import create_app
from tests.test_segments_insert import project, _save  # noqa
from podcast_mcp.services.document_sync import DocumentSyncService

def C(app=None): return TestClient(app or create_app(), client=("127.0.0.1", 50000))

def test_all(tmp_path, project, ten_second_silence_wav, capsys):
    seg = _save(tmp_path, "Warm Intro", chapter_title="Welcome", role="dialogue", lanes=(0,1))
    app = create_app(); c = C(app)
    out = {}
    for at in ["٣", "end", " END ", "1e1", "1_0", "nan", "-1", "", "0x10", "ſtart", "start", "10", "10.000001", "+3", "٣.٥"]:
        r = c.get(f"/api/segments/{seg.id}/insert-preview", params={"path": project, "at": at})
        out[at] = (r.status_code, r.headers.get("X-Sharecut-Error-Code"), r.json().get("at") if r.status_code==200 else r.text[:80])
    for v in ["abc","-1","1.5","", "99999999999999999999"]:
        r = c.get(f"/api/segments/{seg.id}/insert-preview", params={"path": project, "at": "1", "version": v})
        out["v="+v] = (r.status_code, r.headers.get("X-Sharecut-Error-Code"), r.text[:100])
    # missing at
    r = c.get(f"/api/segments/{seg.id}/insert-preview", params={"path": project})
    out["noat"] = (r.status_code, r.headers.get("X-Sharecut-Error-Code"), r.text[:100])
    # non-episode file
    bad = tmp_path/"junk.txt"; bad.write_text("hello")
    app2 = create_app(); c2 = C(app2)
    print("served before", getattr(app2.state,"served_project",None))
    r = c2.get(f"/api/segments/{seg.id}/insert-preview", params={"path": str(bad), "at": "1"})
    out["junk"] = (r.status_code, r.headers.get("X-Sharecut-Error-Code"), r.text[:150])
    print("served after junk", app2.state.served_project)
    # ID with traversal
    for sid in ["..%2F..%2Fetc", "%2e%2e", "a/b"]:
        r = c.get(f"/api/segments/{sid}/insert-preview", params={"path": project, "at": "1"})
        out["sid "+sid] = (r.status_code, r.headers.get("X-Sharecut-Error-Code"), r.text[:80])
    # apply reply shape
    body = {"client_id":"viewer","client_seq":1,"command_id":"c1","type":"InsertSegment","role":"viewer","payload":{"segment_id":seg.id,"at":"END","version":1}}
    r = c.post("/api/document/command", params={"path": project}, json=body)
    out["apply"] = (r.status_code, r.headers.get("X-Sharecut-Error-Code"), json.dumps(r.json())[:1500])
    r2 = c.post("/api/document/command", params={"path": project}, json=body)
    out["apply_retry"] = (r2.status_code, json.dumps(r2.json())[:300])
    body["command_id"]="c2"; body["client_seq"]=2; body["payload"]["at"]="٣"
    r = c.post("/api/document/command", params={"path": project}, json=body)
    out["apply_arabic"] = (r.status_code, r.headers.get("X-Sharecut-Error-Code"), json.dumps(r.json())[:200])
    body["command_id"]="c3"; body["client_seq"]=3; body["payload"]["at"]=True
    r = c.post("/api/document/command", params={"path": project}, json=body)
    out["apply_bool"] = (r.status_code, r.headers.get("X-Sharecut-Error-Code"), r.text[:200])
    body["command_id"]="c4"; body["client_seq"]=4; body["payload"]={"segment_id":"nope-00000000","at":1}
    r = c.post("/api/document/command", params={"path": project}, json=body)
    out["apply_unknown"] = (r.status_code, r.headers.get("X-Sharecut-Error-Code"), r.text[:200])
    with capsys.disabled():
        for k,v in out.items(): print(repr(k), v)
