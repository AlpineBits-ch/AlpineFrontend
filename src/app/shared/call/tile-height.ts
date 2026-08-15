import {DestroyRef, effect, ElementRef, inject, Signal} from '@angular/core';
import {WatchScope} from '../../services/share-watch.service';
import {VoiceSubscriberReportService} from '../../services/voice-subscriber-report.service';

/**
 * Reports how tall this tile is actually drawn, so the server can serve a simulcast layer that
 * matches it.
 *
 * <p>The height is the only thing measured, because it is the only thing the contract asks for
 * (`voice-frontend-guide.md` §6.4) and the only thing the server buckets on. Every tile in this app
 * is `aspect-video`, so width carries no information height does not.</p>
 *
 * <p><b>Device pixels, not CSS pixels.</b> The server compares against a video layer's line count,
 * and a 200px-tall tile on a 2x display is showing 400 lines. Reporting CSS pixels would have every
 * viewer on a HiDPI screen served a layer one rung too low, which is the failure this is most likely
 * to be blamed for later - the picture is soft and nothing in the UI says why.</p>
 *
 * <p>Measurement is `ResizeObserver` rather than an effect on the layout signals, because the things
 * that change a tile's size mostly are not signals here: the window resizing, the DM panel's own
 * height transition, the sidebar collapsing, a font loading. Debouncing and the "is this change
 * material" test both live in {@link VoiceSubscriberReportService}, so a tile can report every
 * notification it gets without thinking about it.</p>
 *
 * <p>Must be called from an injection context - it owns an observer and hangs its teardown off the
 * caller's lifetime.</p>
 *
 * @param root  the tile's own box. Not the component host: `app-call-share-tile` is
 *              `display: contents` and its host has no box at all to observe.
 * @param scope which room this tile belongs to. Null - a surface that was not given one - disables
 *              reporting for that tile rather than guessing a room.
 * @param tileId a key unique to this tile within the room (`camera:{userId}`, `share:{shareId}`),
 *              so one publisher on screen twice is two measurements rather than one that flickers.
 * @param userId the publisher this tile is showing, or null for one that is not worth reporting -
 *              which in practice means the local user's own tile. Nothing is ever pulled from the
 *              SFU for yourself, so a measurement of your own seat is a row in the map the planner
 *              can only ignore.
 */
export function trackTileHeight(
    root: Signal<ElementRef<HTMLElement> | undefined>,
    scope: Signal<WatchScope | null>,
    tileId: Signal<string>,
    userId: Signal<string | null>,
): void {
    const reporter = inject(VoiceSubscriberReportService);

    // Held outside the effect so the cleanup below can retract exactly what was reported, even when
    // the reason for the cleanup is that one of these inputs changed to something else.
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
            // `contentRect` rather than `devicePixelContentBoxSize`: the latter is the exact answer
            // but is Chromium-only, and this runs in a WKWebView too. `devicePixelRatio` applied to
            // the CSS box is the same number everywhere the ratio is an integer, and close enough on
            // the fractional scalings where it is not - the server buckets into three layers.
            for (const entry of entries) measure(entry.contentRect.height);
        });
        observer.observe(element);

        // ResizeObserver fires once on observe, but only on a later frame. A tile that is destroyed
        // inside that frame - a share that ends as it appears - would otherwise never report at all,
        // and a tile whose size has not changed since the last observer still needs its first
        // measurement after `scope` or `userId` moved underneath it.
        measure(element.getBoundingClientRect().height);

        onCleanup(() => {
            observer.disconnect();
            retract();
        });
    });

    inject(DestroyRef).onDestroy(retract);
}
