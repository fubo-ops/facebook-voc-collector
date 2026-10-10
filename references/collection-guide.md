# Automated collection guide

## Entrypoints

```powershell
node scripts/facebook_playwright_collector.cjs --help
node scripts/facebook_playwright_collector.cjs preflight --asin ASIN --session-mode cdp --headless 0
node scripts/facebook_playwright_collector.cjs collect --asin ASIN --target-comments 300 --target-posts 30 --max-comments-per-post 0 --max-discovery-rounds 5 --session-mode cdp --headless 0
node scripts/facebook_playwright_collector.cjs collect --asins ASIN1,ASIN2 --resume --retry-partial
node scripts/facebook_playwright_collector.cjs collect --asin-file .\asins.csv --resume .\outputs\facebook-comments\checkpoint.json --force-reaudit-partial
```

The CLI checks `http://127.0.0.1:9222`. If unavailable, `start_facebook_cdp.ps1` starts visible Chrome with `%USERPROFILE%\.codex\browser-profiles\facebook-cdp`. The profile is dedicated to this collector. A first manual login may be performed before collection; normal collection is automatic.

When `--out-dir` is omitted, outputs go to `%FACEBOOK_COLLECTION_ROOT%\ASIN\`; without that environment variable, the fallback is `Facebook评论采集\ASIN\`. The workbook is named `ASIN_Facebook评论.xlsx`.

## Discovery

Amazon supplies brand, title, product type, category, bullets/functions, materials, target audience, scenarios, problem language, purchase intent, alternatives, and visible comparison products. Visible SellerSprite DOM supplies optional keyword evidence. Absence is written as `sellersprite.status=degraded` with `degraded_reason`.

Round 1 creates exactly seven query families: `product_entity`, `category_solution`, `problem_symptom`, `usage_context`, `decision_intent`, `competitor`, and `natural_language_question`. Each query is composed from its own product evidence rather than a shared forced prefix. Later rounds derive terms only from already discovered Facebook post text and real captured comments; pure time/UI artifacts are excluded. Each query retains provenance fields and per-query discovery/qualification counts.

Posts qualify only when multiple semantic groups match, multiple entity terms match, or the aggregate threshold is reached. A single generic hit cannot qualify a post. The post gets one of four labels: `direct_product`, `competitive_context`, `unmet_need`, or `context_only`.

For low-yield products, `--qualification-mode expanded` additionally accepts a post only when its visible text contains an exact multi-token product entity or a distinctive brand token of at least five characters. Generic single-token hits remain rejected. Use `--discovery-scrolls` and `--max-posts-per-query` to widen visible search depth without changing comment-tree audit rules.

The formal workflow does not prepend a fixed anchor to every search. Relevance is enforced after discovery with multiple independent product signals, so a post containing only `dog`, `bowl`, `food`, or `lick` does not pass.

## Frontier automation

For every qualified post the collector:

1. Opens a collector-owned page and checks visible access state.
2. Waits for the asynchronous comment surface, scrolls to it, opens the comment panel when necessary, and selects `All comments` when that option is visible.
3. Executes `scripts/facebook_visible_capture.js` in Playwright's isolated world; no extension code or UI is involved.
4. Reads stable comment/reply links and expands one visible current/previous comment or reply control per action.
5. Waits for two matching DOM snapshots, reads again, and saves `checkpoint.json` after every action.
6. Closes the frontier only after two reads with no new stable `comment_id` and no remaining controls; otherwise marks the post PARTIAL or BLOCKED.

Zero comments are trusted only when Facebook visibly says there are no comments or invites the viewer to be first. A missing count stays `unknown_total`. Reply parents are backfilled only from a real Facebook ID exposed by the visible DOM; author hints or DOM labels never become fabricated IDs.

The collector never closes pre-existing browser pages. `--max-comments-per-post 0` disables the per-post quantity ceiling; expansion continues until the visible frontier closes. `--max-expand-actions` and `--post-timeout-seconds` remain operational safeguards and any hit is recorded as PARTIAL.

## Resume and re-audit

`--resume` uses the output directory checkpoint; `--resume FILE` uses an explicit file. PASS posts and completed queries are skipped. `--retry-partial` reopens checkpoint PARTIAL posts. `--force-reaudit-partial` removes their prior audit from the current queue while retaining captured rows and evidence history.

## Stop rules

Collection stops with a checkpoint on `target_comments_reached`, `target_posts_reached`, `max_discovery_rounds_reached`, `two_no_high_relevance_rounds`, `two_low_yield_rounds`, `two_high_duplicate_rounds`, `semantic_coverage_saturated`, or `access_restriction:*`. The target is checked between posts, never as a reason to truncate an open relevant frontier. Closing the terminal is a user stop; the last completed browser action has already been checkpointed.

## Offline validation

```powershell
node --check scripts/facebook_playwright_collector.cjs
node --test tests/test_facebook_core.cjs tests/test_popup.cjs
python -m unittest discover -s tests -v
python "$env:USERPROFILE\.codex\skills\.system\skill-creator\scripts\quick_validate.py" .
```

Use the Codex bundled Node/Python runtimes when system installations lack Playwright or openpyxl.
