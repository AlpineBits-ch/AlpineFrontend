import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    effect,
    ElementRef,
    inject,
    input,
    output,
    signal,
    untracked,
    viewChild,
} from '@angular/core';
import twemoji from 'twemoji';
import {takeUntilDestroyed, toObservable, toSignal} from '@angular/core/rxjs-interop';
import {catchError, debounceTime, map, of, switchMap} from 'rxjs';
import {DecimalPipe} from '@angular/common';
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
    setEditorText,
} from './composer-utils';
import {effectiveCeiling, lengthCounterClass, lengthState} from './composer-length';
import {DraftService} from '../../../../../services/draft.service';
import {MarkdownPipe} from '../../../../../pipes/markdown.pipe';
import {
    applyTrailingSentinel,
    blockKey,
    blockOf,
    EditorSegment,
    getEditorSegments,
    getTextCursorOffset,
    highlightBlock,
    isEditorBlank,
    needsReblock,
    renderBlocks,
    restoreCursorOffset,
    splitIntoBlocks,
} from './composer-markdown';
import {SuggestionOverlayComponent} from './suggestion-overlay/suggestion-overlay.component';
import {EmojiPickerButtonComponent} from './emoji-picker-button/emoji-picker-button.component';
import {GifPickerButtonComponent} from './gif-picker-button/gif-picker-button.component';
import {GifService} from '../../../../../services/gif.service';
import {EmojiDataService} from '../../../../../services/emoji-data.service';
import {ComposerAttachmentsService} from './composer-attachments.service';
import {AttachmentPreviewsComponent} from './attachment-previews/attachment-previews.component';
import {GuildService} from '../../../../../services/guild.service';
import {ProfileService} from '../../../../../services/profile.service';
import {TranslateModule} from '@ngx-translate/core';
import {userNameStyle} from '../../../../../models/profile-font.model';
import {BotCommandService} from '../../../../../services/bot-command.service';
import {BotCommandDialogService} from '../../../../../features/bot-command/bot-command-dialog.service';
import {readableContent, UNDECRYPTABLE_SHORT} from '../../../../../helpers/message-content.helper';
import {WikiService} from '../../../../../services/wiki.service';
import {WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {GuildFeature, guildHasFeature} from '../../../../guild/guild-features';
import {wikiShareLink} from '../../../wiki-link';
import {ToastService} from '../../../../../services/toast.service';
import {TranslateService} from '@ngx-translate/core';
import {EntitlementStore, MY_ENTITLEMENTS} from '../../../../../stores/entitlement.store';
import {PersonaService} from '../../../../../services/persona.service';
import {PersonaSwitcherComponent} from '../../../../guild/personas/persona-switcher/persona-switcher.component';
import {personaIdentity} from '../../../../guild/personas/persona-identity';
import {personaMentionToken} from '../../../../guild/personas/persona-mention';
import {DiceTrayComponent} from '../../../../guild/dice/dice-tray/dice-tray.component';
import {SceneService} from '../../../../../services/scene.service';
import {DiceService} from '../../../../../services/dice.service';
import {parseDiceExpression} from '../../../../guild/dice/dice-notation';
import {RelativeTimePipe} from '../../../../../pipes/relative-time.pipe';
import {FileService} from '../../../../../services/file.service';
import {inlineAttachmentIds, inlineAttachmentPattern} from '../../../inline-attachment';
import {RealtimeConnectionService} from '../../../../../services/realtime-connection.service';

const TWEMOJI_BASE = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/';

function segmentText(segments: EditorSegment[]): string {
    return segments.map(s => (s.type === 'text' ? s.text : '')).join('');
}

/** 'yours' is the only loud one. The rest say where the scene stands and nothing more. */
export type SceneTurnState = 'yours' | 'waiting' | 'paused' | 'concluded';

/**
 * What the composer says about the scene it is writing into. The notice sits on the thing you would
 * use to answer it, which is the only place it cannot be missed and the only place it is not nagging.
 * None of it blocks a send: the server owns that rule.
 */
/**
 * What a reader outside the cast is offered. Mutually exclusive with `SceneTurnPrompt`: somebody who
 * is not in the scene has no turn, and somebody who is has nothing to join.
 */
export type SceneJoinState = 'open' | 'ask' | 'pending' | 'denied';

export interface SceneJoinPrompt {
    state: SceneJoinState;
    /** The GM's words on a refusal, when they left any. */
    reason: string | null;
    /** Opens the character picker. Null while an ask is waiting on an answer. */
    open: (() => void) | null;
    /** Takes the ask back. Only set while one is pending. */
    withdraw: (() => void) | null;
    busy: boolean;
}

export interface SceneTurnPrompt {
    state: SceneTurnState;
    /** Who is up: your character for 'yours', theirs for 'waiting'. Empty otherwise. */
    characterName: string;
    /** ISO-8601, or null for a scene with no clock. Only 'yours' carries one. */
    deadlineAt: string | null;
    overdue: boolean;
    /** Passing without posting. Absent when the caller cannot advance the turn. */
    pass: (() => void) | null;
    passing: boolean;
}

@Component({
    selector: 'app-composer',
    imports: [
        Button,
        SuggestionOverlayComponent,
        EmojiPickerButtonComponent,
        GifPickerButtonComponent,
        AttachmentPreviewsComponent,
        PersonaSwitcherComponent,
        DiceTrayComponent,
        MarkdownPipe,
        TranslateModule,
        RelativeTimePipe,
        DecimalPipe,
    ],
    templateUrl: './composer.component.html',
    styleUrl: './composer.component.css',
    providers: [ComposerAttachmentsService],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComposerComponent {
    /** Set when composing in a guild channel, drives async member search. */
    readonly guildId = input<string | null>(null);
    /** Set when composing in a guild channel, required to invoke a bot slash command. */
    readonly channelId = input<string | null>(null);
    /** Set when composing in a DM/group conversation, filtered synchronously. */
    readonly conversationMembers = input<MentionCandidate[]>([]);
    /** Set when composing in a guild channel, feeds @role suggestions. */
    readonly guildRoles = input<RoleDto[]>([]);
    /** Set when composing in a guild channel, feeds # channel suggestions. */
    readonly guildChannels = input<ChannelDto[]>([]);
    readonly replyTo = input<MessageDto | null>(null);
    /** Guild channels only: the caller holds `UsePersonas` and the guild has the module on. */
    readonly canUsePersonas = input(false);
    /** Guild channels only: the caller holds `RollDice` and the guild has the module on. */
    readonly canRollDice = input(false);
    /** Set while this channel is the in-character half of a scene. Null everywhere else. */
    readonly sceneTurn = input<SceneTurnPrompt | null>(null);
    /** Takes the strip when set: the actionable notice wins the slot over the quiet one. */
    readonly sceneJoin = input<SceneJoinPrompt | null>(null);
    /** The server cannot read ciphertext, so proxy tags have to be resolved here instead. */
    readonly resolvePersonaLocally = input(false);
    submitted = output<{
        content: string;
        attachments: string[];
        inReplyTo?: string;
        mentions: string[];
        roleMentions: string[];
        /** Persona ids named in the body as `<@pers_...>`. */
        personaMentions: string[];
        mentionsEveryone: boolean;
        mentionsHere: boolean;
        personaId?: string;
    }>();
    cancelReply = output<void>();

    // ── Inputs / Outputs ─────────────────────────────────────────────────────
    commandAction = output<{name: string; payload?: unknown}>();
    typing = output<void>();
    // Replying to a message does not make its body trustworthy: the chip above the composer
    // renders the same `content` the bubble refuses to.
    readonly replySnippet = computed(() => readableContent(this.replyTo(), UNDECRYPTABLE_SHORT).slice(0, 60));
    readonly editorRef = viewChild.required<ElementRef<HTMLDivElement>>('editor');
    readonly fileInputRef = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');
    readonly gifPickerRef = viewChild(GifPickerButtonComponent);
    readonly isEmpty = signal(true);
    readonly overlayType = signal<'mention' | 'command' | 'emoji' | 'channel' | 'wiki' | null>(null);
    readonly query = signal('');

    // ── View ─────────────────────────────────────────────────────────────────
    readonly selectedIndex = signal(0);
    readonly activeCommand = signal<CommandDef | null>(null);
    readonly filteredEmojis = signal<EmojiSuggestion[]>([]);

    // ── Overlay state ────────────────────────────────────────────────────────
    readonly overlayItems = computed<unknown[]>(() => {
        if (this.overlayType() === 'mention') return this.filteredMentions();
        if (this.overlayType() === 'command') return this.filteredCommands();
        if (this.overlayType() === 'emoji') return this.filteredEmojis();
        if (this.overlayType() === 'channel') return this.filteredChannels();
        if (this.overlayType() === 'wiki') return this.filteredWikiPages();
        return [];
    });
    readonly placeholder = computed(() => {
        const cmd = this.activeCommand();
        if (!cmd) return 'Message';
        const paramHints = cmd.params.map(p => (p.required ? `<${p.label}>` : `[${p.label}]`)).join(' ');
        return paramHints
            ? `/${cmd.name} ${paramHints} -press Enter to send`
            : `/${cmd.name} -press Enter to send`;
    });
    // ── Personas ─────────────────────────────────────────────────────────────
    protected readonly personas = inject(PersonaService);
    /** What is in the editor now. Not to be confused with {@link drafts}, which is what the server holds. */
    protected readonly typed = signal('');
    protected readonly showPersonaSwitcher = computed(() => !!this.guildId() && this.canUsePersonas());
    protected readonly personaResolution = computed(() =>
        this.personas.resolveFor(this.guildId(), this.channelId(), this.typed()),
    );
    protected readonly proxyHintKey = computed((): string | null => {
        if (!this.showPersonaSwitcher()) return null;
        switch (this.personaResolution().source) {
            case 'tag':
                return 'PERSONA.COMPOSER.TAG_STRIPPED';
            case 'escaped':
                return 'PERSONA.COMPOSER.ESCAPED';
            default:
                return null;
        }
    });
    protected readonly proxyHintTag = computed(() => {
        const matched = this.personaResolution().matched;
        return matched ? `${matched.prefix}${matched.suffix}` : '';
    });
    private readonly personaSwitcherRef = viewChild(PersonaSwitcherComponent);

    /** The character a roll would be made as, so the tray never asks a question already answered. */
    protected readonly rollSpeaker = computed(() => {
        const entry = this.personas.entry(this.guildId(), this.personaResolution().personaId);
        return entry ? personaIdentity(entry) : null;
    });
    private readonly dice = inject(DiceService);
    protected readonly diceOpen = signal(false);
    protected readonly showDice = computed(
        () => !!this.guildId() && !!this.channelId() && this.canRollDice(),
    );
    /** Redraws the deadline on the scene strip without each composer holding its own timer. */
    protected readonly now = inject(SceneService).now;

    // ── Long-form writing ────────────────────────────────────────────────────
    /** The room a post has in this guild. Plan-derived, so it differs between servers. */
    protected readonly maxLength = computed(() =>
        effectiveCeiling(this.entitlements.messageMaxLength(this.guildId())),
    );
    protected readonly length = computed(() => lengthState(this.typed().length, this.maxLength()));
    protected readonly counterClass = computed(() => lengthCounterClass(this.length().level));
    protected readonly expanded = signal(false);
    protected readonly previewing = signal(false);
    /** Offered once a post is long enough for the extra room to be worth having. */
    protected readonly canExpand = computed(() => this.expanded() || this.typed().length > 240);

    // ── Drafts ───────────────────────────────────────────────────────────────
    protected readonly drafts = inject(DraftService);
    protected readonly draftRestored = signal(false);
    /** Which channel's draft has already been put on screen, so a restore happens once. */
    private restoredFor: string | null = null;
    private lastChannelId: string | null = null;
    /** Last highlighted state per block, so an untouched block is skipped without reading its DOM twice. */
    private readonly blockKeys = new WeakMap<HTMLElement, string>();
    private readonly blockTexts = new WeakMap<HTMLElement, string>();
    /** The attachment set last written to the draft, so an unchanged list is not saved again. */
    private lastFileKey = '';

    protected readonly attachments = inject(ComposerAttachmentsService);
    private readonly fileService = inject(FileService);
    /** Which attachments the body already names, so the tray knows which tile is already placed. */
    protected readonly inlineIds = computed(() => inlineAttachmentIds(this.typed()));
    /** True while a send is parked waiting on uploads that were still in flight when Enter landed. */
    protected readonly awaitingUploads = signal(false);
    private readonly emojiData = inject(EmojiDataService);
    private readonly gifService = inject(GifService);

    // ── Active command (global, awaiting params) ──────────────────────────────
    private readonly profileService = inject(ProfileService);

    // ── Guild member search (async, debounced) ────────────────────────────────
    readonly replyAuthorName = computed(() => {
        const msg = this.replyTo();
        if (!msg) return '';
        if (msg.authorId === this.profileService.ownProfile()?.userId) return 'yourself';
        return this.profileService.getCachedByUserId(msg.authorId)?.userName ?? 'Unknown';
    });
    private readonly guildService = inject(GuildService);

    // ── Bot slash commands (per-guild, fetched once per guild transition) ────────
    private readonly botCommandService = inject(BotCommandService);
    private readonly botCommandDialogService = inject(BotCommandDialogService);
    private readonly realtime = inject(RealtimeConnectionService);
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
        this.destroyRef.onDestroy(() => {
            this.destroyed = true;
            this.parkDraft();
        });

        // Moving between channels: what was typed in the one being left becomes its draft, and the
        // editor is emptied so it cannot arrive in the next channel. The composer instance is
        // reused across channels, so nothing else clears it.
        effect(() => {
            const channelId = this.channelId();
            untracked(() => {
                if (this.lastChannelId === channelId) return;
                this.parkDraft();
                this.lastChannelId = channelId;
                this.expanded.set(false);
                this.previewing.set(false);
                this.draftRestored.set(false);
                this.clearEditor();
                // After the park above, so the files leaving with the old channel are in its draft.
                this.attachments.clear();
                this.lastFileKey = '';
                this.drafts.ensureLoaded(channelId);
            });
        });

        // Restores once the draft has landed, and only into an editor nobody has typed in since.
        effect(() => {
            const channelId = this.channelId();
            const draft = this.drafts.draft(channelId);
            const content = draft?.content ?? '';
            const files = draft?.attachments ?? [];
            if (!channelId || (!content && files.length === 0)) return;
            untracked(() => {
                if (this.restoredFor === channelId) return;
                this.restoredFor = channelId;
                const editor = this.editorRef().nativeElement;
                if ((editor.textContent ?? '').trim()) return;
                if (content) {
                    setEditorText(editor, content);
                    this.typed.set(content);
                    this.isEmpty.set(false);
                    this.applyMarkdownHighlighting(editor);
                }
                this.attachments.adopt(files);
                this.lastFileKey = files.join(',');
                this.draftRestored.set(true);
            });
        });

        // A restored draft holds tokens, not chips. Each becomes a chip as the tray's metadata for
        // it lands, so the body reads as pictures rather than as ids somebody has to decode.
        effect(() => {
            this.attachments.files();
            untracked(() => this.hydrateInlineChips());
        });

        // Attaching a file is a draft change with no keystroke behind it, so `onInput` never sees
        // it. Held until the channel's own draft has been read: recording before that would write
        // an empty draft over the one still in flight and delete it.
        effect(() => {
            const ids = this.attachments.uploadedIds();
            untracked(() => {
                const channelId = this.channelId();
                if (!channelId || !this.drafts.isLoaded(channelId)) return;

                const key = ids.join(',');
                if (key === this.lastFileKey) return;
                const hadFiles = this.lastFileKey !== '';
                this.lastFileKey = key;
                if (!hadFiles && ids.length === 0) return;

                this.drafts.record(channelId, this.typed(), ids);
            });
        });

        // Must stay untracked: `ensureLoaded` reads the cache it also writes, so tracking it would
        // re-run this on every set the store takes for any subject in the app.
        effect(() => {
            const gid = this.guildId();
            untracked(() => {
                this.entitlements.ensureLoaded(MY_ENTITLEMENTS);
                if (gid) this.entitlements.ensureLoaded({kind: 'guild', id: gid});
            });
        });

        // Tracked, unlike the one above: the ceiling arrives after the set it lives in has loaded.
        effect(() => {
            this.attachments.uploadCeiling.set(this.entitlements.uploadCeilingBytes(this.guildId()));
        });

        effect(() => {
            const gid = this.guildId();
            if (!gid) {
                this.botCommands.set([]);
                return;
            }
            this.botCommandService
                .getCommands(gid)
                .pipe(takeUntilDestroyed(this.destroyRef))
                .subscribe({
                    next: cmds => this.botCommands.set(cmds),
                    error: () => this.botCommands.set([]),
                });
        });

        this.realtime
            .stream('guild.BotInstalled')
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(e => {
                if (e.guildId === this.guildId()) this.refetchBotCommands();
            });
        this.realtime
            .stream('guild.BotUninstalled')
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(e => {
                if (e.guildId === this.guildId()) this.refetchBotCommands();
            });
    }

    // ── Filtered suggestions ──────────────────────────────────────────────────
    private readonly commandAtStart = signal(false);
    readonly filteredCommands = computed<ComposerCommandItem[]>(() => {
        if (this.overlayType() !== 'command') return [];
        const q = this.query().toLowerCase();
        const atStart = this.commandAtStart();
        const local: ComposerCommandItem[] = COMMANDS.filter(c => atStart || c.scope === 'inline')
            // Never offered where it cannot work: this guild has no dice, or the caller no `RollDice`.
            .filter(c => c.name !== 'roll' || this.canRollDice())
            .filter(c => c.name.startsWith(q))
            .map(def => ({kind: 'local' as const, def}));
        // Bot commands always consume the whole message (like local 'global'-scope commands),
        // so only surface them at the start of the editor - never mid-sentence.
        const bot: ComposerCommandItem[] = atStart
            ? this.botCommands()
                  .filter(c => c.name.startsWith(q))
                  .map(def => ({kind: 'bot' as const, def}))
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
                    map(members =>
                        members
                            .filter(m => m.profile)
                            .map((m): MentionCandidate => ({
                                kind: 'user',
                                userId: m.userId,
                                userName: m.profile!.userName,
                                avatarUrl: m.profile?.avatarUrl,
                                accentColor: m.profile?.accentColor,
                                font: m.profile?.font,
                            })),
                    ),
                    catchError(() => of<MentionCandidate[]>([])),
                );
            }),
        ),
        {initialValue: [] as MentionCandidate[]},
    );
    private readonly staticGuildCandidates = computed<MentionCandidate[]>(() => {
        if (!this.guildId()) return [];
        const roleCandidates: MentionCandidate[] = this.guildRoles()
            .filter(r => r.type !== RoleType.Everyone)
            .map(r => ({kind: 'role', roleId: r.id, name: r.name, color: r.color}));
        return [{kind: 'everyone'}, {kind: 'here'}, ...roleCandidates];
    });
    /**
     * The guild's characters, offered beside its people. A character mention is the most natural
     * thing to reach for mid-scene, and it notifies whoever plays them without naming them.
     */
    private readonly personaCandidates = computed<MentionCandidate[]>(() => {
        const guildId = this.guildId();
        if (!guildId || !this.canUsePersonas()) return [];
        return this.personas.cast(guildId).map((entry): MentionCandidate => {
            const identity = personaIdentity(entry);
            return {
                kind: 'persona',
                personaId: entry.persona.id,
                name: identity.name,
                avatarUrl: identity.avatarUrl,
                color: identity.color,
                tag: identity.tag,
            };
        });
    });

    readonly filteredMentions = computed<MentionCandidate[]>(() => {
        if (this.overlayType() !== 'mention') return [];
        const q = this.query().toLowerCase();
        const userCandidates: MentionCandidate[] = this.guildId()
            ? this.guildSearchResults()
            : this.conversationMembers().filter(m => mentionCandidateMatches(m, q));
        const staticMatches = this.staticGuildCandidates().filter(c => mentionCandidateMatches(c, q));
        // Characters lead in a guild that has them: in a roleplay server they are what `@` means.
        const personaMatches = this.personaCandidates().filter(c => mentionCandidateMatches(c, q));
        return [...personaMatches, ...staticMatches, ...userCandidates].slice(0, 8);
    });
    readonly filteredChannels = computed<ChannelDto[]>(() => {
        if (this.overlayType() !== 'channel') return [];
        const q = this.query().toLowerCase();
        return this.guildChannels()
            .filter(c => c.name.toLowerCase().includes(q))
            .slice(0, 8);
    });

    /** Wiki pages for `[[`. */
    readonly filteredWikiPages = computed<WikiPageSummaryDto[]>(() => {
        if (this.overlayType() !== 'wiki') return [];
        const q = this.query().toLowerCase().trim();
        const matches = this.wikiPages().filter(
            p =>
                !q ||
                p.title.toLowerCase().includes(q) ||
                (p.tags ?? []).some(t => t.toLowerCase().includes(q)),
        );
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
        // One read of the editor per keystroke. Typing notification and the trigger scan below both
        // work off this, rather than walking the whole post again for their own copy.
        const text = getMessage(editor);
        this.typed.set(text);
        this.drafts.record(this.channelId(), text, this.attachments.uploadedIds());
        this.isEmpty.set(
            text === '' && !editor.querySelector('.mention-chip') && !editor.querySelector('img[data-emoji]'),
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

        this.emitTypingIfNeeded(text);

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

        if (event.altKey && (event.key === 'p' || event.key === 'P') && this.showPersonaSwitcher()) {
            event.preventDefault();
            this.personaSwitcherRef()?.toggle();
            return;
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

    /**
     * On a plain channel the server owns the resolution, so only a choice it cannot see gets sent:
     * an explicit pick. Tags, autoproxy and the backslash escape are left in the text for it to
     * read. An encrypted channel has no readable text, so the whole resolution happens here.
     */
    private speakingAs(text: string): {content: string; personaId?: string} {
        if (!this.showPersonaSwitcher()) return {content: text};

        const resolved = this.personas.resolveFor(this.guildId(), this.channelId(), text);
        if (this.resolvePersonaLocally()) {
            return {content: resolved.content, personaId: resolved.personaId ?? undefined};
        }
        return {content: text, personaId: resolved.source === 'explicit' ? resolved.personaId! : undefined};
    }

    protected toggleExpanded(): void {
        this.expanded.update(v => !v);
        if (!this.expanded()) this.previewing.set(false);
        this.focus();
    }

    protected togglePreview(): void {
        this.previewing.update(v => !v);
        if (!this.previewing()) this.focus();
    }

    /** Throws away what the server is holding, after the reader has seen what it was. */
    protected discardDraft(): void {
        this.drafts.clear(this.channelId());
        this.restoredFor = this.channelId();
        this.draftRestored.set(false);
        this.clearEditor();
        this.attachments.clear();
        this.lastFileKey = '';
        this.focus();
    }

    protected dismissRestoredNotice(): void {
        this.draftRestored.set(false);
    }

    /** Writes whatever is in the editor now, for a composer about to be reused or torn down. */
    private parkDraft(): void {
        const channelId = this.lastChannelId;
        if (!channelId) return;
        const editor = this.editorRef?.()?.nativeElement;
        if (!editor) return;
        this.drafts.flushNow(channelId, getMessage(editor), this.attachments.uploadedIds());
    }

    private clearEditor(): void {
        const editor = this.editorRef().nativeElement;
        editor.innerHTML = '';
        this.typed.set('');
        this.isEmpty.set(true);
        this.closeOverlay();
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
        const pasted = event.clipboardData?.getData('text/plain') ?? '';
        // Clamped on the way in rather than left for the counter to complain about afterwards: a
        // paste of a whole document has to be highlighted and laid out before anything can say no.
        const room = Math.max(0, this.maxLength() - this.typed().length);
        if (room === 0) return;
        document.execCommand('insertText', false, pasted.slice(0, room));
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
        } else if (candidate.kind === 'persona') {
            // Reads as the character and sends as the id: a name cannot be resolved back to a
            // character without going through an account, which is the thing that must not happen.
            chip.className = 'mention-chip mention-chip-persona';
            chip.dataset['personaId'] = candidate.personaId;
            chip.dataset['display'] = personaMentionToken(candidate.personaId);
            chip.textContent = `@${candidate.name}`;
            if (candidate.color) {
                chip.style.setProperty('--persona-mention-color', candidate.color);
            }
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

    /** Replaces `[[query` with a chip that reads as the page and sends as a link to it. */
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
                if (result.text)
                    this.submitted.emit({
                        content: result.text,
                        attachments: [],
                        mentions: [],
                        roleMentions: [],
                        personaMentions: [],
                        mentionsEveryone: false,
                        mentionsHere: false,
                        // Resolved against an empty body, not the generated text: a command's own
                        // output must never be read as somebody's proxy tags.
                        personaId: this.speakingAs('').personaId,
                    });
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

        this.botCommandService
            .invokeCommandWithRetry(
                guildId,
                channelId,
                {botUserId: cmd.botUserId, commandName: cmd.name, options},
                cmds => this.botCommands.set(cmds),
            )
            .pipe(
                switchMap(() => this.botCommandService.awaitBotResponse(channelId, cmd.botUserId)),
                takeUntilDestroyed(this.destroyRef),
            )
            .subscribe({
                next: () => this.messageStore.removeMessage(tempId),
                error: () => this.messageStore.failMessage(tempId),
            });
    }

    /** Loads this guild's page listing, once, the first time somebody types `[[` in it. */
    private ensureWikiPages(): void {
        const guildId = this.guildId();
        if (!guildId || this.wikiPagesGuildId === guildId) return;

        this.wikiPagesGuildId = guildId;
        this.wikiPages.set([]);

        const guild = this.guildService.guilds().find(g => g.id === guildId);
        if (!guild || !guildHasFeature(guild, GuildFeature.Wiki)) return;

        this.wikiService
            .getWiki(guildId)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
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
        this.submitted.emit({
            content: url,
            attachments: [],
            mentions: [],
            roleMentions: [],
            personaMentions: [],
            mentionsEveryone: false,
            mentionsHere: false,
            personaId: this.speakingAs('').personaId,
        });
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
        // Must gate before touching the editor: everything below clears it, and a user who declines
        // the key prompt would otherwise lose their message. On acceptance we re-enter and it sends.
        if (!this.socialGate.isSatisfied()) {
            void this.socialGate.require().then(allowed => {
                if (allowed) this.send();
            });
            return;
        }

        // Attachments are sent by id and an unfinished upload has none, so park the send rather than
        // narrowing it, and leave the editor untouched meanwhile.
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
            this.toast.error(
                this.translate.instant(this.attachments.failureKey() ?? 'COMPOSER.UPLOAD_FAILED'),
            );
            return;
        }

        // The post stays exactly where it is, and is written to the draft rather than trimmed. The
        // notice above the box already says how much room this server allows.
        if (this.length().blocked) {
            this.drafts.flushNow(this.channelId(), this.typed(), this.attachments.uploadedIds());
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
        const personaMentions = chips.map(c => c.dataset['personaId'] ?? '').filter(Boolean);
        const mentionsEveryone = chips.some(c => c.dataset['everyone'] === 'true');
        const mentionsHere = chips.some(c => c.dataset['here'] === 'true');

        const speaking = this.speakingAs(text);

        if (speaking.content || attachments.length > 0) {
            this.submitted.emit({
                content: speaking.content,
                attachments,
                inReplyTo: this.replyTo()?.id,
                mentions,
                roleMentions,
                personaMentions,
                mentionsEveryone,
                mentionsHere,
                personaId: speaking.personaId,
            });
        }

        editor.innerHTML = '';
        this.typed.set('');
        this.isEmpty.set(true);
        this.previewing.set(false);
        this.expanded.set(false);
        this.draftRestored.set(false);
        this.restoredFor = this.channelId();
        this.lastFileKey = '';
        this.drafts.clear(this.channelId());
        this.closeOverlay();
        editor.focus();
    }

    // ── GIF handling ──────────────────────────────────────────────────────────

    private emitTypingIfNeeded(text: string): void {
        if (!text.trim() || this.typingThrottle !== null) return;
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

    // ── Inline attachments ────────────────────────────────────────────────────

    /** Put an already-uploaded file into the body at the cursor. */
    protected placeInline(index: number): void {
        const file = this.attachments.files()[index];
        if (!file?.uploadedId) return;

        const editor = this.editorRef().nativeElement;
        editor.focus();
        restoreCursorOffset(editor, this.savedEmojiOffset);

        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        range.deleteContents();

        const chip = this.buildAttachmentChip(file.uploadedId, file.name, file.isImage);
        range.insertNode(chip);
        range.setStartAfter(chip);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);

        this.onInput();
    }

    /** Take it out of the body. The file stays attached, it just goes back under the message. */
    protected removeInline(attachmentId: string): void {
        const editor = this.editorRef().nativeElement;
        for (const chip of this.chipsFor(editor, attachmentId)) chip.remove();
        this.onInput();
    }

    /** The tray's own remove, which has to take the chip with it. */
    protected removeAttachment(index: number): void {
        const id = this.attachments.files()[index]?.uploadedId;
        if (id) {
            const editor = this.editorRef().nativeElement;
            for (const chip of this.chipsFor(editor, id)) chip.remove();
        }
        this.attachments.remove(index);
        this.onInput();
    }

    private chipsFor(editor: HTMLElement, attachmentId: string): HTMLElement[] {
        return Array.from(
            editor.querySelectorAll<HTMLElement>(
                `.attachment-chip[data-attachment-id="${CSS.escape(attachmentId)}"]`,
            ),
        );
    }

    private buildAttachmentChip(id: string, name: string, isImage: boolean): HTMLElement {
        const chip = document.createElement('span');
        chip.className = 'attachment-chip';
        chip.contentEditable = 'false';
        chip.dataset['attachmentId'] = id;

        if (isImage) {
            const img = document.createElement('img');
            img.src = this.fileService.attachmentThumbnailUrl(id);
            img.alt = name;
            chip.appendChild(img);
        } else {
            const icon = document.createElement('i');
            icon.className = 'pi pi-paperclip';
            chip.appendChild(icon);
        }

        const label = document.createElement('span');
        label.textContent = name || this.translate.instant('COMPOSER.INLINE_ATTACHMENT');
        chip.appendChild(label);
        return chip;
    }

    /**
     * A restored draft arrives as token text, because that is how the body is stored. Each token
     * becomes a chip once the file behind it is known, which the tray is already fetching.
     */
    private hydrateInlineChips(): void {
        const editor = this.editorRef?.()?.nativeElement;
        if (!editor) return;

        const ready = new Map(
            this.attachments
                .files()
                .filter(f => f.uploadedId && !f.isUploading)
                .map(f => [f.uploadedId!, f]),
        );
        if (ready.size === 0) return;

        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
        const pending: Text[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (inlineAttachmentPattern().test(node.textContent ?? '')) pending.push(node as Text);
        }
        if (pending.length === 0) return;

        const offset = getTextCursorOffset(editor);
        for (const node of pending) {
            const text = node.textContent ?? '';
            const frag = document.createDocumentFragment();
            let last = 0;
            for (const match of text.matchAll(inlineAttachmentPattern())) {
                const file = ready.get(match[1]);
                if (!file) continue;
                if (match.index > last) {
                    frag.appendChild(document.createTextNode(text.slice(last, match.index)));
                }
                frag.appendChild(this.buildAttachmentChip(match[1], file.name, file.isImage));
                last = match.index + match[0].length;
            }
            if (last === 0) continue;
            if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
            node.replaceWith(frag);
        }

        this.typed.set(getMessage(editor));
        restoreCursorOffset(editor, offset);
    }

    // ── Send ─────────────────────────────────────────────────────────────────

    /**
     * Re-highlight the block holding the cursor and nothing else. Rebuilding the whole editor is
     * what a 15k-character post cannot afford: it also drops native undo, breaks IME composition,
     * and resets the scroll position, none of which survive an `innerHTML` swap.
     */
    private applyMarkdownHighlighting(editor: HTMLElement): void {
        // The browser's filler <br> reads as a newline here, so deleting the last character would
        // otherwise leave the composer a line taller than an untouched one.
        if (isEditorBlank(editor)) {
            if (editor.innerHTML !== '') editor.innerHTML = '';
            return;
        }

        if (needsReblock(editor)) {
            this.rebuildBlocks(editor);
            return;
        }

        const sel = window.getSelection();
        const anchor = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).startContainer : null;
        const block = blockOf(anchor, editor);
        if (!block) {
            this.rebuildBlocks(editor);
            return;
        }

        const segments = getEditorSegments(block);
        const key = blockKey(segments);
        if (key === this.blockKeys.get(block)) return;

        const text = segmentText(segments);
        const previous = this.blockTexts.get(block) ?? '';
        if (this.boundariesMoved(block, previous, text)) {
            this.rebuildBlocks(editor);
            return;
        }

        const offset = getTextCursorOffset(block);
        highlightBlock(block, segments);
        this.blockKeys.set(block, key);
        this.blockTexts.set(block, text);
        applyTrailingSentinel(editor);
        restoreCursorOffset(block, offset);
    }

    /**
     * Whether this edit changed where blocks begin, which the single-block path cannot express.
     * A fence is treated as a boundary move on sight: its delimiters decide how the text around
     * them parses, so an edit near one is never local.
     */
    private boundariesMoved(block: HTMLElement, previous: string, text: string): boolean {
        if (text.includes('```') || previous.includes('```')) return true;
        if (splitIntoBlocks(text).length > 1) return true;
        const endedBlock = /\n\n+$/.test(previous);
        return endedBlock && !/\n\n+$/.test(text) && !!block.nextElementSibling;
    }

    private rebuildBlocks(editor: HTMLElement): void {
        const offset = getTextCursorOffset(editor);
        for (const block of renderBlocks(editor, getEditorSegments(editor))) {
            const segments = getEditorSegments(block);
            this.blockKeys.set(block, blockKey(segments));
            this.blockTexts.set(block, segmentText(segments));
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

    /**
     * `/roll` goes straight to the server rather than opening the tray: somebody typing notation
     * already knows what they want, and a confirmation step would only be in the way.
     */
    private rollFromCommand(payload: {expression: string; reason: string}): void {
        const guildId = this.guildId();
        const channelId = this.channelId();
        if (!guildId || !channelId) return;

        if (!this.canRollDice()) {
            this.toast.error(this.translate.instant('DICE.TRAY.NOT_ALLOWED'));
            return;
        }

        const parsed = parseDiceExpression(payload.expression);
        if (!parsed.ok) {
            this.toast.error(this.translate.instant(parsed.key, parsed.params ?? {}));
            return;
        }

        this.dice
            .roll(guildId, channelId, {
                expression: payload.expression,
                personaId: this.personaResolution().personaId,
                reason: payload.reason || null,
            })
            .subscribe({
                error: err => this.toast.httpError(this.translate.instant('DICE.TRAY.FAILED'), err),
            });
    }

    private dispatchAction(action: {name: string; payload?: unknown}): void {
        if (action.name === 'open-gif-picker') {
            this.gifPickerRef()?.open();
            return;
        }
        if (action.name === 'roll-dice') {
            this.rollFromCommand(action.payload as {expression: string; reason: string});
            return;
        }
        if (action.name === 'open-gif-picker-with-search') {
            const query = (action.payload as {query: string}).query;
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
