import {inject, Pipe, PipeTransform} from '@angular/core';
import {DomSanitizer, SafeHtml} from '@angular/platform-browser';

@Pipe({name: 'highlight', standalone: true})
export class HighlightPipe implements PipeTransform {
    private sanitizer = inject(DomSanitizer);

    transform(text: string, query: string): SafeHtml {
        if (!query.trim()) return text;
        const escaped = text.replace(/[<>&"']/g, c =>
            ({'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;'}[c] ?? c)
        );
        const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const highlighted = escaped.replace(
            new RegExp(escapedQuery, 'gi'),
            match => `<mark class="search-highlight">${match}</mark>`
        );
        return this.sanitizer.bypassSecurityTrustHtml(highlighted);
    }
}
