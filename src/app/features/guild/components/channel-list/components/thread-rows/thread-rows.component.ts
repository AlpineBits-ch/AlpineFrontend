import {ChangeDetectionStrategy, Component, computed, effect, inject, input, untracked} from '@angular/core';
import {ChannelDto} from '../../../../../../dtos/response/guild.dto';
import {GuildReadStateService} from '../../../../../../services/guild-read-state.service';
import {VisitedThreadsService} from '../../../../../../services/visited-threads.service';
import {ThreadRegistryService} from '../../../../../../services/thread-registry.service';
import {NavigationService} from '../../../../../main-page/navigation.service';
import {selectNestedThreads} from '../forum-post-rows/nested-thread-rows.util';

/**
 * The threads hanging beneath a text channel: the ones you were just in, and the ones with
 * something waiting. Nesting is drawn by `.chan-nest`, the same guide line the forum posts use.
 */
@Component({
    selector: 'app-thread-rows',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: {class: 'contents'},
    templateUrl: './thread-rows.component.html',
})
export class ThreadRowsComponent {
    readonly parent = input.required<ChannelDto>();

    private navService = inject(NavigationService);
    private readStateService = inject(GuildReadStateService);
    private visitedService = inject(VisitedThreadsService);
    private registry = inject(ThreadRegistryService);

    protected readonly threads = computed(() =>
        selectNestedThreads(
            this.parent().id,
            this.registry.threadsFor(this.parent().id),
            this.visitedService.threadsFor(this.parent().id),
            id => this.readStateService.getChannelState(id),
        ),
    );

    constructor() {
        effect(() => {
            const parentId = this.parent().id;
            untracked(() => this.registry.ensureParent(parentId));
        });
    }

    protected stateOf(threadId: string) {
        return this.readStateService.getChannelState(threadId);
    }

    protected isOpen(threadId: string): boolean {
        return this.navService.threadPanel()?.id === threadId;
    }

    protected open(thread: ChannelDto): void {
        this.navService.openThread(thread);
    }
}
