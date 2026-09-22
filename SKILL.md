---
name: facebook-voc-collector
description: Automatically discover and collect public Facebook Page post, video, and Reel comments and visible replies for Amazon ASINs through a dedicated Chrome CDP profile, with iterative semantic queries, evidence audits, checkpoint resume, technical deduplication, and JSONL/CSV/Excel outputs. Use for Facebook VOC acquisition without a Meta API.
---

# Facebook VOC Collector

Turn Amazon ASIN semantics into automated Facebook conversation discovery. The formal workflow is the independent Playwright CLI; the unpacked extension is a debugging aid only and must not be required for collection.

## Commands

```powershell
node scripts/facebook_playwright_collector.cjs preflight --asin B003ULL1NQ --session-mode cdp --headless 0
node scripts/facebook_playwright_collector.cjs collect --asin B003ULL1NQ --target-comments 300 --target-posts 30 --max-comments-per-post 100 --max-discovery-rounds 5 --session-mode cdp --headless 0
```

Use `--asins` or `--asin-file` for batches. Resume with `--resume [CHECKPOINT]`; add `--retry-partial` or `--force-reaudit-partial` to revisit incomplete posts. Add `--complete-query-plan` when a resumed run must finish pending earlier-round queries and every query through `--max-discovery-rounds` even after the comment or post budget is reached. Run `--help` for all common flags. Read [collection-guide.md](references/collection-guide.md) before a live run and [raw-record-schema.md](references/raw-record-schema.md) when consuming outputs.

## Required workflow

1. Run offline tests, CLI help, syntax checks, and Skill validation before browser access.
2. Use `scripts/start_facebook_cdp.ps1` to connect to or start the dedicated visible Facebook Chrome profile. Manual login is environment preparation only; collection never depends on the extension, manual expansion, or per-post clicks.
3. Resolve Amazon product evidence and visible SellerSprite terms. Record a degraded reason when SellerSprite is absent; never invent terms.
4. Create the seven query families in `conversation_map.json` and `query_plan.json`. Round 1 uses Amazon evidence. Later rounds use only observed Facebook post/comment language and retain `generation_source`, `source_terms`, `evidence_comment_ids`, and `discovery_round`.
5. Discover and score public Page posts, videos, and Reels independently. A generic single-word match is insufficient. Enter qualified posts, wait for and scroll to the comment surface, select all-comments sorting when visible, expand visible comment/reply controls, checkpoint every action, and close only collector-owned pages.
6. Preserve all successfully read comments from qualified posts. Deduplicate only stable comment IDs. Keep no-ID rows with `dedup_uncertain=true`. Semantic tiers annotate records and never delete raw rows.
7. Route PASS-post rows to `Trusted_Comments`, PARTIAL-post rows to `Partial_Candidates`, and no BLOCKED rows to either subset. All readable rows remain in `Raw_Comments`.

## Lineage and audits

Prefer `reply_comment_id` as the reply ID and the same link's `comment_id` as its direct parent. Also support sibling parent/reply containers. Recompute real depth, flag orphan replies, and write `audit.json`, `comment_tree.json`, `frontier.json`, and `action_ledger.json` for each post.

- `PASS`: frontier closed, two stable reads, known total (or an explicit visible zero-comment message), no orphan replies, and verified reply/parent IDs and depth.
- `PARTIAL`: controls remain, total is unknown, a budget/timeout was reached, or lineage is incomplete.
- `BLOCKED`: login/CAPTCHA, 403/429, visible access restriction, unavailable content, or unloaded comment tree.

Stop on target, post or round budget, two low-yield rounds, two high-duplicate rounds, semantic saturation, visible access restriction, or user stop. Persist checkpoint before stopping.

## Outputs

Default directory: `outputs/facebook-comments/`. Required files are raw/trusted/partial JSONL, raw CSV, conversation/query/page maps, manifest, checkpoint, per-post evidence, and `facebook_voc.xlsx` with `Raw_Comments`, `Trusted_Comments`, `Partial_Candidates`, `Conversation_Map`, `Query_Performance`, `Post_Audit`, `Run_Summary`, and `Quality_Gate`.

## Access boundary

Read only content visibly available in the dedicated profile. Do not export credentials, cookies, tokens, or profile files; do not automate login/CAPTCHA or bypass private, membership, age, region, or rate restrictions. Stop and preserve checkpoint on explicit restriction.
