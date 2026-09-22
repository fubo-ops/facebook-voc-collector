"""Local, selected-tab Facebook comment capture receiver. Python stdlib only."""

import argparse
import csv
import datetime as dt
import json
import re
import secrets
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from xml.sax.saxutils import escape

FIELDS = ["record_type", "platform", "asin", "query", "post_id", "post_url",
          "post_title", "comment_id", "parent_comment_id", "depth", "author",
          "body", "created_at", "reaction_count", "comment_url", "collected_at",
          "dedup_uncertain"]
PORT = 43128


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def facebook_url(value):
    url = urlparse(str(value or ""))
    return url.scheme == "https" and url.hostname in {"facebook.com", "www.facebook.com", "m.facebook.com"}


def ingest_capture(out_dir, capture):
    """Append an unmodified capture event; never silently discard visible text."""
    if not isinstance(capture, dict) or not facebook_url(capture.get("post_url")):
        raise ValueError("post_url must be an HTTPS Facebook URL")
    comments = capture.get("comments")
    if not isinstance(comments, list) or len(comments) > 5000:
        raise ValueError("comments must be a list of at most 5000 records")
    if any(not isinstance(row, dict) or len(str(row.get("body", ""))) > 100000 for row in comments):
        raise ValueError("invalid comment record")
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    capture = dict(capture, received_at=now())
    with (out_dir / "captures.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(capture, ensure_ascii=False) + "\n")


def _xlsx(path, sheets):
    """Small interoperable XLSX writer: no third-party runtime dependency."""
    def column_name(column):
        col = ""
        while column:
            column, digit = divmod(column - 1, 26)
            col = chr(65 + digit) + col
        return col

    def cell(value, column, row):
        col = column_name(column)
        value = escape(str(value if value is not None else ""))
        return '<c r="%s%d" s="%d" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>' % (col, row, 1 if row == 1 else 0, value)

    def sheet_xml(rows):
        body = []
        for index, values in enumerate(rows, 1):
            body.append('<row r="%d">%s</row>' % (index, "".join(cell(v, c, index) for c, v in enumerate(values, 1))))
        last = column_name(max((len(x) for x in rows), default=1))
        return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                '<dimension ref="A1:%s%d"/>' % (last, len(rows)) +
                '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
                '<sheetData>%s</sheetData><autoFilter ref="A1:%s%d"/></worksheet>' % ("".join(body), last, len(rows)))

    names = list(sheets)
    workbook = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>%s</sheets></workbook>' %
                "".join('<sheet name="%s" sheetId="%d" r:id="rId%d"/>' % (escape(name), i, i)
                        for i, name in enumerate(names, 1)))
    with zipfile.ZipFile(str(path), "w", zipfile.ZIP_DEFLATED) as book:
        book.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
            "".join('<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' % i for i in range(1, len(names)+1)) + '</Types>')
        book.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        book.writestr("xl/workbook.xml", workbook)
        book.writestr("xl/styles.xml", '<?xml version="1.0" encoding="UTF-8"?>'
            '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<fonts count="2"><font/><font><b/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
            '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
            '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
            '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/></cellXfs>'
            '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')
        book.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            "".join('<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet%d.xml"/>' % (i, i) for i in range(1, len(names)+1)) +
            '<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' % (len(names)+1))
        for i, rows in enumerate(sheets.values(), 1):
            book.writestr("xl/worksheets/sheet%d.xml" % i, sheet_xml(rows))


