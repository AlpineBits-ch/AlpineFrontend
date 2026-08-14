import {ComponentFixture, TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallScreenLayoutComponent} from './call-screen-layout.component';
import {CallScreenShare} from '../call.types';
import {ShareWatchService, WatchScope, scopeKey} from '../../../services/share-watch.service';
import {CallFocusService} from '../../../services/call-focus.service';

function share(shareId: string, isLocal = false): CallScreenShare {
    return {
        shareId,
        userId: isLocal ? 'me' : `user-${shareId}`,
        displayName: isLocal ? 'You' : shareId,
        isLocal,
    };
}

/** viewersOf() implementations the tests below plug in - default is the empty-scope case. */
function setup(
    shares: CallScreenShare[],
    watchScope: WatchScope | null = null,
    viewersOf: (scope: WatchScope, shareId: string) => string[] = () => [],
    nameOf?: (userId: string) => string,
) {
    TestBed.configureTestingModule({
        // The layout renders translated tiles now, so it needs a TranslateService to resolve them.
        imports: [CallScreenLayoutComponent, TranslateModule.forRoot()],
        providers: [
            {
                provide: ShareWatchService,
                useValue: {
                    setWatching: vi.fn(),
                    refresh: vi.fn(),
                    clear: vi.fn(),
                    viewerCount: () => 0,
                    viewersOf,
                },
            },
        ],
    });

    const fixture: ComponentFixture<CallScreenLayoutComponent> = TestBed.createComponent(CallScreenLayoutComponent);
    fixture.componentRef.setInput('screenShares', shares);
    fixture.componentRef.setInput('participants', []);
    fixture.componentRef.setInput('participantsWithAudio', new Set<string>());
    if (watchScope) fixture.componentRef.setInput('watchScope', watchScope);
    if (nameOf) fixture.componentRef.setInput('nameOf', nameOf);
    fixture.detectChanges();

    // Reaching into protected members: they are the whole behaviour of this component, and the
    // alternative is asserting on tile counts in rendered markup.
    return fixture.componentInstance as unknown as {
        displayedShares: () => CallScreenShare[];
        selfCard: () => CallScreenShare | null;
        gridClass: () => string;
        maximizedId: {(): string | null; set: (id: string | null) => void};
        toggleGridFocus: () => void;
        viewerNames: (shareId: string) => string[];
    };
}

describe('CallScreenLayoutComponent share placement', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('gives your own stream the grid when nobody else is sharing', () => {
        // Alone, the local preview is the only thing there is to show - demoting it would leave an
        // empty layout with a thumbnail in the corner.
        const layout = setup([share('mine', true)]);

        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['mine']);
        expect(layout.selfCard()).toBeNull();
    });

    it('drops your own stream out of the grid once somebody else shares', () => {
        // The local preview is a low-rate thumbnail of a screen already in front of you. At full
        // tile size it reads as a broken stream, and it was taking half the room from the stream
        // actually worth watching.
        const layout = setup([share('mine', true), share('theirs')]);

        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['theirs']);
        expect(layout.selfCard()?.shareId).toBe('mine');
    });

    it('keeps every remote stream in the grid', () => {
        const layout = setup([share('mine', true), share('a'), share('b')]);

        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['a', 'b']);
    });

    it('shows only the maximised stream, self-card included', () => {
        const layout = setup([share('mine', true), share('theirs')]);

        layout.maximizedId.set('mine');

        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['mine']);
        expect(layout.selfCard()).toBeNull();
    });

    it('lays one stream out full width', () => {
        expect(setup([share('a')]).gridClass()).toBe('grid-cols-1');
    });

    it('pairs two', () => {
        expect(setup([share('a'), share('b')]).gridClass()).toBe('grid-cols-2');
    });

    it('still pairs at four', () => {
        expect(setup([share('a'), share('b'), share('c'), share('d')]).gridClass()).toBe('grid-cols-2');
    });

    it('goes to three columns past four, rather than stranding a tile', () => {
        const layout = setup([share('a'), share('b'), share('c'), share('d'), share('e')]);

        expect(layout.gridClass()).toBe('grid-cols-3');
    });

    it('counts columns from what is displayed, not from what exists', () => {
        // Your own share is not in the grid, so it must not widen it either.
        const layout = setup([share('mine', true), share('theirs')]);

        expect(layout.gridClass()).toBe('grid-cols-1');
    });
});

