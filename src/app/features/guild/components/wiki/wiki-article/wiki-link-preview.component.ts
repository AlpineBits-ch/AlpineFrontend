import {Component, input} from '@angular/core';
import {DatePipe} from '@angular/common';
import {TranslateModule} from '@ngx-translate/core';
import {WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';

/** What a wiki: link points at, without going there: following an edge to find out it was not the one you wanted costs a page load plus a trip back. The snippet is whatever the content cache already happens to hold, since a full warm is one request over the whole wiki and hovering a link is not a good enough reason to spend that; a cold link shows its metadata and no body rather than stalling behind an unrequested fetch. */
@Component({
    selector: 'app-wiki-link-preview',
    imports: [DatePipe, TranslateModule],
    template: `
        @if (open() && page(); as _) {
            <div
                [style.left.px]="position().left"
                [style.top.px]="position().top"
                class="pointer-events-none fixed z-50 w-72 rounded-xl border border-border
                        bg-card p-3 shadow-xl"
            >
                <p class="m-0 truncate text-[0.8125rem] font-semibold text-white/85">
                    {{ page()!.title }}
                </p>
                <p class="m-0 mt-0.5 text-[0.6875rem] text-white/30">
                    {{ 'WIKI.RAIL.UPDATED' | translate: {date: page()!.updatedAt | date: 'MMM d, y'} }}
                </p>
                @if (snippet()) {
                    <p class="m-0 mt-2 line-clamp-4 text-[0.75rem] leading-relaxed text-white/55">
                        {{ snippet() }}
                    </p>
                }
            </div>
        }
    `,
})
export class WikiLinkPreviewComponent {
    readonly open = input(false);
    readonly page = input<WikiPageSummaryDto | null>(null);
    readonly snippet = input('');
    readonly position = input<{top: number; left: number}>({top: 0, left: 0});
}
