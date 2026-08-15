import {ChangeDetectionStrategy, Component, effect, inject, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Checkbox} from 'primeng/checkbox';
import {ScreenPickerService} from '../../services/screen-picker.service';
import {ScreenSource} from '../../services/rust-media.service';
import {TranslateModule} from '@ngx-translate/core';
import {NgClass} from '@angular/common';
import {InViewDirective} from '../../directives/in-view.directive';

/**
 * The pre-share dialog: pick a source, and that is the whole interaction.
 *
 * <p>It used to be a two-step wizard - choose a source, press Next, choose a resolution, a framerate
 * and an audio toggle, press Go Live. Every one of those settings except audio is adjustable while
 * the share is running, from the quality control on the call bar, so asking for them up front bought
 * nothing and cost two clicks and a screen. A click on a tile now publishes.</p>
 *
 * <p>Audio is the exception, and the reason the one checkbox survives: `shareAudio: false` means no
 * audio track is ever published, and the in-call mute button only exists when there is a track to
 * mute. It is the only setting here that cannot be recovered after the fact.</p>
 *
 * <p>The quality the share opens at is {@link ScreenPickerService.lastPreset} - what the user last
 * set on the bar - passed through unclamped. The publish clamps it against the room's ceiling, which
 * is where that has always actually been enforced.</p>
 */
@Component({
    selector: 'app-screen-picker',
    imports: [TranslateModule, FormsModule, Checkbox, NgClass, InViewDirective],
    templateUrl: './screen-picker.component.html',
    styleUrl: './screen-picker.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScreenPickerComponent {
    readonly picker = inject(ScreenPickerService);
    readonly activeTab = signal<'monitors' | 'windows'>('monitors');
    readonly shareAudio = signal(true);

    /**
     * The tile drawn as suggested, from the activity hint. A highlight and nothing more.
     *
     * <p>This is deliberately not a selection. A click is now a publish, so having the hint "select"
     * a window the way it used to would be starting a share nobody asked for. It moves to the right
     * tab and rings the tile; the user still presses it.</p>
     */
    readonly suggestedSourceId = signal<string | null>(null);

    constructor() {
        // Open on the window the caller asked for, once the list has arrived.
        effect(() => {
            const preferred = this.picker.preferredSourceId();
            const sources = this.picker.sources();
            if (!preferred || this.appliedPreference === preferred) return;
            if (!sources.some(s => s.id === preferred)) return;

            this.appliedPreference = preferred;
            this.activeTab.set('windows');
            this.suggestedSourceId.set(preferred);
        });
    }

    /**
     * The preference already acted on, so re-running the effect - which every `sources` write does
     * - cannot move a user who has since switched tabs back again.
     */
    private appliedPreference: string | null = null;

    get monitors(): ScreenSource[] {
        return this.picker.sources().filter(s => s.isMonitor);
    }

    get windows(): ScreenSource[] {
        return this.picker.sources().filter(s => !s.isMonitor);
    }

    // The per-source aspect ratio that used to size each tile is gone: it made every tile a
    // different height, so the rows never lined up. The tiles are a uniform 16:9 frame now and the
    // image is letterboxed into it, which keeps the source's real shape visible without the grid
    // paying for it.

    /** Choosing a source is going live. There is no confirmation step left to pass through. */
    select(source: ScreenSource): void {
        this.picker.select({
            sourceId: source.id,
            sourceWidth: source.width,
            sourceHeight: source.height,
            // Unclamped on purpose - the publish clamps against the room, and storing a clamped
            // value here would let one 720p channel downgrade the preference for every other.
            preset: this.picker.lastPreset(),
            shareAudio: this.shareAudio(),
        });
        this.reset();
    }

    cancel(): void {
        this.picker.cancel();
        this.reset();
    }

    /**
     * The tile's image, once it has one.
     *
     * <p>Enumeration no longer carries thumbnails - capturing every window up front is what made
     * opening this dialog cost tens of seconds - so this reads the per-source cache the tiles fill
     * as they scroll into view. `source.thumbnail` is still honoured for any caller that supplies
     * one directly.</p>
     */
    thumbSrc(source: ScreenSource): string {
        const captured = this.picker.thumbnails()[source.id] || source.thumbnail;
        return captured ? `data:image/jpeg;base64,${captured}` : '';
    }

    /** Requested, nothing back yet - as opposed to captured-and-failed, which stays as an icon. */
    isThumbnailPending(source: ScreenSource): boolean {
        return !(source.id in this.picker.thumbnails());
    }

    private reset(): void {
        this.suggestedSourceId.set(null);
        this.appliedPreference = null;
    }
}
