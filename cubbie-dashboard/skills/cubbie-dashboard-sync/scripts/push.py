#!/usr/bin/env python3
"""Post a verified batch of tasks to the student's Cubbie Dashboard. Standard library only.

Usage:
  CUBBIE_DASHBOARD_API_KEY="..." python3 scripts/push.py --url https://<api> --input batch.json [--dry-run]
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

ALLOWED_VIEWS = {"student", "grader", "jobs"}
MAX_BYTES = 5_000_000


def fail(code: int, msg: str) -> None:
    print(msg, file=sys.stderr)
    sys.exit(code)


def check(batch: dict) -> None:
    """Catch the common mistakes locally so the student isn't waiting on a round trip."""
    if not isinstance(batch.get("tasks"), list):
        fail(2, "input must have a tasks list")
    seen = set()
    for i, t in enumerate(batch["tasks"]):
        where = f"tasks[{i}]"
        if t.get("view") not in ALLOWED_VIEWS:
            fail(2, f"{where}.view must be student, grader or jobs")
        sid = t.get("sourceId")
        if not sid:
            fail(2, f"{where}.sourceId is required so re-syncs don't duplicate cards")
        if sid in seen:
            fail(2, f"{where}.sourceId {sid!r} appears twice")
        seen.add(sid)
        g = t.get("grading") or {}
        for k in ("studentsSubmitted", "eligibleStudents", "needsGrading"):
            if k in g and g[k] is not None and (not isinstance(g[k], int) or g[k] < 0):
                fail(2, f"{where}.grading.{k} must be a non-negative integer or null (unknown)")
        j = t.get("job") or {}
        if j.get("applicationDate") and not j.get("applicationDateEvidence"):
            fail(2, f"{where}.job.applicationDate needs applicationDateEvidence")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--url", required=True, help="Dashboard API base URL (https)")
    p.add_argument("--input", required=True)
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()

    if not a.url.startswith("https://"):
        fail(2, "--url must start with https://")
    key = os.environ.get("CUBBIE_DASHBOARD_API_KEY", "").strip()
    if not key:
        fail(3, "CUBBIE_DASHBOARD_API_KEY is not set")
    try:
        if os.path.getsize(a.input) > MAX_BYTES:
            fail(2, "input is over 5 MB; sync a narrower date range")
        with open(a.input, encoding="utf-8") as f:
            batch = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        fail(2, f"could not read input: {e}")

    check(batch)
    if a.dry_run:
        print(json.dumps({"ok": True, "tasks": len(batch["tasks"]), "dryRun": True}))
        return

    req = urllib.request.Request(
        a.url.rstrip("/") + "/ingest/cubbie",
        data=json.dumps(batch).encode("utf-8"),
        headers={"content-type": "application/json", "x-cubbie-key": key, "user-agent": "cubbie-dashboard-sync/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            print(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:2000]
        if e.code == 401:
            fail(5, f"key rejected: {body}")
        if e.code in (400, 413):
            fail(6, f"board rejected the data: {body}")
        fail(4, f"dashboard error {e.code}: {body}")
    except (urllib.error.URLError, TimeoutError) as e:
        fail(4, f"dashboard unreachable: {e}")


if __name__ == "__main__":
    main()
