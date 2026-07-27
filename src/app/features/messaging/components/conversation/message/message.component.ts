import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    effect,
    ElementRef,
    HostListener,
    inject,
    input,
    output,
    signal,
    ViewChild
} from '@angular/core';
import {takeUntilDestroyed, toObservable, toSignal} from '@angular/core/rxjs-interop';
import {MessageAttachment, MessageDto} from "../../../../../dtos/response/message.dto";
import {AppAvatarComponent} from "../../../../../components/avatar/avatar.component";
import {AsyncPipe, DatePipe, NgClass} from "@angular/common";
import {ProfileService} from "../../../../../services/profile.service";
import {Observable, of, switchMap} from "rxjs";
import {ProfileDto} from "../../../../../dtos/response/profile.dto";
import {ChannelDto, ChannelType, RoleDto} from "../../../../../dtos/response/guild.dto";
import {NavigationService} from "../../../../main-page/navigation.service";
import {isKlipyGifUrl} from '../../../../../services/gif.service';
import {EmojiDataService, getFlagCode, isRegionalIndicator} from '../../../../../services/emoji-data.service';
import {MarkdownPipe} from '../../../../../pipes/markdown.pipe';
import {AttachmentDto, FileService} from '../../../../../services/file.service';
import {MessagingService} from '../../../../../services/messaging.service';
import {MessageStore} from '../../../../../stores/message.store';
import {ProfileDialogService} from '../../../../../services/profile-dialog.service';
import {openUrl} from '@tauri-apps/plugin-opener';
import {InviteCardComponent} from './invite-card/invite-card.component';
import {MessageHoverToolbarComponent} from './hover-toolbar/message-hover-toolbar.component';
import {MessageReactionBarComponent} from './reaction-bar/message-reaction-bar.component';
import {TwemojiComponent} from '../../../../../components/twemoji/twemoji.component';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {CreateReactionDto} from '../../../../../dtos/request/create-reaction.dto';
import {RemoveReactionDto} from '../../../../../dtos/request/remove-reaction.dto';
import {TranslateModule} from '@ngx-translate/core';
import {UserNameStyleDirective} from '../../../../../directives/user-name-style.directive';

