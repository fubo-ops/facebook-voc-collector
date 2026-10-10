#!/usr/bin/env python3
"""Build the Facebook VOC workbook from collector outputs."""
from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path

ILLEGAL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
RELATIVE_TIME_ONLY = re.compile(
    r"^(?:\d+\s*(?:周|天|小时|分钟|月|年)|刚刚|昨天|"
    r"\d+\s*(?:w|wk|wks|week|weeks|d|day|days|h|hr|hrs|hour|hours|min|mins|minute|minutes))$",
    re.IGNORECASE,
)
UI_ARTIFACT_ONLY = re.compile(
    r"^(?:查看翻译|写评论(?:…|\.\.\.)?|写回复(?:…|\.\.\.)?|作者留下了心情|在线状态指示标|赞|点赞|回复|分享|关注|最相关|所有评论|"
    r"see translation|write a comment(?:…|\.\.\.)?|write a reply(?:…|\.\.\.)?|"
    r"author (?:left a reaction|reacted)|active status indicator|like|reply|share|follow|most relevant|all comments)$",
    re.IGNORECASE,
)
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


def is_ui_artifact_text(value):
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return bool(text and (RELATIVE_TIME_ONLY.fullmatch(text) or UI_ARTIFACT_ONLY.fullmatch(text)))


def quality_rows(raw, trusted, partial, page_map, manifest, out_dir=None):
    stable_ids = [row.get("comment_id") for row in raw if row.get("comment_id")]
    reply_rows = [row for row in raw if not row.get("ui_artifact") and int(row.get("depth") or 0) > 0]
    orphan_rows = [row for row in reply_rows if not row.get("parent_comment_id")]
    csv_count = None
    if out_dir and (out_dir / "raw_comments.csv").exists():
        with (out_dir / "raw_comments.csv").open(encoding="utf-8-sig", newline="") as handle:
            csv_count = sum(1 for _ in csv.DictReader(handle))
    evidence_ok = True
    if out_dir:
        expected_files = ("audit.json", "comment_tree.json", "frontier.json", "action_ledger.json")
        evidence_ok = all(all((out_dir / "evidence" / str(item.get("post_id")) / name).exists()
                              for name in expected_files) for item in page_map)
    checks = {
        "raw_manifest_count_matches": len(raw) == manifest.get("final_collected_count"),
        "raw_csv_count_matches": csv_count is None or csv_count == len(raw),
        "stable_ids_unique": len(stable_ids) == len(set(stable_ids)),
        "trusted_subset_of_raw": all(row.get("record_id") in {item.get("record_id") for item in raw} for row in trusted),
        "partial_subset_of_raw": all(row.get("record_id") in {item.get("record_id") for item in raw} for row in partial),
        "reply_parent_present": not orphan_rows,
        "post_audits_present": len(page_map) >= len({row.get("post_id") for row in raw}),
        "page_map_manifest_count_matches": len(page_map) == manifest.get("post_count", len(page_map)),
        "evidence_bundles_complete": evidence_ok,
        "ui_artifact_manifest_count_matches": sum(bool(row.get("ui_artifact")) for row in raw) == manifest.get("ui_artifact_count", 0),
        "trusted_manifest_count_matches": len(trusted) == manifest.get("trusted_comment_count", manifest.get("trusted_count")),
        "reply_manifest_count_matches": len(reply_rows) == manifest.get("reply_count", len(reply_rows)),
        "trusted_has_no_ui_artifacts": all(not row.get("ui_artifact") and row.get("record_kind") != "ui_artifact" for row in trusted),
        "trusted_has_no_ui_only_text": all(not is_ui_artifact_text(row.get("body_clean", row.get("body"))) for row in trusted),
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
    add_sheet(workbook, "Quality_Gate", quality_rows(raw, trusted, partial, page_map, manifest, out_dir))
    asins = manifest.get("asins") or conversation.get("asins") or ["UNKNOWN_ASIN"]
    output = out_dir / f"{'_'.join(str(value) for value in asins)}_Facebook评论.xlsx"
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
