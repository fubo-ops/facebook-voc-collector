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

const cli = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'facebook_playwright_collector.cjs'), '--help'], {encoding: 'utf8'});
assert.equal(cli.status, 0);
assert.match(cli.stdout, /preflight/);
assert.match(cli.stdout, /--asin-file/);
assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'facebook_playwright_collector.cjs'), 'utf8'), /\.\.\/extension/);
console.log('facebook core fixture PASS');
