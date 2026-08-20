import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {signal, WritableSignal} from '@angular/core';
import {MessageService} from 'primeng/api';
import {of} from 'rxjs';
import {beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {WikiNavComponent} from './wiki-nav.component';
import {WikiStateService} from '../wiki-state.service';
import {WikiService} from '../../../../../services/wiki.service';
import {ToastService} from '../../../../../services/toast.service';
import {WikiAbilities} from '../wiki-permissions';
import {WikiCategoryDto, WikiDto, WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';

const localStore = new Map<string, string>();

beforeAll(() => {
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => localStore.get(k) ?? null,
            setItem: (k: string, v: string) => void localStore.set(k, String(v)),
            removeItem: (k: string) => void localStore.delete(k),
            clear: () => localStore.clear(),
        },
    });
});

function category(id: string, name: string, position: number, parentCategoryId?: string): WikiCategoryDto {
    return {id, guildId: 'g1', name, position, parentCategoryId};
}

function page(id: string, title: string, extra: Partial<WikiPageSummaryDto> = {}): WikiPageSummaryDto {
    return {
        id,
        guildId: 'g1',
        title,
        slug: title.toLowerCase(),
        authorId: 'u1',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        visibility: 'public',
        tags: [],
        isPinned: false,
        revisionCount: 1,
        ...extra,
    };
}

/**
 * Guides(c1) > Deploy(c1a), Api(c2).
 * Alpha(p1) > Beta(p2) in c1, Zeta(p6) in c1a, Gamma(p3) pinned in c2,
 * Delta(p4) > Epsilon(p5) uncategorized.
 */
const WIKI: WikiDto = {
    id: 'w1',
    guildId: 'g1',
    categories: [category('c1', 'Guides', 0), category('c2', 'Api', 1), category('c1a', 'Deploy', 0, 'c1')],
    pages: [
        page('p1', 'Alpha', {categoryId: 'c1'}),
        page('p2', 'Beta', {categoryId: 'c1', parentPageId: 'p1'}),
        page('p3', 'Gamma', {categoryId: 'c2', isPinned: true}),
        page('p4', 'Delta'),
        page('p5', 'Epsilon', {parentPageId: 'p4'}),
        page('p6', 'Zeta', {categoryId: 'c1a'}),
    ],
};

const ALL_ABILITIES: WikiAbilities = {
    canCreate: true,
    canEditAny: true,
    canEditOwn: true,
    canDelete: true,
    canManageStructure: true,
    canManageRevisions: true,
    canPublish: true,
};

interface StateStub {
    wiki: WritableSignal<WikiDto | null>;
    wikiView: WritableSignal<string>;
    selectedPage: WritableSignal<WikiPageSummaryDto | null>;
    guildId: WritableSignal<string>;
    abilities: WritableSignal<WikiAbilities>;
    abilitiesResolved: WritableSignal<boolean>;
    wikiLoadFailed: WritableSignal<boolean>;
    ownUserId: WritableSignal<string | null>;
    openHome: ReturnType<typeof vi.fn>;
    openPage: ReturnType<typeof vi.fn>;
    openEditor: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
    updateWikiOptimistic: (fn: (w: WikiDto) => WikiDto) => void;
}

function makeState(wiki: WikiDto | null = WIKI): StateStub {
    const state: StateStub = {
        wiki: signal(wiki),
        wikiView: signal('home'),
        selectedPage: signal<WikiPageSummaryDto | null>(null),
        guildId: signal('g1'),
        abilities: signal(ALL_ABILITIES),
        abilitiesResolved: signal(true),
        wikiLoadFailed: signal(false),
        ownUserId: signal<string | null>('u1'),
        openHome: vi.fn(),
        openPage: vi.fn(),
        openEditor: vi.fn(),
        reload: vi.fn(),
        updateWikiOptimistic: fn => state.wiki.update(w => (w ? fn(w) : w)),
    };
    return state;
}

