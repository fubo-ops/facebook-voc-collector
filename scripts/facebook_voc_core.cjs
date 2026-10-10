"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const QUERY_FAMILIES = [
  "product_entity", "category_solution", "problem_symptom", "usage_context",
  "decision_intent", "competitor", "natural_language_question"
];

const STOP_WORDS = new Set((
  "a an and are as at be been but by can could did do does for from had has have how i if in into is it its " +
  "me more my no not of on or our so than that the their them then there these they this to too us was we were " +
  "what when where which who why will with would you your facebook amazon product products review reviews video " +
  "like reply share follow see translation write comment comments most relevant all active status indicator " +
  "一个 这个 那个 以及 可以 使用 商品 产品 评论 视频 真的 非常 就是 还是 没有 " +
  "所有心情 回复 分享 查看 展开 登录 搜索结果 筛选条件 排序方式 发布日期 热门 查看翻译 写评论 在线状态指示标"
).split(/\s+/));

const RELATIVE_TIME_ONLY = /^(?:\d+\s*(?:周|天|小时|分钟|月|年)|刚刚|昨天|\d+\s*(?:w|wk|wks|week|weeks|d|day|days|h|hr|hrs|hour|hours|min|mins|minute|minutes))$/i;
const UI_ARTIFACT_ONLY = /^(?:查看翻译|写评论(?:…|\.\.\.)?|写回复(?:…|\.\.\.)?|作者留下了心情|在线状态指示标|赞|点赞|回复|分享|关注|最相关|所有评论|see translation|write a comment(?:…|\.\.\.)?|write a reply(?:…|\.\.\.)?|author (?:left a reaction|reacted)|active status indicator|like|reply|share|follow|most relevant|all comments)$/i;

function now() { return new Date().toISOString(); }
function list(value) { return Array.isArray(value) ? value : value == null ? [] : [value]; }
function clean(values) {
  const seen = new Set(), out = [];
  for (const value of list(values).flat(Infinity)) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    const key = text.toLowerCase();
    if (text && !seen.has(key)) { seen.add(key); out.push(text); }
  }
  return out;
}
function hash(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}
function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
}

