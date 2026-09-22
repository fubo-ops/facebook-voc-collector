# Raw record and evidence schema

## Comment row

Every delivered row represents a comment, never a standalone post.

| Field | Meaning |
|---|---|
| `schema_version` | `facebook_comment_v2` |
| `platform` | `facebook` |
| `source_specific_record_type` | `comment` |
| `asin`, `matched_asins` | ASIN lineage |
| `matched_queries` | Discovery query lineage |
| `post_id`, `post_url`, `post_title` | Stable post provenance |
| `post_semantic_tier` | Post-level relevance tier |
| `semantic_tier`, `semantic_score` | Comment annotation; never a raw-row filter |
| `comment_id` | Stable top-level or reply ID when available |
| `reply_comment_id` | Stable reply ID for reply rows; empty for top-level rows |
| `parent_comment_id` | `post:POST_ID` for top level; direct parent comment ID for replies |
| `depth` | `0` top level; direct lineage depth for replies |
| `author`, `body`, `created_at`, `reaction_count`, `comment_url` | Visible source fields |
| `dedup_uncertain` | `true` only when no stable comment ID exists |
| `post_audit_status` | `PASS`, `PARTIAL`, or `BLOCKED` |
| `evidence_path`, `collected_at` | Audit path and collection time |

For links containing both parameters, `reply_comment_id` is the row's `comment_id` and `comment_id` is its direct `parent_comment_id`. Sibling reply containers use the nearest verified thread wrapper fallback. Orphans force PARTIAL.

## Technical deduplication

Only equal non-empty stable `comment_id` values merge. Merged rows union ASIN/query lineage. Text similarity, author similarity, and semantic labels never merge or remove rows. No-ID reads remain separate and receive a deterministic `record_id` plus `dedup_uncertain=true`.

## Query provenance

Each `query_plan.json` query contains `query_id`, `family`, `query`, `discovery_round`, `generation_source`, `source_terms`, `evidence_comment_ids`, execution status, discovered/qualified post counts, and completion time. Round 1 has no comment evidence; later rounds require observed Facebook language.

## Per-post evidence

`evidence/POST_ID/` contains:

- `audit.json`: status, issues, counts, semantic decision, duplicates, orphans, and platform count.
- `comment_tree.json`: stable node IDs, direct parents, depths, and uncertain-ID flags.
- `frontier.json`: remaining controls, stability count, action count, timeout, and closure state.
- `action_ledger.json`: ordered visible expansion actions with labels and before-counts.

## Workbook routing

`Raw_Comments` contains all technically unique rows from qualified posts. PASS rows also appear in `Trusted_Comments`; PARTIAL rows also appear in `Partial_Candidates`; BLOCKED rows appear only in raw data if they were successfully read before the block. `Quality_Gate` verifies row counts, stable-ID uniqueness, subset routing, reply parents, and post audits.
