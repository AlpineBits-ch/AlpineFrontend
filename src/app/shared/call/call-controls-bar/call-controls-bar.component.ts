import {Component, input, output} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {
    FRAMERATE_OPTIONS,
    RESOLUTION_LABELS,
    StreamFramerate,
    StreamPreset,
    StreamResolution,
} from '../../../models/stream-preset';

const TOGGLE_BASE = 'call-focusable group flex size-12 cursor-pointer items-center justify-center rounded-xl'
    + ' border-0 transition-all duration-150 active:scale-95';

const SEGMENT_BASE = 'call-focusable cursor-pointer rounded border-0 px-2 py-1 text-xs leading-none tabular-nums'
    + ' transition-all active:scale-90';

@Component({
    selector: 'app-call-controls-bar',
    imports: [TranslateModule],
    templateUrl: './call-controls-bar.component.html',
})
export class CallControlsBarComponent {
    // State inputs
    isMuted = input.required<boolean>();
    isDeafened = input.required<boolean>();
    isCameraOn = input.required<boolean>();
    isScreenSharing = input.required<boolean>();
    screenHasAudio = input<boolean>(false);
    screenAudioMuted = input<boolean>(false);
    /** Quality of the running share, so the active resolution and framerate read as selected. */
    preset = input<StreamPreset | null>(null);
    /** Already-translated: "Disconnect" in a guild channel, "End call" in a DM. */
    disconnectLabel = input.required<string>();

    // Action outputs
    muteToggle = output<void>();
    deafenToggle = output<void>();
    cameraToggle = output<void>();
    screenShareToggle = output<void>();
    screenAudioToggle = output<void>();
    /** Emitted with the whole preset - resolution and framerate are never changed independently. */
    presetChange = output<StreamPreset>();
    disconnect = output<void>();

    protected readonly resolutions = Object.entries(RESOLUTION_LABELS)
        .map(([value, label]) => ({value: value as StreamResolution, label}));
    protected readonly framerates = FRAMERATE_OPTIONS;

    /**
     * The look of one control-bar toggle.
     *
     * <p>`danger` is for the toggles whose "on" state is a restriction the user has placed on
     * themselves (muted, deafened); `brand` is for the ones whose "on" state is a thing they are
     * actively doing (camera, screen share). The two were previously spelled out twice each as
     * eleven-class `ngClass` expressions inline.</p>
     */
    protected toggleClass(active: boolean, tone: 'danger' | 'brand'): string {
        if (!active) {
            return `${TOGGLE_BASE} bg-white/[0.07] text-white/60 hover:bg-white/[0.12] hover:text-white/85`;
        }
        return tone === 'danger'
            ? `${TOGGLE_BASE} bg-offline/20 text-offline hover:bg-offline/30`
            : `${TOGGLE_BASE} bg-brand/20 text-brand-dim hover:bg-brand/30`;
    }

    /** One segment of the resolution or framerate picker. */
    protected segmentClass(active: boolean): string {
        return active
            ? `${SEGMENT_BASE} bg-brand text-white`
            : `${SEGMENT_BASE} bg-transparent text-white/45 hover:bg-white/[0.07] hover:text-white/75`;
    }

    protected isResolution(resolution: StreamResolution): boolean {
        return this.preset()?.resolution === resolution;
    }

    protected isFramerate(framerate: StreamFramerate): boolean {
        return this.preset()?.framerate === framerate;
    }

    protected setResolution(resolution: StreamResolution): void {
        const current = this.preset();
        if (current) this.presetChange.emit({...current, resolution});
    }

    protected setFramerate(framerate: StreamFramerate): void {
        const current = this.preset();
        if (current) this.presetChange.emit({...current, framerate});
    }
}
