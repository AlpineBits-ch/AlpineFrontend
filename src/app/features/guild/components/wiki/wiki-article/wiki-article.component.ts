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
import {AuthImageService} from '../../../../../services/auth-image.service';
import {ToastService} from '../../../../../services/toast.service';
import {Heading} from '../wiki-toc';
import {parseWikiHref, wikiHref} from '../wiki-links';
import {parseWikiUrl, wikiSnippet} from '../../../../messaging/wiki-link';
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
import {wikiEditorKeybinds} from './wiki-editor-keybinds';
import {acceleratorFromEvent, KeybindsService} from '../../../../../services/keybinds.service';

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
    /** Output, not a method the template polls: a binding call would re-serialise the whole document every change-detection pass. */
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
    @ViewChild('toolbar') toolbar?: WikiToolbarComponent;
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

    /** Raw markdown editing; the ProseMirror surface stays mounted underneath rather than torn down, so toggling back keeps the editor, history, and caret. */
    protected readonly sourceMode = signal(false);
    protected readonly sourceText = signal('');

    /** Signal, not a getter: the field is assigned in ngAfterViewInit after bindings are checked, so a getter would report undefined then something else in the same pass (NG0100). */
    protected readonly editorInstance = signal<Editor | undefined>(undefined);

    /** Only true when the body changed: the server drops a summary silently on a metadata-only update since no revision is created to carry it. */
    protected readonly summaryApplies = computed(() => {
        if (!this.editing()) return false;
        this.contentVersion();
        if (this.sourceMode()) return this.sourceText() !== (this.page()?.content ?? '');
        return this.markdown() !== (this.page()?.content ?? '');
    });

    /** Read mode only; while editing, the placeholder fills this role. */
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
    private readonly authImages = inject(AuthImageService);
    private readonly drafts = inject(WikiDraftsService);
    private readonly wikiState = inject(WikiStateService);
    private readonly contentCache = inject(WikiContentCacheService);
    private readonly wikiAi = inject(WikiAiService);
    private readonly translate = inject(TranslateService);
    private readonly toast = inject(ToastService);
    private readonly keybinds = inject(KeybindsService);
    private draftTimer?: ReturnType<typeof setTimeout>;
    private previewTimer?: ReturnType<typeof setTimeout>;
    private editor?: Editor;
    private clickHandler?: (e: MouseEvent) => void;
    private keydownHandler?: (e: KeyboardEvent) => void;
    private pointerDownHandler?: () => void;
    private pointerUpHandler?: () => void;
    /** True between pointerdown and pointerup, i.e. while a selection is being dragged out. */
    private selecting = false;
    private overHandler?: (e: MouseEvent) => void;
    private outHandler?: (e: MouseEvent) => void;
    private suggest: SuggestState | null = null;
    /** Which page the document currently holds, so a refresh is not mistaken for a swap. */
    private shownPageId: string | null | undefined;
    /** Plain field, not a signal: the page effect reads it, and a signal here would re-run that effect on every keystroke. */
    private dirty = false;

    constructor() {
        // Loading a different page replaces the document; toggling editing must not.
        effect(() => {
            const page = this.page();
            // Cancelled only on an actual page swap: the effect also re-runs on any wiki summary
            // refresh, and cancelling there would kill an in-flight AI generation on a page
            // nobody left.
            const pageId = page?.id ?? null;
            const swapped = pageId !== this.shownPageId;
            if (swapped) {
                this.shownPageId = pageId;
                this.aiInline?.cancel();
                // Reset only on an actual swap: doing it on a mere refresh would throw away
                // unsaved text in the raw buffer.
                this.sourceMode.set(false);
                this.dirty = false;
            }

            // Must not run over an edit in progress: a refresh can arrive for unrelated reasons,
            // and even the save round-trip itself returns a page whose content predates anything
            // typed while it was in flight.
            if (this.dirty && !swapped) return;

            this.title.set(page?.title ?? '');
            // Compared by content, not by object identity: mergeSummary hands over a new page
            // object on any metadata refresh, and reacting to identity would re-parse the whole
            // document under someone who was only reading it.
            const nextContent = page?.content ?? '';
            if (this.sourceMode()) {
                if (nextContent !== this.sourceText()) this.sourceText.set(nextContent);
            } else if (this.editor && nextContent !== this.markdown()) {
                this.setContent(nextContent);
            }
            this.dirty = false;
        });

        // Kept as its own effect, not folded into the one above: that effect returns early
        // during an edit in progress, but the draft-restore offer still needs to track a remote
        // conflict while typing.
        effect(() => {
            const page = this.page();
            const existing = this.drafts.read(this.guildId(), page?.id ?? null);
            // Suppressed while a remote conflict banner is showing, to avoid stacking two
            // "stale content" banners.
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

        // Broken-link state depends on the page list, not stored content, so it re-evaluates
        // whenever that list changes, not only on load.
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
                // Block node views render DOM outside Angular, where neither the translate pipe
                // nor an injected service is reachable, so their strings are resolved once here
                // and handed down.
                ...wikiExtensions(
                    this.translate.instant('WIKI.ARTICLE.PLACEHOLDER'),
                    wikiBlockLabels(this.translate),
                    // Same reason as the strings: an uploaded image's URL needs the bearer token,
                    // and the node view cannot inject the service that holds it.
                    this.authImages,
                ),
                Extension.create({
                    name: 'wikiSuggest',
                    addProseMirrorPlugins: () => [
                        wikiSuggestPlugin(s => this.onSuggest(s)),
                        // Registered ahead of the ghost-text plugin so Tab selects a menu item
                        // instead of accepting a suggestion while a menu is open.
                        new Plugin({
                            props: {handleKeyDown: (_view, event) => this.onMenuKeyDown(event)},
                        }),
                    ],
                }),
                // Registered ahead of the block extensions' own keymaps, so a rebound shortcut
                // wins over the extension's default.
                wikiEditorKeybinds({
                    binding: id => this.keybinds.getBinding(id),
                    editable: () => this.editing(),
                    host: {
                        toggleMarkdown: () => this.toggleSourceMode(),
                        openLink: () => this.toolbar?.openLinkRow(),
                    },
                }),
                Extension.create({
                    name: 'wikiPasteLink',
                    addProseMirrorPlugins: () => [
                        new Plugin({
                            props: {handlePaste: (_view, event) => this.onPaste(event)},
                        }),
                    ],
                }),
                Extension.create({
                    name: 'wikiGhostText',
                    addProseMirrorPlugins: () => [wikiGhostTextPlugin({
                        // Checks available() as well as the preference: with no key connected,
                        // every pause in typing would fire a request that can only throw.
                        enabled: () => this.wikiAi.ghostTextEnabled() && this.wikiAi.available(),
                        title: () => this.title(),
                        complete: (req, signal) => this.wikiAi.complete(req, signal),
                    })],
                }),
            ],
            editable: this.editing(),
            content: '',
            onUpdate: () => {
                this.dirty = true;
                this.dirtyChanged.emit(true);
                this.contentChanged.emit(this.markdown());
                this.emitHeadings();
                this.markBrokenLinks();
                this.scheduleDraft();
                this.contentVersion.update(v => v + 1);
            },
            // Suppressed while the selection is still being dragged out, or the menu chases the
            // pointer across the paragraph.
            onSelectionUpdate: () => {
                if (this.selecting) this.bubbleMenu?.hide();
                else this.bubbleMenu?.sync();
            },
        });
        this.editorInstance.set(this.editor);
        this.setContent(this.page()?.content ?? '');

        // Read mode keeps live anchors, so wiki: links must be intercepted before the browser
        // tries to resolve an unknown protocol.
        this.clickHandler = (event: MouseEvent) => {
            const anchor = (event.target as HTMLElement).closest('a');
            if (!anchor) return;
            // A mention href is ours too; the webview knows no user: protocol, so the click is
            // swallowed here (opening a profile is a later refinement).
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

        // Captured so arrow keys drive the open menu instead of moving the caret; only consumed
        // while a menu is open.
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

        // pointerup is bound on the document, not the editor: a drag often ends with the pointer
        // outside it, and a missed up would leave the menu suppressed until the next click.
        this.pointerDownHandler = () => {
            this.selecting = true;
            this.bubbleMenu?.hide();
        };
        this.pointerUpHandler = () => {
            if (!this.selecting) return;
            this.selecting = false;
            // After the browser has settled the selection this release produced.
            requestAnimationFrame(() => this.bubbleMenu?.sync());
        };
        this.editorEl.nativeElement.addEventListener('pointerdown', this.pointerDownHandler);
        document.addEventListener('pointerup', this.pointerUpHandler);


        // Delayed so sweeping the pointer across a paragraph of links does not strobe a popover
        // per link.
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
        if (el && this.pointerDownHandler) el.removeEventListener('pointerdown', this.pointerDownHandler);
        if (this.pointerUpHandler) document.removeEventListener('pointerup', this.pointerUpHandler);
        if (el && this.overHandler) el.removeEventListener('mouseover', this.overHandler);
        if (el && this.outHandler) el.removeEventListener('mouseout', this.outHandler);
        this.editor?.destroy();
    }

    /** What would be saved right now, from whichever surface is currently authoritative. */
    markdown(): string {
        if (this.sourceMode()) return this.sourceText();
        return this.serialize() ?? '';
    }

    /** Drops generated markdown at the caret as a normal editor transaction (undoable, autosaves as a draft); nothing here touches the server. */
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

    /** Streams a whole-page draft from the dialog's prompt; an empty page gets its whole body, a written one gets an insertion at the caret. */
    draftWithAi(prompt: string): void {
        this.aiInline?.draftIntoPage(prompt);
    }

    /** Seeds a new page from a template; the title is only suggested, never imposed, over one the user already typed. The body goes through the same replace path as manual typing (undoable, autosaves as a draft). */
    applyTemplate(choice: WikiTemplateChoice): void {
        if (choice.suggestedTitle && !this.title().trim()) this.title.set(choice.suggestedTitle);
        if (choice.markdown) this.replaceMarkdown(choice.markdown);
        // Clears any leftover draft from an earlier abandoned new page, since it must not offer
        // to restore itself on top of the template.
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

    /** Toggles the raw/rich surfaces; the mode flag must not flip until the conversion succeeds, or a failed serialize leaves an empty textarea that becomes "the page" the moment something is typed into it. */
    protected toggleSourceMode(): void {
        // Overlays anchored to the rich surface are closed first: their document coordinates
        // stop existing once the textarea replaces it, and a leftover popup would act on a
        // selection that no longer exists.
        this.bubbleMenu?.hide();
        this.closeMenus();
        this.previewOpen.set(false);

        if (this.sourceMode()) {
            this.commitSourceMode();
            return;
        }
        const markdown = this.serialize();
        if (markdown === null) {
            this.toast.error(this.translate.instant('WIKI.ARTICLE.SOURCE_SWITCH_FAILED'));
            return;
        }
        this.sourceText.set(markdown);
        this.sourceMode.set(true);
    }

    /** Parses the textarea back into the document. A no-op when source mode is not open. */
    private commitSourceMode(): void {
        if (!this.sourceMode()) return;
        if (!this.setContent(this.sourceText())) {
            this.toast.error(this.translate.instant('WIKI.ARTICLE.SOURCE_SWITCH_FAILED'));
            return;
        }
        this.sourceMode.set(false);
    }

    /** The document as markdown, or null where the serializer could not produce it. */
    private serialize(): string | null {
        try {
            return this.editor?.getMarkdown() ?? '';
        } catch (error) {
            console.error('[wiki] markdown serialisation failed', error);
            return null;
        }
    }

    /** Shortcuts that still work in the raw markdown buffer: toggle (else the mode is a one-way door) and save (losing it risks data loss). Everything else on the editor's keymap acts on a ProseMirror document this textarea is not. */
    protected onSourceKeydown(event: KeyboardEvent): void {
        if (event.key === 'Control' || event.key === 'Alt'
            || event.key === 'Shift' || event.key === 'Meta') {
            return;
        }

        if (acceleratorFromEvent(event) === this.keybinds.getBinding('wiki-toggle-markdown')) {
            event.preventDefault();
            this.toggleSourceMode();
            return;
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            this.save();
        }
    }

    protected onSourceInput(value: string): void {
        this.sourceText.set(value);
        this.dirty = true;
        this.dirtyChanged.emit(true);
        this.scheduleDraft();
        this.contentVersion.update(v => v + 1);
    }

    /** Must raise the same dirty flag as the body: without it, a refresh landing mid-word puts the saved title back under the caret. */
    protected onTitleInput(value: string): void {
        this.title.set(value);
        this.dirty = true;
        this.dirtyChanged.emit(true);
        this.scheduleDraft();
    }

    protected openFilePicker(): void {
        this.fileInputEl?.nativeElement.click();
    }

    save(): void {
        if (this.saving() || !this.title().trim()) return;
        // Cleared before anything else: a debounce still in flight would fire ~800ms later and
        // write the draft back over the one this save just cleared, leaving a phantom "unsaved
        // changes" banner.
        clearTimeout(this.draftTimer);

        // Serialized here rather than via markdown(), which swallows a serializer failure as an
        // empty string; saving that would replace the page with nothing.
        const content = this.sourceMode() ? this.sourceText() : this.serialize();
        if (content === null) {
            this.toast.error(this.translate.instant('WIKI.ARTICLE.SAVE_SERIALIZE_FAILED'));
            return;
        }

        this.saving.set(true);
        this.saveStatusChanged.emit('saving');
        const summary = this.editSummary().trim();
        const base = {
            title: this.title().trim(),
            content,
            ...(this.summaryApplies() && summary ? {summary} : {}),
        };
        const editingId = this.page()?.id;
        const request = editingId
            ? this.wikiService.updatePage(this.guildId(), editingId, base)
            : this.wikiService.createPage(this.guildId(), base);
        request.subscribe({
            next: page => {
                this.saving.set(false);
                // The parent feeds the server's response back as the page input, and the reload
                // effect is gated on this flag, so it is only safe to clear when nothing was
                // typed while the request was in flight.
                this.dirty = this.markdown() !== base.content
                    || this.title().trim() !== base.title;
                this.dirtyChanged.emit(this.dirty);
                // The draft is now published; keeping it would offer to restore content
                // identical to what the server already has.
                this.drafts.clear(this.guildId(), editingId ?? null);
                this.pendingDraft.set(null);
                this.editSummary.set('');
                this.saveStatusChanged.emit('saved');
                this.saved.emit(page);
            },
            error: () => {
                this.saving.set(false);
                // Back to 'draft', not 'idle': the local copy is still the user's only record
                // of the edit.
                this.saveStatusChanged.emit('draft');
            },
        });
    }

    protected restoreDraft(): void {
        const draft = this.pendingDraft();
        if (!draft) return;
        this.title.set(draft.title);
        // Must land in the raw buffer when it is open, or the textarea keeps showing the text
        // the restore was meant to replace.
        if (this.sourceMode()) this.sourceText.set(draft.content);
        else this.setContent(draft.content);
        // A restored draft is not what the server holds, so the page effect must not load over it.
        this.dirty = true;
        this.dirtyChanged.emit(true);
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
            // Re-checked at fire time, not just at schedule time: the 800ms window is long
            // enough to leave edit mode inside it.
            if (!this.editing()) return;
            const page = this.page();
            // Compared the same way divergesFrom compares on the way back out, so a draft
            // exists only when restoring it would visibly change something.
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
        // Closed before dispatch, not after: the page-link item re-opens the [[ menu, and
        // closing afterwards would shut the one it just opened.
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
        // A transform acts on what is already written and runs in place; the two generate rows
        // need a prompt first, so they open the dialog, which hands the prompt back to this
        // inline bar.
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

    /** Same trick as applyPageLink: an ordinary Link mark with a user: href, which the markdown serializer round-trips as [@Name](user:<userId>) for free. */
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

    /** Replaces the [[query run with a link mark carrying a wiki: href; an ordinary Link mark, not a custom node, since the markdown serializer already round-trips those. */
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

    /** Pasted wiki URLs become internal wiki: links (needed for hover preview and broken-link marking) but only when the guild matches; a link into another guild's wiki is left as-is. */
    private onPaste(event: ClipboardEvent): boolean {
        const text = event.clipboardData?.getData('text/plain')?.trim();
        if (!text || !this.editor) return false;
        const target = parseWikiUrl(text);
        if (!target || target.guildId !== this.guildId()) return false;

        const title = this.wiki()?.pages.find(p => p.id === target.pageId)?.title;
        this.editor.chain()
            .focus()
            .insertContent({
                type: 'text',
                text: title ?? text,
                marks: [{type: 'link', attrs: {href: wikiHref(target.pageId)}}],
            })
            // Without this the link mark stays active and the next character typed joins the link.
            .unsetMark('link')
            .run();
        return true;
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

        // Reset only when a menu opens; resetting on every keystroke would throw the highlight
        // back to the first row as the query narrows.
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

    /** Registered as a ProseMirror handleKeyDown prop, not a DOM listener: it fires for every keydown ahead of the editor's own keymaps, and returning true is what stops it. Focus must stay in the editor so continuing to type still filters the menu. */
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
            // Built from the id, not read off the response: url is not actually sent, and an
            // undefined here would be written into the saved page as the image's src.
            next: attachment => this.replaceImageSrc(
                blobUrl, this.fileService.attachmentDownloadUrl(attachment.id), attachment.fileName),
            // A failed upload drops the placeholder rather than leaving a broken blob: URL,
            // which would render as a broken image and save as one.
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

    /** Content is markdown, except legacy pages saved as HTML before the markdown switch. Returns whether it was applied; a parse that throws leaves the previous document in place rather than an empty one, so a mode switch stays on the surface that still has the text. */
    private setContent(content: string): boolean {
        if (!this.editor) return false;
        try {
            if (!content) {
                this.editor.commands.setContent('');
            } else if (content.trimStart().startsWith('<')) {
                this.editor.commands.setContent(content);
            } else {
                this.editor.commands.setContent(content, {contentType: 'markdown'});
            }
        } catch (error) {
            console.error('[wiki] markdown parse failed', error);
            return false;
        }
        this.emitHeadings();
        this.markBrokenLinks();
        // setContent does not always emit an update; the empty-state check reads the document
        // through this counter since the editor has no signal of its own.
        this.contentVersion.update(v => v + 1);
        return true;
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
        // Uses the same stripping as the chat card, rather than a separate cruder copy that
        // left table pipes and callout markers in.
        this.previewSnippet.set(wikiSnippet(this.contentCache.content().get(pageId) ?? '', 240));
        this.previewOpen.set(true);
    }

    /** Flags links whose target no longer exists; done as a DOM attribute pass rather than a schema rule since the set of valid ids changes as pages are created and deleted while stored content does not. */
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

/** Appends with a blank line between, so two blocks do not weld into one paragraph. */
function joinBlocks(existing: string, addition: string): string {
    if (!existing.trim()) return addition;
    return `${existing.replace(/\s+$/, '')}\n\n${addition}`;
}
