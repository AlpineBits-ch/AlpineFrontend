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
  ],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'class', 'target', 'rel'],
};

export function renderWikiMarkdown(content: string, sanitizer: DomSanitizer): SafeHtml {
  if (!content) return '';
  // HTML content from WYSIWYG editor; skip markdown parsing
  const raw = content.trimStart().startsWith('<') ? content : (marked.parse(content) as string);
  const clean = DOMPurify.sanitize(raw, WIKI_PURIFY_CONFIG);
  return sanitizer.bypassSecurityTrustHtml(clean);
}

export function formatWikiDate(date: Date): string {
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
