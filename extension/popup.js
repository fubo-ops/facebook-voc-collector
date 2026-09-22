function extractVisible() {
  const url = new URL(location.href);
  const isWatch = url.pathname === '/watch/' && /^\d+$/.test(url.searchParams.get('v') || '');
  if (!['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(url.hostname) ||
      !(/\/posts\/|\/permalink\/|\/videos\/|\/reel\/|story_fbid=/.test(url.href) || isWatch)) {
    throw new Error('请先打开明确的 Facebook 帖子 URL');
  }
  const pageText = document.body.innerText || '';
  if (/captcha|verify your identity|you.re temporarily blocked|登录后继续|暂时无法使用/i.test(pageText.slice(0, 1500))) {
    throw new Error('页面出现访问限制；本次停止');
  }
  const postId = url.searchParams.get('story_fbid') || (isWatch && url.searchParams.get('v')) ||
    (url.pathname.match(/\/(?:posts|permalink|videos|reel)\/([^/?]+)/) || [])[1] || '';
  const cards = [...document.querySelectorAll('[data-commentid], [data-testid="UFI2Comment/root"], [role="article"]')];
  for (const link of document.querySelectorAll('a[href*="comment_id="]')) {
    const linked = new URL(link.href, location.href);
    if (!/^\d+$/.test(linked.searchParams.get('comment_id') || '')) continue;
    let card = link;
    for (let i = 0; i < 7 && card.parentElement; i++) {
      card = card.parentElement;
      if ([...card.querySelectorAll('[role="button"], button')]
          .some(b => /^(reply|回复)$/i.test((b.innerText || '').trim()))) break;
    }
    cards.push(card);
  }
  const entries = [];
  const domSeen = new Set();
  for (const card of cards) {
    const permalink = [...card.querySelectorAll('a[href]')].find(a => {
      const linked = new URL(a.href, location.href);
      return /^\d+$/.test(linked.searchParams.get('comment_id') || '') || /\/comment\//.test(linked.pathname);
    });
    const replyButton = [...card.querySelectorAll('[role="button"], button')]
      .some(b => /^(reply|回复)$/i.test((b.innerText || '').trim()));
    if (!card.getAttribute('data-commentid') && !permalink && !replyButton) continue;
    const permalinkUrl = permalink && new URL(permalink.href, location.href);
    const replyId = permalinkUrl && permalinkUrl.searchParams.get('reply_comment_id');
    const parentId = replyId && permalinkUrl.searchParams.get('comment_id');
    const id = replyId || card.getAttribute('data-commentid') ||
      (permalinkUrl && (permalinkUrl.searchParams.get('comment_id') ||
       (permalinkUrl.href.match(/\/comment\/([^/?]+)/) || [])[1])) || '';
    const texts = [...card.querySelectorAll('[dir="auto"]')].map(n => (n.innerText || '').trim())
      .filter(t => t && !/^(like|reply|share|赞|回复|分享)$/i.test(t));
    const body = texts.sort((a, b) => b.length - a.length)[0] || '';
    if (!body) continue;
    const key = id || card;
    if (domSeen.has(key)) continue;
    domSeen.add(key);
    const author = (card.querySelector('a[role="link"], h3 a, strong a') || {}).innerText || '';
    entries.push({card, comment_id: id, explicit_parent_id: parentId || '', author: author.trim(), body,
      comment_url: permalink ? permalink.href : ''});
  }
  const replyControls = node => [...node.querySelectorAll('[role="button"], button')]
    .filter(b => /view .*repl|hide .*repl|查看.*回复|隐藏.*回复/i.test((b.innerText || '').trim()));
  const branchUnder = (node, wrapper) => {
    while (node && node.parentElement !== wrapper) node = node.parentElement;
    return node;
  };
  const parents = entries.map((entry, index) => {
    if (entry.explicit_parent_id) {
      const match = entries.find(candidate => candidate.comment_id === entry.explicit_parent_id);
      if (match) return match;
    }
    const explicit = entry.card.parentElement && entry.card.parentElement.closest('[data-commentid]');
    if (explicit) {
      const match = entries.find(candidate => candidate !== entry && candidate.card === explicit);
      if (match) return match;
    }
    let wrapper = entry.card.parentElement;
    for (let level = 0; wrapper && level < 5; level++, wrapper = wrapper.parentElement) {
      const earlier = entries.slice(0, index)
        .filter(candidate => wrapper.contains(candidate.card));
      const candidate = earlier[earlier.length - 1];
      if (!candidate) continue;
      const parentBranch = branchUnder(candidate.card, wrapper);
      const replyBranch = branchUnder(entry.card, wrapper);
      const hasBridge = replyControls(wrapper).some(control => {
        const controlBranch = branchUnder(control, wrapper);
        return controlBranch !== parentBranch && controlBranch !== replyBranch;
      });
      if (hasBridge) return candidate;
    }
    return null;
  });
  const depthOf = (index, seen = new Set()) => {
    const parent = parents[index];
    if (!parent || seen.has(parent)) return 0;
    seen.add(parent);
    const parentIndex = entries.indexOf(parent);
    return 1 + depthOf(parentIndex, seen);
  };
  const comments = entries.map((entry, index) => ({comment_id: entry.comment_id,
    parent_comment_id: parents[index] ? parents[index].comment_id : '', depth: depthOf(index),
    author: entry.author, body: entry.body, created_at: '', reaction_count: '',
    comment_url: entry.comment_url}));
  const controls = [...document.querySelectorAll('[role="button"], button')];
  const remaining = controls.filter(b => /view .*repl|view more comments|see more comments|查看更多评论|查看.*回复/i.test((b.innerText || '').trim())).length;
  const countMatch = pageText.match(/(?:^|\s)([\d,]+)\s+comments\b|([\d,]+)\s*条评论/i);
  const displayed = countMatch ? Number((countMatch[1] || countMatch[2]).replace(/,/g, '')) : null;
  return {post_id: postId, post_url: url.href, post_title: document.title,
    displayed_count: displayed, remaining_controls: remaining, comments};
}

function expandVisible() {
  const buttons = [...document.querySelectorAll('[role="button"], button')]
    .filter(b => /view .*repl|view more comments|see more comments|查看更多评论|查看.*回复/i.test((b.innerText || '').trim()))
    .slice(0, 10);
  buttons.forEach(button => button.click());
  return buttons.length;
}

async function sessionToken() {
  const response = await fetch('http://127.0.0.1:43128/session');
  const result = await response.json();
  if (!response.ok || !result.token) throw new Error(result.error || '本地接收器未启动');
  return result.token;
}

async function activeTab() {
  const tabs = await chrome.tabs.query({active: true, currentWindow: true});
  if (tabs.length !== 1) throw new Error('当前标签页不可用');
  return tabs[0].id;
}

async function inject(fn) {
  const result = await chrome.scripting.executeScript({target: {tabId: await activeTab()}, func: fn});
  return result[0].result;
}

if (typeof document !== 'undefined') {
  const status = document.getElementById('status');
  document.getElementById('expand').onclick = async () => {
    try { status.textContent = `已展开 ${await inject(expandVisible)} 个入口；等待页面加载后再次采集。`; }
    catch (error) { status.textContent = error.message; }
  };
  document.getElementById('capture').onclick = async () => {
    try {
      const token = await sessionToken();
      const capture = await inject(extractVisible);
      const response = await fetch('http://127.0.0.1:43128/capture', {
        method: 'POST', headers: {'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json'},
        body: JSON.stringify(capture)});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      status.textContent = `本批读取 ${capture.comments.length} 条；当前原始交付 ${result.final_collected_count} 条。`;
    } catch (error) { status.textContent = error.message; }
  };
}

if (typeof module !== 'undefined') module.exports = {extractVisible, expandVisible, sessionToken};