function parseArgs(argv) {
  const defaults = {
    command: "collect", targetComments: "300", targetPosts: "30", maxCommentsPerPost: "0",
    maxDiscoveryRounds: "5", minNewCommentsPerRound: "3", duplicateRateStop: "0.85",
    maxPostsPerQuery: "10", maxExpandActions: "100", actionDelayMs: "1200", commentLoadWaitMs: "4000",
    postTimeoutSeconds: "180", sessionMode: "cdp", cdpUrl: "http://127.0.0.1:9222",
    headless: "0", outDir: "", qualificationMode: "strict", discoveryScrolls: "3"
  };
  const out = {...defaults};
  let index = 0;
  if (["collect", "preflight"].includes(argv[0])) out.command = argv[index++];
  const booleanFlags = new Set(["--retry-partial", "--force-reaudit-partial", "--complete-query-plan"]);
  for (; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") { out.help = true; continue; }
    if (!flag.startsWith("--")) throw new Error(`Unknown argument: ${flag}`);
    const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (booleanFlags.has(flag)) { out[key] = true; continue; }
    if (flag === "--resume" && (argv[index + 1] == null || argv[index + 1].startsWith("--"))) { out.resume = true; continue; }
    const value = argv[++index];
    if (value == null || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    out[key] = value;
  }
  return out;
}

function readAsins(options) {
  let values = [];
  if (options.asin) values.push(options.asin);
  if (options.asins) values.push(...String(options.asins).split(","));
  if (options.asinFile) {
    const raw = fs.readFileSync(options.asinFile, "utf8");
    values.push(...raw.split(/[\r\n,\t;]+/).filter(value => value.trim().toLowerCase() !== "asin"));
  }
  values = clean(values.map(value => value.toUpperCase()));
  for (const asin of values) if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error(`Invalid ASIN: ${asin}`);
  if (!values.length) throw new Error("Provide --asin, --asins, or --asin-file");
  return values;
}

function normalizePostUrl(input) {
  let url;
  try { url = new URL(input); } catch { return null; }
  if (!/(^|\.)facebook\.com$/i.test(url.hostname)) return null;
  url.hostname = "www.facebook.com";
  let postId = url.searchParams.get("story_fbid") || url.searchParams.get("v");
  const match = url.pathname.match(/\/(?:posts|permalink|videos|reel|reels)\/([^/?]+)/i);
  if (!postId && match) postId = match[1];
  if (!postId || !/^[A-Za-z0-9._:-]+$/.test(postId)) return null;
  const pathname = url.pathname.toLowerCase();
  let canonical;
  if (/\/reels?\//.test(pathname)) canonical = `https://www.facebook.com/reel/${postId}/`;
  else if (/\/videos\//.test(pathname) || pathname === "/watch/") canonical = `https://www.facebook.com/watch/?v=${postId}`;
  else canonical = `https://www.facebook.com/permalink.php?story_fbid=${encodeURIComponent(postId)}`;
  return {post_id: String(postId), post_url: canonical};
}

function classifyAccess(text, url = "", status = 200) {
  const body = String(text || "");
  const rules = [
    [/captcha|security check|robot check|验证码/i, "captcha"],
    [/temporarily blocked|you.re temporarily blocked|暂时无法使用|操作过于频繁/i, "temporarily_blocked"],
    [/log in to facebook|登录 facebook|登录后继续|create new account/i, "login_required"],
    [/content isn.t available|this content isn.t available|此内容目前无法显示/i, "content_unavailable"],
    [/^\s*not found\s*$/i, "search_unavailable"]
  ];
  if (status === 403) return {status: "BLOCKED", reason: "http_403"};
  if (status === 429) return {status: "BLOCKED", reason: "http_429"};
  if (/\/login(?:[/?#]|$)/i.test(url)) return {status: "BLOCKED", reason: "login_required"};
  for (const [pattern, reason] of rules) if (pattern.test(body)) return {status: "BLOCKED", reason};
  return {status: "READY", reason: null};
}

function tokenize(text) {
  return String(text || "").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+'’-]{2,}/gu)
    ?.filter(token => !STOP_WORDS.has(token) && !/^\d+$/.test(token)) || [];
}

function classifyCommentText(value) {
  const rawBody = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  const lines = rawBody.split(/\n+/).map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const kept = [], removed = [];
  for (const line of lines) {
    if (RELATIVE_TIME_ONLY.test(line)) { removed.push({line, reason: "relative_time"}); continue; }
    if (UI_ARTIFACT_ONLY.test(line)) { removed.push({line, reason: "ui_label"}); continue; }
    kept.push(line);
  }
  const bodyClean = kept.join(" ").replace(/\s+/g, " ").trim();
  const uiArtifact = Boolean(rawBody) && !bodyClean && removed.length > 0;
  return {
    raw_body: rawBody,
    body_clean: bodyClean,
    ui_artifact: uiArtifact,
    ui_artifact_reason: uiArtifact ? clean(removed.map(item => item.reason)).join("|") : "",
    record_kind: uiArtifact ? "ui_artifact" : "comment"
  };
}

function featurePhrases(values) {
  return clean(list(values).flatMap(value => {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return [];
    const lead = text.match(/^([^:;.!?]{3,48})\s*[:–—-]/)?.[1];
    const observed = [];
    for (const pattern of [
      /\b(?:dog\s+)?lick(?:ing)?\s+bowl\b/ig, /\bslow\s+feeder(?:\s+bowl)?\b/ig,
      /\b(?:dog|cat|pet)\s+bowl\b/ig, /\benrichment(?:\s+feeding)?\b/ig,
      /\bmental stimulation\b/ig, /\bnon[- ]slip(?:\s+base)?\b/ig
    ]) observed.push(...(text.match(pattern) || []));
    return [lead, ...observed];
  }));
}

function inferProduct(product) {
  const title = String(product.title || "");
  const brand = product.brand || tokenize(title)[0] || "";
  const bullets = clean(product.features || product.core_attributes || []);
  const materialPatterns = /(?:stainless steel|silicone|plastic|leather|cotton|wood|aluminum|glass|ceramic|nylon|rubber|foam|metal|fabric|titanium|bamboo|polyester)/ig;
  const materials = clean([...(title.match(materialPatterns) || []), ...bullets.flatMap(value => value.match(materialPatterns) || [])]);
  const scenarios = clean([...(product.usage_contexts || []), ...bullets.filter(value => /(?:for|during|home|travel|outdoor|indoor|daily|night|car|office|kitchen|bath|dog|cat)/i.test(value))]).slice(0, 8);
  const functions = clean([...(product.functions || []), ...featurePhrases(bullets), ...bullets.slice(0, 10)]);
  const base = clean([product.brand, title, product.category, ...materials, ...functions]).join(" ");
  const words = tokenize(base);
  const compactEntity = clean([brand, ...words.filter(word => /[a-z]/i.test(word)).slice(1, 5)]).join(" ");
  const entities = clean([brand, compactEntity, title]).filter(Boolean);
  const problems = clean([
    ...(product.user_problems || []),
    ...bullets.filter(value => /(?:help|reduce|relief|prevent|protect|support|problem|pain|difficult|without|slow|anxiety|boredom|stress)/i.test(value)).slice(0, 6),
    product.category && `${product.category} problem`, product.category && `${product.category} not working`
  ]);
  const productTypes = clean([product.product_type, ...featurePhrases([title, ...bullets]), product.category]);
  const targetAudiences = clean([...(product.target_audiences || []), ...String([title, ...bullets].join(" ")).match(/\b(?:dogs?|pupp(?:y|ies)|cats?|kittens?|pets?|senior dogs?)\b/ig) || []]);
  const purchaseIntents = clean(product.purchase_intents || ["review", "worth it", "recommendation"]);
  const alternatives = clean(product.alternatives || []);
  return {...product, brand, product_type: productTypes[0] || product.category || title, product_types: productTypes,
    materials, usage_contexts: scenarios, functions, user_problems: problems, target_audiences: targetAudiences,
    purchase_intents: purchaseIntents, alternatives, product_entities: entities,
    competitors: clean(product.competitors || [])};
}

function buildConversationMap(products, sellerSprite = {}) {
  const normalized = products.map(inferProduct);
  return {
    schema_version: "facebook_conversation_map_v1", generated_at: now(), asins: normalized.map(item => item.asin),
    products: normalized,
    layers: {
      product_entities: clean(normalized.flatMap(item => item.product_entities)),
      category_and_functions: clean(normalized.flatMap(item => [item.category, ...item.functions])),
      materials: clean(normalized.flatMap(item => item.materials)),
      usage_contexts: clean(normalized.flatMap(item => item.usage_contexts)),
      user_problems: clean(normalized.flatMap(item => item.user_problems)),
      product_types: clean(normalized.flatMap(item => item.product_types)),
      target_audiences: clean(normalized.flatMap(item => item.target_audiences)),
      purchase_intents: clean(normalized.flatMap(item => item.purchase_intents)),
      alternatives: clean(normalized.flatMap(item => item.alternatives)),
      competitors: clean(normalized.flatMap(item => item.competitors)),
      community_language: []
    },
    sellersprite: sellerSprite
  };
}

function roundOneQueries(conversationMap) {
  const layers = conversationMap.layers;
  const entity = layers.product_entities.find(value => value.split(/\s+/).length >= 2 && value.length < 80) || layers.product_entities[0] || conversationMap.asins[0];
  const productType = layers.product_types?.[0] || layers.category_and_functions[0] || entity;
  const category = layers.category_and_functions.find(value => value !== productType) || productType;
  const problem = [...layers.user_problems].sort((a, b) => a.length - b.length)[0] || `${category} problem`;
  const context = [...layers.usage_contexts].sort((a, b) => a.length - b.length)[0] || `${category} use`;
  const competitor = layers.competitors[0] || layers.alternatives?.[0];
  const target = layers.target_audiences?.[0] || "users";
  const intent = layers.purchase_intents?.[0] || "review";
  const values = {
    product_entity: entity,
    category_solution: `${productType} ${category}`,
    problem_symptom: problem,
    usage_context: context,
    decision_intent: `${productType} ${intent} worth it`,
    competitor: competitor ? `${productType} vs ${competitor}` : `${productType} alternatives`,
    natural_language_question: `best ${productType} for ${target} ${problem}`
  };
  return QUERY_FAMILIES.map(family => ({query_id: `r1-${family}`, family, query: values[family],
    discovery_round: 1, generation_source: "amazon_product_evidence", source_terms: clean(tokenize(values[family])),
    evidence_comment_ids: [], status: "pending"}));
}

function communityTerms(posts, comments, limit = 12) {
  const evidence = new Map();
  for (const source of [...posts, ...comments]) {
    if (source.ui_artifact || source.record_kind === "ui_artifact") continue;
    const id = source.comment_id || `post:${source.post_id}`;
    const rawText = source.body_clean ?? source.body ?? source.post_text ?? source.post_title ?? "";
    const classified = classifyCommentText(rawText);
    if (classified.ui_artifact) continue;
    for (const token of tokenize(classified.body_clean)) {
      if (!evidence.has(token)) evidence.set(token, new Set());
      evidence.get(token).add(id);
    }
  }
  return [...evidence.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
    .slice(0, limit).map(([term, ids]) => ({term, evidence_ids: [...ids].slice(0, 10)}));
}

function laterRoundQueries(round, conversationMap, posts, comments, existing = []) {
  if (round < 2) throw new Error("Later-round queries require discovery_round >= 2");
  const vocabulary = new Set(tokenize([
    ...conversationMap.layers.product_entities,
    ...conversationMap.layers.category_and_functions,
    ...conversationMap.layers.user_problems,
    ...conversationMap.layers.usage_contexts,
    ...conversationMap.layers.materials
  ].join(" ")));
  const terms = communityTerms(posts, comments, 100).filter(item => vocabulary.has(item.term)).slice(0, 12);
  const used = new Set(existing.map(item => String(item.query || "").toLowerCase()));
  if (terms.length < 2) return [];
  const out = [];
  QUERY_FAMILIES.forEach((family, index) => {
    const first = terms[index % Math.max(terms.length, 1)];
    const second = terms[(index + 1) % Math.max(terms.length, 1)];
    if (!first) return;
    const sources = [first, second].filter((item, itemIndex, items) => item && items.findIndex(other => other.term === item.term) === itemIndex);
    const query = sources.map(item => item.term).join(" ");
    if (used.has(query.toLowerCase())) return;
    out.push({query_id: `r${round}-${family}`, family, query, discovery_round: round,
      generation_source: "observed_facebook_community_language", source_terms: sources.map(item => item.term),
      evidence_comment_ids: clean(sources.flatMap(item => item.evidence_ids)).filter(id => !String(id).startsWith("post:")), status: "pending"});
  });
  return out;
}

function semanticScore(text, conversationMap) {
  const classified = classifyCommentText(text);
  if (classified.ui_artifact) return {score: 0, hits: {entity: [], category: [], problem: [], context: [], competitor: []}, matched_groups: []};
  const haystack = new Set(tokenize(classified.body_clean));
  const groups = {
    entity: tokenize(conversationMap.layers.product_entities.join(" ")),
    category: tokenize(conversationMap.layers.category_and_functions.join(" ")),
    problem: tokenize(conversationMap.layers.user_problems.join(" ")),
    context: tokenize(conversationMap.layers.usage_contexts.join(" ")),
    competitor: tokenize(conversationMap.layers.competitors.join(" "))
  };
  const hits = Object.fromEntries(Object.entries(groups).map(([key, terms]) => [key, clean(terms.filter(term => haystack.has(term)))]));
  const score = Math.min(1, hits.entity.length * 0.35 + hits.category.length * 0.18 + hits.problem.length * 0.15 +
    hits.context.length * 0.12 + hits.competitor.length * 0.18);
  return {score: Number(score.toFixed(3)), hits, matched_groups: Object.keys(hits).filter(key => hits[key].length)};
}

function semanticTier(text, conversationMap) {
  const result = semanticScore(text, conversationMap);
  let tier = "context_only";
  if (result.hits.entity.length && result.matched_groups.length >= 2) tier = "direct_product";
  else if (result.hits.competitor.length && result.matched_groups.length >= 2) tier = "competitive_context";
  else if (result.hits.problem.length && (result.hits.category.length || result.hits.context.length)) tier = "unmet_need";
  return {...result, tier};
}

function postQualified(score, mode = "strict", text = "", conversationMap = null) {
  const distinctHits = new Set(Object.values(score.hits).flat());
  const strict = score.hits.entity.length >= 2 || (distinctHits.size >= 2 && (score.matched_groups.length >= 2 || score.score >= 0.5));
  if (strict || mode !== "expanded" || !conversationMap) return strict;
  const haystack = ` ${String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim()} `;
  return clean(conversationMap.layers?.product_entities || []).some(entity => {
    const terms = tokenize(entity);
    if (terms.length >= 2) return haystack.includes(` ${terms.join(" ")} `);
    return terms.length === 1 && terms[0].length >= 5 && haystack.includes(` ${terms[0]} `);
  });
}

function matchesRequiredTermGroups(text, specification = "") {
  if (!String(specification || "").trim()) return true;
  const haystack = new Set(tokenize(text));
  return String(specification).split(";").map(group => clean(group.split("|").map(term => term.toLowerCase())))
    .filter(group => group.length).every(group => group.some(term => haystack.has(term)));
}

function mergeComments(rows) {
  const output = [], index = new Map();
  let duplicateCount = 0, artifactDuplicateCount = 0;
  for (const input of rows) {
    const row = {...input};
    const classified = classifyCommentText(row.raw_body ?? row.body_clean ?? row.body ?? "");
    row.raw_body = row.raw_body ?? classified.raw_body;
    row.body_clean = row.body_clean ?? classified.body_clean;
    row.ui_artifact = Boolean(row.ui_artifact || classified.ui_artifact);
    row.ui_artifact_reason = row.ui_artifact_reason || classified.ui_artifact_reason;
    row.record_kind = row.ui_artifact ? "ui_artifact" : (row.record_kind || "comment");
    row.body = row.body_clean;
    row.comment_id = String(row.comment_id || "").trim();
    if (row.ui_artifact) {
      const key = `artifact:${row.post_id}|${row.source_dom_key || row.raw_body}`;
      if (index.has(key)) { artifactDuplicateCount++; continue; }
      row.dedup_uncertain = false;
      row.record_id = row.record_id || `artifact:${hash(key).slice(0, 24)}`;
      index.set(key, row); output.push(row); continue;
    }
    row.dedup_uncertain = !row.comment_id;
    if (!row.comment_id) {
      row.record_id = row.record_id || `uncertain:${hash(`${row.post_id}|${row.author}|${row.body}|${row.collected_at}`).slice(0, 24)}`;
      output.push(row);
      continue;
    }
    const key = `id:${row.comment_id}`;
    const prior = index.get(key);
    if (!prior) { row.record_id = row.comment_id; index.set(key, row); output.push(row); continue; }
    duplicateCount++;
    prior.matched_asins = clean([...list(prior.matched_asins), ...list(row.matched_asins)]);
    prior.matched_queries = clean([...list(prior.matched_queries), ...list(row.matched_queries)]);
    if (prior.post_audit_status !== "PASS" && row.post_audit_status === "PASS") Object.assign(prior, row, {matched_asins: prior.matched_asins, matched_queries: prior.matched_queries});
  }
  return {rows: output, technical_duplicate_count: duplicateCount, artifact_duplicate_count: artifactDuplicateCount};
}

function replacePostRows(rows, replacement, postId) {
  return list(rows).filter(row => row.post_id !== postId).concat(list(replacement));
}

function deriveDepths(comments, postId) {
  const byId = new Map(comments.filter(row => row.comment_id).map(row => [row.comment_id, row]));
  const orphans = [];
  for (const row of comments) {
    if (!row.parent_comment_id || row.parent_comment_id === `post:${postId}`) {
      row.parent_comment_id = `post:${postId}`; row.depth = 0; continue;
    }
    if (!byId.has(row.parent_comment_id)) { orphans.push(row.comment_id || row.record_id); row.depth = Number(row.depth) || 1; continue; }
    let depth = 1, parent = byId.get(row.parent_comment_id), seen = new Set([row.comment_id]);
    while (parent && parent.parent_comment_id && parent.parent_comment_id !== `post:${postId}` && !seen.has(parent.comment_id)) {
      seen.add(parent.comment_id); depth++; parent = byId.get(parent.parent_comment_id);
    }
    row.depth = depth;
  }
  return orphans;
}

function auditPost(input) {
  const issues = clean(input.issues || []);
  if (input.blocked_reason) return {status: "BLOCKED", issues: clean([...issues, input.blocked_reason])};
  if (input.orphan_reply_ids?.length) issues.push("orphan_replies");
  if (input.incomplete_reply_lineage_ids?.length) issues.push("incomplete_reply_lineage");
  if (input.remaining_controls > 0) issues.push("unexpanded_controls");
  if (input.displayed_count == null || (Number(input.displayed_count) === 0 && !input.zero_comment_evidence)) issues.push("unknown_total");
  if (input.timed_out) issues.push("timeout");
  if ((input.stable_rounds || 0) < 2) issues.push("frontier_not_stable");
  return {status: clean(issues).length ? "PARTIAL" : "PASS", issues: clean(issues)};
}

function stoppingDecision(history, counts, options) {
  if (counts.trusted >= Number(options.targetComments || 300)) return {stop: true, reason: "target_comments_reached"};
  if (counts.posts >= Number(options.targetPosts || 30)) return {stop: true, reason: "target_posts_reached"};
  const byRound = new Map();
  for (const row of history) byRound.set(Number(row.discovery_round), row);
  const completed = [...byRound.values()].sort((a, b) => Number(a.discovery_round) - Number(b.discovery_round));
  if (completed.length >= Number(options.maxDiscoveryRounds || 5)) return {stop: true, reason: "max_discovery_rounds_reached"};
  if (completed.length >= 2 && completed.slice(-2).every(row => Number(row.new_comments || 0) < Number(options.minNewCommentsPerRound || 3)))
    return {stop: true, reason: "two_low_yield_rounds"};
  if (completed.length >= 2 && completed.slice(-2).every(row => Number(row.high_relevance_candidates ?? row.selected_posts ?? 0) === 0))
    return {stop: true, reason: "two_no_high_relevance_rounds"};
  if (completed.length >= 2 && completed.slice(-2).every(row => Number(row.duplicate_rate || 0) >= Number(options.duplicateRateStop || 0.85)))
    return {stop: true, reason: "two_high_duplicate_rounds"};
  if (completed.length >= 2 && completed.slice(-2).every(row => row.semantic_coverage_hash && row.semantic_coverage_hash === completed.at(-1).semantic_coverage_hash))
    return {stop: true, reason: "semantic_coverage_saturated"};
  return {stop: false, reason: null};
}

function commentBudgetReached(count, maxCommentsPerPost) {
  const limit = Number(maxCommentsPerPost ?? 0);
  return Number.isFinite(limit) && limit > 0 && Number(count || 0) >= limit;
}

function applyCommentBudget(rows, maxCommentsPerPost) {
  const limit = Number(maxCommentsPerPost ?? 0);
  if (!Number.isFinite(limit) || limit <= 0) return rows;
  let realComments = 0;
  return rows.filter(row => row.ui_artifact || realComments++ < limit);
}

function frontierClosed(remainingControls, stableRounds) {
  return Number(remainingControls || 0) === 0 && Number(stableRounds || 0) >= 2;
}

function csv(rows) {
  const fields = clean(rows.flatMap(row => Object.keys(row)));
  const cell = value => `"${String(Array.isArray(value) || (value && typeof value === "object") ? JSON.stringify(value) : value ?? "").replace(/"/g, '""')}"`;
  return [fields.join(","), ...rows.map(row => fields.map(field => cell(row[field])).join(","))].join("\r\n") + "\r\n";
}

module.exports = {
  QUERY_FAMILIES, now, clean, hash, writeJson, writeJsonl, parseArgs, readAsins, normalizePostUrl,
  classifyAccess, tokenize, classifyCommentText, inferProduct, buildConversationMap, roundOneQueries, communityTerms,
  laterRoundQueries, semanticScore, semanticTier, postQualified, matchesRequiredTermGroups, mergeComments, replacePostRows, deriveDepths,
  auditPost, stoppingDecision, commentBudgetReached, applyCommentBudget, frontierClosed, csv
};
