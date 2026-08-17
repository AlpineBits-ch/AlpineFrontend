import {ChangeDetectionStrategy, Component, computed, inject, viewChild} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {Popover} from 'primeng/popover';
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
 * Owns its own trigger button, so nothing outside has to know which mode counts as the on state.
 * `display: contents` on the host keeps that button a direct child of the panel's icon row.
 */
@Component({
    selector: 'app-noise-suppression-popover',
    imports: [Popover, TranslateModule],
    templateUrl: './noise-suppression-popover.component.html',
    host: {class: 'contents'},
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NoiseSuppressionPopoverComponent {
    private readonly audioSettings = inject(AudioSettingsService);
    private readonly voice = inject(VoiceEngineService);

    private readonly popover = viewChild.required(Popover);

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
            ? 'bg-[color-mix(in_srgb,var(--color-brand)_15%,transparent)] text-[var(--color-brand-dim)] hover:bg-[color-mix(in_srgb,var(--color-brand)_25%,transparent)]'
            : 'bg-white/[0.06] text-white/70 hover:bg-white/[0.12]',
    );

    protected toggle(event: Event): void {
        this.popover().toggle(event);
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
        if (this.mode() !== mode) return 'bg-transparent text-white/50 hover:text-white/80';
        return mode === 'enhanced'
            ? 'bg-[color-mix(in_srgb,var(--color-brand)_32%,transparent)] text-[var(--color-brand-dim)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-brand)_45%,transparent)]'
            : 'bg-white/[0.12] text-white';
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
