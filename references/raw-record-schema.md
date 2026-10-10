# Raw record and evidence schema

## Comment row

Every delivered row represents a comment, never a standalone post.

| Field | Meaning |
|---|---|
| `schema_version` | `facebook_comment_v3` |
| `platform` | `facebook` |
| `source_specific_record_type`, `record_kind` | `comment` or raw-evidence-only `ui_artifact` |
| `asin`, `matched_asins` | ASIN lineage |
| `matched_queries` | Discovery query lineage |
| `post_id`, `post_url`, `post_title` | Stable post provenance |
| `post_semantic_tier` | Post-level relevance tier |
| `semantic_tier`, `semantic_score` | Comment annotation; never a raw-row filter |
| `comment_id` | Stable top-level or reply ID when available |
| `reply_comment_id` | Stable reply ID for reply rows; empty for top-level rows |
| `parent_comment_id` | `post:POST_ID` for top level; direct parent comment ID for replies |
| `depth` | `0` top level; direct lineage depth for replies |
| `author`, `raw_body`, `body_clean`, `body`, `created_at`, `reaction_count`, `comment_url` | Raw visible text, cleaned comment body, compatibility body, and source fields |
| `ui_artifact`, `ui_artifact_reason` | Whole-record time/UI classification and reason |
| `dedup_uncertain` | `true` only when no stable comment ID exists |
| `post_audit_status` | `PASS`, `PARTIAL`, or `BLOCKED` |
| `evidence_path`, `collected_at` | Audit path and collection time |

For links containing both parameters, `reply_comment_id` is the row's `comment_id` and `comment_id` is its direct `parent_comment_id`. Sibling reply containers use the nearest verified thread wrapper fallback. Orphans force PARTIAL.

## Technical deduplication

Only equal non-empty stable `comment_id` values merge for real comments. Merged rows union ASIN/query lineage. Text similarity, author similarity, and semantic labels never merge or remove real rows. No-ID real comments remain separate and receive a deterministic `record_id` plus `dedup_uncertain=true`. UI artifacts use a separate DOM-evidence key, have `dedup_uncertain=false`, and never masquerade as trustworthy no-ID comments.

## Query provenance

Each `query_plan.json` query contains `query_id`, `family`, `query`, `discovery_round`, `generation_source`, `source_terms`, `evidence_comment_ids`, execution status, discovered/qualified post counts, and completion time. Round 1 has no comment evidence; later rounds require observed Facebook language.

## Per-post evidence

`evidence/POST_ID/` contains:

- `audit.json`: status, issues, counts, semantic decision, duplicates, orphans, and platform count.
- `comment_tree.json`: stable node IDs, direct parents, depths, and uncertain-ID flags.
- `frontier.json`: remaining controls, stability count, action count, timeout, and closure state.
- `action_ledger.json`: ordered visible expansion actions with labels and before-counts.

## Workbook routing

`Raw_Comments` contains all technically unique rows from qualified posts, including retained UI evidence. Only non-artifact PASS rows appear in `Trusted_Comments`; only non-artifact PARTIAL rows appear in `Partial_Candidates`; BLOCKED rows appear only in raw data if successfully read before the block. `Quality_Gate` verifies JSONL/CSV/manifest/page/evidence counts, stable-ID uniqueness, subset routing, reply parents, and that Trusted contains no pure-time/UI text.
