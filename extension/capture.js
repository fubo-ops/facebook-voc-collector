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
    const texts = autoNodes.filter(node => authorNode ? !authorNode.contains(node) : node !== fallbackAuthorNode)
      .map(node => (node.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(text => text && text !== author && !/^(like|reply|share|follow|赞|回复|分享|关注|查看翻译)$/i.test(text));
    const body = texts.sort((a, b) => b.length - a.length)[0] || '';
    if (!body) continue;
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
      author, body,
      created_at: timeNode && (timeNode.getAttribute('aria-label') || timeNode.getAttribute('title') || timeNode.innerText) || fallbackTime,
      reaction_count: reaction, comment_url: permalink ? permalink.url.href : '',
      dom_key: card.getAttribute('aria-label') || `${author}|${body}|${fallbackTime}`});
  }
  const replyControls = node => [...node.querySelectorAll('[role="button"], button')]
    .filter(button => /view .*repl|hide .*repl|see .*repl|查看.*回复|隐藏.*回复/i.test((button.innerText || '').trim()));
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
  const depthOf = (index, visited = new Set()) => {
    const parent = parentEntries[index];
    if (!parent || visited.has(parent)) return 0;
    visited.add(parent);
    return 1 + depthOf(entries.indexOf(parent), visited);
  };
  const comments = entries.map((entry, index) => ({
    comment_id: entry.comment_id,
    parent_comment_id: parentEntries[index] ? (parentEntries[index].comment_id || `unresolved:${parentEntries[index].dom_key}`) : '',
    depth: depthOf(index), author: entry.author, body: entry.body, created_at: entry.created_at,
    reaction_count: entry.reaction_count, comment_url: entry.comment_url, dom_key: entry.dom_key
  }));
  const controls = [...document.querySelectorAll('[role="button"], button')]
    .filter(button => button.offsetParent !== null && /view .*repl|see .*repl|view more comments|see more comments|more comments|查看更多评论|查看.*回复/i.test((button.innerText || '').trim()));
  const ratio = [...pageText.matchAll(/(?:^|\s)([\d,]+)\s*\/\s*([\d,]+)(?:\s|$)/g)].map(match => Number(match[2].replace(/,/g, ''))).filter(Boolean);
  const countMatch = pageText.match(/(?:^|\s)([\d,]+)\s+comments\b|([\d,]+)\s*条评论/i);
  const displayed = ratio[0] || (countMatch ? Number((countMatch[1] || countMatch[2]).replace(/,/g, '')) : null);
  const postText = [...document.querySelectorAll('[dir="auto"]')].map(node => (node.innerText || '').trim())
    .filter(Boolean).sort((a, b) => b.length - a.length)[0] || '';
  return {post_id: postId, post_url: url.href, post_title: document.title, post_text: postText,
    displayed_count: displayed, remaining_controls: controls.length,
    control_labels: controls.map(control => (control.innerText || '').trim()).slice(0, 50), comments};
}

function expandVisible(limit = 1) {
  const buttons = [...document.querySelectorAll('[role="button"], button')]
    .filter(button => button.offsetParent !== null && !button.disabled &&
      /view .*repl|see .*repl|view more comments|see more comments|more comments|查看更多评论|查看.*回复/i.test((button.innerText || '').trim()))
    .slice(0, Math.max(1, Number(limit) || 1));
  const actions = buttons.map((button, index) => ({index, label: (button.innerText || '').trim()}));
  buttons.forEach(button => button.click());
  return actions;
}

globalThis.FacebookCapture = {extractVisible, expandVisible};
if (typeof module !== 'undefined') module.exports = {extractVisible, expandVisible};
