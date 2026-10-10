const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const core = require('../scripts/facebook_voc_core.cjs');

const parsed = core.parseArgs(['collect', '--asin', 'B003ULL1NQ', '--resume', '--retry-partial', '--complete-query-plan']);
assert.equal(parsed.command, 'collect');
assert.equal(parsed.resume, true);
assert.equal(parsed.retryPartial, true);
assert.equal(parsed.completeQueryPlan, true);
assert.equal(parsed.commentLoadWaitMs, '4000');
assert.equal(parsed.qualificationMode, 'strict');
assert.equal(parsed.discoveryScrolls, '3');
assert.equal(parsed.maxCommentsPerPost, '0');
assert.equal(parsed.outDir, '');
assert.equal(require('../scripts/facebook_playwright_collector.cjs').resolveOutputDir({outDir: 'chosen'}, ['B003ULL1NQ']), path.resolve('chosen'));

const asinFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-core-')), 'asins.csv');
fs.writeFileSync(asinFile, 'asin\nB003ULL1NQ\nB000000001\n');
assert.deepEqual(core.readAsins({asinFile}), ['B003ULL1NQ', 'B000000001']);

assert.deepEqual(core.normalizePostUrl('https://www.facebook.com/watch/?v=1480128156214957'), {
  post_id: '1480128156214957', post_url: 'https://www.facebook.com/watch/?v=1480128156214957'
});
assert.deepEqual(core.normalizePostUrl('https://www.facebook.com/page/posts/123?x=1'), {
  post_id: '123', post_url: 'https://www.facebook.com/permalink.php?story_fbid=123'
});

const map = core.buildConversationMap([{
  asin: 'B003ULL1NQ', brand: 'Cosequin', title: 'Cosequin Joint Health Supplement for Dogs',
  category: 'Dog Joint Supplements', features: ['Glucosamine and chondroitin support mobility'],
  competitors: ['Dasuquin']
}], {status: 'degraded', degraded_reason: 'fixture'});
const first = core.roundOneQueries(map);
assert.equal(first.length, 7);
assert.deepEqual(new Set(first.map(item => item.family)), new Set(core.QUERY_FAMILIES));

const later = core.laterRoundQueries(2, map, [{post_id: 'p1', post_text: 'senior dog stiffness mobility'}], [
  {comment_id: 'c1', body: 'My senior dog had morning stiffness but improved mobility'},
  {comment_id: 'c2', body: 'stiffness was the problem for our senior dog'}
], first);
assert.ok(later.length > 0);
assert.ok(later.every(item => item.generation_source === 'observed_facebook_community_language'));
assert.ok(later.some(item => item.evidence_comment_ids.includes('c1') || item.evidence_comment_ids.includes('c2')));
assert.deepEqual(core.tokenize('所有心情 dog stiffness'), ['dog', 'stiffness']);
const brandOnly = core.semanticTier('Cosequin official demonstration', map);
assert.equal(core.postQualified(brandOnly), false);
assert.equal(core.postQualified(brandOnly, 'expanded', 'Cosequin official demonstration', map), true);
const genericOnly = core.semanticTier('dog', map);
assert.equal(core.postQualified(genericOnly, 'expanded', 'dog', map), false);
assert.equal(core.matchesRequiredTermGroups('Dog slow feeder bowl review', 'dog|dogs|puppy;bowl|feeder|lick|mat'), true);
assert.equal(core.matchesRequiredTermGroups('Cute dog playing outside', 'dog|dogs|puppy;bowl|feeder|lick|mat'), false);
assert.equal(core.matchesRequiredTermGroups('Cat lick mat', 'dog|dogs|puppy;bowl|feeder|lick|mat'), false);

const merge = core.mergeComments([
  {comment_id: 'c1', body: 'same', matched_asins: ['A']},
  {comment_id: 'c1', body: 'same', matched_asins: ['B']},
  {comment_id: '', body: 'no id', post_id: 'p1', collected_at: 't1'},
  {comment_id: '', body: 'no id', post_id: 'p1', collected_at: 't2'}
]);
assert.equal(merge.rows.length, 3);
assert.equal(merge.technical_duplicate_count, 1);
assert.equal(merge.rows.filter(row => row.dedup_uncertain).length, 2);
const resumed = core.replacePostRows([{post_id: 'p1', comment_id: 'old'}, {post_id: 'p2', comment_id: 'keep'}],
  [{post_id: 'p1', comment_id: 'new'}, {post_id: 'p1', comment_id: 'new2'}], 'p1');
assert.deepEqual(resumed.map(row => row.comment_id), ['keep', 'new', 'new2']);

