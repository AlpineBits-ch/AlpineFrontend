import {Component, input, output} from '@angular/core';
import {NgClass} from '@angular/common';
import {
    FRAMERATE_OPTIONS,
    RESOLUTION_LABELS,
    StreamFramerate,
    StreamPreset,
    StreamResolution,
} from '../../../models/stream-preset';

@Component({
    selector: 'app-call-controls-bar',
    imports: [NgClass],
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
    disconnectLabel = input<string>('Disconnect');

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
