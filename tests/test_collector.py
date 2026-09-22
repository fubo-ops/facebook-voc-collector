import json
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

from scripts.collector import build_outputs, ingest_capture


class CollectorTests(unittest.TestCase):
    def test_raw_preservation_and_technical_dedup(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            capture = {
                "post_id": "p1", "post_url": "https://www.facebook.com/example/posts/p1",
                "post_title": "Dog joints", "displayed_count": 6,
                "expanded_visible_count": 5,
                "remaining_controls": 1,
                "comments": [
                    {"comment_id": "c1", "body": "Ad: buy now", "author": "A"},
                    {"comment_id": "c2", "body": "ok", "author": "B", "parent_comment_id": "c1", "depth": 1},
                    {"comment_id": "c3", "body": "cat food", "author": "C"},
                    {"comment_id": "c1", "body": "Ad: buy now", "author": "A"},
                    {"body": "same", "author": "D"},
                    {"body": "same", "author": "D"},
                ],
            }
            ingest_capture(root, capture)
            manifest = build_outputs(root, asin="B003ULL1NQ", query="dog joint")
            rows = [json.loads(x) for x in (root / "raw_comments.jsonl").read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(rows), 5)
            self.assertEqual(manifest["raw_captured_count"], 6)
            self.assertEqual(manifest["technical_duplicate_count"], 1)
            self.assertEqual(manifest["final_collected_count"], 5)
            self.assertEqual(manifest["post_audit"][0]["status"], "PARTIAL")
            self.assertEqual(manifest["post_audit"][0]["visible_loaded_count"], 5)
            self.assertEqual(rows[1]["parent_comment_id"], "c1")
            self.assertEqual(len([r for r in rows if r["body"] == "same"]), 2)
            self.assertTrue((root / "raw_comments.xlsx").exists())

    def test_rejects_non_facebook_capture(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                ingest_capture(Path(folder), {"post_url": "https://example.com/", "comments": []})

    def test_local_bridge_requires_pair_token(self):
        with tempfile.TemporaryDirectory() as folder, socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
            probe.close()
            script = Path(__file__).parents[1] / "scripts" / "collector.py"
            process = subprocess.Popen([sys.executable, str(script), "serve", "--out-dir", folder,
                                        "--port", str(port)], stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, universal_newlines=True)
            try:
                opener = build_opener(ProxyHandler({}))
                token = process.stdout.readline().strip().split("=", 1)[1]
                process.stdout.readline()
                payload = json.dumps({"post_url": "https://www.facebook.com/example/posts/p1",
                                      "displayed_count": 1, "comments": [{"comment_id": "c1", "body": "ok"}]}).encode()
                url = "http://127.0.0.1:%d/capture" % port
                session_url = "http://127.0.0.1:%d/session" % port
                with self.assertRaises(HTTPError) as error:
                    opener.open(session_url, timeout=5)
                self.assertEqual(error.exception.code, 403)
                session = Request(session_url, headers={"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"})
                with opener.open(session, timeout=5) as response:
                    self.assertEqual(json.load(response)["token"], token)
                bad = Request(url, payload, {"Authorization": "Bearer WRONG"}, method="POST")
                with self.assertRaises(HTTPError) as error:
                    opener.open(bad, timeout=5)
                self.assertEqual(error.exception.code, 403)
                good = Request(url, payload, {"Authorization": "Bearer " + token}, method="POST")
                with opener.open(good, timeout=5) as response:
                    self.assertEqual(json.load(response)["final_collected_count"], 1)
                self.assertTrue((Path(folder) / "raw_comments.xlsx").exists())
            finally:
                process.terminate()
                process.wait(timeout=5)
                process.stdout.close()
                process.stderr.close()


if __name__ == "__main__":
    unittest.main()