function wikiServiceStub() {
    return {
        updatePage: vi.fn(() => of({})),
        updateCategory: vi.fn(() => of({})),
        createCategory: vi.fn(() => of({})),
        createPage: vi.fn(() => of({})),
        getPage: vi.fn(() => of({})),
        deletePage: vi.fn(() => of({})),
        deleteCategory: vi.fn(() => of({})),
    };
}

interface Setup {
    fixture: ComponentFixture<WikiNavComponent>;
    component: WikiNavComponent;
    state: StateStub;
    wikiService: ReturnType<typeof wikiServiceStub>;
}

function setup(wiki: WikiDto | null = WIKI): Setup {
    localStorage.clear();
    TestBed.resetTestingModule();
    const state = makeState(wiki);
    const wikiService = wikiServiceStub();
    TestBed.configureTestingModule({
        imports: [WikiNavComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            MessageService,
            {provide: WikiStateService, useValue: state},
            {provide: WikiService, useValue: wikiService},
            {provide: ToastService, useValue: {error: vi.fn(), success: vi.fn(), info: vi.fn()}},
        ],
    });
    const fixture = TestBed.createComponent(WikiNavComponent);
    fixture.detectChanges();
    return {fixture, component: fixture.componentInstance, state, wikiService};
}

type Reach = Record<string, (...args: never[]) => unknown>;

function reach(component: WikiNavComponent): Reach {
    return component as unknown as Reach;
}

interface RowLike {
    kind: string;
    key: string;
    id: string;
    depth: number;
    shortcutOf?: string;
}

interface NavInternals {
    rows: () => RowLike[];
    insertLine: () => {id: string; position: string} | null;
    refusedId: () => string | null;
    dropIntoId: () => string | null;
    dragging: () => unknown;
    rovingKey: () => string | null;
    onRowDragStart: (event: DragEvent, row: RowLike) => void;
    onRowDragOver: (event: DragEvent, row: RowLike) => void;
    onRowDrop: (event: DragEvent, row: RowLike) => void;
    onRowDragEnd: () => void;
    onGlobalDrop: (event: DragEvent) => void;
    onGlobalEscape: () => void;
    onScrollerDragLeave: (event: DragEvent) => void;
    reveal: (pageId: string, focusRow?: boolean) => void;
}

function nav(component: WikiNavComponent): NavInternals {
    return component as unknown as NavInternals;
}

function rowFor(component: WikiNavComponent, key: string): RowLike {
    const row = rowsOf(component).find(r => r.key === key);
    if (!row) throw new Error(`no row ${key}`);
    return row;
}

interface FakeTransfer {
    dropEffect: string;
    effectAllowed: string;
    setData: (format: string, data: string) => void;
}

function dragEvent(type: string): DragEvent & {dataTransfer: FakeTransfer} {
    const event = new Event(type, {bubbles: true, cancelable: true});
    const dataTransfer: FakeTransfer = {dropEffect: 'move', effectAllowed: 'none', setData: () => undefined};
    Object.defineProperty(event, 'dataTransfer', {value: dataTransfer});
    Object.defineProperty(event, 'clientY', {value: 0});
    Object.defineProperty(event, 'currentTarget', {value: document.createElement('div')});
    return event as DragEvent & {dataTransfer: FakeTransfer};
}

/** One flat, ordered description of everything the nav draws. The refactor had to keep it identical. */
function snapshot(component: WikiNavComponent): string[] {
    return rowsOf(component)
        .filter(row => row.kind === 'category' || row.kind === 'page')
        .map(row => `${row.kind === 'category' ? 'cat' : 'page'}:${row.id}@${row.depth}`);
}

function rowsOf(component: WikiNavComponent): RowLike[] {
    return reach(component)['rows']() as RowLike[];
}

function shortcuts(component: WikiNavComponent): string[] {
    return rowsOf(component)
        .filter(row => row.kind === 'shortcut')
        .map(row => `${row.shortcutOf}:${row.id}`);
}

