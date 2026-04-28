import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const PURIFY_CONFIG = {
  ALLOWED_TAGS: ['strong', 'em', 's', 'del', 'code', 'br', 'a', 'span'],
  ALLOWED_ATTR: ['href', 'class', 'target', 'rel'],
};

/**
 * Renders inline markdown (bold, italic, strikethrough, code, links) inside a
 * chat message. Each line is processed independently so newlines become <br>.
 *
 * Security: all output is sanitised with DOMPurify before Angular receives it.
 * bypassSecurityTrustHtml is only called on the sanitised string.
 */
@Pipe({ name: 'markdown', standalone: true })
export class MarkdownPipe implements PipeTransform {
  constructor(private sanitizer: DomSanitizer) {}

  transform(value: string | null | undefined): SafeHtml {
    if (!value) return '';
    const lines = value.split('\n');
    const html = lines
      .map(line => marked.parseInline(line) as string)
      .join('<br>');
    const clean = DOMPurify.sanitize(html, PURIFY_CONFIG);
    return this.sanitizer.bypassSecurityTrustHtml(String(clean));
  }
}
