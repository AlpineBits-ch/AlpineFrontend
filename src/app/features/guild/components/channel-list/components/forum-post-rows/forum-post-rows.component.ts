import {ChangeDetectionStrategy, Component, computed, inject, input} from '@angular/core';
import {ChannelDto} from '../../../../../../dtos/response/guild.dto';
import {GuildReadStateService} from '../../../../../../services/guild-read-state.service';
import {ForumVisitedPostsService} from '../../../../../../services/forum-visited-posts.service';
import {NavigationService} from '../../../../../main-page/navigation.service';
import {selectNestedPosts} from './forum-post-rows.util';

/**
 * The posts hanging beneath a forum in the sidebar: the ones you were just reading, and the
 * ones with something waiting in them. Renders nothing at all for a forum with neither.
 *
 * Nesting is drawn by `.chan-nest`, the same guide line the voice member list hangs from.
 * These rows used to draw a bespoke SVG connector tree instead, which meant the sidebar had
 * two different visual languages for one relationship.
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
