#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const {spawnSync} = require("child_process");
const core = require("./facebook_voc_core.cjs");
const pageCapture = require("./facebook_visible_capture.js");

const VERSION = "2.0.0";

function help() {
  console.log(`Facebook VOC automated collector
Usage:
  node scripts/facebook_playwright_collector.cjs preflight --asin ASIN [options]
  node scripts/facebook_playwright_collector.cjs collect --asin ASIN [options]

Inputs:
  --asin ASIN | --asins ASIN1,ASIN2 | --asin-file FILE
  --target-comments 300 --target-posts 30 --max-comments-per-post 100
  --max-discovery-rounds 5 --max-posts-per-query 10
  --comment-load-wait-ms 4000 --post-timeout-seconds 180
  --resume [CHECKPOINT] --retry-partial --force-reaudit-partial --complete-query-plan

Browser:
  --session-mode cdp --cdp-url http://127.0.0.1:9222 --headless 0
  Uses a dedicated visible Chrome profile. Login/CAPTCHA is never automated.

Output:
  --out-dir outputs/facebook-comments
  JSONL, CSV, maps, manifest, checkpoint, per-post evidence, and facebook_voc.xlsx`);
}

function playwright() {
  try { return require("playwright"); } catch {}
  const bundled = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules", "playwright");
  if (fs.existsSync(bundled)) return require(bundled);
  throw new Error("Playwright is required. Set NODE_PATH to the Codex bundled node_modules or install playwright.");
}