def build_outputs(out_dir, asin="", query=""):
    out_dir = Path(out_dir)
    source = out_dir / "captures.jsonl"
    if not source.exists():
        raise FileNotFoundError(source)
    events = [json.loads(line) for line in source.read_text(encoding="utf-8").splitlines() if line.strip()]
    rows, seen, audits = [], set(), {}
    raw_count = duplicate_count = 0
    for event in events:
        post_id = str(event.get("post_id") or event["post_url"])
        current_ids = {str(item.get("comment_id")) for item in event["comments"] if item.get("comment_id")}
        unknown_parent = sum(bool(item.get("parent_comment_id")) and str(item["parent_comment_id"]) not in current_ids and
                             str(item["parent_comment_id"]) not in seen for item in event["comments"])
        missing_ids = sum(not bool(item.get("comment_id")) for item in event["comments"])
        for item in event["comments"]:
            raw_count += 1
            cid = str(item.get("comment_id") or "").strip()
            if cid and cid in seen:
                duplicate_count += 1
                continue
            if cid:
                seen.add(cid)
            row = dict(record_type="comment", platform="facebook", asin=asin, query=query,
                post_id=post_id, post_url=event["post_url"], post_title=event.get("post_title", ""),
                comment_id=cid, parent_comment_id=item.get("parent_comment_id") or "post:" + post_id,
                depth=item.get("depth", 0), author=item.get("author", ""), body=item.get("body", ""),
                created_at=item.get("created_at", ""), reaction_count=item.get("reaction_count", ""),
                comment_url=item.get("comment_url", ""), collected_at=event["received_at"],
                dedup_uncertain=not bool(cid))
            rows.append(row)
        displayed = event.get("displayed_count")
        remaining = int(event.get("remaining_controls") or 0)
        captured = len(event["comments"])
        status = "PASS" if displayed is not None and int(displayed) <= captured and not remaining and not unknown_parent and not missing_ids else "PARTIAL"
        audits[post_id] = dict(post_id=post_id, post_url=event["post_url"], displayed_count=displayed,
            visible_loaded_count=event.get("expanded_visible_count", captured), captured_count=captured,
            remaining_controls=remaining, unknown_parent_count=unknown_parent,
            missing_id_count=missing_ids, status=status,
            reason="" if status == "PASS" else "count_or_lineage_not_fully_verified")
    with (out_dir / "raw_comments.jsonl").open("w", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
    with (out_dir / "raw_comments.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    audit = list(audits.values())
    manifest = dict(schema_version="facebook_voc_raw_v1", asin=asin, query=query,
        raw_captured_count=raw_count, technical_duplicate_count=duplicate_count,
        final_collected_count=len(rows), post_audit=audit,
        stop_reason="awaiting_more_visible_content" if any(x["status"] != "PASS" for x in audit) else "captured_visible_posts",
        generated_at=now())
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "checkpoint.json").write_text(json.dumps({"captured_post_ids": list(audits), "seen_comment_ids": sorted(seen)}, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "query_plan.json").write_text(json.dumps({"asin": asin, "query": query, "generation_source": "user_input"}, ensure_ascii=False, indent=2), encoding="utf-8")
    sheets = {
        "Raw_Comments": [FIELDS] + [[row.get(field, "") for field in FIELDS] for row in rows],
        "Query_Plan": [["asin", "query", "generation_source"], [asin, query, "user_input"]],
        "Post_Audit": [["post_id", "post_url", "displayed_count", "visible_loaded_count", "captured_count", "remaining_controls", "unknown_parent_count", "missing_id_count", "status", "reason"]] +
                      [[item.get(key, "") for key in ("post_id", "post_url", "displayed_count", "visible_loaded_count", "captured_count", "remaining_controls", "unknown_parent_count", "missing_id_count", "status", "reason")] for item in audit],
        "Run_Summary": [["metric", "value"]] + [[key, manifest[key]] for key in ("raw_captured_count", "technical_duplicate_count", "final_collected_count", "stop_reason")],
        "Quality_Gate": [["check", "result"], ["post_audit", "PASS" if all(x["status"] == "PASS" for x in audit) else "PARTIAL"],
                         ["missing_comment_ids", sum(not bool(x["comment_id"]) for x in rows)]],
    }
    _xlsx(out_dir / "raw_comments.xlsx", sheets)
    return manifest


def serve(out_dir, asin, query, port):
    token = secrets.token_urlsafe(24)
    class Handler(BaseHTTPRequestHandler):
        def _extension_origin(self):
            return re.fullmatch(r"chrome-extension://[a-p]{32}", self.headers.get("Origin", ""))

        def do_OPTIONS(self):
            self._send(204, {})

        def do_GET(self):
            if self.path != "/session" or not self._extension_origin():
                return self._send(403, {"error": "invalid_session_origin"})
            self._send(200, {"token": token})

        def do_POST(self):
            if self.path != "/capture" or self.headers.get("Authorization") != "Bearer " + token:
                return self._send(403, {"error": "invalid_session"})
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if size <= 0 or size > 5_000_000:
                    raise ValueError("invalid request size")
                capture = json.loads(self.rfile.read(size))
                ingest_capture(out_dir, capture)
                result = build_outputs(out_dir, asin, query)
                self._send(200, {"final_collected_count": result["final_collected_count"]})
            except (ValueError, json.JSONDecodeError) as exc:
                self._send(400, {"error": str(exc)})

        def _send(self, status, data):
            origin = self.headers.get("Origin", "")
            body = json.dumps(data).encode("utf-8")
            self.send_response(status)
            if self._extension_origin():
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    print("PAIR_TOKEN=" + token, flush=True)
    print("BRIDGE=http://127.0.0.1:%d/capture" % port, flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("serve", "finalize"):
        p = sub.add_parser(name)
        p.add_argument("--out-dir", type=Path, default=Path.cwd() / "outputs" / "facebook")
        p.add_argument("--asin", default="")
        p.add_argument("--query", default="")
        if name == "serve":
            p.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()
    if args.command == "serve":
        serve(args.out_dir, args.asin, args.query, args.port)
    else:
        print(json.dumps(build_outputs(args.out_dir, args.asin, args.query), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
