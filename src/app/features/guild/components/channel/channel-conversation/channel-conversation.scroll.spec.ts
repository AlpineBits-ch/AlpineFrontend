/**
 * Characterization of scrolling and message windowing. The mechanics live in MessageScrollService;
 * what is pinned here is the component's wiring to it. The scroll element is a stub throughout:
 * jsdom reports every geometry as 0.
 */
import {describe, expect, it} from 'vitest';

import {attachScroll, scrollInnards, setup, stubScrollRef} from './channel-conversation.harness';

const ANCHORED = {chan1: {offset: 0, hasMore: false, anchored: true, hasNewer: true}};

describe('ChannelConversationComponent entering a channel', () => {
    it('opens an ordinary channel at its newest message', async () => {
        const {component} = await setup();

        const ref = stubScrollRef(component, {scrollTop: 0, scrollHeight: 900, clientHeight: 300});

        component.ngAfterViewInit();

        expect(ref.nativeElement.scrollTop).toBe(900);
    });

    it('leaves the scroll alone while anchored, so the window opens at its first message', async () => {
        const {fixture, component, store} = await setup('ok', [], 'chan1');

        const el = attachScroll(component, {scrollTop: 42, scrollHeight: 900});

        store.channelMeta.set(ANCHORED);
        fixture.detectChanges();

        scrollInnards(component).scroll.scrollToBottom();

        expect(el.scrollTop).toBe(42);
    });

    it('still scrolls to the bottom of an ordinary window', async () => {
        const {fixture, component, store} = await setup();

        const el = attachScroll(component, {scrollTop: 42, scrollHeight: 900});

        store.channelMeta.set({chan1: {offset: 0, hasMore: false}});
        fixture.detectChanges();

        scrollInnards(component).scroll.scrollToBottom();

        expect(el.scrollTop).toBe(900);
    });

    it('drops the anchor when the channel view goes away', async () => {
        const {fixture, store} = await setup('ok', [], 'chan1');

        fixture.destroy();

        expect(store.clearChannelAnchor).toHaveBeenCalledWith('chan1');
    });
});

describe('ChannelConversationComponent reading older messages', () => {
    it('reads the next page back once the reader nears the top', async () => {
        const {component, store} = await setup('ok', [], null, {
            channelMeta: {chan1: {hasMore: true}},
        });

        attachScroll(component, {scrollTop: 399, scrollHeight: 2000, clientHeight: 500});

        scrollInnards(component).onScroll();

        expect(store.loadMoreForChannel).toHaveBeenCalledWith('chan1');
    });

    it('waits until the reader is within 400px of the top', async () => {
        const {component, store} = await setup('ok', [], null, {channelMeta: {chan1: {hasMore: true}}});

        attachScroll(component, {scrollTop: 400, scrollHeight: 2000, clientHeight: 500});

        scrollInnards(component).onScroll();

        expect(store.loadMoreForChannel).not.toHaveBeenCalled();
    });

    it('does not read again while a page is already in flight', async () => {
        const {component, store} = await setup('ok', [], null, {
            channelMeta: {chan1: {hasMore: true, loadingMore: true}},
        });

        attachScroll(component, {scrollTop: 0, scrollHeight: 2000, clientHeight: 500});

        scrollInnards(component).onScroll();

        expect(store.loadMoreForChannel).not.toHaveBeenCalled();
    });

    it('does not read past the beginning of the channel', async () => {
        const {component, store} = await setup('ok', [], null, {channelMeta: {chan1: {hasMore: false}}});

        attachScroll(component, {scrollTop: 0, scrollHeight: 2000, clientHeight: 500});

        scrollInnards(component).onScroll();

        expect(store.loadMoreForChannel).not.toHaveBeenCalled();
    });
});

describe('ChannelConversationComponent reading forward from an anchored window', () => {
    it('does not walk an anchored window forward when it does not fill the pane', async () => {
        const {fixture, component, store} = await setup('ok', [], 'chan1');

        // Shorter than the pane, so there is nothing to scroll and the reader has asked for nothing.
        attachScroll(component, {scrollTop: 0, scrollHeight: 300, clientHeight: 400});

        store.channelMeta.set(ANCHORED);
        fixture.detectChanges();

        scrollInnards(component).onScroll();

        expect(store.loadNewerForChannel).not.toHaveBeenCalled();
    });

    it('reads newer once the reader scrolls to the end of an anchored window', async () => {
        const {fixture, component, store} = await setup('ok', [], 'chan1');

        attachScroll(component, {scrollTop: 1800, scrollHeight: 2000, clientHeight: 200});

        store.channelMeta.set(ANCHORED);
        fixture.detectChanges();

        scrollInnards(component).onScroll();

        expect(store.loadNewerForChannel).toHaveBeenCalledWith('chan1');
    });

    it('holds while the reader is still short of the end of the window', async () => {
        const {fixture, component, store} = await setup('ok', [], 'chan1');

        attachScroll(component, {scrollTop: 1000, scrollHeight: 2000, clientHeight: 200});

        store.channelMeta.set(ANCHORED);
        fixture.detectChanges();

        scrollInnards(component).onScroll();

        expect(store.loadNewerForChannel).not.toHaveBeenCalled();
    });

    it('never reads forward in an ordinary window, which already ends at the present', async () => {
        const {component, store} = await setup('ok', [], null, {
            channelMeta: {chan1: {hasNewer: true}},
        });

        attachScroll(component, {scrollTop: 1800, scrollHeight: 2000, clientHeight: 200});

        scrollInnards(component).onScroll();

        expect(store.loadNewerForChannel).not.toHaveBeenCalled();
    });
});

describe('ChannelConversationComponent jump to present', () => {
    it('drops the anchor and reads the newest page instead of scrolling', async () => {
        const {fixture, component, store} = await setup('ok', [], 'chan1');

        const el = attachScroll(component, {scrollTop: 0, scrollHeight: 2000, clientHeight: 500});

        store.channelMeta.set(ANCHORED);
        fixture.detectChanges();

        scrollInnards(component).jumpToPresent();

        expect(store.clearChannelAnchor).toHaveBeenCalledWith('chan1');
        expect(store.loadForChannel).toHaveBeenCalledWith('chan1');
        expect(el.scrollTo).not.toHaveBeenCalled();
    });

    it('scrolls an ordinary window to the end, cutting the long part of the trip', async () => {
        const {component, store} = await setup();

        const el = attachScroll(component, {scrollTop: 0, scrollHeight: 2000, clientHeight: 500});

        scrollInnards(component).jumpToPresent();

        expect(el.scrollTop).toBe(900);
        expect(el.scrollTo).toHaveBeenCalledWith({top: 1500, behavior: 'smooth'});
        expect(store.clearChannelAnchor).not.toHaveBeenCalled();
    });

    it('animates the whole way when the present is close', async () => {
        const {component} = await setup();

        const el = attachScroll(component, {scrollTop: 1000, scrollHeight: 2000, clientHeight: 500});

        scrollInnards(component).jumpToPresent();

        expect(el.scrollTop).toBe(1000);
        expect(el.scrollTo).toHaveBeenCalledWith({top: 1500, behavior: 'smooth'});
    });
});
