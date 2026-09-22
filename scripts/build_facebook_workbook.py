#!/usr/bin/env python3
"""Build the Facebook VOC workbook from collector outputs."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ILLEGAL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
SHEETS = (
    "Raw_Comments", "Trusted_Comments", "Partial_Candidates", "Conversation_Map",
    "Query_Performance", "Post_Audit", "Run_Summary", "Quality_Gate",
)


def read_json(path: Path, default):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def read_jsonl(path: Path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def clean(value):
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return ILLEGAL.sub("", str("" if value is None else value))


def add_sheet(workbook, name, rows):
    from openpyxl.styles import Alignment, Font

    sheet = workbook.create_sheet(name)
    rows = list(rows or [])
    fields = list(dict.fromkeys(key for row in rows for key in row)) or ["status"]
    sheet.append(fields)
    for row in rows:
        sheet.append([clean(row.get(field)) for field in fields])
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    for cell in sheet[1]:
        cell.font = Font(bold=True)
    for column in sheet.columns:
        width = min(60, max(12, max(len(str(cell.value or "")) for cell in column) + 2))
        sheet.column_dimensions[column[0].column_letter].width = width
        for cell in column:
            cell.alignment = Alignment(vertical="top", wrap_text=True)


def flatten_conversation_map(value):
    rows = []
    for product in value.get("products", []):
        for field in ("brand", "title", "category"):
            if product.get(field):
                rows.append({"asin": product.get("asin"), "layer": "product", "group": field, "value": product[field]})
    for layer, values in value.get("layers", {}).items():
        for item in values if isinstance(values, list) else [values]:
            rows.append({"asin": "|".join(value.get("asins", [])), "layer": layer, "group": "term", "value": item})
    seller = value.get("sellersprite", {})
    rows.append({"asin": "|".join(value.get("asins", [])), "layer": "sellersprite", "group": "status",
                 "value": seller.get("status", "unknown"), "degraded_reason": seller.get("degraded_reason", "")})
    return rows


def quality_rows(raw, trusted, partial, page_map, manifest):
    stable_ids = [row.get("comment_id") for row in raw if row.get("comment_id")]
    reply_rows = [row for row in raw if int(row.get("depth") or 0) > 0]
    orphan_rows = [row for row in reply_rows if not row.get("parent_comment_id")]
    checks = {
        "raw_manifest_count_matches": len(raw) == manifest.get("final_collected_count"),
        "stable_ids_unique": len(stable_ids) == len(set(stable_ids)),
        "trusted_subset_of_raw": all(row.get("record_id") in {item.get("record_id") for item in raw} for row in trusted),
        "partial_subset_of_raw": all(row.get("record_id") in {item.get("record_id") for item in raw} for row in partial),
        "reply_parent_present": not orphan_rows,
        "post_audits_present": len(page_map) >= len({row.get("post_id") for row in raw}),
    }
    return [{"check": key, "status": "PASS" if value else "FAIL", "value": value} for key, value in checks.items()]


def build(out_dir: Path):
    from openpyxl import Workbook

    raw = read_jsonl(out_dir / "raw_comments.jsonl")
    trusted = read_jsonl(out_dir / "trusted_comments.jsonl")
    partial = read_jsonl(out_dir / "partial_candidates.jsonl")
    conversation = read_json(out_dir / "conversation_map.json", {})
    plan = read_json(out_dir / "query_plan.json", {"queries": []})
    page_map = read_json(out_dir / "page_map.json", [])
    manifest = read_json(out_dir / "manifest.json", {})

    workbook = Workbook()
    workbook.remove(workbook.active)
    add_sheet(workbook, "Raw_Comments", raw)
    add_sheet(workbook, "Trusted_Comments", trusted)
    add_sheet(workbook, "Partial_Candidates", partial)
    add_sheet(workbook, "Conversation_Map", flatten_conversation_map(conversation))
    add_sheet(workbook, "Query_Performance", plan.get("queries", []))
    add_sheet(workbook, "Post_Audit", page_map)
    add_sheet(workbook, "Run_Summary", [{"metric": key, "value": value} for key, value in manifest.items()])
    add_sheet(workbook, "Quality_Gate", quality_rows(raw, trusted, partial, page_map, manifest))
    output = out_dir / "facebook_voc.xlsx"
    workbook.save(output)
    return {"status": "written", "output": str(output.resolve()), "sheets": list(SHEETS),
            "raw": len(raw), "trusted": len(trusted), "partial": len(partial)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.out_dir.resolve()), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
