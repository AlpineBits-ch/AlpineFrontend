import {TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {ConversationScrollService} from './conversation-scroll.service';

/** Scroll container stub: only the three metrics the service measures, plus the scroll methods it calls. */
interface StubEl {
    scrollHeight: number;
    scrollTop: number;
    clientHeight: number;
    scrollTo: ReturnType<typeof vi.fn>;
    querySelector: () => null;
}

function container(scrollHeight: number, scrollTop: number, clientHeight = 600): StubEl {
    return {scrollHeight, scrollTop, clientHeight, scrollTo: vi.fn(), querySelector: () => null};
}

function asEl(el: StubEl): HTMLDivElement {
    return el as unknown as HTMLDivElement;
}

describe('ConversationScrollService viewing-older state', () => {
    let service: ConversationScrollService;

    beforeEach(() => {
        globalThis.ResizeObserver ??= class {
            observe() {}
            unobserve() {}
            disconnect() {}
        } as unknown as typeof ResizeObserver;

        TestBed.configureTestingModule({providers: [ConversationScrollService]});
        service = TestBed.inject(ConversationScrollService);
    });

    it('stays down while the newest message is still close', () => {
        const el = container(5000, 4200);
        service.attach(asEl(el));

        service.onScroll(false, false, () => {});

        expect(service.isViewingOlder()).toBe(false);
    });

    it('raises once scrolled well past the bottom', () => {
        const el = container(5000, 3000);
        service.attach(asEl(el));

        service.onScroll(false, false, () => {});

        expect(service.isViewingOlder()).toBe(true);
    });

    it('clears on a conversation switch', () => {
        const el = container(5000, 3000);
        service.attach(asEl(el));
        service.onScroll(false, false, () => {});

        service.onConversationSwitch();

        expect(service.isViewingOlder()).toBe(false);
    });

    it('raises when new messages grow the list without a scroll event', () => {
        const el = container(1000, 300);
        service.attach(asEl(el));
        service.onScroll(false, false, () => {});
        expect(service.isViewingOlder()).toBe(false);

        el.scrollHeight = 4000;
        service.onRender(undefined, asEl(el));

        expect(service.isViewingOlder()).toBe(true);
    });

    it('hard-cuts to just above the bottom before animating a long jump', () => {
        const el = container(9000, 1000);
        service.attach(asEl(el));

        service.jumpToPresent();

        expect(el.scrollTop).toBe(9000 - 600 - 600);
        expect(el.scrollTo).toHaveBeenCalledWith({top: 8400, behavior: 'smooth'});
    });

    it('animates the whole way when already close', () => {
        const el = container(9000, 8200);
        service.attach(asEl(el));

        service.jumpToPresent();

        expect(el.scrollTop).toBe(8200);
        expect(el.scrollTo).toHaveBeenCalledWith({top: 8400, behavior: 'smooth'});
    });
});
