import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import csharp from 'highlight.js/lib/languages/csharp';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import plaintext from 'highlight.js/lib/languages/plaintext';

hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('cs', csharp);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('plaintext', plaintext);

const PURIFY_CONFIG = {
  ALLOWED_TAGS: ['strong', 'em', 's', 'del', 'code', 'pre', 'br', 'a', 'span'],
  ALLOWED_ATTR: ['href', 'class', 'target', 'rel', 'data-lang'],
};

// Matches fenced code blocks: ```lang\n...```
const CODE_BLOCK_RE = /```(\w*)\r?\n([\s\S]*?)```/g;

@Pipe({ name: 'markdown', standalone: true })
export class MarkdownPipe implements PipeTransform {
  constructor(private sanitizer: DomSanitizer) {}

  transform(value: string | null | undefined): SafeHtml {
    if (!value) return '';
    const html = renderMixed(value);
    const clean = DOMPurify.sanitize(html, PURIFY_CONFIG);
    return this.sanitizer.bypassSecurityTrustHtml(String(clean));
  }
}

function renderMixed(text: string): string {
  const parts: string[] = [];
  CODE_BLOCK_RE.lastIndex = 0;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = CODE_BLOCK_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(renderInline(text.slice(lastIndex, match.index)));
    }
    parts.push(renderCodeBlock(match[2], match[1] || undefined));
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(renderInline(text.slice(lastIndex)));
  }

  return parts.join('');
}

function renderInline(text: string): string {
  return text
    .split('\n')
    .map(line => marked.parseInline(line) as string)
    .join('<br>');
}

function renderCodeBlock(code: string, lang: string | undefined): string {
  const language = lang && hljs.getLanguage(lang) ? lang : undefined;
  const highlighted = language
    ? hljs.highlight(code, { language }).value
    : escapeHtml(code);
  const langAttr = language ? ` data-lang="${language}"` : '';
  return `<pre${langAttr}><code class="hljs">${highlighted}</code></pre>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
