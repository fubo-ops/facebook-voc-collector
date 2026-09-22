import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("build_facebook_workbook", ROOT / "scripts" / "build_facebook_workbook.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class WorkbookTests(unittest.TestCase):
    def test_builds_eight_consistent_sheets(self):
        with tempfile.TemporaryDirectory() as value:
            out = Path(value)
            parent = {"record_id": "p", "comment_id": "p", "post_id": "post", "depth": 0,
                      "parent_comment_id": "post:post", "post_audit_status": "PASS", "body": "parent"}
            reply = {"record_id": "r", "comment_id": "r", "post_id": "post", "depth": 1,
                     "parent_comment_id": "p", "post_audit_status": "PASS", "body": "reply"}
            raw = [parent, reply]
            for name, rows in (("raw_comments.jsonl", raw), ("trusted_comments.jsonl", raw),
                               ("partial_candidates.jsonl", [])):
                (out / name).write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
            (out / "conversation_map.json").write_text(json.dumps({"asins": ["B003ULL1NQ"], "layers": {"community_language": ["mobility"]}, "products": [], "sellersprite": {"status": "degraded"}}), encoding="utf-8")
            (out / "query_plan.json").write_text(json.dumps({"queries": [{"query": "dog mobility"}]}), encoding="utf-8")
            (out / "page_map.json").write_text(json.dumps([{"post_id": "post", "status": "PASS"}]), encoding="utf-8")
            (out / "manifest.json").write_text(json.dumps({"final_collected_count": 2}), encoding="utf-8")
            result = MODULE.build(out)
            self.assertEqual(result["raw"], 2)
            self.assertTrue((out / "facebook_voc.xlsx").exists())
            import openpyxl
            workbook = openpyxl.load_workbook(out / "facebook_voc.xlsx", read_only=True)
            self.assertEqual(tuple(workbook.sheetnames), MODULE.SHEETS)
            quality = {row[0]: row[1] for row in workbook["Quality_Gate"].iter_rows(min_row=2, values_only=True)}
            self.assertTrue(all(value == "PASS" for value in quality.values()))
            workbook.close()


if __name__ == "__main__":
    unittest.main()
