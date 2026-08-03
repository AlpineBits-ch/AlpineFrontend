import {Component, inject, output, signal} from '@angular/core';
import {DatePipe} from '@angular/common';
import {TranslateModule} from '@ngx-translate/core';
import {
    InboxMentionEntry,
    InboxPreview,
    InboxService,
    InboxUnreadEntry,
} from '../../services/inbox.service';
import {isDismissable} from '../../dtos/response/inbox.dto';
import {ProfileService} from '../../services/profile.service';
import {readableContent, UNDECRYPTABLE_SHORT} from '../../helpers/message-content.helper';
import {MessageType} from '../../enums/message-type.enum';

type InboxTab = 'unread' | 'mentions';

/**
 * The body of the titlebar's inbox popover.
 *
 * <p>Its own component rather than more of `titlebar.component.html`: two tabs, previews, per-row
 * actions and paging is more markup than the window controls and the context title put together,
 * and none of it has anything to say about the titlebar.</p>
 */
@Component({
    selector: 'app-inbox-panel',
    imports: [TranslateModule, DatePipe],
    templateUrl: './inbox-panel.component.html',
})
export class InboxPanelComponent {
    /** Fired when a row navigates somewhere, so the popover can close itself. */
    readonly navigated = output<void>();

    protected inbox = inject(InboxService);
    private profiles = inject(ProfileService);

    protected readonly tabs: readonly { id: InboxTab; labelKey: string }[] = [
        {id: 'unread', labelKey: 'INBOX.TAB_UNREAD'},
        {id: 'mentions', labelKey: 'INBOX.TAB_MENTIONS'},
    ];

    protected tab = signal<InboxTab>('unread');

    protected readonly summary = this.inbox.summary;

    protected selectTab(tab: InboxTab): void {
        this.tab.set(tab);
    }

    protected openUnread(entry: InboxUnreadEntry): void {
        this.inbox.openUnread(entry);
        this.navigated.emit();
    }

    protected openMention(entry: InboxMentionEntry): void {
        this.inbox.openMention(entry);
        this.navigated.emit();
    }

    /** The ✓. Stops the click reaching the row, which would navigate instead of dismissing. */
    protected markRead(event: Event, entry: InboxUnreadEntry): void {
        event.stopPropagation();
        void this.inbox.markChannelRead(entry.breadcrumb.channelId);
    }

    protected dismiss(event: Event, entry: InboxMentionEntry): void {
        event.stopPropagation();
        void this.inbox.dismissMention(entry);
    }

    protected markAllRead(): void {
        void this.inbox.markAllRead();
    }

    protected loadMore(): void {
        if (this.tab() === 'unread') void this.inbox.loadMoreUnread();
        else void this.inbox.loadMoreMentions();
    }

    /** Only Direct and `@here` have a per-user row to delete; the others accept and do nothing. */
    protected canDismiss(entry: InboxMentionEntry): boolean {
        return isDismissable(entry.mention.kind);
    }

    /**
     * The one line of body text on a row.
     *
     * <p>Through `readableContent`, which is the only sanctioned way to turn a body into text -
     * a preview this device could not authenticate must say so rather than render base64. Join and
     * leave messages carry no body at all, only a variant index, so they get a fixed phrase.</p>
     */
    protected previewText(preview: InboxPreview | undefined): string {
        if (!preview) return '';
        if (preview.message.type === MessageType.GuildMemberJoin) return '';
        if (preview.message.type === MessageType.GuildMemberLeave) return '';
        return readableContent(preview.message, UNDECRYPTABLE_SHORT);
    }

    /**
     * Who wrote a preview.
     *
     * <p>`authorDisplayName` is set only for webhooks and bots, which have no profile. Everyone
     * else resolves out of the profile cache - a signal, so a row rendered before the fetch lands
     * fills itself in.</p>
     */
    protected authorName(preview: InboxPreview | undefined): string {
        if (!preview) return '';
        return preview.authorDisplayName
            ?? this.profiles.getCachedByUserId(preview.message.authorId)?.userName
            ?? '';
    }

    /** `Echo / General`, or just the guild when the channel sits outside a category. */
    protected contextLine(entry: InboxUnreadEntry): string {
        const {guildName, categoryName} = entry.breadcrumb;
        return categoryName ? `${guildName} / ${categoryName}` : guildName;
    }

    /**
     * `Echo / #general` for a guild mention.
     *
     * <p>Empty for a DM, where the template renders a translated label instead - a guild name is
     * literal text and must never go through the `translate` pipe, which would rewrite one that
     * happened to collide with a key.</p>
     */
    protected mentionContextLine(entry: InboxMentionEntry): string {
        const b = entry.mention.breadcrumb;
        if (!b) return '';
        return `${b.guildName} / ${this.inbox.channelGlyph(b)}${b.channelName}`;
    }

    /** The i18n key naming why this mention reached the user. */
    protected kindKey(entry: InboxMentionEntry): string {
        switch (entry.mention.kind) {
            case 'Here':
                return 'INBOX.KIND_HERE';
            case 'Everyone':
                return 'INBOX.KIND_EVERYONE';
            case 'Role':
                return 'INBOX.KIND_ROLE';
            default:
                return 'INBOX.KIND_DIRECT';
        }
    }
}
