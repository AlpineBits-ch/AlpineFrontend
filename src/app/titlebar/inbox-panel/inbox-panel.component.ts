import {Component, inject, output, signal} from '@angular/core';
import {DatePipe} from '@angular/common';
import {TranslateModule} from '@ngx-translate/core';
import {InboxMentionEntry, InboxPreview, InboxService, InboxUnreadEntry} from '../../services/inbox.service';
import {InboxTask, isDismissable} from '../../dtos/response/inbox.dto';
import {ProfileService} from '../../services/profile.service';
import {readableContent, UNDECRYPTABLE_SHORT} from '../../helpers/message-content.helper';
import {MessageType} from '../../enums/message-type.enum';

type InboxTab = 'unread' | 'mentions' | 'tasks';

/** The body of the titlebar's inbox popover. */
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

    protected readonly tabs: readonly {id: InboxTab; labelKey: string}[] = [
        {id: 'unread', labelKey: 'INBOX.TAB_UNREAD'},
        {id: 'mentions', labelKey: 'INBOX.TAB_MENTIONS'},
        {id: 'tasks', labelKey: 'INBOX.TAB_TASKS'},
    ];

    protected readonly tab = signal<InboxTab>('unread');

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

    protected openTask(task: InboxTask): void {
        this.inbox.openTask(task);
        this.navigated.emit();
    }

    /** The count on a tab's chip. All three come from the one `/summary` request. */
    protected tabCount(tab: InboxTab): number {
        const sum = this.summary();
        if (tab === 'unread') return sum.unreadChannelCount;
        if (tab === 'mentions') return sum.mentionCount;
        return sum.taskCount;
    }

    /** The glyph in front of a task. An unknown kind gets a neutral tick. */
    protected taskIcon(task: InboxTask): string {
        switch (task.kind) {
            case 'ChoreDue':
                return 'pi pi-sync';
            case 'DecisionVote':
                return 'pi pi-flag';
            case 'ListAssignment':
                return 'pi pi-check-square';
            case 'BillDue':
                return 'pi pi-calendar';
            case 'CookingToday':
                return 'pi pi-book';
            case 'MaintenanceDue':
                return 'pi pi-wrench';
            case 'SceneTurn':
                return 'pi pi-comments';
            case 'PersonaReview':
                return 'pi pi-user-edit';
            case 'PersonaChangesRequested':
                return 'pi pi-undo';
            default:
                return 'pi pi-check-circle';
        }
    }

    /** `Echo / #chores`, or just the guild: an approval queue lives in the cast, not in a channel. */
    protected taskContextLine(task: InboxTask): string {
        const b = task.breadcrumb;
        if (!b) return '';
        if (!b.channelName) return b.guildName;
        return `${b.guildName} / ${this.inbox.channelGlyph(b)}${b.channelName}`;
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

    /** The X on a task row. It comes back on its own when the thing it is about moves again. */
    protected dismissTask(event: Event, task: InboxTask): void {
        event.stopPropagation();
        void this.inbox.dismissTask(task);
    }

    protected markAllRead(): void {
        void this.inbox.markAllRead();
    }

    /** Load more, or on the task tab, which has no cursor, retry the one request it makes. */
    protected loadMore(): void {
        if (this.tab() === 'unread') void this.inbox.loadMoreUnread();
        else if (this.tab() === 'mentions') void this.inbox.loadMoreMentions();
        else void this.inbox.loadTasks();
    }

    /** Only Direct and `@here` have a per-user row to delete; the others accept and do nothing. */
    protected canDismiss(entry: InboxMentionEntry): boolean {
        return isDismissable(entry.mention.kind);
    }

    /** The one line of body text on a row. Must go through `readableContent`, or an unauthenticated body renders as base64. */
    protected previewText(preview: InboxPreview | undefined): string {
        if (!preview) return '';
        if (preview.message.type === MessageType.GuildMemberJoin) return '';
        if (preview.message.type === MessageType.GuildMemberLeave) return '';
        return readableContent(preview.message, UNDECRYPTABLE_SHORT);
    }

    /** Who wrote a preview. `authorDisplayName` is set only for webhooks and bots; everyone else comes from the cache. */
    protected authorName(preview: InboxPreview | undefined): string {
        if (!preview) return '';
        return (
            preview.authorDisplayName ??
            this.profiles.getCachedByUserId(preview.message.authorId)?.userName ??
            ''
        );
    }

    /** `Echo / General`, or just the guild when the channel sits outside a category. */
    protected contextLine(entry: InboxUnreadEntry): string {
        const {guildName, categoryName} = entry.breadcrumb;
        return categoryName ? `${guildName} / ${categoryName}` : guildName;
    }

    /** `Echo / #general` for a guild mention, empty for a DM. Literal text: never send it through the `translate` pipe. */
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
