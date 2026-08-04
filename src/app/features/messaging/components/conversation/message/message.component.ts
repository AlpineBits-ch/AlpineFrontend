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
import {
    MessageAttachment,
    MessageDto,
    MessageEmbed,
    MessageEmbedMedia,
    MessageFlags,
    PinMessageResponse
} from "../../../../../dtos/response/message.dto";
import {BotCommandDto} from '../../../../../dtos/response/bot-command.dto';
import {AppAvatarComponent} from "../../../../../components/avatar/avatar.component";
import {AsyncPipe, DatePipe, NgClass} from "@angular/common";
import {ProfileService} from "../../../../../services/profile.service";
import {firstValueFrom, from, Observable, of, switchMap} from "rxjs";
import {ProfileDto} from "../../../../../dtos/response/profile.dto";
import {ChannelDto, ChannelType, RoleDto} from "../../../../../dtos/response/guild.dto";
import {NavigationService} from "../../../../main-page/navigation.service";
import {isKlipyGifUrl} from '../../../../../services/gif.service';
import {EmojiDataService, getFlagCode, isRegionalIndicator} from '../../../../../services/emoji-data.service';
import {MarkdownPipe} from '../../../../../pipes/markdown.pipe';
import {AttachmentDto, FileService} from '../../../../../services/file.service';
import {MessagingService} from '../../../../../services/messaging.service';
import {MessageStore} from '../../../../../stores/message.store';
import {MlsService} from '../../../../../services/mls.service';
import {MessageEncryptionState} from '../../../../../enums/message-encryption-state.enum';
import {toBase64} from '../../../../../helpers/base64.helper';
import {ProfileDialogService} from '../../../../../services/profile-dialog.service';
import {openUrl} from '@tauri-apps/plugin-opener';
import {InviteCardComponent} from './invite-card/invite-card.component';
import {EmbedCardComponent} from './embed-card/embed-card.component';
import {MessageHoverToolbarComponent} from './hover-toolbar/message-hover-toolbar.component';
import {MessageReactionBarComponent} from './reaction-bar/message-reaction-bar.component';
import {TwemojiComponent} from '../../../../../components/twemoji/twemoji.component';
import {TypingDotsComponent} from '../../../../../components/typing-dots/typing-dots.component';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {CreateReactionDto} from '../../../../../dtos/request/create-reaction.dto';
import {RemoveReactionDto} from '../../../../../dtos/request/remove-reaction.dto';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {UserNameStyleDirective} from '../../../../../directives/user-name-style.directive';
import {EmojiSelection} from './reaction-picker/reaction-picker.component';
import {ToastService} from '../../../../../services/toast.service';
import {
    UNDECRYPTABLE_PLACEHOLDER,
    UNDECRYPTABLE_SHORT,
} from '../../../../../helpers/message-content.helper';

