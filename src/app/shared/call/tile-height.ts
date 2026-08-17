import {DestroyRef, effect, ElementRef, inject, Signal} from '@angular/core';
import {WatchScope} from '../../services/share-watch.service';
import {VoiceSubscriberReportService} from '../../services/voice-subscriber-report.service';

/**
 * Reports how tall this tile is actually drawn, in device pixels, so the server can serve a matching
 * simulcast layer. Must be called from an injection context.
 *
 * @param root  the tile's own box, not the component host, which may be `display: contents`.
 * @param scope which room this tile belongs to. Null disables reporting for that tile.
 * @param tileId a key unique to this tile within the room (`camera:{userId}`, `share:{shareId}`).
 * @param userId the publisher this tile is showing, or null for one not worth reporting.
 */
export function trackTileHeight(
    root: Signal<ElementRef<HTMLElement> | undefined>,
    scope: Signal<WatchScope | null>,
    tileId: Signal<string>,
    userId: Signal<string | null>,
): void {
    const reporter = inject(VoiceSubscriberReportService);

    // Must stay outside the effect, so cleanup retracts exactly what was reported even when the
    // cleanup was caused by one of these inputs changing.
    let reported: {scope: WatchScope; tileId: string} | null = null;

    const retract = () => {
        if (!reported) return;
        reporter.release(reported.scope, reported.tileId);
        reported = null;
    };

    effect(onCleanup => {
        const element = root()?.nativeElement;
        const where = scope();
        const id = tileId();
        const publisher = userId();
        if (!element || !where || !publisher || typeof ResizeObserver === 'undefined') return;

        const measure = (height: number) => {
            if (height <= 0) return;
            reported = {scope: where, tileId: id};
            reporter.report(where, id, publisher, height * devicePixelRatio);
        };

        const observer = new ResizeObserver(entries => {
            // `contentRect` rather than `devicePixelContentBoxSize`, which is Chromium-only.
            for (const entry of entries) measure(entry.contentRect.height);
        });
        observer.observe(element);

        // ResizeObserver only fires on a later frame, so measure once synchronously here too.
        measure(element.getBoundingClientRect().height);

        onCleanup(() => {
            observer.disconnect();
            retract();
        });
    });

    inject(DestroyRef).onDestroy(retract);
}
