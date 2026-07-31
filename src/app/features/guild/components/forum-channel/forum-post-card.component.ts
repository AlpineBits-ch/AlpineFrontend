import {ChangeDetectionStrategy, Component, computed, effect, inject, input, output} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {Tooltip} from 'primeng/tooltip';
import {AppAvatarComponent} from '../../../../components/avatar/avatar.component';
import {ProfileService} from '../../../../services/profile.service';
import {ForumLayout, ForumPost, ForumTag} from '../../../../dtos/response/forum.dto';
import {RelativeTimePipe} from '../../../../pipes/relative-time.pipe';
import {ForumTagChipComponent} from './forum-tag-chip.component';

export type PostAction = 'pin' | 'unpin' | 'lock' | 'unlock' | 'archive';

/**
 * One post in the forum list. Both layouts live here rather than in two components
 * because they differ only in arrangement - the same fields, affordances and actions -
 * and splitting them would mean keeping two copies of the moderator menu in sync.
 */
@Component({
    selector: 'app-forum-post-card',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AppAvatarComponent, ForumTagChipComponent, RelativeTimePipe, TranslateModule, Tooltip],
    templateUrl: './forum-post-card.component.html',
})
export class ForumPostCardComponent {
    post = input.required<ForumPost>();
    /** The forum's full tag list; applied tags are resolved against it by id. */
    tags = input.required<ForumTag[]>();
    layout = input<ForumLayout>(ForumLayout.List);
    canModerate = input(false);
    emojiUrls = input<Record<string, string>>({});
    /** Ticks so relative timestamps stay live without the pipe reading the clock itself. */
    nowTick = input(0);
    /**
     * This post is the one open in the main view. Only the narrow pane sets it - the
     * full-width list has no open post to point at. Drawn as a ring rather than a
     * background or border, both of which the card already sets and would then be
     * settled by Tailwind's output order rather than by intent.
     */
    active = input(false);

    open = output<ForumPost>();
    action = output<PostAction>();

    private profileService = inject(ProfileService);

    protected readonly ForumLayout = ForumLayout;

    constructor() {
        effect(() => {
            const userId = this.post().createdByUserId;
            if (userId) this.profileService.resolveByUserId(userId);
        });
    }

    protected authorName = computed(() =>
        this.profileService.getCachedByUserId(this.post().createdByUserId)?.userName ?? '');

    /**
     * Applied tags in the order the server sent them, which is already the forum's own
     * tag order. Ids with no matching tag are dropped rather than rendered as blanks -
     * that gap is the window between a ForumTagDeleted event and a post-list refetch.
     */
    protected appliedTags = computed(() => {
        const byId = new Map(this.tags().map(t => [t.id, t]));
        return (this.post().tagIds ?? []).map(id => byId.get(id)).filter((t): t is ForumTag => !!t);
    });

    /** lastActivityAt is null for posts with no messages, and for every post predating the deploy. */
    protected activityAt = computed(() => this.post().lastActivityAt ?? this.post().createdAt);

    protected emojiUrlFor(tag: ForumTag): string | null {
        return tag.emojiId ? this.emojiUrls()[tag.emojiId] ?? null : null;
    }

    protected emit(action: PostAction, event: Event): void {
        // The whole card is the open target, so every action button has to stop the click
        // from also navigating into the post.
        event.stopPropagation();
        this.action.emit(action);
    }
}
