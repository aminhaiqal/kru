import { escape } from './dom.js';

import { Marked, Renderer } from 'marked';
import DOMPurify from 'dompurify';

const renderer = new Renderer();
// HTML discussed in a reply is content, rather than executable application markup.
renderer.html = ({ text }) => escape(text);
renderer.image = ({ href, text }) => `<a href="${escape(href)}">${escape(text || 'Image')}</a>`;
const markdown = new Marked({ gfm: true, breaks: false, renderer });
const cache = new Map();

function renderChatMarkdown(text) {
  const cached = cache.get(text);
  if (cached !== undefined) return cached;
  const template = document.createElement('template');
  template.innerHTML = DOMPurify.sanitize(markdown.parse(text, { async: false }), {
    ALLOWED_TAGS: [
      'p',
      'br',
      'strong',
      'em',
      'del',
      'a',
      'ul',
      'ol',
      'li',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'blockquote',
      'pre',
      'code',
      'hr',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'input',
    ],
    ALLOWED_ATTR: ['href', 'title', 'class', 'start', 'align', 'type', 'disabled', 'checked'],
    ALLOW_DATA_ATTR: false,
  });
  for (const anchor of template.content.querySelectorAll('a')) {
    const href = anchor.getAttribute('href') || '';
    if (!/^(https?:\/\/|mailto:)/i.test(href)) {
      anchor.replaceWith(...anchor.childNodes);
      continue;
    }
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
  }
  for (const checkbox of template.content.querySelectorAll('input')) {
    checkbox.type = 'checkbox';
    checkbox.disabled = true;
  }
  for (const table of template.content.querySelectorAll('table')) {
    const scroll = document.createElement('div');
    scroll.className = 'markdown-table-scroll';
    table.replaceWith(scroll);
    scroll.append(table);
  }
  const html = template.innerHTML;
  if (text.length <= 64 * 1024) {
    if (cache.size >= 100) cache.delete(cache.keys().next().value);
    cache.set(text, html);
  }
  return html;
}

export { renderChatMarkdown };
