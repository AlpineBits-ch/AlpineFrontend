import {
    AfterViewInit,
    Component,
    computed,
    effect,
    ElementRef,
    inject,
    input,
    OnDestroy,
    output,
    signal,
    ViewChild,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Editor, Extension} from '@tiptap/core';
import {Plugin} from '@tiptap/pm/state';
import {WikiDto, WikiPageDto, WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../../services/wiki.service';
import {FileService} from '../../../../../services/file.service';
import {Heading} from '../wiki-toc';
import {parseWikiHref, wikiHref} from '../wiki-links';
import {WikiDraft, WikiDraftsService} from '../wiki-drafts.service';
import {WikiStateService} from '../wiki-state.service';
import {WikiContentCacheService} from '../wiki-content-cache.service';
import {WikiLinkPreviewComponent} from './wiki-link-preview.component';
import {wikiBlockLabels, wikiExtensions} from './wiki-extensions';
import {SuggestState, wikiSuggestPlugin} from './wiki-suggest.plugin';
import {WikiBubbleMenuComponent} from './wiki-bubble-menu.component';
import {SlashItem, WikiSlashMenuComponent} from './wiki-slash-menu.component';
import {WikiLinkMenuComponent} from './wiki-link-menu.component';
import {WikiToolbarComponent} from './wiki-toolbar.component';
import {WikiEmojiMenuComponent} from './wiki-emoji-menu.component';
import {parseUserHref, userHref, WikiMentionMember, WikiMentionMenuComponent} from './wiki-mention-menu.component';
import {EmojiSuggestion} from '../../../../../services/emoji-data.service';
import {WikiTemplateChoice} from '../wiki-templates/wiki-template.model';
import {WikiAiService} from '../wiki-ai.service';
import {WikiAiInlineComponent} from '../wiki-ai/wiki-ai-inline.component';
import {WikiAiMetadataComponent} from '../wiki-ai/wiki-ai-metadata.component';
import {wikiGhostTextPlugin} from './wiki-ghost-text.plugin';

@Component({
    selector: 'app-wiki-article',
    imports: [
        FormsModule, Button, TranslateModule, WikiBubbleMenuComponent, WikiSlashMenuComponent,
        WikiLinkMenuComponent, WikiToolbarComponent, WikiLinkPreviewComponent,
        WikiEmojiMenuComponent, WikiMentionMenuComponent, WikiAiInlineComponent,
        WikiAiMetadataComponent,
    ],
    templateUrl: './wiki-article.component.html',
    styleUrl: './wiki-article.component.css',
    host: {class: 'flex flex-col flex-1 min-h-0 overflow-hidden'},
})
export class WikiArticleComponent implements AfterViewInit, OnDestroy {
    readonly page = input<WikiPageDto | null>(null);
    readonly wiki = input<WikiDto | null>(null);
    readonly guildId = input.required<string>();
    readonly editing = input(false);
    /** Whether to offer the two "fill this page" actions on an empty page. */
    readonly canEdit = input(false);
    /** Other page titles in this wiki, as context for every AI request the article makes. */
    readonly pageTitles = input<readonly string[]>([]);

    readonly saved = output<WikiPageDto>();
    readonly cancelled = output<void>();
    readonly headingsChanged = output<Heading[]>();
    /**
     * The live body, for anything outside the article that has to track it as it is typed.
     *
     * An output rather than a public method the shell polls: `getMarkdown()` serialises the whole
     * document, and a method call in a template binding would run it on every change-detection
     * pass across the app rather than once per edit.
     */
    readonly contentChanged = output<string>();
    readonly wikiLinkClicked = output<string>();
    readonly dirtyChanged = output<boolean>();
    readonly saveStatusChanged = output<'idle' | 'draft' | 'saving' | 'saved'>();
    readonly requestEdit = output<void>();
    readonly requestAi = output<void>();
    /** Tags the AI suggested and the user accepted. The rail's tag editor owns them. */
    readonly tagsSuggested = output<string[]>();

    @ViewChild('editorEl') editorEl?: ElementRef<HTMLDivElement>;
    @ViewChild('fileInputEl') fileInputEl?: ElementRef<HTMLInputElement>;
    @ViewChild('bubbleMenu') bubbleMenu?: WikiBubbleMenuComponent;
    @ViewChild('slashMenu') slashMenu?: WikiSlashMenuComponent;
    @ViewChild('linkMenu') linkMenu?: WikiLinkMenuComponent;
    @ViewChild('emojiMenu') emojiMenu?: WikiEmojiMenuComponent;
    @ViewChild('mentionMenu') mentionMenu?: WikiMentionMenuComponent;
    @ViewChild('aiInline') aiInline?: WikiAiInlineComponent;

    protected readonly title = signal('');
    protected readonly saving = signal(false);
    protected readonly slashOpen = signal(false);
    protected readonly linkMenuOpen = signal(false);
    protected readonly emojiMenuOpen = signal(false);
    protected readonly mentionMenuOpen = signal(false);
    protected readonly suggestQuery = signal('');
    protected readonly suggestPosition = signal({top: 0, left: 0});

    protected readonly pendingDraft = signal<WikiDraft | null>(null);
    protected readonly editSummary = signal('');

    /** Hover preview of the `wiki:` link under the pointer. */
    protected readonly previewOpen = signal(false);
    protected readonly previewPage = signal<WikiPageSummaryDto | null>(null);
    protected readonly previewSnippet = signal('');
    protected readonly previewPosition = signal({top: 0, left: 0});

    /**
     * Raw markdown editing. The ProseMirror surface stays mounted underneath rather than being
     * torn down, so toggling back does not lose the editor, its history, or the caret - only the
     * document is re-parsed from whatever the textarea holds.
     */
    protected readonly sourceMode = signal(false);
    protected readonly sourceText = signal('');

    /**
     * The live editor, for the menus and the toolbar that attach to it.
     *
     * A signal rather than a getter over the field: the field is assigned in `ngAfterViewInit`,
     * which is after the template bindings for this view have been checked, and a plain getter
     * therefore reported `undefined` then something else in the same pass (NG0100). Reading a
     * signal marks the view dirty, so the change is picked up before the check runs.
     */
    protected readonly editorInstance = signal<Editor | undefined>(undefined);

    /**
     * Only offered when the body actually changed. The server ignores a summary on a
     * metadata-only update because no revision is created to carry it, so showing the field
     * there would invite the user to write a note that is silently dropped.
     */
    protected readonly summaryApplies = computed(() => {
        if (!this.editing()) return false;
        this.contentVersion();
        if (this.sourceMode()) return this.sourceText() !== (this.page()?.content ?? '');
        return this.markdown() !== (this.page()?.content ?? '');
    });

    /**
     * A saved-but-empty page is a dead end otherwise: nothing on screen, and no hint that the
     * next move is yours. Read mode only - while editing, the placeholder does this job.
     */
    protected readonly showEmptyState = computed(() => {
        this.contentVersion();
        return !this.editing() && this.canEdit() && !this.markdown().trim();
    });

    /** Read through contentVersion so it re-serialises on edits, not on every change detection. */
    protected readonly aiMetadataContent = computed(() => {
        this.contentVersion();
        return this.markdown();
    });

    /** Bumped on every edit so the computeds above re-read the non-reactive editor document. */
    private readonly contentVersion = signal(0);

    private readonly wikiService = inject(WikiService);
    private readonly fileService = inject(FileService);
    private readonly drafts = inject(WikiDraftsService);
    private readonly wikiState = inject(WikiStateService);
    private readonly contentCache = inject(WikiContentCacheService);
    private readonly wikiAi = inject(WikiAiService);
    private readonly translate = inject(TranslateService);
    private draftTimer?: ReturnType<typeof setTimeout>;
    private previewTimer?: ReturnType<typeof setTimeout>;
    private editor?: Editor;
    private clickHandler?: (e: MouseEvent) => void;
    private keydownHandler?: (e: KeyboardEvent) => void;
    private overHandler?: (e: MouseEvent) => void;
    private outHandler?: (e: MouseEvent) => void;
    private suggest: SuggestState | null = null;
    /** Which page the document currently holds, so a refresh is not mistaken for a swap. */
    private shownPageId: string | null | undefined;

    constructor() {
        // Loading a different page replaces the document; toggling editing must not.
        effect(() => {
            const page = this.page();
            // The bar owns a document range and locks the editor while it streams. A page swap
            // underneath it would strand a locked editor holding half a generation.
            //
            // Only a swap, though. This effect also re-runs whenever the wiki's summaries are
            // refreshed - anyone's edit to any page, a pin, a tag, a remote-update notice - and
            // cancelling on those discarded a generation mid-stream on a page nobody had left,
            // which read as the AI bar simply vanishing.
            const pageId = page?.id ?? null;
            if (pageId !== this.shownPageId) {
                this.shownPageId = pageId;
                this.aiInline?.cancel();
            }
            this.title.set(page?.title ?? '');
            // A different page must never inherit the previous one's raw buffer.
            this.sourceMode.set(false);
            // Compared against what the editor already holds rather than fired on every change to
            // the page object's identity. `loadWiki` -> `mergeSummary` hands over a new object on
            // any metadata refresh - a tag added, a pin toggled, anyone's edit to any page - and
            // re-parsing there rebuilt the whole document under someone who was only reading it.
            const nextContent = page?.content ?? '';
            if (this.editor && nextContent !== this.markdown()) this.setContent(nextContent);

            const existing = this.drafts.read(this.guildId(), page?.id ?? null);
            // Suppressed while a remote conflict is showing: two competing "your content is
            // stale" banners stacked on top of each other is worse than either alone.
            const remoteConflict = this.wikiState.pendingRemoteUpdate()?.id === page?.id;
            this.pendingDraft.set(
                existing
                && !remoteConflict
                && this.drafts.divergesFrom(existing, page?.title ?? '', page?.content ?? '')
                    ? existing
                    : null,
            );
        });

        effect(() => {
            const editing = this.editing();
            // Same reason: leaving edit mode mid-generation must not leave the bar holding it.
            if (!editing) this.aiInline?.cancel();
            this.editor?.setEditable(editing);
            // Leaving edit mode with the textarea open would render raw markdown as the article.
            if (!editing) this.commitSourceMode();
        });

        // Which links are broken depends on the page list, not on the stored content, so it is
        // re-evaluated whenever that list changes rather than only on load.
        effect(() => {
            this.wiki();
            this.markBrokenLinks();
        });
    }

    ngAfterViewInit(): void {
        if (!this.editorEl) return;
        this.editor = new Editor({
            element: this.editorEl.nativeElement,
            extensions: [
                // The block node views render their own DOM outside Angular, where neither the
                // translate pipe nor an injected service is reachable, so their strings are
                // resolved once here and handed down.
                ...wikiExtensions(
                    this.translate.instant('WIKI.ARTICLE.PLACEHOLDER'),
                    wikiBlockLabels(this.translate),
                ),
                Extension.create({
                    name: 'wikiSuggest',
                    addProseMirrorPlugins: () => [
                        wikiSuggestPlugin(s => this.onSuggest(s)),
                        // Registered ahead of the ghost-text plugin so that while a menu is open
                        // its Tab selects an item rather than accepting a suggestion.
                        new Plugin({
                            props: {handleKeyDown: (_view, event) => this.onMenuKeyDown(event)},
                        }),
                    ],
                }),
                Extension.create({
                    name: 'wikiGhostText',
                    addProseMirrorPlugins: () => [wikiGhostTextPlugin({
                        // `available()` as well as the preference: with no key connected, every
                        // pause in typing would fire a request that can only throw.
                        enabled: () => this.wikiAi.ghostTextEnabled() && this.wikiAi.available(),
                        title: () => this.title(),
                        complete: (req, signal) => this.wikiAi.complete(req, signal),
                    })],
                }),
            ],
            editable: this.editing(),
            content: '',
            onUpdate: () => {
                this.dirtyChanged.emit(true);
                this.contentChanged.emit(this.markdown());
                this.emitHeadings();
                this.markBrokenLinks();
                this.scheduleDraft();
                this.contentVersion.update(v => v + 1);
            },
            onSelectionUpdate: () => this.bubbleMenu?.sync(),
        });
        this.editorInstance.set(this.editor);
        this.setContent(this.page()?.content ?? '');

        // Read mode keeps live anchors, so wiki: links must be intercepted before the browser
        // tries to resolve a protocol it does not know.
        this.clickHandler = (event: MouseEvent) => {
            const anchor = (event.target as HTMLElement).closest('a');
            if (!anchor) return;
            // A mention href is ours too, and the webview knows no `user:` protocol. Swallowing
            // the click is the floor here; opening a profile is a later refinement.
            if (parseUserHref(anchor.getAttribute('href'))) {
                event.preventDefault();
                return;
            }
            const pageId = parseWikiHref(anchor.getAttribute('href'));
            if (!pageId) return;
            event.preventDefault();
            this.wikiLinkClicked.emit(pageId);
        };
        this.editorEl.nativeElement.addEventListener('click', this.clickHandler);

        // Captured, so arrow keys drive the open menu instead of moving the caret out from
        // under it. Only consumed while a menu is actually open.
        this.keydownHandler = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                event.preventDefault();
                this.save();
                return;
            }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
                event.preventDefault();
                this.aiInline?.askAtCaret();
                return;
            }
        };
        this.editorEl.nativeElement.addEventListener('keydown', this.keydownHandler, true);


        // Delayed, so running the pointer across a paragraph of links does not strobe a popover
        // once per link on the way past.
        this.overHandler = (event: MouseEvent) => {
            const anchor = (event.target as HTMLElement).closest('a');
            const pageId = anchor && parseWikiHref(anchor.getAttribute('href'));
            if (!anchor || !pageId) return;
            clearTimeout(this.previewTimer);
            this.previewTimer = setTimeout(() => this.showPreview(anchor, pageId), 350);
        };
        this.outHandler = (event: MouseEvent) => {
            if (!(event.target as HTMLElement).closest('a')) return;
            clearTimeout(this.previewTimer);
            this.previewOpen.set(false);
        };
        this.editorEl.nativeElement.addEventListener('mouseover', this.overHandler);
        this.editorEl.nativeElement.addEventListener('mouseout', this.outHandler);
    }

    ngOnDestroy(): void {
        clearTimeout(this.draftTimer);
        clearTimeout(this.previewTimer);
        const el = this.editorEl?.nativeElement;
        if (el && this.clickHandler) el.removeEventListener('click', this.clickHandler);
        if (el && this.keydownHandler) el.removeEventListener('keydown', this.keydownHandler, true);
        if (el && this.overHandler) el.removeEventListener('mouseover', this.overHandler);
        if (el && this.outHandler) el.removeEventListener('mouseout', this.outHandler);
        this.editor?.destroy();
    }

    /** What would be saved right now, from whichever surface is currently authoritative. */
    markdown(): string {
        if (this.sourceMode()) return this.sourceText();
        return this.editor?.getMarkdown() ?? '';
    }

    /**
     * Drops generated markdown in at the caret.
     *
     * A normal editor transaction, not a content reset: the result is one ⌘Z away from being gone
     * and autosaves as a draft like anything else typed. Nothing here touches the server.
     */
    insertMarkdown(markdown: string): void {
        if (this.sourceMode()) {
            this.onSourceInput(joinBlocks(this.sourceText(), markdown));
            return;
        }
        this.editor?.chain().focus().insertContent(markdown, {contentType: 'markdown'}).run();
    }

    /** Same, for the whole body. Still one undoable step. */
    replaceMarkdown(markdown: string): void {
        if (this.sourceMode()) {
            this.onSourceInput(markdown);
            return;
        }
        this.editor?.chain().focus().selectAll()
            .insertContent(markdown, {contentType: 'markdown'}).run();
    }

    /**
     * Streams a whole-page draft from the dialog's prompt into this document. An empty page hands
     * over its whole body; a written one takes an insertion at the caret.
     */
    draftWithAi(prompt: string): void {
        this.aiInline?.draftIntoPage(prompt);
    }

    /**
     * Seeds a brand new page from a template.
     *
     * The title is only suggested, never imposed: someone who typed one before reaching for a
     * template meant it. The body goes through the same replace path as everything else, so it is
     * one undo away and autosaves as a draft like anything typed by hand.
     */
    applyTemplate(choice: WikiTemplateChoice): void {
        if (choice.suggestedTitle && !this.title().trim()) this.title.set(choice.suggestedTitle);
        if (choice.markdown) this.replaceMarkdown(choice.markdown);
        // Picking a template settles what this page starts from, so a leftover draft from some
        // earlier abandoned new page must stop offering to restore itself on top of it.
        this.drafts.clear(this.guildId(), this.page()?.id ?? null);
        this.pendingDraft.set(null);
    }

    /** The draft request needs the current body, whichever surface holds it. */
    currentContent(): string {
        return this.markdown();
    }

    currentTitle(): string {
        return this.title();
    }

    /** Swaps between the rich surface and the raw markdown behind it, in both directions. */
    protected toggleSourceMode(): void {
        if (this.sourceMode()) {
            this.commitSourceMode();
            return;
        }
        this.sourceText.set(this.markdown());
        this.sourceMode.set(true);
    }

    /** Parses the textarea back into the document. A no-op when source mode is not open. */
    private commitSourceMode(): void {
        if (!this.sourceMode()) return;
        this.sourceMode.set(false);
        this.setContent(this.sourceText());
    }

    protected onSourceInput(value: string): void {
        this.sourceText.set(value);
        this.dirtyChanged.emit(true);
        this.scheduleDraft();
        this.contentVersion.update(v => v + 1);
    }

    protected openFilePicker(): void {
        this.fileInputEl?.nativeElement.click();
    }

    save(): void {
        if (this.saving() || !this.title().trim()) return;
        // Before anything else: a debounce still in flight would fire ~800ms from now and write
        // the draft straight back over the one this save is about to clear, leaving a phantom
        // "unsaved changes" banner on a page that was just published.
        clearTimeout(this.draftTimer);
        this.saving.set(true);
        this.saveStatusChanged.emit('saving');
        const summary = this.editSummary().trim();
        const base = {
            title: this.title().trim(),
            content: this.markdown(),
            ...(this.summaryApplies() && summary ? {summary} : {}),
        };
        const editingId = this.page()?.id;
        const request = editingId
            ? this.wikiService.updatePage(this.guildId(), editingId, base)
            : this.wikiService.createPage(this.guildId(), base);
        request.subscribe({
            next: page => {
                this.saving.set(false);
                this.dirtyChanged.emit(false);
                // The draft has been published, so keeping it would offer to "restore" content
                // identical to what is now on the server.
                this.drafts.clear(this.guildId(), editingId ?? null);
                this.pendingDraft.set(null);
                this.editSummary.set('');
                this.saveStatusChanged.emit('saved');
                this.saved.emit(page);
            },
            error: () => {
                this.saving.set(false);
                // Back to 'draft', not 'idle': the local copy is still there and still the
                // user's only record of the edit.
                this.saveStatusChanged.emit('draft');
            },
        });
    }

    protected restoreDraft(): void {
        const draft = this.pendingDraft();
        if (!draft) return;
        this.title.set(draft.title);
        // Restoring while the raw buffer is open has to land in the buffer, or the textarea keeps
        // showing the text the restore was meant to replace.
        if (this.sourceMode()) this.sourceText.set(draft.content);
        else this.setContent(draft.content);
        this.pendingDraft.set(null);
    }

    protected discardDraft(): void {
        this.drafts.clear(this.guildId(), this.page()?.id ?? null);
        this.pendingDraft.set(null);
    }

    protected draftAge(): string {
        const savedAt = this.pendingDraft()?.savedAt;
        if (!savedAt) return '';
        const minutes = Math.floor((Date.now() - savedAt) / 60000);
        if (minutes < 1) return this.translate.instant('WIKI.DRAFT.AGE_JUST_NOW');
        if (minutes < 60) return this.translate.instant('WIKI.DRAFT.AGE_MINUTES', {n: minutes});
        const hours = Math.floor(minutes / 60);
        return hours < 24
            ? this.translate.instant('WIKI.DRAFT.AGE_HOURS', {n: hours})
            : this.translate.instant('WIKI.DRAFT.AGE_DAYS', {n: Math.floor(hours / 24)});
    }

    /** Debounced so a burst of typing costs one write, not one per keystroke. */
    private scheduleDraft(): void {
        if (!this.editing()) return;
        clearTimeout(this.draftTimer);
        this.draftTimer = setTimeout(() => {
            // Re-checked at fire time, not only at schedule time: the 800ms window is long enough
            // to leave edit mode inside, and a draft written after that is one nobody asked for.
            if (!this.editing()) return;
            const page = this.page();
            // Nothing to keep if this matches what the server already holds. Compared the same way
            // `divergesFrom` compares on the way back out, so a draft exists only when restoring it
            // would visibly change something.
            const unchanged = this.title() === (page?.title ?? '')
                && this.markdown() === (page?.content ?? '');
            if (unchanged) {
                this.drafts.clear(this.guildId(), page?.id ?? null);
                return;
            }
            this.drafts.write(this.guildId(), page?.id ?? null, {
                title: this.title(),
                content: this.markdown(),
                tags: [...(page?.tags ?? [])],
                isPinned: page?.isPinned ?? false,
                categoryId: page?.categoryId,
                parentPageId: page?.parentPageId,
                baseUpdatedAt: page?.updatedAt ? String(page.updatedAt) : null,
                savedAt: Date.now(),
            });
            this.saveStatusChanged.emit('draft');
        }, 800);
    }

    /** Removes the trigger text before running a block command, so "/table" does not survive. */
    protected applySlashItem(item: SlashItem): void {
        const editor = this.editor;
        if (!editor) return;
        this.deleteTriggerRun();
        // Closed before dispatch, not after: the page-link item re-opens the `[[` menu, and
        // closing afterwards would shut the one it had just opened.
        this.closeMenus();

        if (item.run) {
            item.run(editor);
            return;
        }
        switch (item.hostAction) {
            case 'image':
                this.openFilePicker();
                return;
            case 'page-link':
                // Typed in rather than opened directly, so the existing `[[` trigger does the work.
                editor.chain().focus().insertContent('[[').run();
                return;
        }
        // A transform acts on what is already written, so it runs in place. The two generate rows
        // have nothing to act on yet and need the user's prompt first, so they open the dialog -
        // which now hands the prompt straight back to the same inline bar.
        if (item.aiOp) {
            this.aiInline?.runTransform({op: item.aiOp, labelKey: item.labelKey});
            return;
        }
        if (item.aiGenerate) this.requestAi.emit();
    }

    protected applyEmoji(emoji: EmojiSuggestion): void {
        const editor = this.editor;
        if (!editor) return;
        this.deleteTriggerRun();
        editor.chain().focus().insertContent(emoji.native).run();
        this.closeMenus();
    }

    /**
     * Same trick as `applyPageLink`: an ordinary Link mark with a `user:` href, which the markdown
     * serializer round-trips as `[@Name](user:<userId>)` for free.
     */
    protected applyMention(member: WikiMentionMember): void {
        const editor = this.editor;
        if (!editor) return;
        this.deleteTriggerRun();
        editor.chain()
            .focus()
            .insertContent({
                type: 'text',
                text: `@${member.name}`,
                marks: [{type: 'link', attrs: {href: userHref(member.userId)}}],
            })
            // Without this the link mark stays active and the next character typed joins the link.
            .unsetMark('link')
            .insertContent(' ')
            .run();
        this.closeMenus();
    }

    /**
     * Replaces the whole `[[query` run with a link mark carrying a `wiki:` href. An ordinary
     * Link mark, not a custom node - the markdown serializer already round-trips those, so the
     * link survives save and reload with no custom serializer.
     */
    protected applyPageLink(page: WikiPageSummaryDto): void {
        const editor = this.editor;
        if (!editor) return;
        this.deleteTriggerRun();
        editor.chain()
            .focus()
            .insertContent({
                type: 'text',
                text: page.title,
                marks: [{type: 'link', attrs: {href: wikiHref(page.id)}}],
            })
            // Without this the link mark stays active and the next character typed joins the link.
            .unsetMark('link')
            .run();
        this.closeMenus();
    }

    protected onFilesSelected(event: Event): void {
        const input = event.target as HTMLInputElement;
        const files = input.files ? Array.from(input.files) : [];
        input.value = '';
        for (const file of files) this.uploadFile(file);
    }

    private onSuggest(state: SuggestState | null): void {
        this.suggest = state;
        if (!state || !this.editing() || !this.editor) {
            this.closeMenus();
            return;
        }
        const coords = this.editor.view.coordsAtPos(this.editor.state.selection.from);
        this.suggestPosition.set({top: coords.bottom + 6, left: coords.left});
        this.suggestQuery.set(state.query);

        // Reset only on the way in. Resetting on every keystroke would throw the highlight back
        // to the first row as the query narrowed.
        const trigger = state.trigger;
        if (trigger === '/' && !this.slashOpen()) this.slashMenu?.reset();
        if (trigger === '[[' && !this.linkMenuOpen()) this.linkMenu?.reset();
        if (trigger === ':' && !this.emojiMenuOpen()) this.emojiMenu?.reset();
        if (trigger === '@' && !this.mentionMenuOpen()) this.mentionMenu?.reset();

        this.slashOpen.set(trigger === '/');
        this.linkMenuOpen.set(trigger === '[[');
        this.emojiMenuOpen.set(trigger === ':');
        this.mentionMenuOpen.set(trigger === '@');
    }

    /** Deletes the `/query` or `[[query` run that opened the menu. */
    private deleteTriggerRun(): void {
        const editor = this.editor;
        const suggest = this.suggest;
        if (!editor || !suggest) return;
        const {$from} = editor.state.selection;
        const start = $from.start() + suggest.from;
        editor.chain().focus().deleteRange({from: start, to: $from.pos}).run();
    }

    /**
     * Arrow keys, Enter, Tab and Escape while one of the four trigger menus is open.
     *
     * Registered as a ProseMirror `handleKeyDown` prop rather than as a DOM listener. Two DOM
     * approaches were tried first - capture on the editor container, then capture on the document -
     * and neither actually drove the menus. This is the mechanism ProseMirror itself provides:
     * it is called for every keydown the editor receives, ahead of its own keymaps, and returning
     * true is what makes it call `preventDefault` and stop. No listener ordering to reason about,
     * and focus stays in the editor, which it must - the menus are filtered by continuing to type.
     */
    private onMenuKeyDown(event: KeyboardEvent): boolean {
        if (!this.anyMenuOpen()) return false;
        if (event.key === 'Escape') {
            this.closeMenus();
            return true;
        }
        // Each menu returns false while it is shut, so the chain stops at the open one.
        return !!(this.slashMenu?.handleKey(event.key)
            || this.linkMenu?.handleKey(event.key)
            || this.emojiMenu?.handleKey(event.key)
            || this.mentionMenu?.handleKey(event.key));
    }

    private closeMenus(): void {
        this.slashOpen.set(false);
        this.linkMenuOpen.set(false);
        this.emojiMenuOpen.set(false);
        this.mentionMenuOpen.set(false);
    }

    private anyMenuOpen(): boolean {
        return this.slashOpen() || this.linkMenuOpen()
            || this.emojiMenuOpen() || this.mentionMenuOpen();
    }

    private uploadFile(file: File): void {
        if (!file.type.startsWith('image/')) return;
        const blobUrl = URL.createObjectURL(file);
        this.editor?.chain().focus().setImage({src: blobUrl, alt: file.name}).run();
        this.fileService.uploadFile(file).subscribe({
            next: attachment => this.replaceImageSrc(blobUrl, attachment.url, attachment.fileName),
            // A failed upload drops the placeholder rather than leaving a broken blob: URL that
            // renders as a broken image and saves as one.
            error: () => this.replaceImageSrc(blobUrl, '', ''),
        });
    }

    private replaceImageSrc(blobUrl: string, newSrc: string, alt: string): void {
        const editor = this.editor;
        if (!editor) return;
        const tr = editor.state.tr;
        let changed = false;
        editor.state.doc.descendants((node, pos) => {
            if (node.type.name === 'image' && node.attrs['src'] === blobUrl) {
                if (newSrc) {
                    tr.setNodeMarkup(pos, undefined, {...node.attrs, src: newSrc, alt});
                } else {
                    tr.delete(pos, pos + node.nodeSize);
                }
                changed = true;
                return false;
            }
            return true;
        });
        if (changed) editor.view.dispatch(tr);
        URL.revokeObjectURL(blobUrl);
    }

    /** Content is markdown, except for legacy pages saved as HTML before the markdown switch. */
    private setContent(content: string): void {
        if (!this.editor) return;
        if (!content) {
            this.editor.commands.setContent('');
        } else if (content.trimStart().startsWith('<')) {
            this.editor.commands.setContent(content);
        } else {
            this.editor.commands.setContent(content, {contentType: 'markdown'});
        }
        this.emitHeadings();
        this.markBrokenLinks();
        // setContent does not always emit an update, and the empty-state check reads the document
        // through this counter rather than through a signal the editor does not have.
        this.contentVersion.update(v => v + 1);
    }

    private emitHeadings(): void {
        const headings: Heading[] = [];
        this.editor?.state.doc.descendants(node => {
            if (node.type.name === 'heading') {
                headings.push({level: node.attrs['level'] as number, text: node.textContent});
            }
            return true;
        });
        this.headingsChanged.emit(headings);
    }

    /** Fills and positions the hover card for one `wiki:` link. */
    private showPreview(anchor: Element, pageId: string): void {
        const page = this.wiki()?.pages.find(p => p.id === pageId);
        // A broken link has nothing to preview, and the anchor already renders as broken.
        if (!page) return;

        const rect = anchor.getBoundingClientRect();
        const width = 288;
        this.previewPosition.set({
            top: rect.bottom + 8,
            left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        });
        this.previewPage.set(page);
        this.previewSnippet.set(snippetOf(this.contentCache.content().get(pageId) ?? ''));
        this.previewOpen.set(true);
    }

    /**
     * Flags links whose target no longer exists. Done as a DOM attribute pass rather than a
     * schema rule because the set of valid ids changes as pages are created and deleted, while
     * the stored content does not.
     */
    private markBrokenLinks(): void {
        const root = this.editorEl?.nativeElement;
        if (!root) return;
        const known = new Set((this.wiki()?.pages ?? []).map(p => p.id));
        root.querySelectorAll('a').forEach(anchor => {
            const pageId = parseWikiHref(anchor.getAttribute('href'));
            if (pageId === null) return;
            anchor.setAttribute('data-wiki-broken', String(!known.has(pageId)));
        });
    }
}

/**
 * First couple of lines of prose from a markdown body, for the link hover card.
 *
 * Deliberately crude: it strips the handful of markers that would otherwise read as noise in a
 * one-line summary and leaves everything else alone. Rendering the markdown properly to extract a
 * preview would cost more than the preview is worth.
 */
function snippetOf(markdown: string): string {
    return markdown
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
        .replace(/^\s{0,3}[#>\-*+]\s+/gm, '')
        .replace(/[*_`~]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
}

/** Appends with a blank line between, so two blocks do not weld into one paragraph. */
function joinBlocks(existing: string, addition: string): string {
    if (!existing.trim()) return addition;
    return `${existing.replace(/\s+$/, '')}\n\n${addition}`;
}
