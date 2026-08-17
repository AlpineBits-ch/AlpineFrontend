import {DomSanitizer, SafeHtml} from '@angular/platform-browser';
import {marked} from 'marked';
import DOMPurify from 'dompurify';

const WIKI_PURIFY_CONFIG = {
    ALLOWED_TAGS: [
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'p',
        'br',
        'hr',
        'strong',
        'em',
        'del',
        's',
        'u',
        'code',
        'pre',
        'ul',
        'ol',
        'li',
        'blockquote',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
        'a',
        'img',
        'span',
        'div',
        'input',
        'label',
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
        // When marked parses `- [x] text`, the text is a raw text node (direct child of li),
        // not a child element. Wrap it in a span so CSS `> :not(input)` can target it.
        if (input.parentElement === li) {
            const rest = Array.from(li.childNodes).filter(n => n !== input);
            if (rest.length > 0) {
                const span = document.createElement('span');
                rest.forEach(n => span.appendChild(n));
                li.appendChild(span);
            }
        }
    });
    return div.innerHTML;
}

/**
 * DOMPurify's default protocol allowlist, plus `wiki:`.
 *
 * An AI answer cites its sources as ordinary wiki links, and the default regexp drops any href
 * whose scheme it does not recognise - which is every citation. The alternative was to not render
 * the answer as markdown at all, which is what left `##` and `**` showing literally on screen.
 * Widening the allowlist by exactly one internal scheme is the smaller concession: a `wiki:` href
 * navigates inside the app and can never reach the network.
 */
const WIKI_ANSWER_URI_REGEXP = /^(?:(?:(?:f|ht)tps?|mailto|wiki):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

/**
 * Renders an AI answer, keeping its citations clickable.
 *
 * Same sanitiser as everything else in the wiki, so an answer is held to the same schema as page
 * content; only the URI allowlist differs, and only by `wiki:`.
 */
export function renderWikiAnswer(content: string, sanitizer: DomSanitizer): SafeHtml {
    if (!content) return '';
    const raw = marked.parse(content) as string;
    const clean = DOMPurify.sanitize(raw, {
        ...WIKI_PURIFY_CONFIG,
        ALLOWED_URI_REGEXP: WIKI_ANSWER_URI_REGEXP,
    });
    return sanitizer.bypassSecurityTrustHtml(clean);
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
