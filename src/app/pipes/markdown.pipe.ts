import {Pipe, PipeTransform} from '@angular/core';
import {DomSanitizer, SafeHtml} from '@angular/platform-browser';
import {marked} from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';

const PURIFY_CONFIG = {
    ALLOWED_TAGS: ['strong', 'em', 's', 'del', 'code', 'pre', 'br', 'a', 'span'],
    ALLOWED_ATTR: ['href', 'class', 'target', 'rel', 'data-lang'],
};

// Matches fenced code blocks: ```lang\n...\n```
const CODE_BLOCK_RE = /```(\w*)\r?\n([\s\S]*?)```/g;

@Pipe({name: 'markdown', standalone: true})
export class MarkdownPipe implements PipeTransform {
    constructor(private sanitizer: DomSanitizer) {
    }

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
        // Leading/trailing whitespace on a line is never visually significant in chat
        // messages, but a browser only collapses it away at the start/end of a block -
        // not after a <br>. Left untrimmed, a stray leading space renders as a real
        // one-space indent, throwing off alignment between lines.
        .map(line => marked.parseInline(line.trim()) as string)
        .join('<br>');
}

function renderCodeBlock(code: string, lang: string | undefined): string {
    const language = lang && hljs.getLanguage(lang) ? lang : undefined;
    const highlighted = language
        ? hljs.highlight(code, {language}).value
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
