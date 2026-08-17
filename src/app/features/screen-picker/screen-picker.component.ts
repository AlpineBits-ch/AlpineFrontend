import {ChangeDetectionStrategy, Component, effect, inject, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Checkbox} from 'primeng/checkbox';
import {ScreenPickerService} from '../../services/screen-picker.service';
import {ScreenSource} from '../../services/rust-media.service';
import {TranslateModule} from '@ngx-translate/core';
import {NgClass} from '@angular/common';
import {InViewDirective} from '../../directives/in-view.directive';

/** The pre-share dialog: pick a source, and that is the whole interaction. */
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

    /** The tile drawn as suggested, from the activity hint. A highlight and nothing more. */
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

    // Tiles are a uniform 16:9 frame with the image letterboxed in, so the grid rows line up.

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

    /** The tile's image, once it has one. */
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
