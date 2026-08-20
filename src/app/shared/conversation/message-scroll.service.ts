import {DestroyRef, inject, Injectable, signal} from '@angular/core';

const SCROLL_BOTTOM_THRESHOLD = 100;
const LOAD_MORE_THRESHOLD = 400;
const VIEWING_OLDER_THRESHOLD = 500;
const SMOOTH_JUMP_DISTANCE = 600;

export interface ScrollLoadOptions {
    hasMore: boolean;
    loadingMore: boolean;
    onLoadMore: () => void;
    /** Only called while anchored: an ordinary window already ends at the present. */
    onLoadNewer?: () => void;
}

/**
 * Manages all scroll mechanics for a message list:
 * - Scroll-to-bottom on new messages / conversation switch
 * - Scroll-position restoration after loading older messages
 * - ResizeObserver on the message list to keep the view pinned to bottom
 * - Jump-to-message with highlight
 *
 * Component-scoped: each list needs its own instance.
 */
@Injectable()
export class MessageScrollService {
    /** Drives the jump-to-present pill. Further from the bottom than isNearBottom, so a small nudge does not raise it. */
    readonly isViewingOlder = signal(false);
    private isNearBottom = true;
    private savedScrollHeight = 0;
    private restoreScroll = false;
    private pendingScrollToBottom = false;
    private anchored = false;
    private loadingNewer = false;
    private lastConversationId = '';
    private scrollEl?: HTMLDivElement;
    private observedListEl?: HTMLDivElement;
    private contentObserver = new ResizeObserver(() => {
        if (this.isNearBottom && this.scrollEl) this.scrollToBottom();
    });

    constructor() {
        inject(DestroyRef).onDestroy(() => {
            this.contentObserver.disconnect();
            this.observedListEl?.removeEventListener('load', this.onContentLoad, true);
        });
    }

    /** Bind the scroll container element. Call once from ngAfterViewInit. */
    attach(el: HTMLDivElement): void {
        this.scrollEl = el;
    }

    /** An anchored window opens at the first message and does not hold the present, so its bottom is the wrong end. */
    setAnchored(anchored: boolean): void {
        this.anchored = anchored;
    }

    /** Call whenever the message list updates, with the id of the conversation or channel it belongs to. */
    onMessagesChanged(conversationId: string): void {
        if (conversationId !== this.lastConversationId) {
            this.lastConversationId = conversationId;
            this.reset();
        }
        // The page landing is the only signal a forward read finished.
        this.loadingNewer = false;
        if (this.isNearBottom) this.pendingScrollToBottom = true;
    }

    /** Wire to the scroll container's (scroll) DOM event. */
    onScroll(opts: ScrollLoadOptions): void {
        const el = this.scrollEl;
        if (!el) return;

        const fromBottom = this.measure(el);

        if (el.scrollTop < LOAD_MORE_THRESHOLD && opts.hasMore && !opts.loadingMore) {
            this.savedScrollHeight = el.scrollHeight;
            this.restoreScroll = true;
            opts.onLoadMore();
        }

        // A window shorter than the pane sits at its own end from the first paint, so without this
        // it reads page after page and walks the reader to the present they asked to start behind.
        const filledPane = el.scrollHeight >= el.clientHeight;

        if (
            this.anchored &&
            opts.onLoadNewer &&
            !this.loadingNewer &&
            filledPane &&
            fromBottom < LOAD_MORE_THRESHOLD
        ) {
            this.loadingNewer = true;
            opts.onLoadNewer();
        }
    }

    /** Call from afterEveryRender. Handles scroll restoration and keeps the ResizeObserver current.
     *  Pass scrollEl to keep the container reference current after conditional re-renders. */
    onRender(messageListEl?: HTMLDivElement, scrollEl?: HTMLDivElement): void {
        // Keep reference current: the @else block recreates the element after error→retry.
        if (scrollEl) this.scrollEl = scrollEl;

        const el = this.scrollEl;
        if (!el) return;

        if (this.restoreScroll) {
            const diff = el.scrollHeight - this.savedScrollHeight;
            if (diff > 0) el.scrollTop += diff;
            this.restoreScroll = false;
            this.savedScrollHeight = 0;
        } else if (this.pendingScrollToBottom) {
            this.scrollToBottom();
            this.pendingScrollToBottom = false;
        }

        // New messages arriving while scrolled up grow the list without firing a scroll event.
        this.measure(el);

        // Keep observer pointed at the current message list element: it
        // appears/disappears as search mode and error states are toggled.
        if (messageListEl !== this.observedListEl) {
            this.contentObserver.disconnect();
            this.observedListEl?.removeEventListener('load', this.onContentLoad, true);
            this.observedListEl = messageListEl;
            if (messageListEl) {
                this.contentObserver.observe(messageListEl);
                messageListEl.addEventListener('load', this.onContentLoad, {capture: true, passive: true});
            }
        }
    }

    /** Every auto-scroll path funnels through here, which is what makes the anchored guard hold. */
    scrollToBottom(): void {
        if (!this.scrollEl || this.anchored) return;
        this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
        // Mark as near-bottom so the ResizeObserver keeps scrolling for late-loading content.
        this.isNearBottom = true;
        this.isViewingOlder.set(false);
    }

    /** Jump-to-present. Anything further up hard-cuts first, so the animated part is the same length from any depth.
     *  Answers false without scrolling while anchored: the present is not in the window for the caller to scroll to. */
    jumpToPresent(): boolean {
        if (this.anchored) {
            // The caller reloads at the present, so the pill drops now and the new page lands at the bottom.
            this.isNearBottom = true;
            this.isViewingOlder.set(false);
            return false;
        }

        const el = this.scrollEl;
        if (!el) return false;
        const target = el.scrollHeight - el.clientHeight;
        if (target - el.scrollTop > SMOOTH_JUMP_DISTANCE) el.scrollTop = target - SMOOTH_JUMP_DISTANCE;
        el.scrollTo({top: target, behavior: 'smooth'});
        return true;
    }

    /** Scroll to and briefly highlight a message by its ID. */
    jumpToMessage(messageId: string): void {
        if (!this.scrollEl) return;
        const el = this.scrollEl.querySelector(`[data-message-id="${messageId}"]`);
        if (el) {
            el.scrollIntoView({behavior: 'smooth', block: 'center'});
            el.classList.add('msg-highlight');
            setTimeout(() => el.classList.remove('msg-highlight'), 2000);
        }
    }

    private reset(): void {
        this.isNearBottom = true;
        this.isViewingOlder.set(false);
        this.restoreScroll = false;
        requestAnimationFrame(() => {
            if (this.isNearBottom) this.scrollToBottom();
        });
    }

    /** Answers the distance from the bottom. */
    private measure(el: HTMLDivElement): number {
        const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        this.isNearBottom = fromBottom < SCROLL_BOTTOM_THRESHOLD;
        this.isViewingOlder.set(fromBottom > VIEWING_OLDER_THRESHOLD);
        return fromBottom;
    }

    // Capture phase: load does not bubble from child <img> elements.
    private readonly onContentLoad = (): void => {
        if (this.isNearBottom && this.scrollEl) this.scrollToBottom();
    };
}
