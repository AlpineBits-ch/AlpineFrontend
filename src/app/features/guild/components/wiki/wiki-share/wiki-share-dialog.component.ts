import {Component, computed, effect, inject, input, output, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {NgClass} from '@angular/common';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {ChannelType} from '../../../../../dtos/response/guild.dto';
import {GuildService} from '../../../../../services/guild.service';
import {ConversationStore} from '../../../../../stores/conversation.store';
import {ConversationUtilsService} from '../../../../../services/conversation-utils.service';
import {ToastService} from '../../../../../services/toast.service';
import {channelIcon as iconForType} from '../../../channel-types';
import {
    EncryptionUnavailableError,
    MessageSendService,
} from '../../../../messaging/message-send.service';
import {wikiShareLink} from '../../../../messaging/wiki-link';

/** Somewhere a page can be posted. Channels and conversations are one list on purpose: the choice a person is making is "who sees this", and that question doesn't care which of the two it is. */
export interface ShareTarget {
    kind: 'channel' | 'conversation';
    id: string;
    label: string;
    icon: string;
    /** Only for channels: what it sits under, so two `#general`s are tellable apart. */
    context?: string;
}

type ShareState = 'idle' | 'sending' | 'sent';

/**
 * Posts a wiki page into a channel or a DM. Self-contained: it owns its dialog, its picker and its
 * send. The wiki mounts it and hands it a page (see HANDOFF), since the page a share is about is
 * whichever one is on screen, and that is something only the wiki knows.
 */
@Component({
    selector: 'app-wiki-share-dialog',
    imports: [Dialog, Button, InputText, FormsModule, NgClass, PrimeTemplate, TranslateModule],
    templateUrl: './wiki-share-dialog.component.html',
})
export class WikiShareDialogComponent {
    readonly open = input<boolean>(false);
    readonly guildId = input.required<string>();
    /** Null while the wiki is on a view with no page: the dialog is then never opened. */
    readonly page = input<WikiPageSummaryDto | null>(null);

    readonly closed = output<void>();

    protected readonly search = signal('');
    protected readonly note = signal('');
    protected readonly selectedId = signal<string | null>(null);
    protected readonly state = signal<ShareState>('idle');

    /**
     * Text channels of the guild the page lives in, plus every DM. Only the page's own guild: a
     * page is readable by its members and nobody else, so offering to post it into a different
     * guild offers to post a link that everyone there will bounce off. DMs are offered regardless,
     * since a link to somebody outside the guild is a decision a person is allowed to make, and the
     * card tells them plainly that they are not a member.
     */
    protected readonly targets = computed<ShareTarget[]>(() => {
        const guild = this.guildService.guilds().find(g => g.id === this.guildId());
        const channels: ShareTarget[] = (guild?.channels ?? [])
            .filter(c => c.type === ChannelType.Text || c.type === ChannelType.Announcement)
            .sort((a, b) => a.position - b.position)
            .map(c => ({
                kind: 'channel' as const,
                id: c.id,
                label: c.name,
                icon: iconForType(c.type) ?? 'pi pi-hashtag',
                context: guild?.name,
            }));

        const conversations: ShareTarget[] = this.conversations.entities().map(conv => ({
            kind: 'conversation' as const,
            id: conv.id,
            label: this.convUtils.getChatTitle(conv),
            icon: 'pi pi-comment',
        }));

        return [...channels, ...conversations];
    });

    protected readonly filtered = computed(() => {
        const q = this.search().toLowerCase().trim();
        const all = this.targets();
        return (q ? all.filter(t => t.label.toLowerCase().includes(q)) : all).slice(0, 60);
    });

    protected readonly selected = computed(() =>
        this.targets().find(t => t.id === this.selectedId()) ?? null);

    protected readonly canSend = computed(() => !!this.selected() && this.state() === 'idle');

    private readonly guildService = inject(GuildService);
    private readonly conversations = inject(ConversationStore);
    private readonly convUtils = inject(ConversationUtilsService);
    private readonly sender = inject(MessageSendService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    constructor() {
        // The DM list is paged in on demand elsewhere; a share dialog opened before anyone visited Direct Messages would otherwise show channels only.
        this.conversations.loadInitial();

        effect(() => {
            if (!this.open()) return;
            this.search.set('');
            this.note.set('');
            this.selectedId.set(null);
            this.state.set('idle');
        });
    }

    protected select(target: ShareTarget): void {
        this.selectedId.set(target.id === this.selectedId() ? null : target.id);
    }

    protected close(): void {
        this.closed.emit();
    }

    protected async share(): Promise<void> {
        const target = this.selected();
        const page = this.page();
        if (!target || !page || this.state() !== 'idle') return;

        this.state.set('sending');
        const link = wikiShareLink(this.guildId(), page.id);
        const note = this.note().trim();

        try {
            await this.sender.sendText(
                target.kind === 'channel' ? {channelId: target.id} : {conversationId: target.id},
                note ? `${note}\n${link}` : link,
            );
            this.state.set('sent');
            this.toast.success(this.translate.instant('WIKI.SHARE.SENT', {target: target.label}));
            this.close();
        } catch (err) {
            this.state.set('idle');
            // Named separately: "this device cannot encrypt for that channel" is a state somebody can act on (open it and let it catch up), and a generic failure is not.
            this.toast.error(err instanceof EncryptionUnavailableError
                ? this.translate.instant('WIKI.SHARE.ERROR_ENCRYPTED')
                : this.translate.instant('WIKI.SHARE.ERROR'));
        }
    }
}
