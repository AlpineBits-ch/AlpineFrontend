import {Component, computed, effect, inject, input, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Select} from 'primeng/select';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {WikiDto, WikiPageDto, WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {UpdateWikiPageDto} from '../../../../../dtos/request/wiki.dto';
import {WikiService} from '../../../../../services/wiki.service';
import {WikiStateService} from '../wiki-state.service';
import {canEditPage} from '../wiki-permissions';

/** The four fields of a page that are metadata rather than prose. */
type PropertyPatch = Pick<UpdateWikiPageDto, 'tags' | 'isPinned' | 'categoryId' | 'parentPageId'>;

/** `p-select` shows its placeholder for a null model, so "no category" needs a value of its own or it renders as though nothing were chosen at all. */
const NONE = '';

const TAG_MAX_LENGTH = 32;
/** A page with thirty tags has none; the cap is what keeps the field a summary. */
const TAG_MAX_COUNT = 15;

/**
 * Page properties: tags, pinned, category, parent. Editable while reading, not only while editing:
 * they describe the page rather than being part of it.
 */
@Component({
    selector: 'app-wiki-page-properties',
    imports: [FormsModule, Select, ToggleSwitch, TranslateModule],
    templateUrl: './wiki-page-properties.component.html',
})
export class WikiPagePropertiesComponent {
    readonly page = input<WikiPageDto | null>(null);
    readonly wiki = input<WikiDto | null>(null);
    readonly guildId = input.required<string>();

    protected readonly tagQuery = signal('');
    protected readonly suggestIndex = signal(-1);
    protected readonly saving = signal(false);
    /** Set when a write failed, cleared by the next attempt. The revert has already happened. */
    protected readonly failed = signal(false);

    /** Fields written but not yet acknowledged. Held here rather than pushed into the open page so a control shows the new value instantly without handing the article's document a new object mid-read. Presence of the key is the test, not its value: `categoryId: null` is a real pending value. */
    private readonly pending = signal<PropertyPatch>({});

    protected readonly state = inject(WikiStateService);
    private readonly wikiService = inject(WikiService);
    private readonly translate = inject(TranslateService);
    private lastPageId: string | null = null;

    protected readonly tags = computed(() => this.pending().tags ?? this.page()?.tags ?? []);

    protected readonly pinned = computed(() => this.pending().isPinned ?? this.page()?.isPinned ?? false);

    protected readonly categoryValue = computed(() => {
        const pending = this.pending();
        return ('categoryId' in pending ? pending.categoryId : this.page()?.categoryId) ?? NONE;
    });

    protected readonly parentValue = computed(() => {
        const pending = this.pending();
        return ('parentPageId' in pending ? pending.parentPageId : this.page()?.parentPageId) ?? NONE;
    });

    /** Tags and pinning are the page's own record: whoever may edit the page may set them. */
    protected readonly canEditMetadata = computed(() => {
        const page = this.page();
        if (!page) return false;
        return canEditPage(this.state.abilities(), page.authorId, this.state.ownUserId());
    });

    /** Where a page sits is the wiki's shape, so someone who manages the structure may move a page they could not otherwise edit. Both branches deny while abilities are still loading, matching the fail-closed rule the rest of the wiki follows. */
    protected readonly canMovePage = computed(
        () => this.canEditMetadata() || this.state.abilities().canManageStructure,
    );

    protected readonly categoryOptions = computed(() => [
        {label: this.translate.instant('WIKI.RAIL.NO_CATEGORY'), value: NONE},
        ...[...(this.wiki()?.categories ?? [])]
            .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
            .map(category => ({label: category.name, value: category.id})),
    ]);

    /** Every page except this one and its own descendants: reparenting onto something beneath it would cut that branch out of the tree and leave it pointing in a circle, which the nav renders as nothing at all. */
    protected readonly parentOptions = computed(() => {
        const page = this.page();
        const pages = this.wiki()?.pages ?? [];
        if (!page) return [];
        const blocked = subtreeIds(pages, page.id);
        return [
            {label: this.translate.instant('WIKI.RAIL.NO_PARENT'), value: NONE},
            ...pages
                .filter(candidate => !blocked.has(candidate.id))
                .sort((a, b) => a.title.localeCompare(b.title))
                .map(candidate => ({label: candidate.title, value: candidate.id})),
        ];
    });

    /** Tags already in use elsewhere in this wiki, most-used first. */
    protected readonly tagSuggestions = computed(() => {
        const query = this.tagQuery().trim().toLowerCase();
        const applied = new Set(this.tags().map(tag => tag.toLowerCase()));
        const counts = new Map<string, {label: string; uses: number}>();
        for (const page of this.wiki()?.pages ?? []) {
            for (const tag of page.tags ?? []) {
                const key = tag.toLowerCase();
                if (applied.has(key) || (query && !key.includes(query))) continue;
                const seen = counts.get(key);
                if (seen) seen.uses++;
                else counts.set(key, {label: tag, uses: 1});
            }
        }
        return [...counts.values()]
            .sort((a, b) => b.uses - a.uses || a.label.localeCompare(b.label))
            .slice(0, 6)
            .map(entry => entry.label);
    });

    protected readonly canAddTag = computed(
        () => this.canEditMetadata() && this.tags().length < TAG_MAX_COUNT,
    );

    protected readonly tagMaxLength = TAG_MAX_LENGTH;

    /** What the select would be showing, for the read-only rendering that replaces it. */
    protected readonly categoryLabel = computed(
        () =>
            this.categoryOptions().find(option => option.value === this.categoryValue())?.label ??
            this.translate.instant('WIKI.RAIL.NO_CATEGORY'),
    );

    protected readonly parentLabel = computed(
        () =>
            this.parentOptions().find(option => option.value === this.parentValue())?.label ??
            this.translate.instant('WIKI.RAIL.NO_PARENT'),
    );

    constructor() {
        // Keyed on the id, not the object: the wiki listing replaces the page object on every refresh, and resetting on that would drop a write still in flight.
        effect(() => {
            const id = this.page()?.id ?? null;
            if (id === this.lastPageId) return;
            this.lastPageId = id;
            this.pending.set({});
            this.tagQuery.set('');
            this.suggestIndex.set(-1);
            this.failed.set(false);
        });

        // Retires an override once the page reports the value it was standing in for. Reading `pending` through `update` rather than through the signal keeps this effect off its own dependency list, and returning the same object when nothing matched keeps it quiet.
        effect(() => {
            const page = this.page();
            if (!page) return;
            this.pending.update(current => {
                const next = {...current};
                if (next.tags && sameTags(next.tags, page.tags ?? [])) delete next.tags;
                if (next.isPinned === (page.isPinned ?? false)) delete next.isPinned;
                if ('categoryId' in next && (next.categoryId ?? undefined) === page.categoryId) {
                    delete next.categoryId;
                }
                if ('parentPageId' in next && (next.parentPageId ?? undefined) === page.parentPageId) {
                    delete next.parentPageId;
                }
                return Object.keys(next).length === Object.keys(current).length ? current : next;
            });
        });
    }

    protected onTagKeydown(event: KeyboardEvent): void {
        const suggestions = this.tagSuggestions();
        switch (event.key) {
            case 'Enter':
            case ',':
                event.preventDefault();
                this.addTag(suggestions[this.suggestIndex()] ?? this.tagQuery());
                return;
            case 'ArrowDown':
                event.preventDefault();
                this.suggestIndex.set(Math.min(this.suggestIndex() + 1, suggestions.length - 1));
                return;
            case 'ArrowUp':
                event.preventDefault();
                this.suggestIndex.set(Math.max(this.suggestIndex() - 1, -1));
                return;
            case 'Escape':
                this.tagQuery.set('');
                this.suggestIndex.set(-1);
                return;
            case 'Backspace': {
                // Only on an empty field, or backspacing through a typo would delete a tag.
                if (this.tagQuery()) return;
                const tags = this.tags();
                if (tags.length) this.removeTag(tags[tags.length - 1]);
            }
        }
    }

    protected onTagQuery(value: string): void {
        this.tagQuery.set(value);
        this.suggestIndex.set(-1);
    }

    protected addTag(raw: string): void {
        if (!this.canAddTag()) return;
        const tag = raw.trim().replace(/\s+/g, ' ').slice(0, TAG_MAX_LENGTH);
        this.tagQuery.set('');
        this.suggestIndex.set(-1);
        if (!tag) return;
        const tags = this.tags();
        // Case-insensitive, so "Setup" and "setup" cannot both end up on the same page and split its search score in two.
        if (tags.some(existing => existing.toLowerCase() === tag.toLowerCase())) return;
        this.apply({tags: [...tags, tag]});
    }

    protected removeTag(tag: string): void {
        if (!this.canEditMetadata()) return;
        this.apply({tags: this.tags().filter(existing => existing !== tag)});
    }

    protected setPinned(pinned: boolean): void {
        if (!this.canEditMetadata()) return;
        this.apply({isPinned: pinned});
    }

    protected setCategory(value: string): void {
        if (!this.canMovePage()) return;
        this.apply({categoryId: value === NONE ? null : value});
    }

    protected setParent(value: string): void {
        if (!this.canMovePage()) return;
        this.apply({parentPageId: value === NONE ? null : value});
    }

    /**
     * Writes one property, showing it as done and putting it back if the server disagrees. The
     * optimistic write touches the wiki listing, not the open page: handing the article a new page
     * object would re-parse the document underneath the reader. The override is left standing until
     * the page itself reports the same value, so the control cannot flicker back to the old one
     * during the refresh that follows.
     */
    private apply(patch: PropertyPatch): void {
        const page = this.page();
        if (!page) return;
        const keys = Object.keys(patch) as (keyof PropertyPatch)[];
        // Captured before the optimistic write, so a failure has something to go back to.
        const previous = summaryFields(page, keys);

        this.failed.set(false);
        this.saving.set(true);
        this.pending.update(current => ({...current, ...patch}));
        this.patchSummary(page.id, optimisticFields(patch));
        // Our own write returns over the websocket a moment later; without this the page is refetched and the article blinks through a spinner for a change already on screen.
        this.state.suppressPageRefreshOnce();

        this.wikiService.updatePage(this.guildId(), page.id, patch).subscribe({
            next: saved => {
                this.saving.set(false);
                // From the response rather than from the request: the server is free to trim or reorder tags, and the listing should show what it actually stored.
                this.patchSummary(saved.id, summaryFields(saved, keys));
            },
            error: () => {
                this.saving.set(false);
                this.patchSummary(page.id, previous);
                this.clearPending(keys);
                this.failed.set(true);
            },
        });
    }

    private patchSummary(pageId: string, patch: Partial<WikiPageSummaryDto>): void {
        this.state.updateWikiOptimistic(wiki => ({
            ...wiki,
            pages: wiki.pages.map(page => (page.id === pageId ? {...page, ...patch} : page)),
        }));
    }

    private clearPending(keys: readonly (keyof PropertyPatch)[]): void {
        this.pending.update(current => {
            const next = {...current};
            for (const key of keys) delete next[key];
            return next;
        });
    }
}

/**
 * Picks just the named fields off a page, translating the request DTO's `null` ("clear this") into
 * the response DTO's absent value. Never returns `content`, which is what makes it safe to spread
 * into a page currently on screen.
 */
function summaryFields(
    page: WikiPageDto | WikiPageSummaryDto,
    keys: readonly (keyof PropertyPatch)[],
): Partial<WikiPageSummaryDto> {
    const out: Partial<WikiPageSummaryDto> = {};
    for (const key of keys) {
        if (key === 'tags') out.tags = [...(page.tags ?? [])];
        if (key === 'isPinned') out.isPinned = page.isPinned ?? false;
        if (key === 'categoryId') out.categoryId = page.categoryId ?? undefined;
        if (key === 'parentPageId') out.parentPageId = page.parentPageId ?? undefined;
    }
    return out;
}

/** Set comparison, not element-by-element: the server is free to return tags in its own order, and an override that refused to retire over that would outlive the write it stood in for. */
function sameTags(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    const seen = new Set(b);
    return a.every(tag => seen.has(tag));
}

/** The same fields taken from the request instead, for the optimistic write that precedes it. */
function optimisticFields(patch: PropertyPatch): Partial<WikiPageSummaryDto> {
    const out: Partial<WikiPageSummaryDto> = {};
    if (patch.tags !== undefined) out.tags = [...patch.tags];
    if (patch.isPinned !== undefined) out.isPinned = patch.isPinned;
    if ('categoryId' in patch) out.categoryId = patch.categoryId ?? undefined;
    if ('parentPageId' in patch) out.parentPageId = patch.parentPageId ?? undefined;
    return out;
}

/** A page plus everything beneath it, following `parentPageId` downwards. */
function subtreeIds(pages: readonly WikiPageSummaryDto[], rootId: string): Set<string> {
    const ids = new Set([rootId]);
    let grew = true;
    // Repeated passes rather than a child index: a wiki is small, and a cycle already in the data terminates here instead of recursing forever.
    while (grew) {
        grew = false;
        for (const page of pages) {
            if (page.parentPageId && ids.has(page.parentPageId) && !ids.has(page.id)) {
                ids.add(page.id);
                grew = true;
            }
        }
    }
    return ids;
}