function filterOf(component: WikiNavComponent) {
    return (component as unknown as {filterText: {set: (value: string) => void}}).filterText;
}

function prefsOf(component: WikiNavComponent) {
    return (
        component as unknown as {
            prefs: {
                toggleFavourite: (id: string) => void;
                recordVisit: (id: string) => void;
                toggleCollapsed: (id: string) => void;
                load: (guildId: string) => void;
            };
        }
    ).prefs;
}

describe('WikiNavComponent tree shape', () => {
    beforeEach(() => localStore.clear());

    it('nests categories by parent and orders them by position', () => {
        const {component} = setup();

        expect(snapshot(component).filter(entry => entry.startsWith('cat:'))).toEqual([
            'cat:c1@0',
            'cat:c1a@1',
            'cat:c2@0',
        ]);
    });

    it('files every page under its own category, children indented below their parent', () => {
        const {component} = setup();

        expect(snapshot(component)).toEqual([
            'cat:c1@0',
            'page:p1@0',
            'page:p2@1',
            'cat:c1a@1',
            'page:p6@0',
            'cat:c2@0',
            'page:p3@0',
            'page:p4@0',
            'page:p5@1',
        ]);
    });

    it("drops a collapsed category's pages but keeps the category", () => {
        const {component, fixture} = setup();

        prefsOf(component).toggleCollapsed('c1');
        fixture.detectChanges();

        expect(snapshot(component)).toEqual([
            'cat:c1@0',
            'cat:c1a@1',
            'page:p6@0',
            'cat:c2@0',
            'page:p3@0',
            'page:p4@0',
            'page:p5@1',
        ]);
    });

    // A page whose parent is filed elsewhere would otherwise vanish from the tree entirely.
    it('treats a page whose parent is in another category as a root', () => {
        const orphan: WikiDto = {
            ...WIKI,
            pages: [...WIKI.pages, page('p7', 'Orphan', {categoryId: 'c2', parentPageId: 'p1'})],
        };
        const {component} = setup(orphan);

        expect(snapshot(component)).toContain('page:p7@0');
    });

    it('keeps a self-parented page at the root instead of looping', () => {
        const looped: WikiDto = {
            ...WIKI,
            pages: [...WIKI.pages, page('p8', 'Loop', {categoryId: 'c2', parentPageId: 'p8'})],
        };
        const {component} = setup(looped);

        expect(snapshot(component)).toContain('page:p8@0');
    });

    it('narrows to the matches and their ancestors when the filter is on', () => {
        const {component, fixture} = setup();

        filterOf(component).set('zeta');
        fixture.detectChanges();

        expect(snapshot(component)).toEqual(['cat:c1@0', 'cat:c1a@1', 'page:p6@0']);
    });
});

describe('WikiNavComponent shortcuts', () => {
    beforeEach(() => localStore.clear());

    it('lists favourites, then pinned, then recents', () => {
        const {component, fixture} = setup();
        const prefs = prefsOf(component);

        prefs.toggleFavourite('p1');
        prefs.recordVisit('p4');
        fixture.detectChanges();

        expect(shortcuts(component)).toEqual(['favourite:p1', 'pinned:p3', 'recent:p4']);
    });

    it('shows a page once even when it is favourite, pinned and recent at the same time', () => {
        const {component, fixture} = setup();
        const prefs = prefsOf(component);

        prefs.toggleFavourite('p3');
        prefs.recordVisit('p3');
        fixture.detectChanges();

        expect(shortcuts(component)).toEqual(['favourite:p3']);
    });

    it('drops a recent that is pinned', () => {
        const {component, fixture} = setup();

        prefsOf(component).recordVisit('p3');
        fixture.detectChanges();

        expect(shortcuts(component)).toEqual(['pinned:p3']);
    });

    it('never shows more than six', () => {
        const {component, fixture} = setup();
        const prefs = prefsOf(component);

        for (const id of ['p1', 'p2', 'p4', 'p5', 'p6']) prefs.toggleFavourite(id);
        prefs.recordVisit('p3');
        fixture.detectChanges();

        expect(shortcuts(component)).toHaveLength(6);
    });

    it('leaves out a page the filter has hidden', () => {
        const {component, fixture} = setup();

        prefsOf(component).toggleFavourite('p1');
        filterOf(component).set('zeta');
        fixture.detectChanges();

        expect(shortcuts(component)).toEqual([]);
    });
});

