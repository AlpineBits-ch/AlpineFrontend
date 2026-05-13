import {DomSanitizer, SafeHtml} from '@angular/platform-browser';
import {marked} from 'marked';
import DOMPurify from 'dompurify';

const WIKI_PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'strong', 'em', 'del', 's', 'u',
    'code', 'pre',
    'ul', 'ol', 'li',
    'blockquote',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'a', 'img',
    'span', 'div',
    'input', 'label',
  ],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'class', 'target', 'rel', 'type', 'checked'],
};

function tagTaskItems(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('li').forEach(li => {
    const input = li.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!input) return;
    li.classList.add('wiki-task-item');
    if (input.checked || input.hasAttribute('checked')) {
      li.classList.add('wiki-task-checked');
    }
  });
  return div.innerHTML;
}

export function renderWikiMarkdown(content: string, sanitizer: DomSanitizer): SafeHtml {
  if (!content) return '';
  const raw = content.trimStart().startsWith('<') ? content : (marked.parse(content) as string);
  const clean = tagTaskItems(DOMPurify.sanitize(raw, WIKI_PURIFY_CONFIG));
  return sanitizer.bypassSecurityTrustHtml(clean);
}

export function toggleNthCheckbox(content: string, index: number, checked: boolean): string {
  const isHtml = content.trimStart().startsWith('<');
  if (isHtml) {
    const div = document.createElement('div');
    div.innerHTML = content;
    const checkboxes = div.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const box = checkboxes[index];
    if (!box) return content;
    if (checked) {
      box.setAttribute('checked', '');
    } else {
      box.removeAttribute('checked');
    }
    const li = box.closest('li[data-type="taskItem"]');
    if (li) li.setAttribute('data-checked', String(checked));
    return div.innerHTML;
  }
  let count = -1;
  return content.replace(/^(\s*[-*+] )\[([ xX])\]/gm, (match, prefix) => {
    count++;
    if (count !== index) return match;
    return `${prefix}[${checked ? 'x' : ' '}]`;
  });
}

export function formatWikiDate(date: Date): string {
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