@Component({
    selector: 'app-message',
    imports: [
        AppAvatarComponent,
        DatePipe,
        AsyncPipe,
        NgClass,
        MarkdownPipe,
        InviteCardComponent,
        EmbedCardComponent,
        MessageHoverToolbarComponent,
        MessageReactionBarComponent,
        TwemojiComponent,
        TypingDotsComponent,
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
    /**
     * The full-size overlay. Fed both by attachments (which need a metadata fetch first) and by
     * embed images (which already know their URL), so it holds a URL rather than an attachment.
     */
    lightbox = signal<{
        loading: boolean;
        url: string | null;
        name: string;
        attachment: AttachmentDto | null;
        /** The origin's own address, for "open original". Absent for our own attachments. */
        originalUrl?: string;
    } | null>(null);
    public message = input.required<MessageDto>();
    public guildChannels = input<ChannelDto[]>([]);
    public guildRoles = input<RoleDto[]>([]);
    public guildBots = input<BotCommandDto[]>([]);
    public guildId = input<string | undefined>();
    public isGrouped = input<boolean>(false);
    public canPinMessages = input<boolean>(false);
    /** `DeleteAnyMessage` in this channel - the one permission that may dismiss someone else's preview. */
    public canDeleteAnyMessage = input<boolean>(false);
    public channelType = input<ChannelType | undefined>();
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
    /**
     * The body as it should be *displayed*, with the sender's no-preview brackets taken off.
     *
     * <p>Wrapping a URL in angle brackets - `&lt;https://example.com&gt;` - is how a sender opts out
     * of a preview, and it is what the server reads. Showing the brackets would leak that mechanic
     * into the conversation as punctuation nobody typed on purpose.</p>
     *
     * <p>Display only: {@link startEdit} keeps the raw text, so an edit round-trips the brackets
     * and does not silently re-enable a preview the sender had suppressed.</p>
     */
    public readonly displayContent = computed(() =>
        this.content().replace(/<(https?:\/\/[^\s<>]+)>/g, '$1'));

    /**
     * Whether there is a body to render alongside whatever cards this message carries.
     *
     * <p>This used to be "render the text only when there are no embeds", which was survivable
     * while every embed was a bot's whole message. A link preview is an attachment to something a
     * person actually wrote, so that rule swallowed the message the moment its card arrived.</p>
     */
    public readonly hasRenderableContent = computed(() => this.displayContent().trim().length > 0);

    public contentSegments = computed(() => {
        const text = this.displayContent();
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
    readonly canPin = computed(() => !this.message().conversationId ? this.canPinMessages() : true);
    // Publishing (announcement cross-posting) reuses the PinMessages permission deliberately -
    // no separate permission bit exists for it.
    protected canPublish = computed(() => this.channelType() === ChannelType.Announcement && this.canPin());
    protected published = signal(false);
    protected publishing = signal(false);
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
        return this.botName(msg.authorId) ?? this.profileService.getCachedByUserId(msg.authorId)?.userName ?? 'Unknown';
    });
    protected readonly replyAuthorProfile = computed(() => {
        const msg = this.replyMessage();
        if (!msg) return undefined;
        return this.profileService.getCachedByUserId(msg.authorId);
    });
    protected readonly replySnippet = computed(() => {
        const msg = this.replyMessage();
        if (!msg) return '';
        if (msg.undecryptable) return UNDECRYPTABLE_SHORT;
        try {
            const bytes = Uint8Array.from(atob(msg.content), c => c.charCodeAt(0));
            return new TextDecoder().decode(bytes).slice(0, 80);
        } catch {
            return '';
        }
    });
    private emojiDataService = inject(EmojiDataService);
    /**
     * True when nothing readable may be shown for this message.
     *
     * <p>Set by every read path that could not authenticate the content: a decrypt that failed, a
     * context this device was never admitted to, and - since §L.9 - a message the server declares
     * cleartext inside a context this device has encrypted.</p>
     */
    public readonly isUndecryptable = computed(() => !!this.message().undecryptable);

    public content = computed(() => {
        // <b>The flag had no consumer.</b> `undecryptable` was set in three places and read
        // nowhere, so an unauthenticated body was still decoded and rendered - as base64 garbage
        // for a failed decrypt, and as the attacker's own words for a message the server simply
        // labelled `Plain`. Refusing to produce the text is what makes the flag mean something.
        if (this.isUndecryptable()) return UNDECRYPTABLE_PLACEHOLDER;

        const bytes = Uint8Array.from(atob(this.message().content), c => c.charCodeAt(0));
        const decoded = new TextDecoder().decode(bytes);
        return this.emojiDataService.resolveShortcodes(decoded);
    });
    public embeds = computed<MessageEmbed[]>(() => {
        const json = this.message().embedsJson;
        if (!json) return [];
        try {
            const parsed = JSON.parse(json);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    });

    /**
     * True when a person removed this message's previews - for everyone, not just for them.
     *
     * <p>Also the answer to *why* there are no embeds: suppressed by somebody, as opposed to never
     * generated. Nothing else can tell those apart, and offering "restore preview" on a message
     * that never had one is a button that does nothing.</p>
     */
    public readonly embedsSuppressed = computed(() =>
        ((this.message().flags ?? 0) & MessageFlags.SuppressEmbeds) !== 0);

    /**
     * Whether the message's text carries a link the server could unfurl.
     *
     * <p>Used only to decide whether restoring a suppressed preview is worth offering. Mirrors the
     * two server-side opt-outs so the offer does not appear where nothing would come back: a URL
     * inside a code span or fence is never unfurled, and neither is one the sender deliberately
     * wrapped in angle brackets.</p>
     */
    public readonly hasUnfurlableLink = computed(() => {
        if (this.isUndecryptable()) return false;
        const withoutCode = this.content()
            .replace(/```[\s\S]*?```/g, ' ')
            .replace(/`[^`\n]*`/g, ' ');
        return /(^|[^<\w])https?:\/\/[^\s<>]+/.test(withoutCode);
    });

    /**
     * Whether to offer the ✕ at all.
     *
     * <p>The author always may. In a channel, so may anyone holding `DeleteAnyMessage`; in a DM
     * nobody but the author does, however the permission bit happens to be set elsewhere. Rendered
     * from the same rule the server enforces, so the button is never one that 403s.</p>
     */
    public readonly canSuppressEmbeds = computed(() => {
        const msg = this.message();
        if (msg.isPending || msg.isFailed || msg.isEphemeral || msg.isBotCommandPlaceholder) return false;
        if (this.isOwn()) return true;
        return !msg.conversationId && this.canDeleteAnyMessage();
    });

    /** The subtle "preview hidden - show" row: only where a preview could actually come back. */
    public readonly canRestoreEmbeds = computed(() =>
        this.embedsSuppressed() && this.canSuppressEmbeds() && this.hasUnfurlableLink());

    /**
     * The "(edited)" marker, driven by `editedAt` and never by `updatedAt`.
     *
     * <p>`updatedAt` is bumped by anything that writes the row - a preview attaching, a pin - so
     * driving the marker off it labels every message containing a link as edited, by nobody, a
     * second after it was posted.</p>
     */
    public readonly isEdited = computed(() => !!this.message().editedAt);

    protected readonly suppressingEmbeds = signal(false);
    private fileService = inject(FileService);
    private messagingService = inject(MessagingService);
    private messageStore = inject(MessageStore);
    private mlsService = inject(MlsService);
    private destroyRef = inject(DestroyRef);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);
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
        this.lightbox.set({loading: true, url: null, name: minimal.fileName, attachment: null});
        this.fileService.getAttachmentMetadataById(minimal.id).subscribe({
            next: att => this.lightbox.update(s => s ? {...s, loading: false, url: att.url, attachment: att} : s),
            error: () => this.lightbox.set(null),
        });
    }

    /**
     * Opens an embed image full-size.
     *
     * <p>Shows the proxied copy, exactly as the card does - blowing an image up is not a reason to
     * start talking to the origin. `originalUrl` is kept only so "open original" has somewhere to
     * go, and it takes an explicit click.</p>
     */
    openEmbedMedia(media: MessageEmbedMedia): void {
        const src = media.proxyUrl ?? media.url;
        if (!src) return;
        this.lightbox.set({
            loading: false,
            url: src,
            name: this.mediaFileName(media.url),
            attachment: null,
            originalUrl: media.url,
        });
    }

    /** Best-effort display name for an embed image - the last path segment, or nothing. */
    private mediaFileName(url: string): string {
        try {
            return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
        } catch {
            return '';
        }
    }

    downloadFromLightbox(): void {
        const state = this.lightbox();
        if (state?.attachment) {
            this.download(state.attachment);
        } else if (state?.url) {
            void openUrl(state.url);
        }
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

        const wasEncrypted = this.message().encryptionState === MessageEncryptionState.Encrypted;

        from(this.encryptEditIfNeeded(text)).pipe(
            switchMap(payload => this.messagingService.updateMessage(this.message().id, payload)),
            takeUntilDestroyed(this.destroyRef),
        ).subscribe({
            next: updated => {
                // Keep the plaintext locally. The server now holds ciphertext and MLS ratchets
                // forward only, so this is the one moment the edit is still readable to us.
                if (wasEncrypted) {
                    // Keyed on context and generation as well as the id - `updated.id` is the
                    // server's, and the cache must not be addressable by it alone.
                    const original = this.message();
                    const contextId = original.conversationId ?? original.channelId;
                    if (contextId) {
                        void this.mlsService.cacheMessage(
                            contextId, original.mlsGeneration ?? null, updated.id, toBase64(text),
                            original.authorId);
                    }
                    this.messageStore.applyMessageUpdate({...updated, content: toBase64(text)});
                } else {
                    this.messageStore.applyMessageUpdate(updated);
                }
                this.saving.set(false);
            },
            error: () => {
                this.saving.set(false);
                this.editText.set(text);
                this.isEditing.set(true);
            },
        });
    }

    /**
     * Encrypts an edit to an encrypted message before it leaves the machine.
     *
     * The edit path posted the replacement text in the clear regardless of the message's encryption
     * state, so editing an end-to-end encrypted message silently published its new contents to the
     * server - defeating that message's encryption entirely, by the user's own hand, with nothing
     * on screen to say so.
     *
     * Throws rather than falling back to cleartext: a failure here must abandon the edit, never
     * quietly downgrade it.
     */
    private async encryptEditIfNeeded(text: string): Promise<string> {
        const message = this.message();
        if (message.encryptionState !== MessageEncryptionState.Encrypted) return text;

        const contextId = message.conversationId ?? message.channelId;
        const keyHandle = this.mlsService.keyHandle();
        if (!contextId || !keyHandle) {
            throw new Error('Cannot edit an encrypted message while the MLS session is locked');
        }

        const generation = message.mlsGeneration
            ?? await this.mlsService.getKnownGeneration(contextId);
        const groupId = generation === null || generation === undefined
            ? null
            : await this.mlsService.getGroupId(contextId, generation);
        if (!groupId) throw new Error(`No MLS group held for encrypted context ${contextId}`);

        const {ciphertext} = await firstValueFrom(
            this.mlsService.sendMessage(groupId, keyHandle, toBase64(text)),
        );
        return ciphertext;
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

    public botName(authorId: string | undefined): string | undefined {
        return authorId ? this.guildBots().find(b => b.botUserId === authorId)?.botName : undefined;
    }

    public mentionedProfile(userId: string): ProfileDto | undefined {
        return this.profileService.getCachedByUserId(userId);
    }

    public mentionedRole(roleId: string): RoleDto | undefined {
        return this.guildRoles().find(r => r.id === roleId);
    }

    hasOwnReaction(emoji: string, emojiId?: string): boolean {
        const own = this.profileService.ownProfile()?.userId;
        if (!own) return false;
        return this.message().reactions?.some(r => emojiId
            ? r.emojiId === emojiId && r.userId === own
            : r.emoji === emoji && !r.emojiId && r.userId === own) ?? false;
    }

    toggleReaction(selection: EmojiSelection): void {
        const msg = this.message();
        const own = this.profileService.ownProfile()?.userId;
        if (!own || msg.isPending || msg.isFailed) return;

        const emoji = selection.customEmojiName ?? selection.native ?? '';
        const emojiId = selection.customEmojiId;
        if (!emoji) return;

        const hasReacted = this.hasOwnReaction(emoji, emojiId);

        if (hasReacted) {
            const contextId = msg.conversationId ?? msg.channelId ?? '';
            const dto: RemoveReactionDto = {reaction: emoji, contextId};
            this.messageStore.applyReactionRemoved({messageId: msg.id, emoji, emojiId, userId: own});
            this.messagingService.removeReaction(msg.id, dto).subscribe({
                error: () => this.messageStore.applyReactionAdded({messageId: msg.id, emoji, emojiId, userId: own}),
            });
        } else {
            const dto: CreateReactionDto = emojiId
                ? {channelId: msg.channelId, emojiId}
                : {conversationId: msg.conversationId ?? '', reaction: emoji, channelId: msg.channelId};
            this.messageStore.applyReactionAdded({messageId: msg.id, emoji, emojiId, userId: own});
            this.messagingService.addReaction(msg.id, dto).subscribe({
                error: () => this.messageStore.applyReactionRemoved({messageId: msg.id, emoji, emojiId, userId: own}),
            });
        }
    }

    togglePin(): void {
        const msg = this.message();
        if (msg.isPending || msg.isFailed) return;
        if (msg.isPinned) {
            this.messageStore.applyUnpinned({messageId: msg.id, authorId: msg.authorId, unpinnedById: this.profileService.ownProfile()?.userId ?? ''});
            this.messagingService.unpinMessage(msg.id).subscribe({
                error: () => this.messageStore.applyPinned({
                    messageId: msg.id,
                    authorId: msg.authorId,
                    pinnedById: msg.pinnedById ?? '',
                    pinnedAt: msg.pinnedAt ?? new Date().toISOString(),
                }),
            });
        } else {
            const own = this.profileService.ownProfile()?.userId ?? '';
            const optimisticAt = new Date().toISOString();
            this.messageStore.applyPinned({messageId: msg.id, authorId: msg.authorId, pinnedById: own, pinnedAt: optimisticAt});
            this.messagingService.pinMessage(msg.id).subscribe({
                next: (res: PinMessageResponse) => {
                    if (res.pinnedAt && res.pinnedById) {
                        this.messageStore.applyPinned({messageId: msg.id, authorId: msg.authorId, pinnedById: res.pinnedById, pinnedAt: res.pinnedAt});
                    }
                },
                error: () => this.messageStore.applyUnpinned({messageId: msg.id, authorId: msg.authorId, unpinnedById: own}),
            });
        }
    }

    /**
     * Dismisses or restores every preview on this message, for everyone who can see it.
     *
     * <p>Applied optimistically and rolled back on failure. Restoring cannot bring the old card
     * back from here - the server re-queues the unfurl and it returns over `*.MessageUpdated` -
     * so the space simply stays empty for a moment.</p>
     */
    toggleEmbedSuppression(): void {
        const msg = this.message();
        if (this.suppressingEmbeds() || !this.canSuppressEmbeds()) return;

        const suppress = !this.embedsSuppressed();
        const previousEmbeds = msg.embedsJson;
        this.suppressingEmbeds.set(true);
        this.messageStore.applyEmbedSuppression(msg.id, suppress);

        this.messagingService.setEmbedSuppression(msg.id, suppress)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
                next: () => this.suppressingEmbeds.set(false),
                error: err => {
                    this.suppressingEmbeds.set(false);
                    this.messageStore.applyEmbedSuppression(msg.id, !suppress, previousEmbeds);
                    this.toast.httpError(this.translate.instant('MESSAGE.EMBED_SUPPRESS_FAILED'), err);
                },
            });
    }

    protected publish(): void {
        if (this.published() || this.publishing()) return;
        // No server-side re-publish guard exists: a second call sends duplicate copies to
        // every follower. Latch locally the moment the request succeeds - and set the
        // in-flight flag synchronously, before subscribing, so a second click before the
        // response arrives can't slip through and fire a duplicate request.
        this.publishing.set(true);
        this.messagingService.publishMessage(this.message().id)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
                next: res => {
                    this.published.set(true);
                    this.publishing.set(false);
                    this.toast.success(
                        res.published === 0
                            ? this.translate.instant('MESSAGE.PUBLISH_NO_FOLLOWERS')
                            : res.published === 1
                                ? this.translate.instant('MESSAGE.PUBLISH_SUCCESS_SINGULAR', {count: res.published})
                                : this.translate.instant('MESSAGE.PUBLISH_SUCCESS', {count: res.published}));
                },
                error: err => {
                    this.publishing.set(false);
                    this.toast.httpError(this.translate.instant('MESSAGE.PUBLISH_FAILED'), err);
                },
            });
    }
}
