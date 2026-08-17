import {DestroyRef, inject, Injectable} from '@angular/core';

const SCROLL_BOTTOM_THRESHOLD = 100;
const LOAD_MORE_THRESHOLD = 400;

/**
 * Manages all scroll mechanics for the conversation view:
 * - Scroll-to-bottom on new messages / conversation switch
 * - Scroll-position restoration after loading older messages
 * - ResizeObserver on the message list to keep the view pinned to bottom
 * - Jump-to-message with highlight
 */
@Injectable()
export class ConversationScrollService {
    isNearBottom = true;
    savedScrollHeight = 0;
    restoreScroll = false;
    pendingScrollToBottom = false;
    lastConvId = '';
    private scrollEl?: HTMLDivElement;
    private observedListEl?: HTMLDivElement;
    private contentObserver = new ResizeObserver(() => {
        if (this.isNearBottom && this.scrollEl) this.scrollToBottom();
    });

    // Capture-phase listener: catches load events from child <img> elements

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

    /** Call when the active conversation has changed (detected by the host component). */
    onConversationSwitch(): void {
        this.isNearBottom = true;
        this.restoreScroll = false;
        requestAnimationFrame(() => {
            if (this.isNearBottom) this.scrollToBottom();
        });
    }

    /** Call whenever the message list updates: marks a pending scroll-to-bottom if near the bottom. */
    markNewMessages(): void {
        if (this.isNearBottom) this.pendingScrollToBottom = true;
    }

    /** Wire to the scroll container's (scroll) DOM event. */
    onScroll(hasMore: boolean, loadingMore: boolean, onLoadMore: () => void): void {
        const el = this.scrollEl;
        if (!el) return;

        const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        this.isNearBottom = fromBottom < SCROLL_BOTTOM_THRESHOLD;

        if (el.scrollTop < LOAD_MORE_THRESHOLD && hasMore && !loadingMore) {
            this.savedScrollHeight = el.scrollHeight;
            this.restoreScroll = true;
            onLoadMore();
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

    scrollToBottom(): void {
        if (!this.scrollEl) return;
        this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
        // Mark as near-bottom so the ResizeObserver keeps scrolling for late-loading content.
        this.isNearBottom = true;
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

    // (load does not bubble, so capture phase is required).
    private readonly onContentLoad = (): void => {
        if (this.isNearBottom && this.scrollEl) this.scrollToBottom();
    };
}