function probeCdp(cdpUrl, timeoutMs = 2500) {
  return new Promise(resolve => {
    let target;
    try { target = new URL("/json/version", cdpUrl); }
    catch (error) { resolve({status: "cdp_not_listening", reason: `invalid_cdp_url:${error.message}`}); return; }
    const request = http.get(target, {timeout: timeoutMs}, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => body += chunk);
      response.on("end", () => {
        try {
          const value = JSON.parse(body);
          resolve(response.statusCode === 200 && value.webSocketDebuggerUrl
            ? {status: "ready", browser: value.Browser, cdp_url: cdpUrl}
            : {status: "cdp_not_listening", reason: `cdp_http_${response.statusCode}`});
        } catch { resolve({status: "cdp_not_listening", reason: "invalid_cdp_response"}); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", error => resolve({status: "cdp_not_listening", reason: error.code || error.message}));
  });
}

function runCdpStarter(options) {
  const port = Number(new URL(options.cdpUrl).port || 9222);
  const script = path.join(__dirname, "start_facebook_cdp.ps1");
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Port", String(port)];
  if (options.profileDir) args.push("-ProfileDir", path.resolve(options.profileDir));
  const result = spawnSync("powershell.exe", args, {encoding: "utf8", windowsHide: true});
  const lines = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  try { return {...JSON.parse(lines.at(-1) || "{}"), exit_code: result.status}; }
  catch { return {status: "start_failed", reason: String(result.stderr || result.stdout || "no starter output"), exit_code: result.status}; }
}

async function ensureCdp(options) {
  if (options.sessionMode !== "cdp") throw new Error("Formal CLI supports --session-mode cdp only.");
  let result = await probeCdp(options.cdpUrl);
  if (result.status === "ready") return result;
  const starter = runCdpStarter(options);
  if (starter.status !== "ready") return {status: starter.status, reason: starter.reason || starter.action || "cdp_start_failed", starter};
  result = await probeCdp(options.cdpUrl);
  return result.status === "ready" ? {...result, starter} : {...result, starter};
}

async function connect(options) {
  const browser = await playwright().chromium.connectOverCDP(options.cdpUrl);
  const context = browser.contexts()[0];
  if (!context) throw new Error("CDP exposed no browser context.");
  return {browser, context};
}

async function bodyState(page) {
  const body = await page.locator("body").innerText({timeout: 15000}).catch(() => "");
  return {...core.classifyAccess(body, page.url()), body, title: await page.title().catch(() => ""), url: page.url()};
}

async function goto(page, url, timeout = 60000) {
  let status = 0;
  try {
    const response = await page.goto(url, {waitUntil: "domcontentloaded", timeout});
    status = response?.status() || 0;
  } catch (error) {
    if (!/Timeout/i.test(error.name + error.message)) throw error;
  }
  await page.waitForTimeout(1500);
  const state = await bodyState(page);
  return {...state, ...core.classifyAccess(state.body, page.url(), status), http_status: status};
}

async function amazonProduct(page, asin) {
  const url = `https://www.amazon.com/dp/${asin}`;
  const state = await goto(page, url);
  if (state.status !== "READY") return {asin, url, title: asin, access_status: state.status, degraded_reason: state.reason};
  const value = await page.evaluate(() => {
    const text = selector => document.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() || "";
    const texts = selector => [...document.querySelectorAll(selector)].map(node => node.textContent.replace(/\s+/g, " ").trim()).filter(Boolean);
    const seller = [];
    for (const node of document.querySelectorAll("[data-sellersprite], [class*='seller-sprite' i], [id*='sellersprite' i]")) {
      const value = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (value) seller.push(value);
    }
    const competitors = texts("#comparison_table .a-size-base, [data-csa-c-content-id*='comparison'] .a-size-base").slice(0, 12);
    return {
      title: text("#productTitle") || document.title,
      brand: text("#bylineInfo").replace(/^Brand:\s*/i, "").replace(/^Visit the\s+/i, "").replace(/\s+Store$/i, ""),
      category: texts("#wayfinding-breadcrumbs_feature_div a").at(-1) || "",
      features: texts("#feature-bullets li span.a-list-item").slice(0, 12),
      seller_terms: seller.slice(0, 30), competitors
    };
  });
  return {asin, url, access_status: "READY", ...value};
}

async function productContext(context, asins, owned) {
  const page = await context.newPage(); owned.add(page);
  const products = [];
  try { for (const asin of asins) products.push(await amazonProduct(page, asin)); }
  finally { await page.close().catch(() => {}); owned.delete(page); }
  const terms = core.clean(products.flatMap(product => product.seller_terms || []));
  const sellerSprite = terms.length
    ? {status: "available", visible_keywords: terms}
    : {status: "degraded", visible_keywords: [], degraded_reason: "no_visible_sellersprite_keywords"};
  return {products, sellerSprite};
}

async function discoverPosts(page, query, options, conversationMap) {
  const candidates = [];
  let lastReason = null, readySearches = 0;
  const searchUrls = [
    `https://www.facebook.com/search/posts/?q=${encodeURIComponent(query.query)}`,
    `https://www.facebook.com/watch/search/?q=${encodeURIComponent(query.query)}`
  ];
  for (const url of searchUrls) {
    const state = await goto(page, url);
    if (state.status !== "READY") {
      lastReason = state.reason;
      if (!["search_unavailable", "login_required"].includes(state.reason)) return {status: "BLOCKED", reason: state.reason, posts: []};
      continue;
    }
    readySearches++;
    for (let index = 0; index < 3; index++) {
      await page.evaluate(() => window.scrollBy(0, Math.max(900, innerHeight * 0.9)));
      await page.waitForTimeout(900);
    }
    candidates.push(...await page.evaluate(() => {
    const output = [];
    for (const anchor of document.querySelectorAll("a[href]")) {
      let url;
      try { url = new URL(anchor.href, location.href); } catch { continue; }
      if (!/(^|\.)facebook\.com$/.test(url.hostname)) continue;
      if (!(/\/(?:posts|permalink|videos|reels?)\//.test(url.pathname) || (url.pathname === "/watch/" && url.searchParams.get("v")) || url.searchParams.get("story_fbid"))) continue;
      let container = anchor.closest("[role='article']") || anchor.parentElement;
      for (let level = 0; container && level < 3; level++, container = container.parentElement) {
        const text = (container.innerText || "").replace(/\s+/g, " ").trim();
        if (text.length >= 40) break;
      }
      output.push({url: url.href, text: (container?.innerText || anchor.innerText || "").replace(/\s+/g, " ").trim().slice(0, 4000)});
    }
    return output;
    }));
  }
  if (!readySearches) return {status: "BLOCKED", reason: lastReason || "search_unavailable", posts: []};
  const posts = [], seen = new Set();
  for (const candidate of candidates) {
    const normalized = core.normalizePostUrl(candidate.url);
    if (!normalized || seen.has(normalized.post_id)) continue;
    seen.add(normalized.post_id);
    const semantic = core.semanticTier(candidate.text, conversationMap);
    posts.push({...normalized, post_text: candidate.text, discovered_by_query_id: query.query_id,
      discovered_by_query: query.query, discovery_round: query.discovery_round, semantic_tier: semantic.tier,
      semantic_score: semantic.score, semantic_hits: semantic.hits, qualified: core.postQualified(semantic)});
    if (posts.length >= Number(options.maxPostsPerQuery || 10)) break;
  }
  return {status: "READY", reason: null, posts};
}

function checkpointPath(options, outDir) {
  if (!options.resume || options.resume === true) return path.join(outDir, "checkpoint.json");
  return path.resolve(options.resume);
}

function freshCheckpoint(asins) {
  return {schema_version: "facebook_checkpoint_v2", collector_version: VERSION, asins, created_at: core.now(),
    updated_at: core.now(), discovery_round: 1, round_history: [], queries: [], page_map: [], discovered_posts: [],
    raw_capture_events: [], final_rows: [], expanded_control_keys: [], collected_comment_ids: [], owned_page_urls: [], stop_reason: null};
}

function loadCheckpoint(options, outDir, asins) {
  const file = checkpointPath(options, outDir);
  if (!options.resume || !fs.existsSync(file)) return freshCheckpoint(asins);
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (core.clean(value.asins).join(",") !== core.clean(asins).join(",")) throw new Error("Resume ASIN set does not match checkpoint");
  return {...freshCheckpoint(asins), ...value, resumed_from: file};
}

function saveCheckpoint(file, checkpoint) {
  checkpoint.updated_at = core.now();
  core.writeJson(file, checkpoint);
}

function evidenceDir(outDir, postId) { return path.join(outDir, "evidence", String(postId).replace(/[^A-Za-z0-9._-]/g, "_")); }

async function capturePage(page) {
  return page.evaluate(pageCapture.extractVisible);
}

async function prepareCommentSurface(page, waitMs = 4000) {
  await page.waitForTimeout(Number(waitMs));
  const actions = [];
  const scrolled = await page.evaluate(() => {
    const visible = node => node && node.offsetParent !== null;
    const nodes = [...document.querySelectorAll('[role="button"], button')].filter(visible);
    const target = nodes.find(node => /(?:\d+\s*comments|\d+\s*条评论|view more comments|查看更多评论|most relevant|最相关)/i.test((node.innerText || node.getAttribute('aria-label') || '').trim()));
    if (target) target.scrollIntoView({block: 'center'}); else window.scrollTo(0, document.body.scrollHeight);
    return Boolean(target);
  });
  if (scrolled) actions.push({type: 'scroll_to_comments'});
  await page.waitForTimeout(750);
  const openedComments = await page.evaluate(() => {
    const text = document.body.innerText || '';
    const nodes = [...document.querySelectorAll('[role="button"], button')].filter(node => node.offsetParent !== null);
    const surfaceVisible = /(?:\d+\s*comments\b|\d+\s*条评论|no comments yet|be the first to comment|暂无评论|成为第一个评论者)/i.test(text) ||
      nodes.some(node => /^(most relevant|最相关|all comments|所有评论)$|view more comments|查看更多评论|查看.*回复/i.test((node.innerText || '').trim())) ||
      Boolean(document.querySelector('[role="article"][aria-label*="Commenter" i], [role="article"][aria-label*="评论者"]'));
    if (surfaceVisible) return '';
    const button = nodes.find(node => /^(comments?|评论)$/i.test((node.innerText || '').trim()));
    if (!button) return '';
    const label = (button.innerText || '').trim(); button.click(); return label;
  });
  if (openedComments) { actions.push({type: 'open_comments', label: openedComments}); await page.waitForTimeout(1500); }
  const openedSort = await page.evaluate(() => {
    const button = [...document.querySelectorAll('[role="button"], button')].find(node => node.offsetParent !== null &&
      /^(most relevant|最相关|newest|最新)$/i.test((node.innerText || '').trim()));
    if (!button) return '';
    const label = (button.innerText || '').trim(); button.click(); return label;
  });
  if (openedSort) {
    actions.push({type: 'open_comment_sort', label: openedSort});
    await page.waitForTimeout(600);
    const selected = await page.evaluate(() => {
      const option = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], [role="button"], button')]
        .find(node => node.offsetParent !== null && /^(all comments|所有评论)$/i.test((node.innerText || '').trim()));
      if (!option) return '';
      const label = (option.innerText || '').trim(); option.click(); return label;
    });
    if (selected) { actions.push({type: 'select_all_comments', label: selected}); await page.waitForTimeout(1200); }
  }
  return actions;
}

async function waitForCaptureStable(page, timeoutMs = 6000) {
  const deadline = Date.now() + Number(timeoutMs), pause = 500;
  let prior = null, repeats = 0, latest = null;
  while (Date.now() < deadline) {
    latest = await capturePage(page);
    const signature = JSON.stringify({displayed: latest.displayed_count, controls: latest.control_labels,
      comments: latest.comments.map(row => row.comment_id || row.dom_key)});
    if (signature === prior) repeats++; else { prior = signature; repeats = 0; }
    if (repeats >= 1) return latest;
    await page.waitForTimeout(pause);
  }
  return latest || capturePage(page);
}

function normalizeCaptured(capture, post, checkpoint, conversationMap) {
  return capture.comments.map(comment => {
    const semantics = core.semanticTier(comment.body, conversationMap);
    return {
      schema_version: "facebook_comment_v2", platform: "facebook", source_specific_record_type: "comment",
      asin: checkpoint.asins[0], matched_asins: checkpoint.asins, matched_queries: [post.discovered_by_query].filter(Boolean),
      post_id: post.post_id, post_url: post.post_url, post_title: capture.post_title || "", post_semantic_tier: post.semantic_tier,
      semantic_tier: semantics.tier, semantic_score: semantics.score, comment_id: comment.comment_id || "",
      reply_comment_id: comment.parent_comment_id ? (comment.comment_id || "") : "",
      parent_comment_id: comment.parent_comment_id || `post:${post.post_id}`, depth: Number(comment.depth) || 0,
      author: comment.author || "", body: comment.body || "", created_at: comment.created_at || "",
      reaction_count: comment.reaction_count || "", comment_url: comment.comment_url || "", collected_at: core.now(),
      source_dom_key: comment.dom_key || "",
      post_audit_status: null, evidence_path: path.relative(process.cwd(), evidenceDir(path.resolve(checkpoint.out_dir), post.post_id)).replace(/\\/g, "/")
    };
  });
}

async function collectPost(context, post, options, checkpoint, checkpointFile, conversationMap, outDir, owned) {
  const page = await context.newPage(); owned.add(page); checkpoint.owned_page_urls.push(post.post_url);
  const evidence = evidenceDir(outDir, post.post_id); fs.mkdirSync(evidence, {recursive: true});
  const actionLedger = [], localEvents = [], observed = new Map(), started = Date.now();
  let latest = null, prefetched = null, stableRounds = 0, timedOut = false, blockedReason = null, actionCount = 0;
  try {
    const navigationUrl = /\/reels?\//i.test(post.post_url) ? `https://www.facebook.com/watch/?v=${post.post_id}` : post.post_url;
    const state = await goto(page, navigationUrl);
    if (state.status !== "READY") blockedReason = state.reason;
    if (!blockedReason) {
      const preparation = await prepareCommentSurface(page, options.commentLoadWaitMs || 4000);
      if (preparation.length) actionLedger.push({action_index: actionLedger.length + 1, at: core.now(), controls: preparation,
        before_count: 0, remaining_before: null});
      saveCheckpoint(checkpointFile, checkpoint);
      const preparedState = await bodyState(page);
      if (preparedState.status === "BLOCKED") blockedReason = preparedState.reason;
      try { if (!blockedReason) prefetched = await waitForCaptureStable(page); }
      catch (error) {
        const access = core.classifyAccess(await page.locator("body").innerText().catch(() => ""), page.url());
        blockedReason = access.status === "BLOCKED" ? access.reason : `comment_tree_unavailable:${error.message}`;
      }
    }
    while (!blockedReason) {
      if ((Date.now() - started) / 1000 >= Number(options.postTimeoutSeconds || 180)) { timedOut = true; break; }
      let capture;
      try { capture = prefetched || await capturePage(page); prefetched = null; }
      catch (error) {
        const access = core.classifyAccess(await page.locator("body").innerText().catch(() => ""), page.url());
        blockedReason = access.status === "BLOCKED" ? access.reason : `comment_tree_unavailable:${error.message}`;
        break;
      }
      latest = capture;
      const rows = normalizeCaptured(capture, post, checkpoint, conversationMap);
      const before = new Set(observed.keys());
      localEvents.push(...rows);
      rows.forEach((row, index) => {
        const key = row.comment_id ? `id:${row.comment_id}` : `dom:${row.source_dom_key || index}`;
        if (!observed.has(key)) observed.set(key, row);
      });
      const after = new Set(observed.keys());
      const newKeys = [...after].filter(key => !before.has(key));
      stableRounds = newKeys.length ? 0 : stableRounds + 1;
      Object.assign(post, {last_visible_count: observed.size, last_remaining_controls: capture.remaining_controls, last_capture_at: core.now()});
      checkpoint.raw_capture_events.push(...rows);
      checkpoint.collected_comment_ids = core.clean([...checkpoint.collected_comment_ids, ...rows.map(row => row.comment_id).filter(Boolean)]);
      saveCheckpoint(checkpointFile, checkpoint);
      if (observed.size >= Number(options.maxCommentsPerPost || 100) && capture.remaining_controls) break;
      if (!capture.remaining_controls && stableRounds >= 2) break;
      if (actionCount >= Number(options.maxExpandActions || 100)) break;
      if (capture.remaining_controls) {
        const actions = await page.evaluate(pageCapture.expandVisible, 1);
        actionCount += actions.length;
        actionLedger.push({action_index: actionLedger.length + 1, at: core.now(), controls: actions,
          before_count: observed.size, remaining_before: capture.remaining_controls});
        checkpoint.expanded_control_keys.push(...actions.map(action => `${post.post_id}:${action.label}:${actionLedger.length}`));
        saveCheckpoint(checkpointFile, checkpoint);
        prefetched = await waitForCaptureStable(page, Math.max(3000, Number(options.actionDelayMs || 1200) * 3));
      }
      if (!prefetched) await page.waitForTimeout(Number(options.actionDelayMs || 1200));
    }
  } finally {
    await page.close().catch(() => {}); owned.delete(page);
  }
  const eventMerge = core.mergeComments(localEvents);
  const observedMerge = core.mergeComments([...observed.values()]);
  const commentBudget = Number(options.maxCommentsPerPost || 100);
  const rows = observedMerge.rows.slice(0, commentBudget);
  if (!blockedReason && Number(latest?.displayed_count || 0) > 0 && !rows.length) blockedReason = "comment_tree_unavailable";
  const orphanReplyIds = core.deriveDepths(rows, post.post_id);
  const issues = [];
  if (observedMerge.rows.length > rows.length || (rows.length >= commentBudget && ((latest?.remaining_controls || 0) > 0 || Number(latest?.displayed_count || 0) > rows.length))) issues.push("per_post_comment_budget_reached");
  if (actionCount >= Number(options.maxExpandActions || 100)) issues.push("expand_action_budget_reached");
  const audit = core.auditPost({blocked_reason: blockedReason, orphan_reply_ids: orphanReplyIds,
    remaining_controls: latest?.remaining_controls ?? 0, displayed_count: latest?.displayed_count ?? null,
    zero_comment_evidence: Boolean(latest?.zero_comment_evidence), stable_rounds: stableRounds, timed_out: timedOut, issues});
  rows.forEach(row => row.post_audit_status = audit.status);
  const frontier = {post_id: post.post_id, stable_rounds: stableRounds, remaining_controls: latest?.remaining_controls ?? null,
    control_labels: latest?.control_labels || [], displayed_count: latest?.displayed_count ?? null,
    zero_comment_evidence: Boolean(latest?.zero_comment_evidence), action_count: actionCount,
    timed_out: timedOut, closed: audit.status === "PASS", issues: audit.issues};
  const commentTree = {post_id: post.post_id, nodes: rows.map(row => ({comment_id: row.comment_id,
    parent_comment_id: row.parent_comment_id, depth: row.depth, dedup_uncertain: row.dedup_uncertain}))};
  const auditRecord = {...audit, post_id: post.post_id, post_url: post.post_url, qualified: post.qualified,
    semantic_tier: post.semantic_tier, semantic_score: post.semantic_score, unique_comments: rows.length,
    replies: rows.filter(row => row.depth > 0).length, technical_duplicates: eventMerge.technical_duplicate_count,
    orphan_reply_ids: orphanReplyIds, displayed_count: latest?.displayed_count ?? null,
    zero_comment_evidence: Boolean(latest?.zero_comment_evidence),
    remaining_controls: latest?.remaining_controls ?? null, stable_rounds: stableRounds, collected_at: core.now()};
  core.writeJson(path.join(evidence, "audit.json"), auditRecord);
  core.writeJson(path.join(evidence, "comment_tree.json"), commentTree);
  core.writeJson(path.join(evidence, "frontier.json"), frontier);
  core.writeJson(path.join(evidence, "action_ledger.json"), actionLedger);
  return {rows, audit: auditRecord, frontier, actionLedger};
}

function outputRows(checkpoint) {
  const merged = core.mergeComments(checkpoint.final_rows || []);
  const eventMerge = core.mergeComments(checkpoint.raw_capture_events || []);
  const pageStatus = new Map((checkpoint.page_map || []).map(item => [item.post_id, item.status]));
  merged.rows.forEach(row => { if (pageStatus.has(row.post_id)) row.post_audit_status = pageStatus.get(row.post_id); });
  merged.technical_duplicate_count = eventMerge.technical_duplicate_count;
  return {merged, raw: merged.rows,
    trusted: merged.rows.filter(row => row.post_audit_status === "PASS"),
    partial: merged.rows.filter(row => row.post_audit_status === "PARTIAL")};
}

function pythonExecutable() {
  const bundled = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
  return fs.existsSync(bundled) ? bundled : (process.platform === "win32" ? "python" : "python3");
}

function writeOutputs(outDir, checkpoint, conversationMap, buildWorkbook = true) {
  fs.mkdirSync(outDir, {recursive: true});
  const {merged, raw, trusted, partial} = outputRows(checkpoint);
  core.writeJsonl(path.join(outDir, "raw_comments.jsonl"), raw);
  core.writeJsonl(path.join(outDir, "trusted_comments.jsonl"), trusted);
  core.writeJsonl(path.join(outDir, "partial_candidates.jsonl"), partial);
  fs.writeFileSync(path.join(outDir, "raw_comments.csv"), core.csv(raw), "utf8");
  core.writeJson(path.join(outDir, "conversation_map.json"), conversationMap);
  core.writeJson(path.join(outDir, "query_plan.json"), {schema_version: "facebook_query_plan_v2", queries: checkpoint.queries, round_history: checkpoint.round_history});
  core.writeJson(path.join(outDir, "page_map.json"), checkpoint.page_map);
  const manifest = {schema_version: "facebook_manifest_v2", collector_version: VERSION, generated_at: core.now(),
    asins: checkpoint.asins, stop_reason: checkpoint.stop_reason, raw_captured_count: (checkpoint.raw_capture_events || []).length,
    technical_duplicate_count: merged.technical_duplicate_count, final_collected_count: raw.length,
    trusted_count: trusted.length, partial_count: partial.length,
    blocked_post_count: checkpoint.page_map.filter(item => item.status === "BLOCKED").length,
    pass_post_count: checkpoint.page_map.filter(item => item.status === "PASS").length,
    partial_post_count: checkpoint.page_map.filter(item => item.status === "PARTIAL").length,
    reply_count: raw.filter(row => row.depth > 0).length, post_count: checkpoint.page_map.length,
    checkpoint_resumed: Boolean(checkpoint.resumed_from)};
  core.writeJson(path.join(outDir, "manifest.json"), manifest);
  if (buildWorkbook) {
    const result = spawnSync(pythonExecutable(), [path.join(__dirname, "build_facebook_workbook.py"), "--out-dir", outDir], {encoding: "utf8", windowsHide: true});
    if (result.status !== 0) throw new Error(`Workbook build failed: ${result.stderr || result.stdout}`);
  }
  return manifest;
}

async function preflight(options, context, asins, owned) {
  const result = {command: "preflight", status: "ready", checks: {}, collected_at: core.now()};
  const product = await productContext(context, asins, owned);
  result.checks.amazon = product.products.every(item => item.access_status === "READY") ? "READY" : "DEGRADED";
  result.checks.sellersprite = product.sellerSprite.status;
  result.sellersprite_degraded_reason = product.sellerSprite.degraded_reason || null;
  const map = core.buildConversationMap(product.products, product.sellerSprite);
  const seed = core.roundOneQueries(map).find(item => item.family === "product_entity")?.query || asins[0];
  const fbPage = await context.newPage(); owned.add(fbPage);
  try {
    const fb = await goto(fbPage, `https://www.facebook.com/watch/search/?q=${encodeURIComponent(seed)}`);
    result.checks.facebook_search = fb.status;
    if (fb.status !== "READY") { result.status = "BLOCKED"; result.stop_reason = fb.reason; return result; }
    result.checks.visible_results = await fbPage.locator("a[href*='/reel/'], a[href*='/videos/'], a[href*='/watch/?v=']").count();
    if (!result.checks.visible_results) { result.status = "BLOCKED"; result.stop_reason = "search:no_visible_results"; return result; }
  } finally { await fbPage.close().catch(() => {}); owned.delete(fbPage); }
  return result;
}

async function collect(options, context, asins, owned) {
  const outDir = path.resolve(options.outDir || "outputs/facebook-comments");
  fs.mkdirSync(outDir, {recursive: true});
  const cpFile = checkpointPath(options, outDir);
  const checkpoint = loadCheckpoint(options, outDir, asins);
  checkpoint.out_dir = outDir;
  let conversationMap;
  if (checkpoint.conversation_map) conversationMap = checkpoint.conversation_map;
  else {
    const {products, sellerSprite} = await productContext(context, asins, owned);
    conversationMap = core.buildConversationMap(products, sellerSprite);
    checkpoint.conversation_map = conversationMap;
    checkpoint.queries = core.roundOneQueries(conversationMap);
    saveCheckpoint(cpFile, checkpoint);
  }

  const discoveryPage = await context.newPage(); owned.add(discoveryPage);
  const completeQueryPlan = Boolean(options.completeQueryPlan);
  try {
    const partialQueue = (options.retryPartial || options.forceReauditPartial)
      ? checkpoint.page_map.filter(item => item.status === "PARTIAL").map(item => ({...item, force_reaudit: Boolean(options.forceReauditPartial)})) : [];
    if (options.forceReauditPartial) checkpoint.page_map = checkpoint.page_map.filter(item => item.status !== "PARTIAL");
    for (const post of partialQueue) {
      const result = await collectPost(context, post, options, checkpoint, cpFile, conversationMap, outDir, owned);
      checkpoint.page_map = checkpoint.page_map.filter(item => item.post_id !== post.post_id);
      checkpoint.page_map.push(result.audit);
      checkpoint.final_rows = core.replacePostRows(checkpoint.final_rows, result.rows, post.post_id);
      saveCheckpoint(cpFile, checkpoint); writeOutputs(outDir, checkpoint, conversationMap, false);
    }

    while (true) {
      const rowsBefore = outputRows(checkpoint);
      let decision = core.stoppingDecision(checkpoint.round_history, {trusted: rowsBefore.trusted.length, posts: checkpoint.page_map.length}, options);
      const maxRounds = Number(options.maxDiscoveryRounds || 5);
      const pendingRounds = checkpoint.queries.filter(query => query.status !== "done" && query.discovery_round <= maxRounds)
        .map(query => query.discovery_round);
      const planComplete = !pendingRounds.length && checkpoint.discovery_round > maxRounds;
      if (completeQueryPlan && !planComplete && decision.stop) decision = {stop: false, reason: null};
      if (decision.stop) { checkpoint.stop_reason = decision.reason; break; }
      const round = pendingRounds.length ? Math.min(...pendingRounds) : checkpoint.discovery_round;
      if (!checkpoint.queries.some(query => query.discovery_round === round && query.status !== "done")) {
        if (round === 1 && !checkpoint.queries.some(query => query.discovery_round === 1)) checkpoint.queries.push(...core.roundOneQueries(conversationMap));
        if (round > 1) checkpoint.queries.push(...core.laterRoundQueries(round, conversationMap, checkpoint.discovered_posts, rowsBefore.raw, checkpoint.queries));
      }
      const roundQueries = checkpoint.queries.filter(query => query.discovery_round === round && query.status !== "done");
      if (!roundQueries.length) { checkpoint.stop_reason = "semantic_coverage_saturated"; break; }
      const roundStartRaw = rowsBefore.raw.length, roundStartEvents = checkpoint.raw_capture_events.length;
      let roundBlocked = null, discoveredCount = 0, selectedCount = 0;
      for (const query of roundQueries) {
        const discovery = await discoverPosts(discoveryPage, query, options, conversationMap);
        query.status = discovery.status === "READY" ? "done" : "blocked";
        query.discovered_posts = discovery.posts.length;
        query.qualified_posts = discovery.posts.filter(post => post.qualified).length;
        query.completed_at = core.now();
        if (discovery.status === "BLOCKED") { query.blocked_reason = discovery.reason; roundBlocked = discovery.reason; saveCheckpoint(cpFile, checkpoint); break; }
        discoveredCount += discovery.posts.length;
        for (const candidate of discovery.posts) {
          if (!checkpoint.discovered_posts.some(post => post.post_id === candidate.post_id)) checkpoint.discovered_posts.push(candidate);
        }
        const visited = new Set(checkpoint.page_map.map(item => item.post_id));
        for (const post of discovery.posts.filter(item => item.qualified && !visited.has(item.post_id))) {
          if (checkpoint.page_map.length >= Number(options.targetPosts || 30)) break;
          selectedCount++;
          const result = await collectPost(context, post, options, checkpoint, cpFile, conversationMap, outDir, owned);
          checkpoint.page_map.push(result.audit);
          checkpoint.final_rows = core.replacePostRows(checkpoint.final_rows, result.rows, post.post_id);
          saveCheckpoint(cpFile, checkpoint);
          writeOutputs(outDir, checkpoint, conversationMap, false);
          const current = outputRows(checkpoint);
          if (current.trusted.length >= Number(options.targetComments || 300)) break;
        }
        saveCheckpoint(cpFile, checkpoint);
        if (!completeQueryPlan && (outputRows(checkpoint).trusted.length >= Number(options.targetComments || 300) || checkpoint.page_map.length >= Number(options.targetPosts || 30))) break;
      }
      const after = outputRows(checkpoint);
      const newComments = after.raw.length - roundStartRaw;
      const newEvents = checkpoint.raw_capture_events.length - roundStartEvents;
      const duplicateRate = newEvents ? Math.max(0, (newEvents - newComments) / newEvents) : 0;
      const terms = core.communityTerms(checkpoint.discovered_posts, after.raw).map(item => item.term);
      conversationMap.layers.community_language = core.clean([...conversationMap.layers.community_language, ...terms]);
      checkpoint.conversation_map = conversationMap;
      checkpoint.round_history.push({discovery_round: round, queries: roundQueries.length, discovered_posts: discoveredCount,
        selected_posts: selectedCount, new_comments: newComments, duplicate_rate: Number(duplicateRate.toFixed(4)),
        semantic_coverage_hash: core.hash(conversationMap.layers.community_language.slice().sort().join("|")).slice(0, 16), completed_at: core.now()});
      checkpoint.discovery_round = Math.max(checkpoint.discovery_round, round + 1);
      if (roundBlocked) { checkpoint.stop_reason = `access_restriction:${roundBlocked}`; break; }
      saveCheckpoint(cpFile, checkpoint);
    }
  } finally { await discoveryPage.close().catch(() => {}); owned.delete(discoveryPage); }
  saveCheckpoint(cpFile, checkpoint);
  return writeOutputs(outDir, checkpoint, conversationMap, true);
}

async function main() {
  const options = core.parseArgs(process.argv.slice(2));
  if (options.help) { help(); return 0; }
  const asins = core.readAsins(options);
  const readiness = await ensureCdp(options);
  if (readiness.status !== "ready") {
    const outDir = path.resolve(options.outDir || "outputs/facebook-comments");
    fs.mkdirSync(outDir, {recursive: true});
    const checkpoint = freshCheckpoint(asins); checkpoint.stop_reason = `cdp:${readiness.reason || readiness.status}`; checkpoint.out_dir = outDir;
    saveCheckpoint(path.join(outDir, "checkpoint.json"), checkpoint);
    console.log(JSON.stringify({status: "BLOCKED", ...readiness}, null, 2));
    return 3;
  }
  const {browser, context} = await connect(options), owned = new Set();
  try {
    const result = options.command === "preflight"
      ? await preflight(options, context, asins, owned)
      : await collect(options, context, asins, owned);
    console.log(JSON.stringify(result, null, 2));
    return result.status === "BLOCKED" ? 3 : 0;
  } finally {
    for (const page of owned) await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(JSON.stringify({status: "ERROR", error: error.stack || error.message}, null, 2)); process.exitCode = 1;
});

module.exports = {help, probeCdp, ensureCdp, amazonProduct, discoverPosts, collectPost, writeOutputs, preflight, collect};
