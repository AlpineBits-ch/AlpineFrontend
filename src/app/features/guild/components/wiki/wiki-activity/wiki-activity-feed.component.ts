import {Component, computed, effect, inject, input, output} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {WikiCategoryDto, WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {AppAvatarComponent} from '../../../../../components/avatar/avatar.component';
import {ProfileService} from '../../../../../services/profile.service';
import {MinuteClockService} from '../../../../../services/minute-clock.service';
import {RelativeTimePipe} from '../../../../../pipes/relative-time.pipe';
import {buildWikiActivity, WIKI_ACTIVITY_DEFAULT_LIMIT, WikiActivityEntry} from './wiki-activity';

/** "Ana edited Rules, 2h ago": the part of the wiki's front page that changes, so it is worth checking rather than worth skipping. */
@Component({
    selector: 'app-wiki-activity-feed',
    imports: [AppAvatarComponent, TranslateModule, RelativeTimePipe],
    templateUrl: './wiki-activity-feed.component.html',
})
export class WikiActivityFeedComponent {
    readonly pages = input<readonly WikiPageSummaryDto[]>([]);
    readonly categories = input<readonly WikiCategoryDto[]>([]);
    readonly limit = input(WIKI_ACTIVITY_DEFAULT_LIMIT);

    readonly openPage = output<WikiPageSummaryDto>();

    /** 30s cadence, shared with everything else in the app that renders a time; a per-row interval would be one timer per entry for text that changes once a minute. */
    protected readonly clock = inject(MinuteClockService);

    protected readonly entries = computed(() => buildWikiActivity(this.pages(), this.limit()));

    private readonly profileService = inject(ProfileService);
    private readonly categoryNames = computed(
        () => new Map(this.categories().map(c => [c.id, c.name])),
    );

    constructor() {
        this.clock.retain();

        // `app-avatar` resolves the face on its own, but the name beside it is read from the cache synchronously, so something has to ask for it. Resolving here rather than per row means one pass over the visible entries instead of one effect per row, and `resolveByUserId` is already a no-op for anyone cached, which after the first render is nearly everyone.
        effect(() => {
            for (const entry of this.entries()) {
                if (entry.actorId) this.profileService.resolveByUserId(entry.actorId);
            }
        });
    }

    /** Undefined rather than the raw id: an unresolved profile shows a face and a verb, no id. */
    protected actorName(entry: WikiActivityEntry): string | undefined {
        return entry.actorId ? this.profileService.getCachedByUserId(entry.actorId)?.userName : undefined;
    }

    protected categoryName(page: WikiPageSummaryDto): string | undefined {
        return page.categoryId ? this.categoryNames().get(page.categoryId) : undefined;
    }
}