const tree = [
  {comment_id: 'p', parent_comment_id: '', depth: 0},
  {comment_id: 'r', parent_comment_id: 'p', depth: 0}
];
assert.deepEqual(core.deriveDepths(tree, 'post1'), []);
assert.equal(tree[1].depth, 1);
assert.equal(core.auditPost({displayed_count: 2, remaining_controls: 0, stable_rounds: 2, orphan_reply_ids: []}).status, 'PASS');
assert.equal(core.auditPost({displayed_count: 0, zero_comment_evidence: true, remaining_controls: 0, stable_rounds: 2, orphan_reply_ids: []}).status, 'PASS');
assert.deepEqual(core.auditPost({displayed_count: 0, zero_comment_evidence: false, remaining_controls: 0, stable_rounds: 2, orphan_reply_ids: []}).issues, ['unknown_total']);
assert.equal(core.auditPost({displayed_count: 2, remaining_controls: 0, stable_rounds: 1, orphan_reply_ids: []}).status, 'PARTIAL');
assert.equal(core.auditPost({displayed_count: null, remaining_controls: 1, stable_rounds: 0, orphan_reply_ids: []}).status, 'PARTIAL');
assert.equal(core.auditPost({blocked_reason: 'captcha'}).status, 'BLOCKED');
assert.equal(core.stoppingDecision([{discovery_round: 1}, {discovery_round: 1}], {trusted: 0, posts: 0}, {maxDiscoveryRounds: 2}).stop, false);

const dogMap = core.buildConversationMap([{
  asin: 'B0HMGGX71C', brand: 'Yipetor', title: 'Yipetor Dog Lick Bowl for Dogs', category: 'Dog Bowls',
  features: ['SLOW FEEDER DESIGN: slows eating', 'MENTAL STIMULATION: enrichment feeding for puppies',
    'FOOD GRADE SILICONE: non-slip base'], alternatives: ['lick mat'], competitors: ['KONG']
}], {status: 'degraded', degraded_reason: 'fixture'});
assert.ok(dogMap.layers.product_types.some(value => /dog lick bowl/i.test(value)));
assert.ok(dogMap.layers.target_audiences.some(value => /dog/i.test(value)));
assert.ok(dogMap.layers.purchase_intents.includes('review'));
assert.ok(dogMap.layers.alternatives.includes('lick mat'));
const dogQueries = core.roundOneQueries(dogMap);
assert.equal(dogQueries.length, 7);
assert.ok(new Set(dogQueries.map(item => item.query.split(/\s+/)[0].toLowerCase())).size > 1,
  'round-one queries must not share a forced prefix');
assert.ok(dogQueries.every(item => item.source_terms.length && item.generation_source === 'amazon_product_evidence'));
for (const generic of ['dog', 'bowl', 'food', 'lick']) {
  const score = core.semanticTier(generic, dogMap);
  assert.equal(core.postQualified(score, 'strict', generic, dogMap), false, `${generic} alone must not qualify`);
}
assert.equal(core.postQualified(core.semanticTier('dog lick bowl slow feeder enrichment feeding', dogMap),
  'strict', 'dog lick bowl slow feeder enrichment feeding', dogMap), true);

for (const value of ['38周', '1天', '刚刚', '昨天', '38 weeks', '2 HRS', '查看翻译', '写评论', '作者留下了心情', '在线状态指示标']) {
  assert.equal(core.classifyCommentText(value).ui_artifact, true, `${value} should be an artifact`);
}
assert.deepEqual(core.classifyCommentText('我用了38周，效果很好').body_clean, '我用了38周，效果很好');
assert.deepEqual(core.classifyCommentText('I used it for 38 weeks and it helped').body_clean,
  'I used it for 38 weeks and it helped');
assert.deepEqual(core.classifyCommentText('Great slow feeder\n38 weeks\nSee translation').body_clean, 'Great slow feeder');

const laterDog = core.laterRoundQueries(2, dogMap, [{post_id: 'dp1', post_text: 'dog lick bowl enrichment\n38 weeks\nSee translation'}], [
  {comment_id: 'dc1', body_clean: 'slow feeder bowl helps enrichment feeding'},
  {comment_id: 'ui1', body_clean: '', raw_body: '38周', ui_artifact: true, record_kind: 'ui_artifact'},
  {comment_id: 'ui2', body_clean: '', raw_body: '查看翻译', ui_artifact: true, record_kind: 'ui_artifact'}
], dogQueries);
assert.ok(laterDog.length > 0);
assert.ok(laterDog.every(item => item.discovery_round === 2 && item.source_terms.length >= 2));
assert.ok(laterDog.every(item => !item.source_terms.includes('38周') && !item.source_terms.includes('查看翻译')));
assert.ok(laterDog.some(item => item.evidence_comment_ids.includes('dc1')));
assert.ok(!core.communityTerms([{post_id: 'dp1', post_text: 'dog lick bowl\n38 weeks\nSee translation'}], [])
  .some(item => ['weeks', 'translation'].includes(item.term)));

const rows245 = Array.from({length: 245}, (_, index) => ({comment_id: `c${index}`, body: `comment ${index}`}));
assert.equal(core.applyCommentBudget(rows245, 0).length, 245);
assert.equal(core.commentBudgetReached(245, 0), false);
assert.equal(core.applyCommentBudget(rows245, 100).length, 100);
assert.equal(core.frontierClosed(0, 2), true);
assert.equal(core.frontierClosed(1, 2), false);
assert.equal(core.frontierClosed(0, 1), false);

