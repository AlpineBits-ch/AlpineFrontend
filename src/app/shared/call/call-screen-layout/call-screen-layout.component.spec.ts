import {ComponentFixture, TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {CallScreenLayoutComponent} from './call-screen-layout.component';
import {CallScreenShare} from '../call.types';
import {ShareWatchService} from '../../../services/share-watch.service';

function share(shareId: string, isLocal = false): CallScreenShare {
    return {
        shareId,
        userId: isLocal ? 'me' : `user-${shareId}`,
        displayName: isLocal ? 'You' : shareId,
        isLocal,
    };
}

function setup(shares: CallScreenShare[]) {
    TestBed.configureTestingModule({
        imports: [CallScreenLayoutComponent],
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

    const fixture: ComponentFixture<CallScreenLayoutComponent> = TestBed.createComponent(CallScreenLayoutComponent);
    fixture.componentRef.setInput('screenShares', shares);
    fixture.componentRef.setInput('participants', []);
    fixture.componentRef.setInput('participantsWithAudio', new Set<string>());
    fixture.detectChanges();

    // Reaching into protected members: they are the whole behaviour of this component, and the
    // alternative is asserting on tile counts in rendered markup.
    return fixture.componentInstance as unknown as {
        displayedShares: () => CallScreenShare[];
        selfCard: () => CallScreenShare | null;
        gridClass: () => string;
        maximizedId: {set: (id: string | null) => void};
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
