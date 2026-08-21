import {
    AfterViewInit,
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    ElementRef,
    inject,
    input,
    OnDestroy,
    output,
    signal,
    viewChild,
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
import {SuggestState, wikiSuggestPlugin, WikiSuggestHandle} from './wiki-suggest.plugin';
import {WikiBubbleMenuComponent} from './wiki-bubble-menu.component';
import {SlashItem, WikiSlashMenuComponent, wikiTurnIntoItems} from './wiki-slash-menu.component';
import {WikiToolbarComponent} from './wiki-toolbar.component';
import {WikiFindBarComponent} from './wiki-find-bar.component';
import {WikiLinkPickerComponent, WikiLinkPickerTab, WikiLinkResult} from './wiki-link-picker.component';
import {anchorTo, AnchorRect, injectWikiFloating} from './wiki-floating';
import {WikiBlockHandleLabels} from './wiki-block-handle.plugin';
import {resolveWikiAnchor} from './wiki-anchor';
import {LinkOpener} from '../../../../../platform/ports/link-opener.port';
import {WikiEmojiMenuComponent} from './wiki-emoji-menu.component';
import {userHref, WikiMentionMember, WikiMentionMenuComponent} from './wiki-mention-menu.component';
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
        FormsModule,
        Button,
        TranslateModule,
        WikiBubbleMenuComponent,
        WikiSlashMenuComponent,
        WikiLinkPickerComponent,
        WikiFindBarComponent,
        WikiToolbarComponent,
        WikiLinkPreviewComponent,
        WikiEmojiMenuComponent,
        WikiMentionMenuComponent,
        WikiAiInlineComponent,
        WikiAiMetadataComponent,
    ],
    templateUrl: './wiki-article.component.html',
    styleUrl: './wiki-article.component.css',
    host: {class: 'flex flex-col flex-1 min-h-0 overflow-hidden'},
    changeDetection: ChangeDetectionStrategy.OnPush,
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
    /** 'error' is emitted alongside the toast a failed save raises; the draft is written first, so the local copy is still the user's record. */
    readonly saveStatusChanged = output<'idle' | 'draft' | 'saving' | 'saved' | 'error'>();
    readonly requestEdit = output<void>();
    readonly requestAi = output<void>();
    /** Tags the AI suggested and the user accepted. The rail's tag editor owns them. */
    readonly tagsSuggested = output<string[]>();

    readonly editorEl = viewChild<ElementRef<HTMLDivElement>>('editorEl');
    readonly fileInputEl = viewChild<ElementRef<HTMLInputElement>>('fileInputEl');
    readonly toolbar = viewChild<WikiToolbarComponent>('toolbar');
    readonly bubbleMenu = viewChild<WikiBubbleMenuComponent>('bubbleMenu');
    readonly slashMenu = viewChild<WikiSlashMenuComponent>('slashMenu');

    readonly emojiMenu = viewChild<WikiEmojiMenuComponent>('emojiMenu');
    readonly mentionMenu = viewChild<WikiMentionMenuComponent>('mentionMenu');
    readonly aiInline = viewChild<WikiAiInlineComponent>('aiInline');

    private readonly titleEl = viewChild<ElementRef<HTMLInputElement>>('titleEl');
    private readonly linkPicker = viewChild<WikiLinkPickerComponent>('linkPicker');
    private readonly findBar = viewChild<WikiFindBarComponent>('findBar');

    protected readonly title = signal('');
    protected readonly saving = signal(false);
    protected readonly slashOpen = signal(false);
    protected readonly emojiMenuOpen = signal(false);
    protected readonly mentionMenuOpen = signal(false);
    protected readonly suggestQuery = signal('');
    protected readonly suggestPosition = signal({top: 0, left: 0});

    /** The one link surface, for the toolbar button, the shortcut and the `[[` trigger alike. */
    protected readonly linkPickerOpen = signal(false);
    protected readonly linkPickerTab = signal<WikiLinkPickerTab>('page');
    protected readonly linkPickerHref = signal('');
    protected readonly linkPickerAnchor = signal<AnchorRect | null>(null);
    /** False for the `[[` trigger, which keeps typing into the document. */
    protected readonly linkPickerCapture = signal(false);

    protected readonly findOpen = signal(false);

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

    /** Page bodies for the link picker's heading rows; the cache fills as pages are read. */
    protected readonly pageContent = computed(() => this.contentCache.content());

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
    private readonly links = inject(LinkOpener);

    /** Keeps the four caret-anchored menus on the caret while the article scrolls under them. */
    private readonly suggestFloating = injectWikiFloating({
        reposition: () => this.positionSuggest(),
        close: () => this.closeMenus(),
        contains: node => this.editorEl()?.nativeElement.contains(node) ?? false,
        // Escape reaches the menus through the editor's own keymap chain.
        escape: false,
    });

    private draftTimer?: ReturnType<typeof setTimeout>;
    private previewTimer?: ReturnType<typeof setTimeout>;
    private editor?: Editor;
    private clickHandler?: (e: MouseEvent) => void;
    private keydownHandler?: (e: KeyboardEvent) => void;
    private pickerKeyHandler?: (e: KeyboardEvent) => void;
    private pointerDownHandler?: () => void;
    private pointerUpHandler?: () => void;
    /** True between pointerdown and pointerup, i.e. while a selection is being dragged out. */
    private selecting = false;
    private overHandler?: (e: MouseEvent) => void;
    private outHandler?: (e: MouseEvent) => void;
    private suggest: SuggestState | null = null;
    private suggestHandle?: WikiSuggestHandle;
    /** Files behind an in-flight or failed upload, keyed by the blob URL standing in for them. */
    private readonly pendingUploads = new Map<string, File>();
    /** Restored from a draft, and preferred over the nav's defaults for the create call. */
    private readonly draftDefaults = signal<{categoryId?: string; parentPageId?: string} | null>(null);
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
                this.aiInline()?.cancel();
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
                existing &&
                    !remoteConflict &&
                    this.drafts.divergesFrom(existing, page?.title ?? '', page?.content ?? '')
                    ? existing
                    : null,
            );
        });

        effect(() => {
            const editing = this.editing();
            // Same reason: leaving edit mode mid-generation must not leave the bar holding it.
            if (!editing) this.aiInline()?.cancel();
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

        // With focus in the picker's own field the editor's keymap never sees a key, so the
        // arrows, Tab and Escape it answers have to be routed from the document instead.
        effect(() => {
            const captured = this.linkPickerOpen() && this.linkPickerCapture();
            if (captured === !!this.pickerKeyHandler) return;
            if (captured) {
                this.pickerKeyHandler = (event: KeyboardEvent) => {
                    if (this.linkPicker()?.handleKey(event)) event.preventDefault();
                };
                document.addEventListener('keydown', this.pickerKeyHandler, true);
            } else {
                document.removeEventListener('keydown', this.pickerKeyHandler!, true);
                this.pickerKeyHandler = undefined;
            }
        });
    }

    ngAfterViewInit(): void {
        const editorEl = this.editorEl()?.nativeElement;
        if (!editorEl) return;
        this.suggestHandle = wikiSuggestPlugin(s => this.onSuggest(s));
        this.editor = new Editor({
            element: editorEl,
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
                    {
                        uploads: {retry: src => this.retryUpload(src)},
                        blockHandle: {
                            labels: this.blockHandleLabels(),
                            turnInto: () => wikiTurnIntoItems(),
                            translate: key => this.translate.instant(key),
                            pageId: () => this.page()?.id ?? null,
                            onCopyLink: href => this.copyBlockLink(href),
                        },
                    },
                ),
                Extension.create({
                    name: 'wikiSuggest',
                    addProseMirrorPlugins: () => [
                        this.suggestHandle!.plugin,
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
                        openLink: () => this.toolbar()?.openLinkRow(),
                    },
                }),
                Extension.create({
                    name: 'wikiPasteLink',
                    addProseMirrorPlugins: () => [
                        new Plugin({
                            props: {
                                handlePaste: (_view, event) => this.onPaste(event),
                                handleDrop: (_view, event) => this.onDrop(event as DragEvent),
                            },
                        }),
                    ],
                }),
                Extension.create({
                    name: 'wikiGhostText',
                    addProseMirrorPlugins: () => [
                        wikiGhostTextPlugin({
                            // Checks available() as well as the preference: with no key connected,
                            // every pause in typing would fire a request that can only throw.
                            enabled: () => this.wikiAi.ghostTextEnabled() && this.wikiAi.available(),
                            title: () => this.title(),
                            complete: (req, signal) => this.wikiAi.complete(req, signal),
                        }),
                    ],
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
                if (this.selecting) this.bubbleMenu()?.hide();
                else this.bubbleMenu()?.sync();
            },
        });
        this.editorInstance.set(this.editor);
        this.setContent(this.page()?.content ?? '');

        // Read mode keeps live anchors, and every one of them is prevented here: an anchor left to
        // default behaviour reaches the WebView, which hands it to the system browser, or worse
        // navigates the client away from itself.
        this.clickHandler = (event: MouseEvent) => {
            const anchor = (event.target as HTMLElement).closest('a');
            if (!anchor) return;
            event.preventDefault();
            const target = resolveWikiAnchor(anchor.getAttribute('href'), this.wiki()?.pages ?? []);
            switch (target.kind) {
                case 'page':
                    this.wikiLinkClicked.emit(target.pageId);
                    return;
                case 'external':
                    void this.links.open(target.href);
                    return;
                // A mention, a red link and an href in no allowed scheme are all swallowed;
                // opening a profile is a later refinement.
                default:
                    return;
            }
        };
        editorEl.addEventListener('click', this.clickHandler);

        // Captured so arrow keys drive the open menu instead of moving the caret; only consumed
        // while a menu is open.
        this.keydownHandler = (event: KeyboardEvent) => {
            // Read mode too: highlighting writes nothing, and the WebView has no find bar of its
            // own, so an unhandled Ctrl+F does nothing at all.
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
                event.preventDefault();
                this.openFind();
                return;
            }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                event.preventDefault();
                this.save();
                return;
            }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
                event.preventDefault();
                this.aiInline()?.askAtCaret();
                return;
            }
        };
        editorEl.addEventListener('keydown', this.keydownHandler, true);

        // pointerup is bound on the document, not the editor: a drag often ends with the pointer
        // outside it, and a missed up would leave the menu suppressed until the next click.
        this.pointerDownHandler = () => {
            this.selecting = true;
            this.bubbleMenu()?.hide();
        };
        this.pointerUpHandler = () => {
            if (!this.selecting) return;
            this.selecting = false;
            // After the browser has settled the selection this release produced.
            requestAnimationFrame(() => this.bubbleMenu()?.sync());
        };
        editorEl.addEventListener('pointerdown', this.pointerDownHandler);
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
        editorEl.addEventListener('mouseover', this.overHandler);
        editorEl.addEventListener('mouseout', this.outHandler);
    }

    ngOnDestroy(): void {
        clearTimeout(this.draftTimer);
        clearTimeout(this.previewTimer);
        const el = this.editorEl()?.nativeElement;
        if (el && this.clickHandler) el.removeEventListener('click', this.clickHandler);
        if (el && this.keydownHandler) el.removeEventListener('keydown', this.keydownHandler, true);
        if (el && this.pointerDownHandler) el.removeEventListener('pointerdown', this.pointerDownHandler);
        if (this.pointerUpHandler) document.removeEventListener('pointerup', this.pointerUpHandler);
        if (el && this.overHandler) el.removeEventListener('mouseover', this.overHandler);
        if (el && this.outHandler) el.removeEventListener('mouseout', this.outHandler);
        if (this.pickerKeyHandler) document.removeEventListener('keydown', this.pickerKeyHandler, true);
        for (const blobUrl of this.pendingUploads.keys()) URL.revokeObjectURL(blobUrl);
        this.pendingUploads.clear();
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
        this.editor?.chain().focus().selectAll().insertContent(markdown, {contentType: 'markdown'}).run();
    }

    /** Streams a whole-page draft from the dialog's prompt; an empty page gets its whole body, a written one gets an insertion at the caret. */
    draftWithAi(prompt: string): void {
        this.aiInline()?.draftIntoPage(prompt);
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
        this.bubbleMenu()?.hide();
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
        if (event.key === 'Control' || event.key === 'Alt' || event.key === 'Shift' || event.key === 'Meta') {
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
        this.fileInputEl()?.nativeElement.click();
    }

    save(): void {
        if (this.saving()) return;
        if (!this.title().trim()) {
            // Returning silently here read as a dead Save button.
            this.toast.warn(this.translate.instant('WIKI.ARTICLE.TITLE_REQUIRED'));
            this.titleEl()?.nativeElement.focus();
            return;
        }
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
        const editingId = this.page()?.id;
        // Where the nav said to put it ("Add article here" / "Add sub-page here"), or what a
        // restored draft was started under. Only a create can place a page; an update carries the
        // fields it already has.
        const placement = editingId ? null : (this.draftDefaults() ?? this.wikiState.editorDefaults());
        const base = {
            title: this.title().trim(),
            content,
            ...(this.summaryApplies() && summary ? {summary} : {}),
            ...(placement?.categoryId ? {categoryId: placement.categoryId} : {}),
            ...(placement?.parentPageId ? {parentPageId: placement.parentPageId} : {}),
        };
        const request = editingId
            ? this.wikiService.updatePage(this.guildId(), editingId, base)
            : this.wikiService.createPage(this.guildId(), base);
        request.subscribe({
            next: page => {
                this.saving.set(false);
                // The parent feeds the server's response back as the page input, and the reload
                // effect is gated on this flag, so it is only safe to clear when nothing was
                // typed while the request was in flight.
                this.dirty = this.markdown() !== base.content || this.title().trim() !== base.title;
                this.dirtyChanged.emit(this.dirty);
                // The draft is now published; keeping it would offer to restore content
                // identical to what the server already has.
                this.drafts.clear(this.guildId(), editingId ?? null);
                this.pendingDraft.set(null);
                this.draftDefaults.set(null);
                this.editSummary.set('');
                this.saveStatusChanged.emit('saved');
                this.saved.emit(page);
            },
            error: error => {
                this.saving.set(false);
                // Written before the status goes out: the local copy is still the user's only
                // record of the edit, and the debounce that would have written it was cleared.
                this.writeDraft();
                this.saveStatusChanged.emit('error');
                this.toast.httpError(this.translate.instant('WIKI.ARTICLE.SAVE_FAILED'), error);
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
        // The draft stores where the page was going to live; without this a restored draft of a
        // sub-page saves to the root.
        this.draftDefaults.set(
            draft.categoryId || draft.parentPageId
                ? {categoryId: draft.categoryId, parentPageId: draft.parentPageId}
                : null,
        );
        // The rail's tag editor owns tags, so restoring them means handing them back to it.
        if (draft.tags.length) this.tagsSuggested.emit([...draft.tags]);
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
            if (this.writeDraft()) this.saveStatusChanged.emit('draft');
        }, 800);
    }

    /** Returns whether anything was stored; false means the draft matched the server and was cleared. */
    private writeDraft(): boolean {
        const page = this.page();
        const placement = this.draftDefaults() ?? this.wikiState.editorDefaults();
        // Compared the same way divergesFrom compares on the way back out, so a draft
        // exists only when restoring it would visibly change something.
        const unchanged = this.title() === (page?.title ?? '') && this.markdown() === (page?.content ?? '');
        if (unchanged) {
            this.drafts.clear(this.guildId(), page?.id ?? null);
            return false;
        }
        this.drafts.write(this.guildId(), page?.id ?? null, {
            title: this.title(),
            content: this.markdown(),
            tags: [...(page?.tags ?? [])],
            isPinned: page?.isPinned ?? false,
            categoryId: page?.categoryId ?? placement?.categoryId,
            parentPageId: page?.parentPageId ?? placement?.parentPageId,
            baseUpdatedAt: page?.updatedAt ? String(page.updatedAt) : null,
            savedAt: Date.now(),
        });
        return true;
    }

    /** Removes the trigger text before running a block command, so "/table" does not survive. */
    protected applySlashItem(item: SlashItem): void {
        if (!this.editor) return;
        this.deleteTriggerRun();
        // Closed before dispatch, not after: the page-link item re-opens the link picker, and
        // closing afterwards would shut the one it just opened.
        this.closeMenus();
        this.runSlashItem(item);
    }

    /** The same dispatch without the trigger run, for the toolbar's insert menu. */
    protected runSlashItem(item: SlashItem): void {
        const editor = this.editor;
        if (!editor) return;

        if (item.run) {
            item.run(editor);
            return;
        }
        switch (item.hostAction) {
            case 'image':
                this.openFilePicker();
                return;
            case 'page-link':
                this.openLinkPickerAtCaret('page', true);
                return;
        }
        // A transform acts on what is already written and runs in place; the two generate rows
        // need a prompt first, so they open the dialog, which hands the prompt back to this
        // inline bar.
        if (item.aiOp) {
            this.aiInline()?.runTransform({op: item.aiOp, labelKey: item.labelKey});
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
        editor
            .chain()
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

    /** The toolbar button and the configurable shortcut both land here. */
    protected onLinkPickerRequested(request: {href: string; anchor: AnchorRect}): void {
        this.closeMenus();
        this.linkPickerHref.set(request.href);
        this.linkPickerAnchor.set(request.anchor);
        // A wiki: href is a page link, and retargeting one starts on the page tab.
        this.linkPickerTab.set(request.href && !parseWikiHref(request.href) ? 'url' : 'page');
        this.linkPickerCapture.set(true);
        this.suggestQuery.set('');
        this.linkPickerOpen.set(true);
    }

    /**
     * Writes what the picker chose. A page becomes an ordinary Link mark carrying a `wiki:` href,
     * not a custom node, since the markdown serializer already round-trips those, and it is what
     * `extractLinkedPageIds` matches, which is what the graph is built from.
     */
    protected onLinkApplied(result: WikiLinkResult): void {
        const editor = this.editor;
        if (!editor) return;
        // The `[[` run is still in the document when the picker was opened by typing it.
        if (!this.linkPickerCapture()) this.deleteTriggerRun();
        this.closeLinkPicker();

        if (result.kind === 'url') {
            editor.chain().focus().extendMarkRange('link').setLink({href: result.href}).run();
            return;
        }
        editor
            .chain()
            .focus()
            .insertContent({
                type: 'text',
                text: result.title,
                marks: [{type: 'link', attrs: {href: wikiHref(result.pageId, result.headingId)}}],
            })
            // Without this the link mark stays active and the next character typed joins the link.
            .unsetMark('link')
            .run();
    }

    protected onLinkRemoved(): void {
        this.editor?.chain().focus().extendMarkRange('link').unsetLink().run();
        this.closeLinkPicker();
    }

    protected closeLinkPicker(): void {
        this.linkPickerOpen.set(false);
        this.linkPickerCapture.set(false);
        this.linkPickerHref.set('');
    }

    protected onFindClosed(): void {
        this.findOpen.set(false);
    }

    /** Anchored on the caret, for the `[[` trigger and the slash menu's page-link row. */
    private openLinkPickerAtCaret(tab: WikiLinkPickerTab, captureFocus: boolean): void {
        const editor = this.editor;
        if (!editor) return;
        const coords = editor.view.coordsAtPos(editor.state.selection.from);
        this.linkPickerAnchor.set(coords);
        this.linkPickerHref.set('');
        this.linkPickerTab.set(tab);
        this.linkPickerCapture.set(captureFocus);
        this.linkPickerOpen.set(true);
    }

    private openFind(): void {
        const editor = this.editor;
        const {from, to} = editor?.state.selection ?? {from: 0, to: 0};
        if (editor && to > from) {
            this.findBar()?.setQuery(editor.state.doc.textBetween(from, to, ' '));
        }
        this.findOpen.set(true);
    }

    protected onFilesSelected(event: Event): void {
        const input = event.target as HTMLInputElement;
        const files = input.files ? Array.from(input.files) : [];
        input.value = '';
        for (const file of files) this.uploadFile(file);
    }

    /** Pasted wiki URLs become internal wiki: links (needed for hover preview and broken-link marking) but only when the guild matches; a link into another guild's wiki is left as-is. */
    private onPaste(event: ClipboardEvent): boolean {
        // A pasted screenshot is how most images reach a wiki, and it arrives as a file rather
        // than as text.
        if (this.editing() && this.uploadImages(event.clipboardData?.files)) {
            event.preventDefault();
            return true;
        }
        const text = event.clipboardData?.getData('text/plain')?.trim();
        if (!text || !this.editor) return false;
        const target = parseWikiUrl(text);
        if (!target || target.guildId !== this.guildId()) return false;

        const title = this.wiki()?.pages.find(p => p.id === target.pageId)?.title;
        this.editor
            .chain()
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
        this.suggestQuery.set(state.query);

        // Reset only when a menu opens; resetting on every keystroke would throw the highlight
        // back to the first row as the query narrows.
        const trigger = state.trigger;
        if (trigger === '/' && !this.slashOpen()) this.slashMenu()?.reset();
        if (trigger === '[[' && !this.linkPickerOpen()) this.linkPicker()?.reset();
        if (trigger === ':' && !this.emojiMenuOpen()) this.emojiMenu()?.reset();
        if (trigger === '@' && !this.mentionMenuOpen()) this.mentionMenu()?.reset();

        this.slashOpen.set(trigger === '/');
        this.emojiMenuOpen.set(trigger === ':');
        this.mentionMenuOpen.set(trigger === '@');
        if (trigger === '[[') this.openLinkPickerAtCaret('page', false);
        else if (!this.linkPickerCapture()) this.linkPickerOpen.set(false);

        this.positionSuggest();
        this.suggestFloating.attach();
    }

    /** Flips and clamps against the viewport; the raw caret coordinate put the slash menu below the fold on the last visible line. */
    private positionSuggest(): void {
        const editor = this.editor;
        if (!editor) return;
        if (this.linkPickerOpen() && !this.linkPickerCapture()) {
            this.linkPickerAnchor.set(editor.view.coordsAtPos(editor.state.selection.from));
        }
        const size = this.slashOpen() ? SLASH_MENU_SIZE : LIST_MENU_SIZE;
        const coords = editor.view.coordsAtPos(editor.state.selection.from);
        this.suggestPosition.set(anchorTo(coords, size));
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
        // Escape is checked ahead of the open-menu gate: the bubble bar and its AI submenu are
        // not suggest menus, and gating on those left them on screen.
        if (event.key === 'Escape' && (this.anyMenuOpen() || this.bubbleMenu()?.isVisible())) {
            this.closeMenus();
            this.bubbleMenu()?.hide();
            this.toolbar()?.closeMenu();
            // State is re-derived from the text before the caret on the next keystroke, so
            // without this the menu Escape just closed comes straight back.
            this.suggestHandle?.suppress();
            return true;
        }
        if (!this.anyMenuOpen()) return false;
        // Each menu returns false while it is shut, so the chain stops at the open one.
        return !!(
            this.slashMenu()?.handleKey(event.key) ||
            this.linkPicker()?.handleKey(event) ||
            this.emojiMenu()?.handleKey(event.key) ||
            this.mentionMenu()?.handleKey(event.key)
        );
    }

    private closeMenus(): void {
        this.slashOpen.set(false);
        this.emojiMenuOpen.set(false);
        this.mentionMenuOpen.set(false);
        // A picker the toolbar opened owns the keyboard; it is not a caret-tracking suggest menu
        // and must not close on the next transaction.
        if (!this.linkPickerCapture()) this.closeLinkPicker();
        this.suggestFloating.detach();
    }

    private anyMenuOpen(): boolean {
        return this.slashOpen() || this.linkPickerOpen() || this.emojiMenuOpen() || this.mentionMenuOpen();
    }

    /** Files dropped on the article go through the same optimistic insert as the file picker. */
    private onDrop(event: DragEvent): boolean {
        if (!this.editing()) return false;
        if (!this.uploadImages(event.dataTransfer?.files)) return false;
        event.preventDefault();
        return true;
    }

    /** Returns whether anything was taken, so the caller knows to swallow the event. */
    private uploadImages(files: FileList | null | undefined): boolean {
        const images = Array.from(files ?? []).filter(file => file.type.startsWith('image/'));
        for (const file of images) this.uploadFile(file);
        return images.length > 0;
    }

    private uploadFile(file: File): void {
        if (!file.type.startsWith('image/')) return;
        const blobUrl = URL.createObjectURL(file);
        this.pendingUploads.set(blobUrl, file);
        this.editor?.chain().focus().setImage({src: blobUrl, alt: file.name}).run();
        this.sendUpload(blobUrl, file);
    }

    /** Re-runs the upload behind a node whose retry button was pressed. */
    private retryUpload(blobUrl: string): void {
        const file = this.pendingUploads.get(blobUrl);
        if (file) this.sendUpload(blobUrl, file);
    }

    private sendUpload(blobUrl: string, file: File): void {
        this.fileService.uploadFile(file).subscribe({
            // Built from the id, not read off the response: url is not actually sent, and an
            // undefined here would be written into the saved page as the image's src.
            next: attachment => {
                this.pendingUploads.delete(blobUrl);
                this.replaceImageSrc(
                    blobUrl,
                    this.fileService.attachmentDownloadUrl(attachment.id),
                    attachment.fileName,
                );
                URL.revokeObjectURL(blobUrl);
            },
            // The node stays, and so does the blob URL behind it: deleting it made a dropped
            // screenshot shimmer and vanish with nothing to act on. The node view renders a
            // retry/remove strip off this attribute.
            error: () => this.markUploadFailed(blobUrl),
        });
    }

    private markUploadFailed(blobUrl: string): void {
        const editor = this.editor;
        if (!editor) return;
        const tr = editor.state.tr;
        let changed = false;
        editor.state.doc.descendants((node, pos) => {
            if (node.type.name === 'image' && node.attrs['src'] === blobUrl) {
                tr.setNodeAttribute(pos, 'uploadFailed', true);
                changed = true;
                return false;
            }
            return true;
        });
        if (changed) editor.view.dispatch(tr.setMeta('addToHistory', false));
    }

    private replaceImageSrc(blobUrl: string, newSrc: string, alt: string): void {
        const editor = this.editor;
        if (!editor) return;
        const tr = editor.state.tr;
        let changed = false;
        editor.state.doc.descendants((node, pos) => {
            if (node.type.name === 'image' && node.attrs['src'] === blobUrl) {
                tr.setNodeMarkup(pos, undefined, {...node.attrs, src: newSrc, alt, uploadFailed: false});
                changed = true;
                return false;
            }
            return true;
        });
        if (changed) editor.view.dispatch(tr);
    }

    /** Content is markdown, except legacy pages saved as HTML before the markdown switch. Returns whether it was applied; a parse that throws leaves the previous document in place rather than an empty one, so a mode switch stays on the surface that still has the text. */
    private setContent(content: string): boolean {
        if (!this.editor) return false;
        try {
            if (!content) {
                this.editor.commands.setContent('');
            } else if (isLegacyHtml(content)) {
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

    /** The gutter renders outside Angular, so its strings are resolved once at construction. */
    private blockHandleLabels(): WikiBlockHandleLabels {
        return {
            drag: this.translate.instant('WIKI.BLOCK_HANDLE.DRAG'),
            insertBelow: this.translate.instant('WIKI.BLOCK_HANDLE.INSERT_BELOW'),
            turnInto: this.translate.instant('WIKI.BLOCK_HANDLE.TURN_INTO'),
            duplicate: this.translate.instant('WIKI.BLOCK_HANDLE.DUPLICATE'),
            copyLink: this.translate.instant('WIKI.BLOCK_HANDLE.COPY_LINK'),
            remove: this.translate.instant('WIKI.BLOCK_HANDLE.DELETE'),
            back: this.translate.instant('COMMON.BACK'),
        };
    }

    private copyBlockLink(href: string): void {
        void navigator.clipboard
            ?.writeText(href)
            .then(() => this.toast.success(this.translate.instant('WIKI.BLOCK_HANDLE.LINK_COPIED')))
            .catch(() => this.toast.error(this.translate.instant('WIKI.BLOCK_HANDLE.LINK_COPY_FAILED')));
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
        const root = this.editorEl()?.nativeElement;
        if (!root) return;
        const pages = this.wiki()?.pages ?? [];
        const known = new Set(pages.map(p => p.id));
        root.querySelectorAll('a').forEach(anchor => {
            const target = resolveWikiAnchor(anchor.getAttribute('href'), pages);
            // A relative href naming no page is a red link too, and it has to read as one before
            // it is clicked.
            if (target.kind === 'broken') anchor.setAttribute('data-wiki-broken', 'true');
            else if (target.kind === 'page') {
                anchor.setAttribute('data-wiki-broken', String(!known.has(target.pageId)));
            }
        });
    }
}

/** Appends with a blank line between, so two blocks do not weld into one paragraph. */
function joinBlocks(existing: string, addition: string): string {
    if (!existing.trim()) return addition;
    return `${existing.replace(/\s+$/, '')}\n\n${addition}`;
}

const SLASH_MENU_SIZE = {width: 320, height: 350};
const LIST_MENU_SIZE = {width: 256, height: 300};

/**
 * Whether a stored body is one of the pages saved as HTML before the markdown switch.
 *
 * A leading `<` decides nothing on its own: the markdown serializer emits raw HTML for a toggle
 * (`<details open>`) and for a sized image (`<img … width>`), so a page whose first block is one of
 * those took the HTML branch and had everything after it mangled. What separates the two is blank
 * lines: `getHTML()` produces one unbroken run of tags, and every markdown document puts a blank
 * line between blocks.
 */
export function isLegacyHtml(content: string): boolean {
    const text = content.trimStart();
    if (!text.startsWith('<')) return false;
    if (/^<details[\s>]/i.test(text)) return false;
    return !/\n[ \t]*\n/.test(text);
}
