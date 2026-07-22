import {ChangeDetectionStrategy, Component, inject, NgZone, OnDestroy, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {NgClass} from '@angular/common';
import {Select} from 'primeng/select';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {Slider} from 'primeng/slider';
import {TranslateModule} from '@ngx-translate/core';
import {invoke} from '@tauri-apps/api/core';
import {AudioSettingsService} from '../../../../../services/audio-settings.service';
import {IsleProximityService} from '../../../../../services/isle-proximity.service';
import {NativePttService} from '../../../../../services/native-ptt.service';

interface RustAudioDevice {
    id: string;
    name: string;
    isDefault: boolean;
}

interface RustCameraDevice {
    id: string;
    name: string;
}

interface DeviceOption {
    label: string;
    value: string;
}

interface BitrateOption {
    label: string;
    value: number;
}

@Component({
    selector: 'app-voice-video-settings',
    imports: [FormsModule, NgClass, Select, ToggleSwitch, Slider, TranslateModule],
    templateUrl: './voice-video-settings.component.html',
    styleUrl: './voice-video-settings.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VoiceVideoSettingsComponent implements OnDestroy {
    readonly micOptions = signal<DeviceOption[]>([{label: 'Default', value: 'default'}]);
    readonly speakerOptions = signal<DeviceOption[]>([{label: 'Default', value: 'default'}]);
    readonly cameraOptions = signal<DeviceOption[]>([{label: 'None', value: ''}]);
    readonly audioBitrateOptions: BitrateOption[] = [
        {label: 'Low · 32 kbps', value: 32},
        {label: 'Normal · 64 kbps', value: 64},
        {label: 'High · 128 kbps', value: 128},
        {label: 'Maximum · 320 kbps', value: 320},
        {label: 'Ultra · 510 kbps', value: 510},
    ];
    readonly screenAudioBitrateOptions: BitrateOption[] = [
        {label: 'Normal · 128 kbps', value: 128},
        {label: 'High · 256 kbps', value: 256},
        {label: 'Maximum · 320 kbps', value: 320},
        {label: 'Ultra · 510 kbps', value: 510},
    ];
    readonly videoBitrateOptions: BitrateOption[] = [
        {label: 'Low · 500 kbps', value: 500},
        {label: 'Normal · 1.5 Mbps', value: 1500},
        {label: 'High · 4 Mbps', value: 4000},
        {label: 'Ultra · 8 Mbps', value: 8000},
    ];
    readonly screenVideoBitrateOptions: BitrateOption[] = [
        {label: 'Low · 1.5 Mbps', value: 1500},
        {label: 'Normal · 4 Mbps', value: 4000},
        {label: 'High · 8 Mbps', value: 8000},
        {label: 'Ultra · 15 Mbps', value: 15000},
    ];
    readonly micLevel = signal(0);
    readonly isMicActive = signal(false);

    // ── Persisted settings -setters write through to AudioSettingsService ───
    readonly isVoiceTesting = signal(false);
    readonly permissionError = signal(false);
    readonly micBars = Array.from({length: 24}, (_, i) => i);
    readonly capturingPtt = signal(false);
    /** Display label for the current PTT binding (native tokens are formatted in Rust). */
    readonly pttLabel = signal('');
    private audioSettings = inject(AudioSettingsService);
    private proximity = inject(IsleProximityService);
    private nativePtt = inject(NativePttService);
    private zone = inject(NgZone);
    private pttCaptureHandler: ((e: KeyboardEvent) => void) | null = null;
    /** Removes the DOM keyboard listeners installed during a native PTT capture. */
    private nativeCaptureTeardown: (() => void) | null = null;
    private audioCtx: AudioContext | null = null;
    private analyser: AnalyserNode | null = null;
    private gainNode: GainNode | null = null;
    private micStream: MediaStream | null = null;
    private animFrameId: number | null = null;
    private lastTick = 0;

    constructor() {
        void this.loadDevices();
        void this.loadPttLabel();
    }

    private async loadPttLabel(): Promise<void> {
        await this.nativePtt.whenReady();
        if (this.nativePtt.supported()) {
            this.pttLabel.set(await this.nativePtt.label(this.audioSettings.settings().proximityPttKey));
        }
    }

    get selectedMicId(): string {
        return this.audioSettings.settings().micId;
    }

    set selectedMicId(v: string) {
        this.audioSettings.update({micId: v});
    }

    get selectedSpeakerId(): string {
        return this.audioSettings.settings().speakerId;
    }

    set selectedSpeakerId(v: string) {
        this.audioSettings.update({speakerId: v});
    }

    get selectedCameraId(): string {
        return this.audioSettings.settings().cameraId;
    }

    set selectedCameraId(v: string) {
        this.audioSettings.update({cameraId: v});
    }

    get noiseSuppression(): boolean {
        return this.audioSettings.settings().noiseSuppression;
    }

    set noiseSuppression(v: boolean) {
        this.audioSettings.update({noiseSuppression: v});
    }

    get echoCancellation(): boolean {
        return this.audioSettings.settings().echoCancellation;
    }

    set echoCancellation(v: boolean) {
        this.audioSettings.update({echoCancellation: v});
    }

    get autoGainControl(): boolean {
        return this.audioSettings.settings().autoGainControl;
    }

    set autoGainControl(v: boolean) {
        this.audioSettings.update({autoGainControl: v});
    }

    // ── Mic test state ───────────────────────────────────────────────────────

    get audioBitrate(): number {
        return this.audioSettings.settings().audioBitrate;
    }

    set audioBitrate(v: number) {
        this.audioSettings.update({audioBitrate: v});
    }

    get screenAudioBitrate(): number {
        return this.audioSettings.settings().screenAudioBitrate;
    }

    set screenAudioBitrate(v: number) {
        this.audioSettings.update({screenAudioBitrate: v});
    }

    get videoBitrate(): number {
        return this.audioSettings.settings().videoBitrate;
    }

    set videoBitrate(v: number) {
        this.audioSettings.update({videoBitrate: v});
    }

    get screenVideoBitrate(): number {
        return this.audioSettings.settings().screenVideoBitrate;
    }

    set screenVideoBitrate(v: number) {
        this.audioSettings.update({screenVideoBitrate: v});
    }

    get enhancedNoiseSuppression(): boolean {
        return this.audioSettings.settings().enhancedNoiseSuppression;
    }

    set enhancedNoiseSuppression(v: boolean) {
        this.audioSettings.update({enhancedNoiseSuppression: v});
    }

    get vadStrength(): number {
        return Math.round(this.audioSettings.settings().vadStrength * 100);
    }

    set vadStrength(v: number) {
        this.audioSettings.update({vadStrength: v / 100});
    }

    // ── Isle proximity voice ───────────────────────────────────────────────

    get proximityVolume(): number {
        return Math.round(this.audioSettings.settings().proximityVolume * 100);
    }

    set proximityVolume(v: number) {
        this.proximity.setVolume(Math.max(0, Math.min(1, v / 100)));
    }

    /** Outgoing mic boost as a percentage (100 = unity, up to 200). */
    get proximityMicBoost(): number {
        return Math.round(this.audioSettings.settings().proximityMicGain * 100);
    }

    set proximityMicBoost(v: number) {
        this.proximity.setMicGain(Math.max(0, Math.min(2, v / 100)));
    }

    get proximitySpatial(): boolean {
        return this.audioSettings.settings().proximitySpatialEnabled;
    }

    set proximitySpatial(v: boolean) {
        this.proximity.setSpatialEnabled(v);
    }

    /** Human-readable form of the stored push-to-talk binding. */
    get pttKeyLabel(): string {
        if (this.nativePtt.supported()) return this.pttLabel() || '-';
        return this.formatAccelerator(this.audioSettings.settings().proximityPttKey);
    }

    /** Capture a new push-to-talk binding -natively on Windows (keys/modifiers/mouse), else keyboard-only. */
    startPttCapture(): void {
        if (this.capturingPtt()) return;

        if (this.nativePtt.supported()) {
            void this.captureNative();
            return;
        }

        this.capturingPtt.set(true);
        this.pttCaptureHandler = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.code === 'Escape') {
                this.endPttCapture();
                return;
            }
            // Wait for a non-modifier key so "Ctrl+…" style combos can be built.
            if (this.isModifierCode(e.code)) return;
            this.audioSettings.update({proximityPttKey: this.buildAccelerator(e)});
            void this.proximity.reapplyPtt();
            this.endPttCapture();
        };
        window.addEventListener('keydown', this.pttCaptureHandler, true);
    }

    private endPttCapture(): void {
        if (this.pttCaptureHandler) {
            window.removeEventListener('keydown', this.pttCaptureHandler, true);
            this.pttCaptureHandler = null;
        }
        this.capturingPtt.set(false);
    }

    /**
     * Windows capture: keyboard bindings are read from the DOM, mouse buttons from
     * the native hook.
     *
     * The native low-level keyboard hook does NOT see key presses while our own
     * WebView2 window is focused -Chromium consumes keyboard input through its own
     * out-of-process path -so key/modifier/Escape events never reach it during
     * setup (the game, a separate process, is a different story: the hook works
     * there, which is why armed in-game PTT is fine). While the settings window is
     * focused the DOM *does* receive those key events, so we capture keyboard binds
     * there and let the native hook handle only mouse buttons (which the DOM can't
     * cleanly grab, and which we want swallowed so the bound click doesn't also act).
     * The two race: whichever produces a binding first wins and tears down the other.
     */
    private async captureNative(): Promise<void> {
        this.capturingPtt.set(true);

        let done = false;
        let modCandidate: string | null = null;
        let comboUsed = false;

        // Finish a keyboard-side capture: stop the native (mouse) capture too, then
        // apply the binding. Passing null cancels without binding (Escape).
        const finishKeyboard = (token: string | null): void => {
            if (done) return;
            done = true;
            teardown();
            void this.nativePtt.cancelCapture(); // resets the Rust capturing flag
            if (token) {
                this.audioSettings.update({proximityPttKey: token});
                void this.nativePtt.label(token).then(l => this.pttLabel.set(l));
                void this.proximity.reapplyPtt();
            }
            this.capturingPtt.set(false);
        };

        const onKeyDown = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.code === 'Escape') {
                finishKeyboard(null);
                return;
            }
            if (this.isModifierCode(e.code)) {
                // Remember it as a bare-modifier candidate; a following key builds a combo.
                modCandidate = e.code;
                comboUsed = false;
                return;
            }
            // Ignore keys the native token format can't represent -keep capturing
            // rather than storing a binding that will never arm.
            if (!this.isBindableKeyCode(e.code)) return;
            // Non-modifier key -bind it together with whatever modifiers are held.
            comboUsed = true;
            finishKeyboard(this.buildAccelerator(e));
        };

        const onKeyUp = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            // Bare modifier: released the candidate with no other key pressed during the hold.
            if (this.isModifierCode(e.code) && e.code === modCandidate && !comboUsed) {
                finishKeyboard(this.modifierToken(e.code));
            }
        };

        const teardown = () => {
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('keyup', onKeyUp, true);
            this.nativeCaptureTeardown = null;
        };
        this.nativeCaptureTeardown = teardown;
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('keyup', onKeyUp, true);

        try {
            // Native hook resolves on a mouse button (or on the cancel we emit above).
            const res = await this.nativePtt.beginCapture();
            if (done) return; // keyboard already won (its cancel resolved this promise)
            done = true;
            teardown();
            if (!res.cancelled) {
                this.audioSettings.update({proximityPttKey: res.token});
                this.pttLabel.set(res.label);
                void this.proximity.reapplyPtt();
            }
            this.capturingPtt.set(false);
        } catch (e) {
            console.error('[ptt] native capture failed', e);
            if (!done) {
                done = true;
                teardown();
                this.capturingPtt.set(false);
            }
        }
    }

    /** True for `KeyboardEvent.code` values the native `code_name_to_vk` can map. */
    private isBindableKeyCode(code: string): boolean {
        return /^Key[A-Z]$/.test(code)
            || /^Digit[0-9]$/.test(code)
            || /^F([1-9]|1[0-9]|2[0-4])$/.test(code)
            || code === 'Backquote' || code === 'Space' || code === 'Tab';
    }

    /** Bare-modifier token for the native hook (matches Rust `parse_token`). */
    private modifierToken(code: string): string {
        if (code.startsWith('Control')) return 'Ctrl';
        if (code.startsWith('Alt')) return 'Alt';
        if (code.startsWith('Shift')) return 'Shift';
        return 'Win'; // MetaLeft / MetaRight
    }

    private isModifierCode(code: string): boolean {
        return code === 'ControlLeft' || code === 'ControlRight'
            || code === 'AltLeft' || code === 'AltRight'
            || code === 'ShiftLeft' || code === 'ShiftRight'
            || code === 'MetaLeft' || code === 'MetaRight';
    }

    /** Builds a Tauri global-shortcut accelerator (e.g. "Control+Shift+KeyV") from a keydown. */
    private buildAccelerator(e: KeyboardEvent): string {
        const parts: string[] = [];
        if (e.ctrlKey) parts.push('Control');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        if (e.metaKey) parts.push('Super');
        parts.push(e.code);
        return parts.join('+');
    }

    private formatAccelerator(accel: string): string {
        return accel.split('+').map(part => {
            switch (part) {
                case 'Control':
                    return 'Ctrl';
                case 'Super':
                    return 'Win';
                case 'Backquote':
                    return '`';
                default:
                    if (part.startsWith('Key')) return part.slice(3);
                    if (part.startsWith('Digit')) return part.slice(5);
                    return part;
            }
        }).join(' + ');
    }

    async toggleMicTest(): Promise<void> {
        if (this.isMicActive()) {
            this.stopMic();
        } else {
            await this.startMic();
        }
    }

    onVoiceTestChange(enabled: boolean): void {
        this.applyVoiceTest(enabled);
    }

    isMicBarActive(index: number): boolean {
        return (index / this.micBars.length) * 100 < this.micLevel();
    }

    micBarClass(index: number): string {
        const pct = index / this.micBars.length;
        if (pct < 0.6) return 'bg-emerald-400';
        if (pct < 0.82) return 'bg-amber-400';
        return 'bg-rose-500';
    }

    ngOnDestroy(): void {
        this.stopMic();
        this.endPttCapture();
        this.nativeCaptureTeardown?.();
        if (this.capturingPtt() && this.nativePtt.supported()) void this.nativePtt.cancelCapture();
    }



    private async loadDevices(): Promise<void> {
        try {
            const [mics, speakers, cameras] = await Promise.all([
                invoke<RustAudioDevice[]>('enumerate_audio_devices'),
                invoke<RustAudioDevice[]>('enumerate_output_devices'),
                invoke<RustCameraDevice[]>('enumerate_camera_devices'),
            ]);
            this.micOptions.set(mics.map(d => ({label: d.name, value: d.id})));
            this.speakerOptions.set(speakers.map(d => ({label: d.name, value: d.id})));
            this.cameraOptions.set([
                {label: 'None', value: ''},
                ...cameras.map(d => ({label: d.name, value: d.id})),
            ]);
        } catch (e) {
            console.error('[devices] enumeration failed', e);
        }
    }

    private async startMic(): Promise<void> {
        if (!navigator?.mediaDevices) return;
        try {
            this.micStream = await navigator.mediaDevices.getUserMedia({
                audio: this.audioSettings.buildAudioConstraint(),
            });
            this.audioCtx = new AudioContext();
            const source = this.audioCtx.createMediaStreamSource(this.micStream);
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.smoothingTimeConstant = 0.72;
            source.connect(this.analyser);
            this.isMicActive.set(true);
            this.permissionError.set(false);
            this.poll();
        } catch {
            this.permissionError.set(true);
        }
    }

    private stopMic(): void {
        this.applyVoiceTest(false);
        if (this.animFrameId !== null) {
            cancelAnimationFrame(this.animFrameId);
            this.animFrameId = null;
        }
        this.micStream?.getTracks().forEach(t => t.stop());
        this.audioCtx?.close();
        this.audioCtx = null;
        this.analyser = null;
        this.micStream = null;
        this.isMicActive.set(false);
        this.micLevel.set(0);
    }

    private poll(): void {
        const buf = new Uint8Array(this.analyser!.frequencyBinCount);
        const tick = (now: number) => {
            if (!this.analyser) return;
            if (now - this.lastTick >= 33) {
                this.analyser.getByteFrequencyData(buf);
                const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
                this.zone.run(() => this.micLevel.set(Math.min(100, avg * 2.6)));
                this.lastTick = now;
            }
            this.animFrameId = requestAnimationFrame(tick);
        };
        this.animFrameId = requestAnimationFrame(tick);
    }

    private applyVoiceTest(enabled: boolean): void {
        if (!this.analyser || !this.audioCtx) return;
        if (enabled && !this.isVoiceTesting()) {
            this.gainNode = this.audioCtx.createGain();
            this.gainNode.gain.value = 1;
            this.analyser.connect(this.gainNode);
            this.gainNode.connect(this.audioCtx.destination);
            this.isVoiceTesting.set(true);
        } else if (!enabled && this.isVoiceTesting()) {
            this.gainNode?.disconnect();
            this.gainNode = null;
            this.isVoiceTesting.set(false);
        }
    }
}