describe('CallScreenLayoutComponent grid/focus toggle', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('focuses the first displayed share when toggled from the grid', () => {
        // There is no single "the" share to focus from the grid without a specific tile having
        // been picked - this is the coarse entry point; a double-click on a particular tile is the
        // precise one (see call-share-tile.component.html).
        const layout = setup([share('a'), share('b'), share('c')]);

        layout.toggleGridFocus();

        expect(layout.maximizedId()).toBe('a');
    });

    it('clears back to the grid when toggled while a share is maximised', () => {
        const layout = setup([share('a'), share('b')]);
        layout.maximizedId.set('b');

        layout.toggleGridFocus();

        expect(layout.maximizedId()).toBeNull();
    });
});

describe('CallScreenLayoutComponent focus requests', () => {
    const scope: WatchScope = {kind: 'call', callId: 'call-1'};

    beforeEach(() => {
        TestBed.resetTestingModule();
        TestBed.configureTestingModule({
            imports: [CallScreenLayoutComponent, TranslateModule.forRoot()],
            providers: [
                {
                    provide: ShareWatchService,
                    useValue: {
                        setWatching: vi.fn(),
                        refresh: vi.fn(),
                        clear: vi.fn(),
                        viewerCount: () => 0,
                        viewersOf: () => [],
                    },
                },
            ],
        });
    });

    /**
     * Creates the layout for `scope` against whatever CallFocusService request the test armed
     * beforehand - request() has to land before the layout exists, exactly the ordering a real
     * caller (a notification action, click-to-watch) cannot control either, since the layout for the
     * scope it cares about may not have been created yet.
     */
    function createLayout(shares: CallScreenShare[]) {
        const fixture: ComponentFixture<CallScreenLayoutComponent> = TestBed.createComponent(CallScreenLayoutComponent);
        fixture.componentRef.setInput('screenShares', shares);
        fixture.componentRef.setInput('participants', []);
        fixture.componentRef.setInput('participantsWithAudio', new Set<string>());
        fixture.componentRef.setInput('watchScope', scope);
        fixture.detectChanges();

        return fixture.componentInstance as unknown as {displayedShares: () => CallScreenShare[]};
    }

    it('maximizes the share belonging to a requested user id', () => {
        TestBed.inject(CallFocusService).request(scopeKey(scope), {userId: 'user-b'});

        const layout = createLayout([share('mine', true), share('a'), share('b')]);

        // Resolved through getShareForUser: the caller only knew whose stream to focus, not its
        // share id.
        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['b']);
    });

    it('ignores a request armed for a different scope', () => {
        // Armed for a call this layout is not showing - a request meant for another surface must
        // not leak into whichever layout happens to run its effect first.
        TestBed.inject(CallFocusService).request('call:some-other-call', {userId: 'user-a'});

        const layout = createLayout([share('a'), share('b')]);

        expect(layout.displayedShares().map(s => s.shareId)).toEqual(['a', 'b']);
    });
});

describe('CallScreenLayoutComponent viewer names', () => {
    const scope: WatchScope = {kind: 'call', callId: 'call-1'};
    const roster: Record<string, string> = {'user-x': 'Xena', 'user-y': 'Yara'};

    beforeEach(() => TestBed.resetTestingModule());

    it('maps viewer ids through the given name resolver', () => {
        const layout = setup(
            [share('a')],
            scope,
            (_, shareId) => shareId === 'a' ? ['user-x', 'user-y'] : [],
            id => roster[id] ?? id,
        );

        expect(layout.viewerNames('a')).toEqual(['Xena', 'Yara']);
    });

    it('falls back to echoing the id when no resolver is wired', () => {
        // The default a host that forgets to pass nameOf gets - see the nameOf doc comment. Real
        // hosts always wire one; this only proves the fallback does not throw or silently drop ids.
        const layout = setup([share('a')], scope, (_, shareId) => shareId === 'a' ? ['user-x'] : []);

        expect(layout.viewerNames('a')).toEqual(['user-x']);
    });

    it('returns no names without a watch scope, regardless of what viewersOf would say', () => {
        const layout = setup([share('a')], null, () => ['user-x']);

        expect(layout.viewerNames('a')).toEqual([]);
    });
});