describe('WikiNavComponent drag and drop', () => {
    beforeEach(() => localStore.clear());

    function startDrag(component: WikiNavComponent, key: string): void {
        nav(component).onRowDragStart(dragEvent('dragstart'), rowFor(component, key));
    }

    function hover(component: WikiNavComponent, key: string): DragEvent & {dataTransfer: FakeTransfer} {
        const event = dragEvent('dragover');
        nav(component).onRowDragOver(event, rowFor(component, key));
        return event;
    }

    it('commits nothing until the pointer is released on a row', () => {
        const {component, wikiService} = setup();

        startDrag(component, 'p:p4');
        hover(component, 'c:c1');

        expect(wikiService.updatePage).not.toHaveBeenCalled();
    });

    it('files a page into the category it was dropped on', () => {
        const {component, wikiService} = setup();

        startDrag(component, 'p:p4');
        hover(component, 'c:c1');
        nav(component).onRowDrop(dragEvent('drop'), rowFor(component, 'c:c1'));

        expect(wikiService.updatePage).toHaveBeenCalledWith('g1', 'p4', {
            categoryId: 'c1',
            parentPageId: null,
        });
    });

    // The drop used to be committed in `dragend`, which fires on the source whatever the outcome.
    it('cancels on Escape mid-drag', () => {
        const {component, wikiService} = setup();

        startDrag(component, 'p:p4');
        hover(component, 'c:c1');
        nav(component).onGlobalEscape();
        nav(component).onRowDrop(dragEvent('drop'), rowFor(component, 'c:c1'));

        expect(wikiService.updatePage).not.toHaveBeenCalled();
        expect(nav(component).dragging()).toBeNull();
    });

    it('cancels on a release outside the tree', () => {
        const {component, wikiService} = setup();

        startDrag(component, 'p:p4');
        hover(component, 'c:c1');
        nav(component).onGlobalDrop(dragEvent('drop'));

        expect(wikiService.updatePage).not.toHaveBeenCalled();
        expect(nav(component).dragging()).toBeNull();
    });

    it('drops the indicator when the pointer leaves the tree', () => {
        const {component} = setup();

        startDrag(component, 'p:p4');
        hover(component, 'c:c1');
        expect(nav(component).dropIntoId()).toBe('c1');

        nav(component).onScrollerDragLeave(dragEvent('dragleave'));

        expect(nav(component).dropIntoId()).toBeNull();
    });

    it('says no to a category dropped on one with a different parent', () => {
        const {component, wikiService} = setup();

        startDrag(component, 'c:c2');
        const event = hover(component, 'c:c1a');

        expect(event.dataTransfer.dropEffect).toBe('none');
        expect(nav(component).refusedId()).toBe('c1a');

        nav(component).onRowDrop(dragEvent('drop'), rowFor(component, 'c:c1a'));
        expect(wikiService.updateCategory).not.toHaveBeenCalled();
    });

    it('says no to a page dropped on its own descendant', () => {
        const {component, wikiService} = setup();

        startDrag(component, 'p:p1');
        const event = hover(component, 'p:p2');

        expect(event.dataTransfer.dropEffect).toBe('none');
        expect(nav(component).refusedId()).toBe('p2');

        nav(component).onRowDrop(dragEvent('drop'), rowFor(component, 'p:p2'));
        expect(wikiService.updatePage).not.toHaveBeenCalled();
    });

    // Pages have no position field, so an insertion line between two of them promises an order nothing can store.
    it('draws no insertion line on a page row', () => {
        const {component} = setup();

        startDrag(component, 'p:p4');
        hover(component, 'p:p1');

        expect(nav(component).insertLine()).toBeNull();
        expect(nav(component).dropIntoId()).toBe('p1');
    });

    it('keeps the insertion line on category rows', () => {
        const {component} = setup();

        startDrag(component, 'c:c1');
        hover(component, 'c:c2');

        expect(nav(component).insertLine()?.id).toBe('c2');
    });

    it('nests a page under the page it was dropped on', () => {
        const {component, wikiService} = setup();

        startDrag(component, 'p:p4');
        hover(component, 'p:p1');
        nav(component).onRowDrop(dragEvent('drop'), rowFor(component, 'p:p1'));

        expect(wikiService.updatePage).toHaveBeenCalledWith('g1', 'p4', {
            categoryId: 'c1',
            parentPageId: 'p1',
        });
    });

    it('leaves nothing behind after a drag ends', () => {
        const {component} = setup();

        startDrag(component, 'p:p4');
        hover(component, 'c:c1');
        nav(component).onRowDragEnd();

        expect(nav(component).dragging()).toBeNull();
        expect(nav(component).dropIntoId()).toBeNull();
        expect(nav(component).refusedId()).toBeNull();
    });
});

