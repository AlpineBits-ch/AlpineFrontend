import {Component, DestroyRef, computed, effect, ElementRef, inject, input, output, signal, untracked, viewChild} from '@angular/core';
import twemoji from 'twemoji';
import {takeUntilDestroyed, toObservable, toSignal} from '@angular/core/rxjs-interop';
import {catchError, debounceTime, map, of, switchMap} from 'rxjs';
import {Button} from 'primeng/button';
import {MessageDto} from '../../../../../dtos/response/message.dto';
import {MessageEncryptionState} from '../../../../../enums/message-encryption-state.enum';
import {MessageType} from '../../../../../enums/message-type.enum';
import {MessageStore} from '../../../../../stores/message.store';
import {SocialKeyGateService} from '../../../../../services/social-key-gate.service';
import {ChannelDto, RoleDto, RoleType} from '../../../../../dtos/response/guild.dto';
import {BotCommandDto} from '../../../../../dtos/response/bot-command.dto';
import {InvokeBotCommandOptionDto} from '../../../../../dtos/request/invoke-bot-command.dto';
import {CommandDef, COMMANDS, ComposerCommandItem} from './commands';
import {
    detectTrigger,
    EmojiSuggestion,
    getMessage,
    MentionCandidate,
    mentionCandidateMatches,
} from './composer-utils';
import {
    buildHighlightedFragment,
    getEditorSegments,
    getTextCursorOffset,
    restoreCursorOffset
} from './composer-markdown';
import {SuggestionOverlayComponent} from './suggestion-overlay/suggestion-overlay.component';
import {EmojiPickerButtonComponent} from './emoji-picker-button/emoji-picker-button.component';
import {GifPickerButtonComponent} from './gif-picker-button/gif-picker-button.component';
import {GifService} from '../../../../../services/gif.service';
import {EmojiDataService} from '../../../../../services/emoji-data.service';
import {ComposerAttachmentsService} from './composer-attachments.service';
import {AttachmentPreviewsComponent} from './attachment-previews/attachment-previews.component';
import {GuildService} from '../../../../../services/guild.service';
import {ProfileService} from "../../../../../services/profile.service";
import {TranslateModule} from '@ngx-translate/core';
import {userNameStyle} from '../../../../../models/profile-font.model';
import {BotCommandService} from '../../../../../services/bot-command.service';
import {GuildWebsocketService} from '../../../../../services/guild-websocket.service';
import {BotCommandDialogService} from '../../../../../features/bot-command/bot-command-dialog.service';
import {readableContent, UNDECRYPTABLE_SHORT} from '../../../../../helpers/message-content.helper';
import {WikiService} from '../../../../../services/wiki.service';
import {WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {GuildFeature, guildHasFeature} from '../../../../guild/guild-features';
import {wikiShareLink} from '../../../wiki-link';
import {ToastService} from '../../../../../services/toast.service';
import {TranslateService} from '@ngx-translate/core';
import {EntitlementStore, MY_ENTITLEMENTS} from '../../../../../stores/entitlement.store';

const TWEMOJI_BASE = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/';

@Component({
    selector: 'app-composer',
    imports: [Button, SuggestionOverlayComponent, EmojiPickerButtonComponent, GifPickerButtonComponent, AttachmentPreviewsComponent, TranslateModule],
    templateUrl: './composer.component.html',
    styleUrl: './composer.component.css',
    providers: [ComposerAttachmentsService],
})
export class ComposerComponent {
    /** Set when composing in a guild channel -drives async member search. */
    guildId = input<string | null>(null);
    /** Set when composing in a guild channel -required to invoke a bot slash command. */
    channelId = input<string | null>(null);
    /** Set when composing in a DM/group conversation -filtered synchronously. */
    conversationMembers = input<MentionCandidate[]>([]);
    /** Set when composing in a guild channel -feeds @role suggestions. */
    guildRoles = input<RoleDto[]>([]);
    /** Set when composing in a guild channel -feeds # channel suggestions. */
    guildChannels = input<ChannelDto[]>([]);
    replyTo = input<MessageDto | null>(null);
    message = output<{
        content: string;
        attachments: string[];
        inReplyTo?: string;
        mentions: string[];
        roleMentions: string[];
        mentionsEveryone: boolean;
        mentionsHere: boolean;
    }>();
    cancelReply = output<void>();

    // ── Inputs / Outputs ─────────────────────────────────────────────────────
    commandAction = output<{ name: string; payload?: unknown }>();
    typing = output<void>();
    // Replying to a message does not make its body trustworthy: the chip above the composer
    // renders the same `content` the bubble refuses to.
    replySnippet = computed(() =>
        readableContent(this.replyTo(), UNDECRYPTABLE_SHORT).slice(0, 60));
    editorRef = viewChild.required<ElementRef<HTMLDivElement>>('editor');
    fileInputRef = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');
    gifPickerRef = viewChild(GifPickerButtonComponent);
    isEmpty = signal(true);
    overlayType = signal<'mention' | 'command' | 'emoji' | 'channel' | 'wiki' | null>(null);
    query = signal('');

    // ── View ─────────────────────────────────────────────────────────────────
    selectedIndex = signal(0);
    activeCommand = signal<CommandDef | null>(null);
    filteredEmojis = signal<EmojiSuggestion[]>([]);

    // ── Overlay state ────────────────────────────────────────────────────────
    overlayItems = computed<unknown[]>(() => {
        if (this.overlayType() === 'mention') return this.filteredMentions();
        if (this.overlayType() === 'command') return this.filteredCommands();
        if (this.overlayType() === 'emoji') return this.filteredEmojis();
        if (this.overlayType() === 'channel') return this.filteredChannels();
        if (this.overlayType() === 'wiki') return this.filteredWikiPages();
        return [];
    });
    placeholder = computed(() => {
        const cmd = this.activeCommand();
        if (!cmd) return 'Message';
        const paramHints = cmd.params.map(p => p.required ? `<${p.label}>` : `[${p.label}]`).join(' ');
        return paramHints ? `/${cmd.name} ${paramHints} -press Enter to send` : `/${cmd.name} -press Enter to send`;
    });
    protected readonly attachments = inject(ComposerAttachmentsService);
    /** True while a send is parked waiting on uploads that were still in flight when Enter landed. */
    protected readonly awaitingUploads = signal(false);
    private readonly emojiData = inject(EmojiDataService);
    private readonly gifService = inject(GifService);

    // ── Active command (global, awaiting params) ──────────────────────────────
    private readonly profileService = inject(ProfileService);

    // ── Guild member search (async, debounced) ────────────────────────────────
    replyAuthorName = computed(() => {
        const msg = this.replyTo();
        if (!msg) return '';
        if (msg.authorId === this.profileService.ownProfile()?.userId) return 'yourself';
        return this.profileService.getCachedByUserId(msg.authorId)?.userName ?? 'Unknown';
    });
    private readonly guildService = inject(GuildService);

    // ── Bot slash commands (per-guild, fetched once per guild transition) ────────
    private readonly botCommandService = inject(BotCommandService);
    private readonly botCommandDialogService = inject(BotCommandDialogService);
    private readonly guildWsService = inject(GuildWebsocketService);
    private readonly messageStore = inject(MessageStore);
    private readonly destroyRef = inject(DestroyRef);
    private readonly socialGate = inject(SocialKeyGateService);
    private readonly entitlements = inject(EntitlementStore);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);
    /** Set on teardown, so a send parked on an upload does not resume into a dead view. */
    private destroyed = false;
    private readonly botCommands = signal<BotCommandDto[]>([]);

    // ── Wiki pages (per-guild, fetched on the first `[[`) ────────────────────────
    private readonly wikiService = inject(WikiService);
    private readonly wikiPages = signal<WikiPageSummaryDto[]>([]);
    /** The guild {@link wikiPages} was filled for, so a guild switch cannot serve the old list. */
    private wikiPagesGuildId: string | null = null;

    constructor() {
        this.destroyRef.onDestroy(() => this.destroyed = true);

        // Which upload ceiling applies is decided by where the file is going, so the attachment
        // service is told the scope rather than reaching for a route. Both sets are read here: the
        // user's own is the ceiling in a DM and one half of the pair inside a guild.
        //
        // Untracked, so the guild is the only thing this depends on. `ensureLoaded` reads the cache
        // it also writes, and tracking that would re-run this on every set the store takes for any
        // subject in the app.
        effect(() => {
            const gid = this.guildId();
            untracked(() => {
                this.attachments.guildId.set(gid);
                this.entitlements.ensureLoaded(MY_ENTITLEMENTS);
                if (gid) this.entitlements.ensureLoaded({kind: 'guild', id: gid});
            });
        });

        effect(() => {
            const gid = this.guildId();
            if (!gid) {
                this.botCommands.set([]);
                return;
            }
            this.botCommandService.getCommands(gid).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
                next: cmds => this.botCommands.set(cmds),
                error: () => this.botCommands.set([]),
            });
        });

        this.guildWsService.botInstalledObservable.pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(e => {
                if (e.guildId === this.guildId()) this.refetchBotCommands();
            });
        this.guildWsService.botUninstalledObservable.pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(e => {
                if (e.guildId === this.guildId()) this.refetchBotCommands();
            });
    }

    // ── Filtered suggestions ──────────────────────────────────────────────────
    private commandAtStart = signal(false);
    filteredCommands = computed<ComposerCommandItem[]>(() => {
        if (this.overlayType() !== 'command') return [];
        const q = this.query().toLowerCase();
        const atStart = this.commandAtStart();
        const local: ComposerCommandItem[] = COMMANDS
            .filter(c => atStart || c.scope === 'inline')
            .filter(c => c.name.startsWith(q))
            .map(def => ({kind: 'local' as const, def}));
        // Bot commands always consume the whole message (like local 'global'-scope commands),
        // so only surface them at the start of the editor - never mid-sentence.
        const bot: ComposerCommandItem[] = atStart
            ? this.botCommands().filter(c => c.name.startsWith(q)).map(def => ({kind: 'bot' as const, def}))
            : [];
        return [...local, ...bot];
    });
    private readonly _queryStream = toObservable(this.query);
    private readonly guildSearchResults = toSignal(
        this._queryStream.pipe(
            debounceTime(200),
            switchMap(q => {
                const gid = this.guildId();
                if (!gid || this.overlayType() !== 'mention') return of<MentionCandidate[]>([]);
                return this.guildService.searchMembers(gid, q).pipe(
                    map(members => members
                        .filter(m => m.profile)
                        .map((m): MentionCandidate => ({
                            kind: 'user',
                            userId: m.userId,
                            userName: m.profile!.userName,
                            avatarUrl: m.profile?.avatarUrl,
                            accentColor: m.profile?.accentColor,
                            font: m.profile?.font,
                        }))
                    ),
                    catchError(() => of<MentionCandidate[]>([]))
                );
            }),
        ),
        {initialValue: [] as MentionCandidate[]}
    );
    private readonly staticGuildCandidates = computed<MentionCandidate[]>(() => {
        if (!this.guildId()) return [];
        const roleCandidates: MentionCandidate[] = this.guildRoles()
            .filter(r => r.type !== RoleType.Everyone)
            .map(r => ({kind: 'role', roleId: r.id, name: r.name, color: r.color}));
        return [
            {kind: 'everyone'},
            {kind: 'here'},
            ...roleCandidates,
        ];
    });
    filteredMentions = computed<MentionCandidate[]>(() => {
        if (this.overlayType() !== 'mention') return [];
        const q = this.query().toLowerCase();
        const userCandidates: MentionCandidate[] = this.guildId()
            ? this.guildSearchResults()
            : this.conversationMembers().filter(m => mentionCandidateMatches(m, q));
        const staticMatches = this.staticGuildCandidates().filter(c => mentionCandidateMatches(c, q));
        return [...staticMatches, ...userCandidates].slice(0, 8);
    });
    filteredChannels = computed<ChannelDto[]>(() => {
        if (this.overlayType() !== 'channel') return [];
        const q = this.query().toLowerCase();
        return this.guildChannels()
            .filter(c => c.name.toLowerCase().includes(q))
            .slice(0, 8);
    });

    /**
     * Wiki pages for `[[`.
     *
     * <p>Matched on title and tags. Pinned pages sort first on an empty query, so the bare `[[`
     * offers the pages the guild has decided matter rather than whatever the listing returned
     * first.</p>
     */
    filteredWikiPages = computed<WikiPageSummaryDto[]>(() => {
        if (this.overlayType() !== 'wiki') return [];
        const q = this.query().toLowerCase().trim();
        const matches = this.wikiPages().filter(p => !q
            || p.title.toLowerCase().includes(q)
            || (p.tags ?? []).some(t => t.toLowerCase().includes(q)));
        return [...matches]
            .sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || a.title.localeCompare(b.title))
            .slice(0, 8);
    });

    // ── Typing throttle ───────────────────────────────────────────────────────
    private typingThrottle: ReturnType<typeof setTimeout> | null = null;

    // ── Trigger range ─────────────────────────────────────────────────────────

    private triggerRange: Range | null = null;
    private savedEmojiOffset = 0;

    // ── File input ────────────────────────────────────────────────────────────

    onAttachClick(): void {
        this.fileInputRef().nativeElement.click();
    }

    onFileInputChange(event: Event): void {
        const input = event.target as HTMLInputElement;
        if (input.files) {
            for (const file of Array.from(input.files)) this.attachments.attach(file);
        }
        input.value = '';
    }

    // ── Input events ─────────────────────────────────────────────────────────

    onInput(): void {
        const editor = this.editorRef().nativeElement;
        this.savedEmojiOffset = getTextCursorOffset(editor);
        this.isEmpty.set(
            (editor.textContent ?? '').trim() === '' &&
            !editor.querySelector('.mention-chip') &&
            !editor.querySelector('img[data-emoji]')
        );

        // Auto-replace :shortcode: on closing colon
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            const node = range.startContainer;
            if (node.nodeType === Node.TEXT_NODE) {
                const textBefore = (node.textContent ?? '').slice(0, range.startOffset);
                const autoMatch = textBefore.match(/(?:^|[^\w]):([\w-]+):$/);
                if (autoMatch) {
                    const native = this.emojiData.resolveOne(autoMatch[1]);
                    if (native) {
                        const colonPos = textBefore.lastIndexOf(':', range.startOffset - 2);
                        const r = document.createRange();
                        r.setStart(node as Text, colonPos);
                        r.setEnd(node as Text, range.startOffset);
                        r.deleteContents();
                        const img = this.createEmojiImg(native);
                        r.insertNode(img);
                        const newRange = document.createRange();
                        newRange.setStartAfter(img);
                        newRange.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(newRange);
                        this.closeOverlay();
                        return;
                    }
                }
            }
        }

        this.emitTypingIfNeeded(editor);

        const result = detectTrigger(editor);
        if (result) {
            this.overlayType.set(result.type);
            this.query.set(result.query);
            this.selectedIndex.set(0);
            this.triggerRange = result.range;

            if (result.type === 'command') this.commandAtStart.set(result.atStart);
            if (result.type === 'emoji') this.filteredEmojis.set(this.emojiData.search(result.query));
            if (result.type === 'wiki') this.ensureWikiPages();
        } else {
            this.closeOverlay();
            this.applyMarkdownHighlighting(editor);
        }
    }

    focus(): void {
        this.editorRef().nativeElement.focus();
    }

    onKeydown(event: KeyboardEvent): void {
        const isOpen = this.overlayType() !== null && this.overlayItems().length > 0;

        if (isOpen) {
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                this.selectedIndex.update(i => Math.min(i + 1, this.overlayItems().length - 1));
                return;
            }
            if (event.key === 'ArrowUp') {
                event.preventDefault();
                this.selectedIndex.update(i => Math.max(i - 1, 0));
                return;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                this.confirmSelection();
                return;
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                this.closeOverlay();
                return;
            }
        }

        if (event.key === 'Escape' && this.activeCommand()) {
            event.preventDefault();
            this.activeCommand.set(null);
            const editor = this.editorRef().nativeElement;
            editor.innerHTML = '';
            this.isEmpty.set(true);
            return;
        }

        if (event.key === 'Enter' && event.shiftKey) {
            event.preventDefault();
            this.insertNewline();
            return;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            this.send();
        }
    }

    onPaste(event: ClipboardEvent): void {
        const items = event.clipboardData?.items;
        if (items) {
            for (const item of Array.from(items)) {
                if (item.type.startsWith('image/')) {
                    event.preventDefault();
                    const file = item.getAsFile();
                    if (file) this.attachments.attach(file);
                    return;
                }
            }
        }
        event.preventDefault();
        const text = event.clipboardData?.getData('text/plain') ?? '';
        document.execCommand('insertText', false, text);
    }

    onEditorFocus(): void {
        this.savedEmojiOffset = getTextCursorOffset(this.editorRef().nativeElement);
    }

    onEditorClick(): void {
        this.savedEmojiOffset = getTextCursorOffset(this.editorRef().nativeElement);
    }

    onMentionSelected(candidate: MentionCandidate): void {
        if (!this.triggerRange) return;

        this.triggerRange.deleteContents();

        const chip = document.createElement('span');
        chip.contentEditable = 'false';

        if (candidate.kind === 'user') {
            chip.className = 'mention-chip';
            chip.dataset['userId'] = candidate.userId;
            chip.dataset['display'] = `@${candidate.userName}`;
            chip.textContent = `@${candidate.userName}`;
            Object.assign(chip.style, userNameStyle(candidate));
        } else if (candidate.kind === 'role') {
            chip.className = 'mention-chip mention-chip-role';
            chip.dataset['roleId'] = candidate.roleId;
            chip.dataset['display'] = `@${candidate.name}`;
            chip.textContent = `@${candidate.name}`;
            chip.style.color = candidate.color;
        } else if (candidate.kind === 'everyone') {
            chip.className = 'mention-chip mention-chip-special';
            chip.dataset['everyone'] = 'true';
            chip.dataset['display'] = '@everyone';
            chip.textContent = '@everyone';
        } else {
            chip.className = 'mention-chip mention-chip-special';
            chip.dataset['here'] = 'true';
            chip.dataset['display'] = '@here';
            chip.textContent = '@here';
        }

        this.triggerRange.insertNode(chip);
        const space = document.createTextNode(' ');
        chip.after(space);

        const sel = window.getSelection();
        if (sel) {
            const r = document.createRange();
            r.setStartAfter(space);
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
        }

        this.closeOverlay();
        this.editorRef().nativeElement.focus();
    }

    onChannelSelected(channel: ChannelDto): void {
        if (!this.triggerRange) return;

        this.triggerRange.deleteContents();
        const textNode = document.createTextNode(`#${channel.name} `);
        this.triggerRange.insertNode(textNode);

        const sel = window.getSelection();
        if (sel) {
            const r = document.createRange();
            r.setStartAfter(textNode);
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
        }

        this.closeOverlay();
        this.isEmpty.set(false);
        this.editorRef().nativeElement.focus();
    }

    /**
     * Replaces `[[query` with a chip that reads as the page and sends as a link to it.
     *
     * <p>The chip's `data-display` is what {@link getMessage} puts on the wire - the shareable URL -
     * while its text stays the page title. That is the same split a member mention already uses, so
     * nothing new had to learn about chips.</p>
     */
    onWikiPageSelected(page: WikiPageSummaryDto): void {
        if (!this.triggerRange) return;
        const guildId = this.guildId();
        if (!guildId) return;

        this.triggerRange.deleteContents();

        const chip = document.createElement('span');
        chip.contentEditable = 'false';
        chip.className = 'mention-chip mention-chip-wiki';
        chip.dataset['wikiPageId'] = page.id;
        chip.dataset['display'] = wikiShareLink(guildId, page.id);
        chip.textContent = page.title;

        this.triggerRange.insertNode(chip);
        const space = document.createTextNode(' ');
        chip.after(space);

        const sel = window.getSelection();
        if (sel) {
            const r = document.createRange();
            r.setStartAfter(space);
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
        }

        this.closeOverlay();
        this.isEmpty.set(false);
        this.editorRef().nativeElement.focus();
    }

    onCommandSelected(item: ComposerCommandItem): void {
        if (item.kind === 'bot') {
            this.onBotCommandSelected(item.def);
            return;
        }
        const cmd = item.def;
        const editor = this.editorRef().nativeElement;
        const isInline = !this.commandAtStart() || cmd.scope === 'inline';

        if (isInline) {
            if (this.triggerRange) {
                const result = cmd.execute('');
                this.triggerRange.deleteContents();
                if (result.text) {
                    const textNode = document.createTextNode(result.text);
                    this.triggerRange.insertNode(textNode);
                    const sel = window.getSelection();
                    if (sel) {
                        const r = document.createRange();
                        r.setStartAfter(textNode);
                        r.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(r);
                    }
                }
                if (result.action) this.dispatchAction(result.action);
            }
            this.closeOverlay();
            editor.focus();
        } else {
            editor.innerHTML = '';
            if (cmd.params.length === 0) {
                const result = cmd.execute('');
                if (result.text) this.message.emit({content: result.text, attachments: [], mentions: [], roleMentions: [], mentionsEveryone: false, mentionsHere: false});
                if (result.action) this.dispatchAction(result.action);
            } else {
                this.activeCommand.set(cmd);
            }
            this.closeOverlay();
            editor.focus();
        }
    }

    private onBotCommandSelected(cmd: BotCommandDto): void {
        const editor = this.editorRef().nativeElement;
        editor.innerHTML = '';
        this.isEmpty.set(true);
        this.closeOverlay();
        editor.focus();

        if (cmd.options.length === 0) {
            this.runBotCommand(cmd, []);
            return;
        }
        const guildId = this.guildId();
        const channelId = this.channelId();
        if (!guildId || !channelId) return;
        this.botCommandDialogService.open({guildId, channelId, command: cmd});
    }

    private runBotCommand(cmd: BotCommandDto, options: InvokeBotCommandOptionDto[]): void {
        const guildId = this.guildId();
        const channelId = this.channelId();
        if (!guildId || !channelId) return;

        const tempId = crypto.randomUUID();
        const now = new Date();
        this.messageStore.addMessage({
            id: tempId,
            content: '',
            channelId,
            conversationId: undefined,
            authorId: cmd.botUserId,
            createdAt: now,
            updatedAt: now,
            isPending: true,
            isFailed: false,
            isBotCommandPlaceholder: true,
            attachments: [],
            inReplyTo: undefined,
            mentions: [],
            encryptionState: MessageEncryptionState.Plain,
            mlsEpoch: undefined,
            mlsSequenceNumber: undefined,
            senderDeviceId: undefined,
            type: MessageType.Message,
        });

        this.botCommandService.invokeCommandWithRetry(
            guildId,
            channelId,
            {botUserId: cmd.botUserId, commandName: cmd.name, options},
            cmds => this.botCommands.set(cmds),
        ).pipe(
            switchMap(() => this.botCommandService.awaitBotResponse(channelId, cmd.botUserId)),
            takeUntilDestroyed(this.destroyRef),
        ).subscribe({
            next: () => this.messageStore.removeMessage(tempId),
            error: () => this.messageStore.failMessage(tempId),
        });
    }

    /**
     * Loads this guild's page listing, once, the first time somebody types `[[` in it.
     *
     * <p>Not an effect on `guildId`: most messages contain no wiki link, and fetching a page tree
     * for every channel anybody clicks through would be a request per switch for a menu that never
     * opens. A guild with the Wiki module off is left empty, so the menu simply never appears.</p>
     */
    private ensureWikiPages(): void {
        const guildId = this.guildId();
        if (!guildId || this.wikiPagesGuildId === guildId) return;

        this.wikiPagesGuildId = guildId;
        this.wikiPages.set([]);

        const guild = this.guildService.guilds().find(g => g.id === guildId);
        if (!guild || !guildHasFeature(guild, GuildFeature.Wiki)) return;

        this.wikiService.getWiki(guildId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
            next: wiki => {
                // A second guild switch while this was in flight would otherwise land one guild's
                // pages under another guild's name.
                if (this.wikiPagesGuildId === guildId) this.wikiPages.set(wiki.pages);
            },
            error: () => this.wikiPages.set([]),
        });
    }

    private refetchBotCommands(): void {
        const gid = this.guildId();
        if (!gid) return;
        this.botCommandService.getCommands(gid).subscribe({
            next: cmds => this.botCommands.set(cmds),
            error: () => {},
        });
    }

    onEmojiShortcodeSelected(emoji: EmojiSuggestion): void {
        if (!this.triggerRange) return;

        this.triggerRange.deleteContents();
        const img = this.createEmojiImg(emoji.native);
        this.triggerRange.insertNode(img);

        const sel = window.getSelection();
        if (sel) {
            const r = document.createRange();
            r.setStartAfter(img);
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
        }

        this.closeOverlay();
        this.isEmpty.set(false);
        this.editorRef().nativeElement.focus();
    }

    // ── Mention handling ──────────────────────────────────────────────────────

    onGifSelected(url: string): void {
        this.message.emit({content: url, attachments: [], mentions: [], roleMentions: [], mentionsEveryone: false, mentionsHere: false});
    }

    // ── Command handling ──────────────────────────────────────────────────────

    onEmojiSelected(emoji: string): void {
        const editor = this.editorRef().nativeElement;
        editor.focus();
        restoreCursorOffset(editor, this.savedEmojiOffset);

        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const img = this.createEmojiImg(emoji);
        range.insertNode(img);
        range.setStartAfter(img);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        this.savedEmojiOffset += 1;
        this.isEmpty.set(false);
    }

    // ── Emoji shortcode overlay selection ─────────────────────────────────────

    send(): void {
        // Gated before a single character is touched, deliberately. Everything below this line
        // clears the editor, and a user who declines the key prompt would otherwise find their
        // message gone as the price of saying "not now". On acceptance we re-enter and it sends.
        //
        // The check is synchronous and allocation-free on the overwhelmingly common path - an
        // account with a master key never reaches the promise.
        if (!this.socialGate.isSatisfied()) {
            void this.socialGate.require().then(allowed => {
                if (allowed) this.send();
            });
            return;
        }

        // Attachments are sent by id, and an upload that has not answered yet has no id -
        // `flushAndClear` would drop it and the message would go out with only the files that
        // happened to be fast enough. So park the send instead of narrowing it, and run it again
        // once the last upload lands. The editor is deliberately left untouched meanwhile: the
        // user keeps whatever they typed, and can keep typing while the parked send waits.
        if (this.attachments.isUploading()) {
            if (this.awaitingUploads()) return;
            this.awaitingUploads.set(true);
            void this.attachments.settled().then(() => {
                this.awaitingUploads.set(false);
                if (!this.destroyed) this.send();
            });
            return;
        }

        // A failed upload settles too, and sending here would silently post without it. Say so
        // rather than swallow the Enter - the failed chip is on screen with its own ✕.
        if (this.attachments.hasFailed()) {
            this.toast.error(this.translate.instant(
                this.attachments.failureKey() ?? 'COMPOSER.UPLOAD_FAILED'));
            return;
        }

        if (this.typingThrottle !== null) {
            clearTimeout(this.typingThrottle);
            this.typingThrottle = null;
        }
        const editor = this.editorRef().nativeElement;
        let text = this.emojiData.resolveShortcodes(getMessage(editor));

        const cmd = this.activeCommand();
        if (cmd) {
            const result = cmd.execute(text);
            this.activeCommand.set(null);
            if (result.action) this.dispatchAction(result.action);
            text = result.text ?? '';
        }

        const attachments = this.attachments.flushAndClear();
        const chips = Array.from(editor.querySelectorAll<HTMLElement>('.mention-chip'));
        const mentions = chips.map(c => c.dataset['userId'] ?? '').filter(Boolean);
        const roleMentions = chips.map(c => c.dataset['roleId'] ?? '').filter(Boolean);
        const mentionsEveryone = chips.some(c => c.dataset['everyone'] === 'true');
        const mentionsHere = chips.some(c => c.dataset['here'] === 'true');

        if (text || attachments.length > 0) {
            this.message.emit({content: text, attachments, inReplyTo: this.replyTo()?.id, mentions, roleMentions, mentionsEveryone, mentionsHere});
        }

        editor.innerHTML = '';
        this.isEmpty.set(true);
        this.closeOverlay();
        editor.focus();
    }

    // ── GIF handling ──────────────────────────────────────────────────────────

    private emitTypingIfNeeded(editor: HTMLElement): void {
        const hasContent = getMessage(editor).trim().length > 0;
        if (!hasContent || this.typingThrottle !== null) return;
        this.typing.emit();
        this.typingThrottle = setTimeout(() => {
            this.typingThrottle = null;
        }, 2000);
    }

    // ── Emoji picker handling ─────────────────────────────────────────────────

    private insertNewline(): void {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const br = document.createElement('br');
        range.insertNode(br);
        range.setStartAfter(br);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        this.onInput();
    }

    // ── Send ─────────────────────────────────────────────────────────────────

    private applyMarkdownHighlighting(editor: HTMLElement): void {
        const offset = getTextCursorOffset(editor);
        const segments = getEditorSegments(editor);
        const frag = buildHighlightedFragment(segments);
        editor.innerHTML = '';
        editor.appendChild(frag);
        // Browsers don't render a trailing <br> as a visible new line unless there
        // is content after it. Add a sentinel so the cursor can visually land on
        // the new line after Shift+Enter.
        const last = editor.lastChild;
        if (last instanceof HTMLElement && last.tagName === 'BR' && (editor.textContent ?? '').length > 0) {
            const sentinel = document.createElement('br');
            sentinel.dataset['sentinel'] = '1';
            editor.appendChild(sentinel);
        }
        restoreCursorOffset(editor, offset);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private confirmSelection(): void {
        const idx = this.selectedIndex();
        if (this.overlayType() === 'mention') {
            const f = this.filteredMentions()[idx];
            if (f) this.onMentionSelected(f);
        } else if (this.overlayType() === 'command') {
            const c = this.filteredCommands()[idx];
            if (c) this.onCommandSelected(c);
        } else if (this.overlayType() === 'emoji') {
            const e = this.filteredEmojis()[idx];
            if (e) this.onEmojiShortcodeSelected(e);
        } else if (this.overlayType() === 'channel') {
            const ch = this.filteredChannels()[idx];
            if (ch) this.onChannelSelected(ch);
        } else if (this.overlayType() === 'wiki') {
            const page = this.filteredWikiPages()[idx];
            if (page) this.onWikiPageSelected(page);
        }
    }

    private dispatchAction(action: { name: string; payload?: unknown }): void {
        if (action.name === 'open-gif-picker') {
            this.gifPickerRef()?.open();
            return;
        }
        if (action.name === 'open-gif-picker-with-search') {
            const query = (action.payload as { query: string }).query;
            this.gifPickerRef()?.openWithSearch(query);
            return;
        }
        this.commandAction.emit(action);
    }

    private createEmojiImg(native: string): HTMLImageElement {
        const tmp = document.createElement('span');
        tmp.innerHTML = twemoji.parse(native, {
            folder: 'svg',
            ext: '.svg',
            base: TWEMOJI_BASE,
            attributes: () => ({
                style: 'height:1.25em;width:1.25em;vertical-align:-0.25em;display:inline-block',
                draggable: 'false',
            }),
        });
        const img = (tmp.querySelector('img') ?? document.createElement('img')) as HTMLImageElement;
        img.dataset['emoji'] = native;
        img.contentEditable = 'false';
        img.alt = native;
        return img;
    }

    private closeOverlay(): void {
        this.overlayType.set(null);
        this.query.set('');
        this.filteredEmojis.set([]);
        this.triggerRange = null;
    }
}
