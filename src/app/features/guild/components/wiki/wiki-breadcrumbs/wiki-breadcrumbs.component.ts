import {Component, computed, input, output} from '@angular/core';
import {Button} from 'primeng/button';
import {Tooltip} from 'primeng/tooltip';
import {TranslateModule} from '@ngx-translate/core';
import {WikiDto, WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {buildTrail, TrailSegment} from './wiki-trail';

export type SaveStatus = 'idle' | 'draft' | 'saving' | 'saved' | 'error';

/** The slim bar above the article: where you are on the left, what you can do on the right. */
@Component({
    selector: 'app-wiki-breadcrumbs',
    imports: [Button, Tooltip, TranslateModule],
    templateUrl: './wiki-breadcrumbs.component.html',
})
export class WikiBreadcrumbsComponent {
    readonly wiki = input<WikiDto | null>(null);
    readonly pageId = input<string | null>(null);
    readonly editing = input(false);
    readonly saveStatus = input<SaveStatus>('idle');
    readonly canEdit = input(false);
    readonly canDelete = input(false);

    readonly openSegment = output<WikiPageSummaryDto>();
    /** Drawer requests for widths where the nav and rail columns are not on screen. */
    readonly openNav = output<void>();
    readonly openRail = output<void>();
    readonly draftWithAi = output<void>();
    readonly edit = output<void>();
    readonly save = output<void>();
    readonly cancel = output<void>();
    readonly history = output<void>();
    readonly deletePage = output<void>();
    readonly share = output<void>();
    readonly ask = output<void>();

    protected readonly trail = computed(() => buildTrail(this.wiki(), this.pageId()));

    protected readonly statusLabel = computed(() => {
        switch (this.saveStatus()) {
            case 'draft':
                return 'WIKI.STATUS.DRAFT_SAVED';
            case 'saving':
                return 'WIKI.STATUS.SAVING';
            case 'saved':
                return 'WIKI.STATUS.SAVED';
            case 'error':
                return 'WIKI.STATUS.SAVE_FAILED';
            default:
                return '';
        }
    });

    /** The last segment is where you already are, so it is text rather than a link. */
    protected isLast(segment: TrailSegment): boolean {
        const trail = this.trail();
        return trail[trail.length - 1]?.id === segment.id;
    }

    protected onSegment(segment: TrailSegment): void {
        if (segment.kind !== 'page' || this.isLast(segment)) return;
        const page = this.wiki()?.pages.find(p => p.id === segment.id);
        if (page) this.openSegment.emit(page);
    }
}