describe('WikiNavComponent reveal and keyboard', () => {
    beforeEach(() => localStore.clear());

    it('un-collapses the category holding the page that was opened elsewhere', () => {
        const {component, fixture, state} = setup();
        prefsOf(component).toggleCollapsed('c1');
        fixture.detectChanges();
        expect(snapshot(component)).not.toContain('page:p1@0');

        state.selectedPage.set(WIKI.pages[0]);
        fixture.detectChanges();

        expect(snapshot(component)).toContain('page:p1@0');
    });

    it('marks the open page as the current one', () => {
        const {fixture, state} = setup();

        state.wikiView.set('page');
        state.selectedPage.set(WIKI.pages[0]);
        fixture.detectChanges();

        const current = fixture.nativeElement.querySelectorAll('[aria-current="page"]');
        expect(current).toHaveLength(1);
        expect(current[0].getAttribute('data-row')).toBe('p:p1');
    });

    it('is one tab stop, not one per row', () => {
        const {fixture} = setup();

        const stops = fixture.nativeElement.querySelectorAll('[role="treeitem"][tabindex="0"]');
        expect(stops).toHaveLength(1);
    });

    it('gives every row a level and every category an expanded state', () => {
        const {fixture} = setup();

        const nested: HTMLElement = fixture.nativeElement.querySelector('[data-row="c:c1a"]');
        expect(nested.getAttribute('aria-level')).toBe('2');
        expect(nested.getAttribute('aria-expanded')).toBe('true');
    });

    it('shows the skeleton while the tree has not answered yet', () => {
        const {fixture} = setup(null);

        expect(fixture.nativeElement.querySelector('[role="status"]')).not.toBeNull();
    });

    it('reports a failed load instead of an empty wiki, and keeps a way to retry', () => {
        const {fixture, state} = setup(null);
        state.wikiLoadFailed.set(true);
        fixture.detectChanges();

        // A failed first load also leaves `wiki` null, so the skeleton must give way to the failure.
        expect(fixture.nativeElement.querySelector('[role="status"]')).toBeNull();
        expect(fixture.nativeElement.textContent).toContain('WIKI.NAV.LOAD_FAILED');
        expect(fixture.nativeElement.textContent).not.toContain('WIKI.NAV.EMPTY');
    });

    it('says the wiki is empty when the tree answered with no pages', () => {
        const {fixture} = setup({...WIKI, categories: [], pages: []});

        expect(fixture.nativeElement.textContent).toContain('WIKI.NAV.EMPTY');
        expect(fixture.nativeElement.textContent).not.toContain('WIKI.NAV.LOAD_FAILED');
    });
});
