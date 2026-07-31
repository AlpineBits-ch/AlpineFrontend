import {ChangeDetectionStrategy, Component, computed, inject, input} from '@angular/core';
import {ChannelDto} from '../../../../../../dtos/response/guild.dto';
import {GuildReadStateService} from '../../../../../../services/guild-read-state.service';
import {ForumVisitedPostsService} from '../../../../../../services/forum-visited-posts.service';
import {NavigationService} from '../../../../../main-page/navigation.service';
import {forumTreePath, NESTED_ROW_HEIGHT, selectNestedPosts} from './forum-post-rows.util';

/** Makes each instance's gradient id unique - SVG ids resolve document-wide, not per component. */
let gradientSeq = 0;

/**
 * The posts hanging beneath a forum in the sidebar: the ones you were just reading, and the
 * ones with something waiting in them. Renders nothing at all for a forum with neither.
 *
 * The connecting tree is one stroked SVG per group rather than borders on each row, because
 * two semi-transparent borders meeting at a corner composite over each other and light the
 * junction up brighter than the rest of the line.
 */
@Component({
    selector: 'app-forum-post-rows',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: {class: 'contents'},
    templateUrl: './forum-post-rows.component.html',
})
export class ForumPostRowsComponent {
    forum = input.required<ChannelDto>();

    private navService = inject(NavigationService);
    private readStateService = inject(GuildReadStateService);
    private visitedService = inject(ForumVisitedPostsService);

    /** Bound to each row's height, so the CSS cannot drift from the SVG's coordinate space. */
    protected readonly rowHeight = NESTED_ROW_HEIGHT;
    protected readonly gradientId = `forum-tree-${++gradientSeq}`;

    /**
     * Posts arrive in the guild payload alongside top-level channels - the sidebar filters
     * them out of its own rows - so the whole list is already here and needs no fetch.
     */
    private allChannels = computed(() => {
        const ws = this.navService.workspace();
        return ws.type === 'server' ? ws.guild.channels : [];
    });

    protected posts = computed(() => selectNestedPosts(
        this.forum().id,
        this.allChannels(),
        this.visitedService.postsFor(this.forum().id),
        id => this.readStateService.getChannelState(id),
    ));

    protected tree = computed(() => forumTreePath(this.posts().length));

    protected stateOf(postId: string) {
        return this.readStateService.getChannelState(postId);
    }

    protected isOpen(postId: string): boolean {
        return this.navService.isChannelActive(postId);
    }

    protected open(post: ChannelDto): void {
        this.navService.openChannel(post);
    }
}
