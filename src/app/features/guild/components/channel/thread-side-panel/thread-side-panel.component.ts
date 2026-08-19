import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    HostListener,
    inject,
    input,
    signal,
    untracked,
} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {ChannelDto} from '../../../../../dtos/response/guild.dto';
import {MessageDto} from '../../../../../dtos/response/message.dto';
import {MessageStore} from '../../../../../stores/message.store';
import {MessagingService} from '../../../../../services/messaging.service';
import {NavigationService} from '../../../../main-page/navigation.service';
import {ChannelConversationComponent} from '../channel-conversation/channel-conversation.component';
import {AppAvatarComponent} from '../../../../../components/avatar/avatar.component';
import {readableContent, UNDECRYPTABLE_SHORT} from '../../../../../helpers/message-content.helper';

@Component({
    selector: 'app-thread-side-panel',
    imports: [ChannelConversationComponent, AppAvatarComponent, TranslateModule],
    templateUrl: './thread-side-panel.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ThreadSidePanelComponent {
    readonly thread = input.required<ChannelDto>();

    protected readonly navService = inject(NavigationService);
    private readonly messageStore = inject(MessageStore);
    private readonly messaging = inject(MessagingService);

    private readonly fetchedStarter = signal<MessageDto | null>(null);

    /** The starter stays in the parent channel, so without this the panel opens on a reply to nothing. */
    protected readonly starter = computed(() => {
        const id = this.thread().starterMessageId;
        if (!id) return null;
        return this.messageStore.entities().find(m => m.id === id) ?? this.fetchedStarter();
    });

    protected readonly starterText = computed(() => {
        const message = this.starter();
        return message ? readableContent(message, UNDECRYPTABLE_SHORT) : '';
    });

    protected readonly parentName = computed(() => {
        const ws = this.navService.workspace();
        if (ws.type !== 'server') return '';
        return ws.guild.channels.find(c => c.id === this.thread().parentChannelId)?.name ?? '';
    });

    constructor() {
        effect(() => {
            const thread = this.thread();
            const id = thread.starterMessageId;
            const parentId = thread.parentChannelId;

            untracked(() => {
                this.fetchedStarter.set(null);
                if (!id || !parentId) return;
                if (this.messageStore.entities().some(m => m.id === id)) return;

                this.messaging.getMessageById({channelId: parentId, messageId: id}).subscribe({
                    next: message => this.fetchedStarter.set(message),
                    // A deleted starter leaves the panel without its quote, which is survivable.
                    error: () => {},
                });
            });
        });
    }

    @HostListener('document:keydown.escape')
    protected onEscape(): void {
        this.navService.closeThread();
    }
}