@Component({
    selector: 'app-message',
    imports: [
        AppAvatarComponent,
        DatePipe,
        AsyncPipe,
        NgClass,
        MarkdownPipe,
        InviteCardComponent,
        MessageHoverToolbarComponent,
        MessageReactionBarComponent,
        TwemojiComponent,
        Dialog,
        Button,
        TranslateModule,
        UserNameStyleDirective,
    ],
    templateUrl: './message.component.html',
    styleUrl: './message.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MessageComponent {
    private static readonly INVITE_URL_RE = /https:\/\/venta\.gg\/invite\/([A-Za-z0-9_-]+)/g;
    public profileService = inject(ProfileService);
    protected navService = inject(NavigationService);
    lightbox = signal<{ loading: boolean; att: AttachmentDto | null; name: string } | null>(null);
    public message = input.required<MessageDto>();
    public guildChannels = input<ChannelDto[]>([]);
    public guildRoles = input<RoleDto[]>([]);
    public reply = output<MessageDto>();
    public jumpTo = output<string>();

    constructor() {
        effect(() => {
            for (const userId of this.message().mentions ?? []) {
                this.profileService.resolveByUserId(userId);
            }
        });
    }
    public isOnlyEmoji = computed(() => {
        const content = this.content().trim().replace(/ /g, '')

        // 30 is the new 15 btw
        if (content.length > 30) return false;
        if (content.length === 0) return false;
        if ([...content].some(isRegionalIndicator)) return false;

        return /^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F?|\u200D)+$/u.test(content);
    });
    public contentSegments = computed(() => {
        const text = this.content();
        const msg = this.message();
        let segments: { type: 'text' | 'mention' | 'role' | 'everyone' | 'here' | 'channel' | 'gif' | 'emoji' | 'flag' | 'invite'; value: string; refId?: string }[] = [];

        // If the entire message is a GIF URL, render it as a single GIF segment
        if (isKlipyGifUrl(text)) {
            return [{type: 'gif' as const, value: text.trim()}];
        }

        // If the entire message is a single invite URL, render only the card
        const singleInvite = /^https:\/\/venta\.gg\/invite\/([A-Za-z0-9_-]+)$/.exec(text.trim());
        if (singleInvite) {
            return [{type: 'invite' as const, value: singleInvite[1]}];
        }

        // Reads the profile cache reactively -this computed reruns once a mentioned
        // user's profile resolves (see the constructor's resolution effect below).
        const mentionedProfiles = (msg.mentions ?? [])
            .map(id => this.profileService.getCachedByUserId(id))
            .filter((p): p is ProfileDto => !!p);
        const channels = this.guildChannels();
        const mentionedRoles = (msg.roleMentions ?? [])
            .map(id => this.guildRoles().find(r => r.id === id))
            .filter((r): r is RoleDto => !!r);

        // Role (and user) names can contain spaces/punctuation that the generic
        // single-word @pattern below can't capture as one unit (e.g. "@The Isle").
        // Match every known mentioned name explicitly, longest first, before falling
        // back to the generic single-word pattern.
        const knownNames = [...mentionedProfiles.map(p => p.userName), ...mentionedRoles.map(r => r.name)]
            .sort((a, b) => b.length - a.length);
        const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const knownNamePattern = knownNames.length > 0
            ? knownNames.map(n => `@${escapeRegex(n)}\\b`).join('|') + '|'
            : '';
        const regex = new RegExp(
            knownNamePattern + '@[\\w\\-.]+#\\w+|@everyone\\b|@here\\b|@[\\w\\-.]+|#[\\w-]+',
            'g'
        );
        let last = 0;
        let match;

        // 1. Extract mentions, channel links, and text
        while ((match = regex.exec(text)) !== null) {
            if (match.index > last) {
                segments.push({type: 'text', value: text.slice(last, match.index)});
            }
            const raw = match[0];
            if (/^@[\w\-.]+#\w+$/.test(raw)) {
                // Legacy discriminator-style mention -kept for compatibility, no click target.
                segments.push({type: 'mention', value: raw});
            } else if (raw === '@everyone' && msg.mentionsEveryone) {
                segments.push({type: 'everyone', value: raw});
            } else if (raw === '@here' && msg.mentionsHere) {
                segments.push({type: 'here', value: raw});
            } else if (raw === '@everyone' || raw === '@here') {
                // Literal text that happens to look like a broadcast mention, but the
                // message doesn't actually carry the corresponding flag -render as plain text.
                segments.push({type: 'text', value: raw});
            } else if (raw.startsWith('@')) {
                // Only a real mention if it matches one of the message's actual mentioned
                // users or roles -otherwise it's just someone typing an @-prefixed word.
                const name = raw.slice(1);
                const profile = mentionedProfiles.find(p => p.userName === name);
                if (profile) {
                    segments.push({type: 'mention', value: raw, refId: profile.userId});
                } else {
                    const role = mentionedRoles.find(r => r.name === name);
                    segments.push(role
                        ? {type: 'role', value: raw, refId: role.id}
                        : {type: 'text', value: raw});
                }
            } else {
                // Channel link -only if it resolves against a channel actually in this guild.
                // Prefer a text channel over a same-named voice channel: "#general" should
                // point at somewhere you can read, not the voice room that happens to share a name.
                const name = raw.slice(1);
                const channel = channels.find(c => c.name === name && c.type === ChannelType.Text)
                    ?? channels.find(c => c.name === name);
                segments.push(channel
                    ? {type: 'channel', value: raw, refId: channel.id}
                    : {type: 'text', value: raw});
            }
            last = match.index + raw.length;
        }
        if (last < text.length) {
            segments.push({type: 'text', value: text.slice(last)});
        }

        // 2. Process text segments to separate single emojis
        const emojiSegments: { type: 'text' | 'mention' | 'role' | 'everyone' | 'here' | 'channel' | 'gif' | 'emoji' | 'flag' | 'invite'; value: string; refId?: string }[] = [];

        const emojiRegex = /^(?=\p{Emoji})(?!\p{Number}).$/u;

        for (const segment of segments) {
            if (segment.type === 'text') {
                const chars = [...segment.value];
                let currentText = '';

                for (let i = 0; i < chars.length; i++) {
                    const char = chars[i];
                    if (isRegionalIndicator(char)) {
                        const next = chars[i + 1];
                        const code = next ? getFlagCode(char, next) : null;
                        if (code) {
                            if (currentText.length > 0) {
                                emojiSegments.push({type: 'text', value: currentText});
                                currentText = '';
                            }
                            emojiSegments.push({type: 'flag', value: char + next});
                            i++;
                            continue;
                        }
                    }
                    if (emojiRegex.test(char)) {
                        if (currentText.length > 0) {
                            emojiSegments.push({type: 'text', value: currentText});
                            currentText = '';
                        }
                        emojiSegments.push({type: 'emoji', value: char});
                    } else {
                        currentText += char;
                    }
                }

                if (currentText.length > 0) {
                    emojiSegments.push({type: 'text', value: currentText});
                }
            } else {
                emojiSegments.push(segment);
            }
        }

        // 3. Split text segments by invite URLs
        const finalSegments: typeof emojiSegments = [];
        const inviteRe = MessageComponent.INVITE_URL_RE;
        for (const segment of emojiSegments) {
            if (segment.type !== 'text') {
                finalSegments.push(segment);
                continue;
            }
            inviteRe.lastIndex = 0;
            let lastIdx = 0;
            let m: RegExpExecArray | null;
            while ((m = inviteRe.exec(segment.value)) !== null) {
                if (m.index > lastIdx) {
                    finalSegments.push({type: 'text', value: segment.value.slice(lastIdx, m.index)});
                }
                finalSegments.push({type: 'invite', value: m[1]});
                lastIdx = m.index + m[0].length;
            }
            if (lastIdx < segment.value.length) {
                finalSegments.push({type: 'text', value: segment.value.slice(lastIdx)});
            }
        }

        return finalSegments;
    });
    readonly isOwn = computed(() =>
        this.message().authorId === this.profileService.ownProfile()?.userId
    );
    readonly longPressMenu = signal(false);
    readonly isEditing = signal(false);
    readonly editText = signal('');
    readonly saving = signal(false);
    readonly showDeleteConfirm = signal(false);
    readonly quickReactions = ['👍', '❤️', '😂'];
    protected readonly openUrl = openUrl;
    protected profileDialogSvc = inject(ProfileDialogService);
    protected readonly replyAuthorName = computed(() => {
        const msg = this.replyMessage();
        if (!msg) return '';
        if (msg.authorId === this.profileService.ownProfile()?.userId) return 'You';
        return this.profileService.getCachedByUserId(msg.authorId)?.userName ?? 'Unknown';
    });
    protected readonly replyAuthorProfile = computed(() => {
        const msg = this.replyMessage();
        if (!msg) return undefined;
        return this.profileService.getCachedByUserId(msg.authorId);
    });
    protected readonly replySnippet = computed(() => {
        const msg = this.replyMessage();
        if (!msg) return '';
        try {
            const bytes = Uint8Array.from(atob(msg.content), c => c.charCodeAt(0));
            return new TextDecoder().decode(bytes).slice(0, 80);
        } catch {
            return '';
        }
    });
    private emojiDataService = inject(EmojiDataService);
    public content = computed(() => {
        const bytes = Uint8Array.from(atob(this.message().content), c => c.charCodeAt(0));
        const decoded = new TextDecoder().decode(bytes);
        return this.emojiDataService.resolveShortcodes(decoded);
    });
    private fileService = inject(FileService);
    private messagingService = inject(MessagingService);
    private messageStore = inject(MessageStore);
    private destroyRef = inject(DestroyRef);
    @ViewChild('editArea') private editAreaRef?: ElementRef<HTMLTextAreaElement>;
    private readonly replyCtx = computed(() => ({
        id: this.message().inReplyTo,
        conversationId: this.message().conversationId,
        channelId: this.message().channelId,
    }));
    protected readonly replyMessage = toSignal(
        toObservable(this.replyCtx).pipe(
            switchMap(ctx => ctx.id
                ? this.messageStore.getOrFetchMessage(ctx.id, {
                    conversationId: ctx.conversationId,
                    channelId: ctx.channelId
                })
                : of(null as MessageDto | null)
            )
        ),
        {initialValue: null as MessageDto | null}
    );
    private longPressTimer: ReturnType<typeof setTimeout> | null = null;

    @HostListener('document:keydown.escape')
    closeLightbox(): void {
        this.lightbox.set(null);
        this.longPressMenu.set(false);
    }

    onTouchStart(): void {
        this.longPressTimer = setTimeout(() => {
            this.longPressMenu.set(true);
            this.longPressTimer = null;
            if ('vibrate' in navigator) navigator.vibrate(30);
        }, 500);
    }

    onTouchMove(): void {
        if (this.longPressTimer !== null) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }
    }

    onTouchEnd(): void {
        if (this.longPressTimer !== null) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }
    }

    onLongPressReply(): void {
        this.longPressMenu.set(false);
        this.reply.emit(this.message());
    }

    onLongPressEdit(): void {
        this.longPressMenu.set(false);
        this.startEdit();
    }

    onLongPressDelete(): void {
        this.longPressMenu.set(false);
        this.confirmDelete();
    }

    openLightbox(minimal: MessageAttachment): void {
        this.lightbox.set({loading: true, att: null, name: minimal.fileName});
        this.fileService.getAttachmentMetadataById(minimal.id).subscribe({
            next: att => this.lightbox.update(s => s ? {...s, loading: false, att} : s),
            error: () => this.lightbox.set(null),
        });
    }

    download(att: { id: string; fileName: string }): void {
        this.fileService.downloadAttachmentById(att.id).subscribe(blob => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = att.fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });
    }

    fileIcon(contentType: string): string {
        if (contentType.startsWith('video/')) return 'pi-video';
        if (contentType.startsWith('audio/')) return 'pi-volume-up';
        if (contentType === 'application/pdf') return 'pi-file-pdf';
        if (contentType.includes('zip') || contentType.includes('rar') || contentType.includes('tar')) return 'pi-folder';
        if (contentType.startsWith('text/')) return 'pi-file-edit';
        return 'pi-file';
    }

    fileIconColor(contentType: string): string {
        if (contentType.startsWith('video/')) return 'text-purple-400';
        if (contentType.startsWith('audio/')) return 'text-emerald-400';
        if (contentType === 'application/pdf') return 'text-rose-400';
        if (contentType.includes('zip') || contentType.includes('rar')) return 'text-amber-400';
        if (contentType.startsWith('text/')) return 'text-sky-400';
        return 'text-white/40';
    }

    startEdit(): void {
        this.editText.set(this.content());
        this.isEditing.set(true);
        setTimeout(() => {
            const el = this.editAreaRef?.nativeElement;
            if (el) {
                el.focus();
                el.setSelectionRange(el.value.length, el.value.length);
                this.autoResize(el);
            }
        }, 0);
    }

    cancelEdit(): void {
        this.isEditing.set(false);
        this.showDeleteConfirm.set(false);
    }

    saveEdit(): void {
        const text = this.editText().trim();
        if (!text || this.saving()) return;
        this.saving.set(true);
        this.isEditing.set(false);
        this.messagingService.updateMessage(this.message().id, text)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
                next: updated => {
                    this.messageStore.applyMessageUpdate(updated);
                    this.saving.set(false);
                },
                error: () => {
                    this.saving.set(false);
                    this.editText.set(text);
                    this.isEditing.set(true);
                },
            });
    }

    confirmDelete(): void {
        this.showDeleteConfirm.set(true);
    }

    deleteMessage(): void {
        this.showDeleteConfirm.set(false);
        this.messagingService.deleteMessage(this.message().id).subscribe({
            next: () => this.messageStore.removeMessage(this.message().id),
        });
    }

    onEditEnter(event: Event): void {
        const ke = event as KeyboardEvent;
        if (!ke.shiftKey) {
            event.preventDefault();
            this.saveEdit();
        }
    }

    autoResize(el: HTMLTextAreaElement): void {
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 240) + 'px';
    }

    onChannelMentionClick(channelId: string): void {
        const channel = this.guildChannels().find(c => c.id === channelId);
        if (channel) this.navService.openChannel(channel);
    }

    onLinkClick(event: MouseEvent): void {
        const anchor = (event.target as HTMLElement).closest('a');
        if (!anchor) return;
        const href = anchor.getAttribute('href');
        if (!href) return;
        event.preventDefault();
        openUrl(href);
    }

    public getProfile(): Observable<ProfileDto> {
        return this.profileService.getByUserId(this.message().authorId);
    }

    public mentionedProfile(userId: string): ProfileDto | undefined {
        return this.profileService.getCachedByUserId(userId);
    }

    public mentionedRole(roleId: string): RoleDto | undefined {
        return this.guildRoles().find(r => r.id === roleId);
    }

    hasOwnReaction(emoji: string): boolean {
        const own = this.profileService.ownProfile()?.userId;
        if (!own) return false;
        return this.message().reactions?.some(r => r.emoji === emoji && r.userId === own) ?? false;
    }

    toggleReaction(emoji: string): void {
        const msg = this.message();
        const own = this.profileService.ownProfile()?.userId;
        if (!own || msg.isPending || msg.isFailed) return;

        const hasReacted = this.hasOwnReaction(emoji);

        if (hasReacted) {
            const contextId = msg.conversationId ?? msg.channelId ?? '';
            const dto: RemoveReactionDto = {reaction: emoji, contextId};
            this.messageStore.applyReactionRemoved({messageId: msg.id, emoji, userId: own});
            this.messagingService.removeReaction(msg.id, dto).subscribe({
                error: () => this.messageStore.applyReactionAdded({messageId: msg.id, emoji, userId: own}),
            });
        } else {
            const dto: CreateReactionDto = {
                conversationId: msg.conversationId ?? '',
                reaction: emoji,
                channelId: msg.channelId,
            };
            this.messageStore.applyReactionAdded({messageId: msg.id, emoji, userId: own});
            this.messagingService.addReaction(msg.id, dto).subscribe({
                error: () => this.messageStore.applyReactionRemoved({messageId: msg.id, emoji, userId: own}),
            });
        }
    }
}
