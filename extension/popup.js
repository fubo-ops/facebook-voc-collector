function extractVisible() {
  const url = new URL(location.href);
  const isWatch = url.pathname === '/watch/' && /^[A-Za-z0-9._:-]+$/.test(url.searchParams.get('v') || '');
  if (!['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(url.hostname) ||
      !(/\/posts\/|\/permalink\/|\/videos\/|\/reels?\/|story_fbid=/.test(url.href) || isWatch)) {
    throw new Error('请先打开明确的 Facebook 帖子 URL');
  }
  const pageText = document.body.innerText || '';
  if (/captcha|verify your identity|you.re temporarily blocked|登录后继续|暂时无法使用|操作过于频繁/i.test(pageText.slice(0, 2500))) {
    throw new Error('页面出现访问限制；本次停止');
  }
  const postId = url.searchParams.get('story_fbid') || (isWatch && url.searchParams.get('v')) ||
    (url.pathname.match(/\/(?:posts|permalink|videos|reels?)\/([^/?]+)/) || [])[1] || '';
  const decodedCommentId = value => {
    if (/^\d+$/.test(value || '')) return value;
    try {
      const decoded = atob(String(value || '').replace(/-/g, '+').replace(/_/g, '/'));
      return (decoded.match(/comment:\d+_(\d+)/) || [])[1] || '';
    } catch { return ''; }
  };
  const classifyBody = value => {
    const raw_body = String(value || '').replace(/\r\n?/g, '\n').trim();
    const relativeTime = /^(?:\d+\s*(?:周|天|小时|分钟|月|年)|刚刚|昨天|\d+\s*(?:w|wk|wks|week|weeks|d|day|days|h|hr|hrs|hour|hours|min|mins|minute|minutes))$/i;
    const uiLabel = /^(?:查看翻译|写评论(?:…|\.\.\.)?|写回复(?:…|\.\.\.)?|作者留下了心情|在线状态指示标|赞|点赞|回复|分享|关注|最相关|所有评论|see translation|write a comment(?:…|\.\.\.)?|write a reply(?:…|\.\.\.)?|author (?:left a reaction|reacted)|active status indicator|like|reply|share|follow|most relevant|all comments)$/i;
    const kept = [], reasons = [];
    for (const line of raw_body.split(/\n+/).map(item => item.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
      if (relativeTime.test(line)) reasons.push('relative_time');
      else if (uiLabel.test(line)) reasons.push('ui_label');
      else kept.push(line);
    }
    const body_clean = kept.join(' ').replace(/\s+/g, ' ').trim();
    const ui_artifact = Boolean(raw_body) && !body_clean && reasons.length > 0;
    return {raw_body, body_clean, ui_artifact,
      ui_artifact_reason: ui_artifact ? [...new Set(reasons)].join('|') : '',
      record_kind: ui_artifact ? 'ui_artifact' : 'comment'};
  };
  const links = [...document.querySelectorAll('a[href*="comment_id="]')].filter(link => {
    try {
      const linked = new URL(link.href, location.href);
      return Boolean(decodedCommentId(linked.searchParams.get('reply_comment_id') || linked.searchParams.get('comment_id')));
    } catch { return false; }
  });
  const cards = [...document.querySelectorAll('[data-commentid], [data-testid="UFI2Comment/root"], [role="article"][aria-label*="Commenter" i], [role="article"][aria-label*="评论者"]')];
  for (const link of links) {
    let card = link.closest('[role="article"]') || link;
    if (card === link) {
      for (let i = 0; i < 8 && card.parentElement; i++) {
        card = card.parentElement;
        if ([...card.querySelectorAll('[role="button"], button')]
            .some(button => /^(reply|回复)$/i.test((button.innerText || '').trim()))) break;
      }
    }
    cards.push(card);
  }
  const entries = [], seen = new Set();
  for (const card of cards) {
    const permalink = [...card.querySelectorAll('a[href]')].map(link => {
      try { return {link, url: new URL(link.href, location.href)}; } catch { return null; }
    }).filter(Boolean).find(item => decodedCommentId(item.url.searchParams.get('reply_comment_id') || item.url.searchParams.get('comment_id')));
    const dataId = card.getAttribute('data-commentid') || '';
    const rawReplyId = permalink && permalink.url.searchParams.get('reply_comment_id');
    const rawCommentId = permalink && permalink.url.searchParams.get('comment_id');
    const replyId = decodedCommentId(rawReplyId);
    const linkCommentId = decodedCommentId(rawCommentId);
    const commentId = replyId || decodedCommentId(dataId) || linkCommentId || '';
    const parentId = replyId ? linkCommentId : '';
    const key = commentId || card;
    if (seen.has(key)) continue;
    const autoNodes = [...card.querySelectorAll('[dir="auto"]')]
      .filter(node => !node.closest('[role="button"], button') && (node.innerText || '').trim());
    const authorNode = [...card.querySelectorAll('a[role="link"], h3 a, strong a')]
      .find(node => (node.innerText || '').trim());
    const fallbackAuthorNode = autoNodes[0];
    const author = (authorNode && authorNode.innerText || fallbackAuthorNode && fallbackAuthorNode.innerText || '').replace(/\s+/g, ' ').trim();
    const bodyCandidates = autoNodes.filter(node => authorNode ? !authorNode.contains(node) : node !== fallbackAuthorNode)
      .map(node => classifyBody(node.innerText || ''))
      .filter(item => item.raw_body && item.raw_body !== author)
      .sort((a, b) => b.body_clean.length - a.body_clean.length || b.raw_body.length - a.raw_body.length);
    const bodyRecord = bodyCandidates[0] || classifyBody('');
    const body = bodyRecord.body_clean;
    if (!bodyRecord.raw_body) continue;
    seen.add(key);
    const timeNode = permalink && permalink.link;
    const fallbackTime = (card.innerText || '').split(/\r?\n/).map(text => text.trim())
      .find(text => /^\d+\s*(?:m|h|d|w|周|天|小时|分钟|年)(?:前)?$/i.test(text)) || '';
    const reaction = [...card.querySelectorAll('[role="button"], button')]
      .map(button => (button.innerText || button.getAttribute('aria-label') || '').trim())
      .find(text => /(?:reaction|心情|赞).*[\d,.万千kKmM]|^[\d,.万千kKmM]+$/.test(text)) || '';
    const label = card.getAttribute('aria-label') || '';
    const replyHint = (label.match(/(?:replied to|回复了)\s*([^'的]+)(?:'s comment|的评论)/i) || [])[1] || '';
    entries.push({card, comment_id: commentId, explicit_parent_id: parentId || '', reply_hint: replyHint.trim(),
      author, body, raw_body: bodyRecord.raw_body, body_clean: bodyRecord.body_clean,
      ui_artifact: bodyRecord.ui_artifact, ui_artifact_reason: bodyRecord.ui_artifact_reason,
      record_kind: bodyRecord.record_kind,
      created_at: timeNode && (timeNode.getAttribute('aria-label') || timeNode.getAttribute('title') || timeNode.innerText) || fallbackTime,
      reaction_count: reaction, comment_url: permalink ? permalink.url.href : '',
      dom_key: card.getAttribute('aria-label') || `${author}|${body}|${fallbackTime}`});
  }
  const replyControls = node => [...node.querySelectorAll('[role="button"], button')]
    .filter(button => /view .*repl|hide .*repl|see .*repl|查看.*回复|隐藏.*回复|全部\s*\d+\s*条回复/i.test((button.innerText || '').trim()));
  const branchUnder = (node, wrapper) => {
    while (node && node.parentElement !== wrapper) node = node.parentElement;
    return node;
  };
  const parentEntries = entries.map((entry, index) => {
    if (entry.explicit_parent_id) {
      const direct = entries.find(candidate => candidate.comment_id === entry.explicit_parent_id);
      if (direct) return direct;
    }
    if (entry.reply_hint) {
      const hinted = entries.slice(0, index).reverse().find(candidate => candidate.author &&
        (candidate.author.includes(entry.reply_hint) || entry.reply_hint.includes(candidate.author)));
      if (hinted) return hinted;
    }
    const ancestor = entry.card.parentElement && entry.card.parentElement.closest('[data-commentid]');
    if (ancestor) {
      const direct = entries.find(candidate => candidate !== entry && candidate.card === ancestor);
      if (direct) return direct;
    }
    let wrapper = entry.card.parentElement;
    for (let level = 0; wrapper && level < 4; level++, wrapper = wrapper.parentElement) {
      if (wrapper.querySelectorAll('[role="article"]').length > 3) continue;
      const prior = entries.slice(0, index).filter(candidate => wrapper.contains(candidate.card));
      const candidate = prior[prior.length - 1];
      if (!candidate) continue;
      const parentBranch = branchUnder(candidate.card, wrapper), replyBranch = branchUnder(entry.card, wrapper);
      if (replyControls(wrapper).some(control => {
        const controlBranch = branchUnder(control, wrapper);
        return controlBranch !== parentBranch && controlBranch !== replyBranch;
      })) return candidate;
    }
    return null;
  });
  parentEntries.forEach((parent, index) => {
    if (parent && entries[index].explicit_parent_id && !parent.comment_id) parent.comment_id = entries[index].explicit_parent_id;
  });
  const depthOf = (index, visited = new Set()) => {
    const parent = parentEntries[index];
    if (!parent || visited.has(parent)) return 0;
    visited.add(parent);
    return 1 + depthOf(entries.indexOf(parent), visited);
  };
  const comments = entries.map((entry, index) => ({
    comment_id: entry.comment_id,
    parent_comment_id: entry.explicit_parent_id || (parentEntries[index] ? (parentEntries[index].comment_id || `unresolved:${parentEntries[index].dom_key}`) : ''),
    depth: entry.explicit_parent_id ? Math.max(1, depthOf(index)) : depthOf(index), author: entry.author,
    body: entry.body, raw_body: entry.raw_body, body_clean: entry.body_clean,
    ui_artifact: entry.ui_artifact, ui_artifact_reason: entry.ui_artifact_reason, record_kind: entry.record_kind,
    created_at: entry.created_at,
    reaction_count: entry.reaction_count, comment_url: entry.comment_url, dom_key: entry.dom_key
  }));
  const controls = [...document.querySelectorAll('[role="button"], button')]
    .filter(button => button.offsetParent !== null && /view .*repl|see .*repl|view more comments|see more comments|more comments|previous comments|earlier comments|查看更多评论|查看之前的评论|更多评论|查看.*回复|全部\s*\d+\s*条回复|更多回复/i.test((button.innerText || '').trim()));
  const ratio = [...pageText.matchAll(/(?:^|\s)([\d,]+)\s*\/\s*([\d,]+)(?:\s|$)/g)].map(match => Number(match[2].replace(/,/g, ''))).filter(Boolean);
  const countMatch = pageText.match(/(?:^|\s)([\d,]+)\s+comments\b|([\d,]+)\s*条评论/i);
  const zeroCommentEvidence = /no comments yet|be the first to comment|暂无评论|还没有评论|成为第一个评论者|第一个发表评论/i.test(pageText);
  const displayed = countMatch ? Number((countMatch[1] || countMatch[2]).replace(/,/g, '')) : (ratio[0] || (zeroCommentEvidence ? 0 : null));
  const postText = [...document.querySelectorAll('[dir="auto"]')].map(node => (node.innerText || '').trim())
    .filter(Boolean).sort((a, b) => b.length - a.length)[0] || '';
  return {post_id: postId, post_url: url.href, post_title: document.title, post_text: postText,
    displayed_count: displayed, zero_comment_evidence: zeroCommentEvidence, remaining_controls: controls.length,
    control_labels: controls.map(control => (control.innerText || '').trim()).slice(0, 50), comments};
}

function expandVisible(limit = 1) {
  const buttons = [...document.querySelectorAll('[role="button"], button')]
    .filter(button => button.offsetParent !== null && !button.disabled &&
      /view .*repl|see .*repl|view more comments|see more comments|more comments|previous comments|earlier comments|查看更多评论|查看之前的评论|更多评论|查看.*回复|全部\s*\d+\s*条回复|更多回复/i.test((button.innerText || '').trim()))
    .slice(0, Math.max(1, Number(limit) || 1));
  const actions = buttons.map((button, index) => ({index, label: (button.innerText || '').trim()}));
  buttons.forEach(button => button.click());
  return actions;
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
    try {
      const expanded = await inject(expandVisible);
      status.textContent = `已展开 ${Array.isArray(expanded) ? expanded.length : expanded} 个入口；等待页面加载后再次采集。`;
    }
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
