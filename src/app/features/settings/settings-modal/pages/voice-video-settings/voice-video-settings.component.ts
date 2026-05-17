import {ChangeDetectionStrategy, Component, inject, NgZone, OnDestroy, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {NgClass} from '@angular/common';
import {Select} from 'primeng/select';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {Slider} from 'primeng/slider';
import {TranslateModule} from '@ngx-translate/core';
import {AudioSettingsService} from '../../../../../services/audio-settings.service';

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

    // ── Persisted settings — setters write through to AudioSettingsService ───
    readonly isVoiceTesting = signal(false);
    readonly permissionError = signal(false);
    readonly micBars = Array.from({length: 24}, (_, i) => i);
    private audioSettings = inject(AudioSettingsService);
    private zone = inject(NgZone);
    private audioCtx: AudioContext | null = null;
    private analyser: AnalyserNode | null = null;
    private gainNode: GainNode | null = null;
    private micStream: MediaStream | null = null;
    private animFrameId: number | null = null;
    private lastTick = 0;

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
    }

    private async loadDevices(): Promise<void> {
        if (!navigator?.mediaDevices) return;
        try {
            const temp = await navigator.mediaDevices.getUserMedia({audio: true});
            temp.getTracks().forEach(t => t.stop());
            const all = await navigator.mediaDevices.enumerateDevices();
            this.micOptions.set([
                {label: 'Default', value: 'default'},
                ...all.filter(d => d.kind === 'audioinput').map(d => ({
                    label: d.label || 'Microphone',
                    value: d.deviceId,
                })),
            ]);
            this.speakerOptions.set([
                {label: 'Default', value: 'default'},
                ...all.filter(d => d.kind === 'audiooutput').map(d => ({
                    label: d.label || 'Speaker',
                    value: d.deviceId,
                })),
            ]);
            this.cameraOptions.set([
                {label: 'None', value: ''},
                ...all.filter(d => d.kind === 'videoinput').map(d => ({
                    label: d.label || 'Camera',
                    value: d.deviceId,
                })),
            ]);
        } catch {
            this.permissionError.set(true);
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