const artifactMerge = core.mergeComments([
  {post_id: 'p1', source_dom_key: 'ui', raw_body: '38周', body: '38周'},
  {post_id: 'p1', source_dom_key: 'ui', raw_body: '38周', body: '38周'},
  {post_id: 'p1', raw_body: 'real no id', body: 'real no id', collected_at: '1'}
]);
assert.equal(artifactMerge.rows.length, 2);
assert.equal(artifactMerge.rows.find(row => row.ui_artifact).dedup_uncertain, false);
assert.equal(artifactMerge.rows.find(row => !row.ui_artifact).dedup_uncertain, true);
const collector = require('../scripts/facebook_playwright_collector.cjs');
const output = collector.outputRows({page_map: [{post_id: 'p1', status: 'PASS'}], raw_capture_events: [], final_rows: [
  {post_id: 'p1', comment_id: 'good', body: 'Useful dog lick bowl review'},
  {post_id: 'p1', comment_id: 'noise', raw_body: '38周', body: '38周'}
]});
assert.equal(output.raw.length, 2);
assert.equal(output.trusted.length, 1);
assert.equal(output.trusted[0].comment_id, 'good');

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-output-'));
const checkpointFixture = {asins: ['B0HMGGX71C'], stop_reason: 'fixture', resumed_from: 'checkpoint.json',
  queries: dogQueries, round_history: [], page_map: [{post_id: 'p1', status: 'PASS'}],
  final_rows: [
    {post_id: 'p1', comment_id: 'parent', parent_comment_id: 'post:p1', depth: 0, body: 'Useful parent'},
    {post_id: 'p1', comment_id: 'reply-id', reply_comment_id: 'reply-id', parent_comment_id: 'parent', depth: 1, body: 'Useful reply'},
    {post_id: 'p1', comment_id: 'noise', raw_body: '38周', body: '38周'}
  ], raw_capture_events: [
    {post_id: 'p1', comment_id: 'parent', body: 'Useful parent'},
    {post_id: 'p1', comment_id: 'parent', body: 'Useful parent'}
  ]};
const manifestFixture = collector.writeOutputs(outputDir, checkpointFixture, dogMap, false);
assert.equal(manifestFixture.final_collected_count, 3);
assert.equal(manifestFixture.ui_artifact_count, 1);
assert.equal(manifestFixture.trusted_comment_count, 2);
assert.equal(manifestFixture.reply_count, 1);
assert.equal(manifestFixture.technical_duplicate_count, 1);
assert.equal(fs.readFileSync(path.join(outputDir, 'trusted_comments.jsonl'), 'utf8').trim().split(/\r?\n/).length, 2);
assert.equal(JSON.parse(fs.readFileSync(path.join(outputDir, 'page_map.json'), 'utf8')).length, 1);

assert.equal(core.auditPost({displayed_count: 2, remaining_controls: 0, stable_rounds: 2,
  orphan_reply_ids: [], incomplete_reply_lineage_ids: ['reply-no-id']}).status, 'PARTIAL');
assert.equal(core.stoppingDecision([
  {discovery_round: 1, high_relevance_candidates: 0, new_comments: 10, duplicate_rate: 0},
  {discovery_round: 2, high_relevance_candidates: 0, new_comments: 10, duplicate_rate: 0}
], {trusted: 0, posts: 0}, {maxDiscoveryRounds: 5, minNewCommentsPerRound: 3}).reason, 'two_no_high_relevance_rounds');
assert.equal(core.stoppingDecision([
  {discovery_round: 1, high_relevance_candidates: 2, new_comments: 0, duplicate_rate: 0},
  {discovery_round: 2, high_relevance_candidates: 1, new_comments: 1, duplicate_rate: 0}
], {trusted: 0, posts: 0}, {maxDiscoveryRounds: 5, minNewCommentsPerRound: 3}).reason, 'two_low_yield_rounds');
assert.equal(core.stoppingDecision([
  {discovery_round: 1, high_relevance_candidates: 2, new_comments: 10, duplicate_rate: .9},
  {discovery_round: 2, high_relevance_candidates: 1, new_comments: 10, duplicate_rate: .9}
], {trusted: 0, posts: 0}, {maxDiscoveryRounds: 5, minNewCommentsPerRound: 3, duplicateRateStop: .85}).reason, 'two_high_duplicate_rounds');
assert.equal(core.stoppingDecision([
  {discovery_round: 1, high_relevance_candidates: 2, new_comments: 10, duplicate_rate: 0, semantic_coverage_hash: 'same'},
  {discovery_round: 2, high_relevance_candidates: 1, new_comments: 10, duplicate_rate: 0, semantic_coverage_hash: 'same'}
], {trusted: 0, posts: 0}, {maxDiscoveryRounds: 5, minNewCommentsPerRound: 3}).reason, 'semantic_coverage_saturated');

const cli = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'facebook_playwright_collector.cjs'), '--help'], {encoding: 'utf8'});
assert.equal(cli.status, 0);
assert.match(cli.stdout, /preflight/);
assert.match(cli.stdout, /--asin-file/);
assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'facebook_playwright_collector.cjs'), 'utf8'), /\.\.\/extension/);
console.log('facebook core fixture PASS');
