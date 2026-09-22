const assert = require('node:assert/strict');
const {extractVisible, expandVisible, sessionToken} = require('../extension/popup.js');
const {extractVisible: extractAutomated} = require('../scripts/facebook_visible_capture.js');

class FakeNode {
  constructor(tag = 'div', attrs = {}, innerText = '') {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.innerText = innerText;
    this.href = attrs.href || '';
    this.parentElement = null;
    this.children = [];
  }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  click() {}
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.matches(selector)) return node;
    }
    return null;
  }
  matches(selector) {
    if (selector === '[data-commentid]') return Boolean(this.attrs['data-commentid']);
    if (selector === '[role="article"]') return this.attrs.role === 'article';
    if (selector === '[data-testid="UFI2Comment/root"]') return this.attrs['data-testid'] === 'UFI2Comment/root';
    if (selector === '[role="button"]') return this.attrs.role === 'button';
    if (selector === 'button') return this.tagName === 'BUTTON';
    if (selector === '[dir="auto"]') return this.attrs.dir === 'auto';
    if (selector === 'a[href]') return this.tagName === 'A' && Boolean(this.href);
    if (selector === 'a[href*="comment_id="]') return this.tagName === 'A' && this.href.includes('comment_id=');
    if (selector === 'a[role="link"]') return this.tagName === 'A' && this.attrs.role === 'link';
    return false;
  }
  querySelectorAll(selector) {
    const alternatives = selector.split(',').map(part => part.trim());
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (alternatives.some(part => child.matches(part))) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function comment(id, author, body, parentId = '') {
  const attrs = parentId ? {role: 'article'} : {'data-commentid': id};
  const query = parentId ? `comment_id=${parentId}&reply_comment_id=${id}` : `comment_id=${id}`;
  return new FakeNode('div', attrs).append(
    new FakeNode('a', {role: 'link'}, author),
    new FakeNode('span', {dir: 'auto'}, body),
    new FakeNode('a', {href: `https://www.facebook.com/example/posts/p1?${query}`}, '1h'),
    new FakeNode('button', {}, 'Reply'));
}

function installDocument(root, href = 'https://www.facebook.com/example/posts/p1', bodyText = '6 comments') {
  global.location = {href};
  global.document = {
    title: 'Dog joints',
    body: Object.assign(root, {innerText: bodyText}),
    querySelectorAll: selector => root.querySelectorAll(selector)
  };
}

const root = new FakeNode('main');
const thread = new FakeNode('div');
const parent = comment('1001', 'A', 'Parent comment');
const reply = comment('1002', 'B', 'Nested reply', '1001');
thread.append(parent, new FakeNode('button', {}, '查看1条回复'), new FakeNode('div').append(reply));
root.append(thread, comment('1003', 'C', 'Unrelated top-level comment'));
installDocument(root);

const result = extractVisible();
assert.equal(result.post_id, 'p1');
assert.equal(result.comments.length, 3);
assert.equal(result.comments.find(item => item.comment_id === '1002').parent_comment_id, '1001');
assert.equal(result.comments.find(item => item.comment_id === '1002').depth, 1);
assert.equal(result.comments.find(item => item.comment_id === '1003').parent_comment_id, '');
assert.equal(result.displayed_count, 6);
assert.equal(expandVisible(), 1);
const automated = extractAutomated();
assert.equal(automated.comments.find(item => item.comment_id === '1002').parent_comment_id, '1001');
assert.equal(automated.comments.find(item => item.comment_id === '1002').depth, 1);

const siblingRoot = new FakeNode('main');
const siblingThread = new FakeNode('div');
const idlessParent = new FakeNode('div', {role: 'article', 'data-testid': 'UFI2Comment/root'}).append(
  new FakeNode('a', {role: 'link'}, 'Parent'), new FakeNode('span', {dir: 'auto'}, 'Parent without permalink'),
  new FakeNode('button', {}, 'Reply'));
const linkedReply = comment('2002', 'Reply', 'Sibling reply', '2001');
siblingThread.append(idlessParent, new FakeNode('button', {}, '全部 1 条回复'), new FakeNode('div').append(linkedReply));
siblingRoot.append(siblingThread);
installDocument(siblingRoot);
const siblingCapture = extractAutomated();
assert.equal(siblingCapture.comments.find(item => item.body === 'Parent without permalink').comment_id, '2001');
assert.equal(siblingCapture.comments.find(item => item.comment_id === '2002').parent_comment_id, '2001');
assert.equal(siblingCapture.comments.find(item => item.comment_id === '2002').depth, 1);

const orphanRoot = new FakeNode('main').append(comment('3002', 'Reply', 'Orphan until parent loads', '3001'));
installDocument(orphanRoot);
const orphanCapture = extractAutomated();
assert.equal(orphanCapture.comments[0].parent_comment_id, '3001');
assert.equal(orphanCapture.comments[0].depth, 1);
assert.deepEqual(require('../scripts/facebook_voc_core.cjs').deriveDepths(orphanCapture.comments, 'p1'), ['3002']);

installDocument(new FakeNode('main'), 'https://www.facebook.com/example/posts/p1', '暂无评论 成为第一个评论者');
const emptyCapture = extractAutomated();
assert.equal(emptyCapture.displayed_count, 0);
assert.equal(emptyCapture.zero_comment_evidence, true);
installDocument(new FakeNode('main'), 'https://www.facebook.com/example/posts/p1', '评论');
assert.equal(extractAutomated().displayed_count, null);

const encodedRoot = new FakeNode('main');
const encodedId = Buffer.from('comment:999_4563578640527507').toString('base64');
encodedRoot.append(new FakeNode('div', {role: 'article', 'aria-label': '评论者：D1周前'}).append(
  new FakeNode('a', {role: 'link'}, 'D'),
  new FakeNode('span', {dir: 'auto'}, 'Decoded Facebook comment'),
  new FakeNode('a', {href: `https://www.facebook.com/profile?comment_id=${encodedId}`}, '1周')));
installDocument(encodedRoot);
assert.equal(extractAutomated().comments[0].comment_id, '4563578640527507');

installDocument(root, 'https://www.facebook.com/watch/?v=1480128156214957');
assert.equal(extractVisible().post_id, '1480128156214957');
installDocument(root, 'https://example.com/post/1');
assert.throws(extractVisible, /Facebook/);
global.fetch = async () => ({ok: true, json: async () => ({token: 'AUTO_TOKEN'})});
sessionToken().then(token => {
  assert.equal(token, 'AUTO_TOKEN');
  console.log('popup capture, reply-tree, and automatic pairing fixture PASS');
});
