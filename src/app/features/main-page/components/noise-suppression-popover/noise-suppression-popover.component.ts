import {ChangeDetectionStrategy, Component, computed, ElementRef, inject, signal} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {AudioSettings, AudioSettingsService} from '../../../../services/audio-settings.service';
import {VoiceEngineService} from '../../../../services/voice-engine.service';

type Mode = AudioSettings['noiseSuppressionMode'];

const HINT_KEYS: Record<Mode, string> = {
    none: 'VOICE_BAR.NS_OFF_HINT',
    standard: 'VOICE_BAR.NS_STANDARD_HINT',
    enhanced: 'VOICE_BAR.NS_ENHANCED_HINT',
};

/**
 * Noise suppression, reachable from the call panel instead of only from the settings page.
 *
 * A plain panel rather than `p-popover`: the preset does not cover the standalone popover, so it
 * renders in light Aura, and the only fix on offer is `::ng-deep` overrides.
 *
 * `display: contents` on the host, so the panel row above is the positioning context. The overlay
 * anchors to the row's right edge rather than to the button, which is what keeps it inside the
 * sidebar instead of running off the left of the window.
 */
@Component({
    selector: 'app-noise-suppression-popover',
    imports: [TranslateModule],
    templateUrl: './noise-suppression-popover.component.html',
    host: {
        class: 'contents',
        '(document:click)': 'onDocumentClick($event)',
        '(document:keydown.escape)': 'close()',
    },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NoiseSuppressionPopoverComponent {
    private readonly audioSettings = inject(AudioSettingsService);
    private readonly voice = inject(VoiceEngineService);
    private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

    protected readonly open = signal(false);

    /** Least processing first, so the row reads as one scale rather than three unrelated buttons. */
    protected readonly modes: readonly {value: Mode; labelKey: string}[] = [
        {value: 'none', labelKey: 'VOICE_BAR.NS_OFF'},
        {value: 'standard', labelKey: 'VOICE_BAR.NS_STANDARD'},
        {value: 'enhanced', labelKey: 'VOICE_BAR.NS_ENHANCED'},
    ];

    /** The same setting the voice settings page writes; there is no second copy of it. */
    readonly mode = computed(() => this.audioSettings.settings().noiseSuppressionMode);

    protected readonly hintKey = computed(() => HINT_KEYS[this.mode()]);

    protected readonly bars = Array.from({length: 24}, (_, i) => i);

    /**
     * Post-suppression, which is what makes this worth showing here: `chain.rs` measures the level
     * after both suppressors, so switching to enhanced and rustling something visibly drops the bar.
     */
    private readonly levelPercent = computed(() => this.voice.level() * 100);

    /** Tinted only at `enhanced`: the trigger has to read as on or off from across the sidebar. */
    protected readonly triggerClass = computed(() =>
        this.mode() === 'enhanced'
            ? 'bg-brand/15 text-brand-dim hover:bg-brand/25'
            : 'bg-white/[0.06] text-text-primary hover:bg-white/[0.12]',
    );

    protected toggle(): void {
        this.open.update(o => !o);
    }

    protected close(): void {
        this.open.set(false);
    }

    /** The trigger's own click reaches here too, but its target is inside the host, so it survives. */
    protected onDocumentClick(event: MouseEvent): void {
        if (this.open() && !this.host.nativeElement.contains(event.target as Node)) this.close();
    }

    protected select(mode: Mode): void {
        this.audioSettings.update({noiseSuppressionMode: mode});
    }

    /**
     * Carries the background for every state, selected or not. Splitting it across the static class
     * and this one would put two `background-color` utilities on the same element, and which wins is
     * decided by their order in the generated stylesheet rather than by anything here.
     */
    protected segmentClass(mode: Mode): string {
        if (this.mode() !== mode) return 'bg-transparent text-text-secondary hover:text-text-primary';
        return mode === 'enhanced' ? 'bg-brand/25 text-brand-dim' : 'bg-white/[0.12] text-white';
    }

    protected barActive(index: number): boolean {
        return (index / this.bars.length) * 100 < this.levelPercent();
    }

    /** Mirrors the meter on the voice settings page, so the two cannot disagree about a level. */
    protected barClass(index: number): string {
        const pct = index / this.bars.length;
        if (pct < 0.6) return 'bg-emerald-400';
        if (pct < 0.82) return 'bg-amber-400';
        return 'bg-rose-500';
    }
}
