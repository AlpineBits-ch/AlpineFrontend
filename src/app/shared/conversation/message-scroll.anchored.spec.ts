import {TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {MessageScrollService} from './message-scroll.service';

/** Scroll container stub: jsdom reports every metric as 0, so the geometry is assigned outright. */
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

describe('MessageScrollService anchored window', () => {
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

    it('leaves the scroll position alone on scrollToBottom', () => {
        const el = container(5000, 200);
        service.attach(asEl(el));
        service.setAnchored(true);

        service.scrollToBottom();

        expect(el.scrollTop).toBe(200);
    });

    it('scrolls to the bottom again once the anchor is dropped', () => {
        const el = container(5000, 200);
        service.attach(asEl(el));
        service.setAnchored(true);
        service.setAnchored(false);

        service.scrollToBottom();

        expect(el.scrollTop).toBe(5000);
    });

    it('does not scroll on render while anchored', () => {
        const el = container(5000, 200);
        service.attach(asEl(el));
        service.setAnchored(true);
        service.onMessagesChanged('channel-a');

        service.onRender(undefined, asEl(el));

        expect(el.scrollTop).toBe(200);
    });

    it('loads newer messages once the bottom comes into range', () => {
        const el = container(5000, 4300);
        service.attach(asEl(el));
        service.setAnchored(true);
        const onLoadNewer = vi.fn();

        service.onScroll({hasMore: false, loadingMore: false, onLoadMore: () => {}, onLoadNewer});

        expect(onLoadNewer).toHaveBeenCalledOnce();
    });

    it('does not page forward from a window shorter than the pane', () => {
        const el = container(400, 0);
        service.attach(asEl(el));
        service.setAnchored(true);
        const onLoadNewer = vi.fn();

        service.onScroll({hasMore: false, loadingMore: false, onLoadMore: () => {}, onLoadNewer});

        expect(onLoadNewer).not.toHaveBeenCalled();
    });

    it('pages forward from a window that exactly fills the pane', () => {
        const el = container(600, 0);
        service.attach(asEl(el));
        service.setAnchored(true);
        const onLoadNewer = vi.fn();

        service.onScroll({hasMore: false, loadingMore: false, onLoadMore: () => {}, onLoadNewer});

        expect(onLoadNewer).toHaveBeenCalledOnce();
    });

    it('reads forward once for a burst of scroll events', () => {
        const el = container(5000, 4300);
        service.attach(asEl(el));
        service.setAnchored(true);
        const onLoadNewer = vi.fn();
        const opts = {hasMore: false, loadingMore: false, onLoadMore: () => {}, onLoadNewer};

        service.onScroll(opts);
        service.onScroll(opts);
        service.onScroll(opts);

        expect(onLoadNewer).toHaveBeenCalledOnce();
    });

    it('reads forward again once that page has landed', () => {
        const el = container(5000, 4300);
        service.attach(asEl(el));
        service.setAnchored(true);
        const onLoadNewer = vi.fn();
        const opts = {hasMore: false, loadingMore: false, onLoadMore: () => {}, onLoadNewer};

        service.onScroll(opts);
        service.onMessagesChanged('chan-a');
        service.onScroll(opts);

        expect(onLoadNewer).toHaveBeenCalledTimes(2);
    });

    it('reads nothing before a container is attached', () => {
        service.setAnchored(true);
        const onLoadMore = vi.fn();
        const onLoadNewer = vi.fn();

        service.onScroll({hasMore: true, loadingMore: false, onLoadMore, onLoadNewer});

        expect(onLoadMore).not.toHaveBeenCalled();
        expect(onLoadNewer).not.toHaveBeenCalled();
    });

    it('never pages forward from an unanchored window', () => {
        const el = container(5000, 4300);
        service.attach(asEl(el));
        const onLoadNewer = vi.fn();

        service.onScroll({hasMore: false, loadingMore: false, onLoadMore: () => {}, onLoadNewer});

        expect(onLoadNewer).not.toHaveBeenCalled();
    });

    it('still pages backwards while anchored', () => {
        const el = container(5000, 100);
        service.attach(asEl(el));
        service.setAnchored(true);
        const onLoadMore = vi.fn();
        const onLoadNewer = vi.fn();

        service.onScroll({hasMore: true, loadingMore: false, onLoadMore, onLoadNewer});

        expect(onLoadMore).toHaveBeenCalledOnce();
        expect(onLoadNewer).not.toHaveBeenCalled();
    });

    it('refuses jump-to-present so the caller can drop the anchor instead', () => {
        const el = container(9000, 1000);
        service.attach(asEl(el));
        service.setAnchored(true);

        expect(service.jumpToPresent()).toBe(false);
        expect(el.scrollTop).toBe(1000);
        expect(el.scrollTo).not.toHaveBeenCalled();
    });

    it('lowers the jump pill when it refuses, since the caller is leaving the window', () => {
        const el = container(9000, 1000);
        service.attach(asEl(el));
        service.setAnchored(true);
        service.onScroll({hasMore: false, loadingMore: false, onLoadMore: () => {}});
        expect(service.isViewingOlder()).toBe(true);

        service.jumpToPresent();

        expect(service.isViewingOlder()).toBe(false);
    });

    it('pins the reloaded page to the bottom after it refuses', () => {
        const el = container(9000, 1000);
        service.attach(asEl(el));
        service.setAnchored(true);
        service.onMessagesChanged('chan-a');
        service.onScroll({hasMore: false, loadingMore: false, onLoadMore: () => {}});

        service.jumpToPresent();
        service.setAnchored(false);
        service.onMessagesChanged('chan-a');
        service.onRender(undefined, asEl(el));

        expect(el.scrollTop).toBe(9000);
    });

    it('reports a jump-to-present it performed', () => {
        const el = container(9000, 8200);
        service.attach(asEl(el));

        expect(service.jumpToPresent()).toBe(true);
    });
});
