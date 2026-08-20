import {TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {MessageScrollService} from './message-scroll.service';

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

describe('MessageScrollService viewing-older state', () => {
    let service: MessageScrollService;

    beforeEach(() => {
        globalThis.ResizeObserver ??= class {
            observe() {}
            unobserve() {}
            disconnect() {}
        } as unknown as typeof ResizeObserver;

        TestBed.configureTestingModule({providers: [MessageScrollService]});
        service = TestBed.inject(MessageScrollService);
    });

    /** A channel opened and settled at its newest message, which is where the reader starts. */
    function opened(scrollHeight: number, clientHeight: number): StubEl {
        const el = container(scrollHeight, 0, clientHeight);
        service.attach(asEl(el));
        service.onMessagesChanged('chan-a');
        service.onRender(undefined, asEl(el));
        return el;
    }

    it('stays down while the newest message is still close', () => {
        const el = container(5000, 4200);
        service.attach(asEl(el));

        service.onScroll({hasMore: false, loadingMore: false, onLoadMore: () => {}});

        expect(service.isViewingOlder()).toBe(false);
    });

    it('raises once scrolled well past the bottom', () => {
        const el = container(5000, 3000);
        service.attach(asEl(el));

        service.onScroll({hasMore: false, loadingMore: false, onLoadMore: () => {}});

        expect(service.isViewingOlder()).toBe(true);
    });

    it('clears on a conversation switch', () => {
        const el = container(5000, 3000);
        service.attach(asEl(el));
        service.onMessagesChanged('conv-a');
        service.onScroll({hasMore: false, loadingMore: false, onLoadMore: () => {}});

        service.onMessagesChanged('conv-b');

        expect(service.isViewingOlder()).toBe(false);
    });

    it('holds the state while the same conversation gets new messages', () => {
        const el = container(5000, 3000);
        service.attach(asEl(el));
        service.onMessagesChanged('conv-a');
        service.onScroll({hasMore: false, loadingMore: false, onLoadMore: () => {}});

        service.onMessagesChanged('conv-a');

        expect(service.isViewingOlder()).toBe(true);
    });

    it('raises when new messages grow the list without a scroll event', () => {
        const el = container(1000, 300);
        service.attach(asEl(el));
        service.onScroll({hasMore: false, loadingMore: false, onLoadMore: () => {}});
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

    it('loads older messages once the top comes into range', () => {
        const el = container(5000, 100);
        service.attach(asEl(el));
        const onLoadMore = vi.fn();

        service.onScroll({hasMore: true, loadingMore: false, onLoadMore});

        expect(onLoadMore).toHaveBeenCalledOnce();
    });

    it('holds the reader in place when the older page arrives', () => {
        const el = container(2000, 0);
        service.attach(asEl(el));
        service.onScroll({hasMore: true, loadingMore: false, onLoadMore: () => {}});

        el.scrollHeight = 3200;
        service.onRender(undefined, asEl(el));

        expect(el.scrollTop).toBe(1200);
    });

    it('counts under 100px from the bottom as sitting at the present', () => {
        const el = opened(2000, 500);

        el.scrollTop = 1401;
        service.onScroll({hasMore: false, loadingMore: false, onLoadMore: () => {}});
        service.onMessagesChanged('chan-a');
        service.onRender(undefined, asEl(el));

        expect(el.scrollTop).toBe(2000);
    });

    it('counts 100px from the bottom as having left the present', () => {
        const el = opened(2000, 500);

        el.scrollTop = 1400;
        service.onScroll({hasMore: false, loadingMore: false, onLoadMore: () => {}});
        service.onMessagesChanged('chan-a');
        service.onRender(undefined, asEl(el));

        expect(el.scrollTop).toBe(1400);
    });

    it('raises the jump pill past 500px from the bottom', () => {
        const el = container(2000, 999, 500);
        service.attach(asEl(el));

        service.onScroll({hasMore: false, loadingMore: false, onLoadMore: () => {}});

        expect(service.isViewingOlder()).toBe(true);
    });

    it('leaves the jump pill down at exactly 500px from the bottom', () => {
        const el = container(2000, 1000, 500);
        service.attach(asEl(el));

        service.onScroll({hasMore: false, loadingMore: false, onLoadMore: () => {}});

        expect(service.isViewingOlder()).toBe(false);
    });
});
