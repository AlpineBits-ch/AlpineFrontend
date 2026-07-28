import {ChangeDetectionStrategy, Component, EventEmitter, inject, NgZone, OnDestroy, Output, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {NgClass} from '@angular/common';
import {Select} from 'primeng/select';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {Slider} from 'primeng/slider';
import {Button} from 'primeng/button';
import {RadioButton} from 'primeng/radiobutton';
import {TranslateModule} from '@ngx-translate/core';
import {invoke} from '@tauri-apps/api/core';
import {AudioSettingsService} from '../../../../../services/audio-settings.service';
import {IsleProximityService} from '../../../../../services/isle-proximity.service';
import {StreamSrcDirective} from '../../../../../directives/stream-src.directive';

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
    imports: [FormsModule, NgClass, Select, ToggleSwitch, Slider, Button, RadioButton, TranslateModule, StreamSrcDirective],
    templateUrl: './voice-video-settings.component.html',
    styleUrl: './voice-video-settings.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VoiceVideoSettingsComponent implements OnDestroy {
    /** Bubbled up to the settings modal, which switches to the Keybinds page. */
    @Output() readonly openKeybinds = new EventEmitter<void>();

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
    readonly inputModeOptions: {value: 'voice-activity' | 'push-to-talk'; label: string; desc: string}[] = [
        {value: 'voice-activity', label: 'Voice Activity', desc: 'Transmit automatically when your mic level crosses the sensitivity threshold below'},
        {value: 'push-to-talk', label: 'Push to Talk', desc: 'Only transmit while your bound key is held - bind it on the Keybinds page'},
    ];
    readonly micLevel = signal(0);
    readonly isMicActive = signal(false);
    readonly isCameraActive = signal(false);
    readonly cameraStream = signal<MediaStream | null>(null);

    // ── Persisted settings -setters write through to AudioSettingsService ───
    readonly isVoiceTesting = signal(false);
    readonly permissionError = signal(false);
    readonly micBars = Array.from({length: 24}, (_, i) => i);
    private audioSettings = inject(AudioSettingsService);
    private proximity = inject(IsleProximityService);
    private zone = inject(NgZone);
    private audioCtx: AudioContext | null = null;
    private analyser: AnalyserNode | null = null;
    private gainNode: GainNode | null = null;
    private micStream: MediaStream | null = null;
    private animFrameId: number | null = null;
    private lastTick = 0;
    private cameraTestGeneration = 0;

    constructor() {
        void this.loadDevices();
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
        if (this.isCameraActive()) {
            this.stopCameraTest();
            void this.startCameraTest();
        }
    }

    get noiseSuppression(): boolean {
        return this.audioSettings.settings().noiseSuppression;
    }

    set noiseSuppression(v: boolean) {
        this.audioSettings.update({noiseSuppression: v});
    }

    get inputMode(): 'voice-activity' | 'push-to-talk' {
        return this.audioSettings.settings().inputMode;
    }

    set inputMode(v: 'voice-activity' | 'push-to-talk') {
        this.audioSettings.update({inputMode: v});
    }

    get inputSensitivity(): number {
        return this.audioSettings.settings().inputSensitivity;
    }

    set inputSensitivity(v: number) {
        this.audioSettings.update({inputSensitivity: v});
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

    async toggleMicTest(): Promise<void> {
        if (this.isMicActive()) {
            this.stopMic();
        } else {
            await this.startMic();
        }
    }

    async toggleCameraTest(): Promise<void> {
        if (this.isCameraActive()) {
            this.stopCameraTest();
        } else {
            await this.startCameraTest();
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
        this.stopCameraTest();
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
                audio: await this.audioSettings.buildAudioConstraint(),
            });
            this.audioCtx = new AudioContext();
            const source = this.audioCtx.createMediaStreamSource(this.micStream);
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.smoothingTimeConstant = 0.72;
            source.connect(this.analyser);
            // Monitor through the selected speaker, so the voice test actually
            // exercises the device the user just picked.
            void this.routeTestToSelectedSpeaker(this.audioCtx);
            this.isMicActive.set(true);
            this.permissionError.set(false);
            this.poll();
        } catch {
            this.permissionError.set(true);
        }
    }

    /** Best-effort: send the mic-test monitor to the selected speaker. */
    private async routeTestToSelectedSpeaker(ctx: AudioContext): Promise<void> {
        const withSink = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
        if (typeof withSink.setSinkId !== 'function') return;

        const sinkId = await this.audioSettings.resolveSpeakerSinkId();
        // Bail if the test was stopped (or restarted) while we were resolving.
        if (!sinkId || this.audioCtx !== ctx) return;
        try {
            await withSink.setSinkId(sinkId);
        } catch (e) {
            console.warn('[devices] mic-test setSinkId failed; using the default output', e);
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

    private async startCameraTest(): Promise<void> {
        if (!navigator?.mediaDevices) return;
        const generation = ++this.cameraTestGeneration;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: await this.audioSettings.buildVideoConstraint(),
            });
            if (generation !== this.cameraTestGeneration) {
                stream.getTracks().forEach(t => t.stop());
                return;
            }
            this.cameraStream.set(stream);
            this.isCameraActive.set(true);
        } catch {
            // Denied or unavailable - the existing permissionError banner covers the mic case;
            // camera failures just leave the preview empty, matching the picker's own silent failure mode.
        }
    }

    private stopCameraTest(): void {
        this.cameraTestGeneration++;
        this.cameraStream()?.getTracks().forEach(t => t.stop());
        this.cameraStream.set(null);
        this.isCameraActive.set(false);
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
