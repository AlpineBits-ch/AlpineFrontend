import {Component, computed, input, output} from '@angular/core';
import {Button} from 'primeng/button';
import {TranslateModule} from '@ngx-translate/core';
import {WikiCategoryDto, WikiDto, WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {formatWikiDate} from '../wiki.utils';
import {WikiActivityFeedComponent} from '../wiki-activity/wiki-activity-feed.component';
import {WikiGraphPreviewComponent} from '../wiki-graph/wiki-graph-preview.component';
import {countContributors} from '../wiki-activity/wiki-activity';

export interface CategoryTreeNode {
    category: WikiCategoryDto;
    depth: number;
    pageCount: number;
}

/**
 * The wiki's front door.
 *
 * <p>It used to be four lists, three of which the nav on the left already showed - so opening it
 * told you nothing you could not see without opening it. The hierarchy is now built around the one
 * thing that is only here: what has changed, and who changed it. The counts and the category
 * overview moved to a side column, where they are orientation rather than the main event.</p>
 */
@Component({
    selector: 'app-wiki-home',
    imports: [Button, TranslateModule, WikiActivityFeedComponent, WikiGraphPreviewComponent],
    templateUrl: './wiki-home.component.html',
})
export class WikiHomeComponent {
    readonly wiki = input<WikiDto | null>(null);
    readonly canCreate = input(false);

    readonly openPage = output<WikiPageSummaryDto>();
    readonly newPage = output<void>();
    readonly draftWithAi = output<void>();
    readonly openGraph = output<void>();
    readonly openSearch = output<void>();

    protected readonly pages = computed(() => this.wiki()?.pages ?? []);
    protected readonly categories = computed(() => this.wiki()?.categories ?? []);

    protected readonly pinnedPages = computed(() => this.pages().filter(p => p.isPinned));

    protected readonly categoryTreeNodes = computed((): CategoryTreeNode[] => {
        const categories = this.categories();
        const pages = this.pages();
        const result: CategoryTreeNode[] = [];
        const buildTree = (parentId: string | undefined, depth: number) => {
            const children = categories
                .filter(c => (parentId === undefined ? !c.parentCategoryId : c.parentCategoryId === parentId))
                .sort((a, b) => a.position - b.position);
            for (const child of children) {
                result.push({
                    category: child,
                    depth,
                    pageCount: pages.filter(p => p.categoryId === child.id).length,
                });
                buildTree(child.id, depth + 1);
            }
        };
        buildTree(undefined, 0);
        return result;
    });

    protected readonly totalPages = computed(() => this.pages().length);
    protected readonly totalCategories = computed(() => this.categories().length);
    protected readonly totalContributors = computed(() => countContributors(this.pages()));
    /** Distinguishes "no wiki loaded yet" from "a wiki with nothing in it". */
    protected readonly isEmpty = computed(() => this.wiki() !== null && this.pages().length === 0);

    protected readonly formatDate = formatWikiDate;
}
