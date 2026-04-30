import { ChangeDetectionStrategy, Component, inject, NgZone, OnDestroy, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgClass } from '@angular/common';
import { Select } from 'primeng/select';
import { ToggleSwitch } from 'primeng/toggleswitch';
import { AudioSettingsService } from '../../../../../services/audio-settings.service';

interface DeviceOption {
  label: string;
  value: string;
}

@Component({
  selector: 'app-voice-video-settings',
  imports: [FormsModule, NgClass, Select, ToggleSwitch],
  templateUrl: './voice-video-settings.component.html',
  styleUrl: './voice-video-settings.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VoiceVideoSettingsComponent implements OnDestroy {
  private audioSettings = inject(AudioSettingsService);
  private zone = inject(NgZone);

  readonly micOptions     = signal<DeviceOption[]>([{ label: 'Default', value: 'default' }]);
  readonly speakerOptions = signal<DeviceOption[]>([{ label: 'Default', value: 'default' }]);
  readonly cameraOptions  = signal<DeviceOption[]>([{ label: 'None', value: '' }]);

  // ── Persisted settings — setters write through to AudioSettingsService ───

  get selectedMicId(): string { return this.audioSettings.settings().micId; }
  set selectedMicId(v: string) { this.audioSettings.update({ micId: v }); }

  get selectedSpeakerId(): string { return this.audioSettings.settings().speakerId; }
  set selectedSpeakerId(v: string) { this.audioSettings.update({ speakerId: v }); }

  get selectedCameraId(): string { return this.audioSettings.settings().cameraId; }
  set selectedCameraId(v: string) { this.audioSettings.update({ cameraId: v }); }

  get noiseSuppression(): boolean { return this.audioSettings.settings().noiseSuppression; }
  set noiseSuppression(v: boolean) { this.audioSettings.update({ noiseSuppression: v }); }

  get echoCancellation(): boolean { return this.audioSettings.settings().echoCancellation; }
  set echoCancellation(v: boolean) { this.audioSettings.update({ echoCancellation: v }); }

  get autoGainControl(): boolean { return this.audioSettings.settings().autoGainControl; }
  set autoGainControl(v: boolean) { this.audioSettings.update({ autoGainControl: v }); }

  // ── Mic test state ───────────────────────────────────────────────────────

  readonly micLevel        = signal(0);
  readonly isMicActive     = signal(false);
  readonly isVoiceTesting  = signal(false);
  readonly permissionError = signal(false);

  readonly micBars = Array.from({ length: 24 }, (_, i) => i);

  private audioCtx:    AudioContext | null = null;
  private analyser:    AnalyserNode | null = null;
  private gainNode:    GainNode | null     = null;
  private micStream:   MediaStream | null  = null;
  private animFrameId: number | null       = null;
  private lastTick = 0;

  constructor() {
    void this.loadDevices();
  }

  private async loadDevices(): Promise<void> {
    if (!navigator?.mediaDevices) return;
    try {
      const temp = await navigator.mediaDevices.getUserMedia({ audio: true });
      temp.getTracks().forEach(t => t.stop());
      const all = await navigator.mediaDevices.enumerateDevices();
      this.micOptions.set([
        { label: 'Default', value: 'default' },
        ...all.filter(d => d.kind === 'audioinput').map(d => ({
          label: d.label || 'Microphone',
          value: d.deviceId,
        })),
      ]);
      this.speakerOptions.set([
        { label: 'Default', value: 'default' },
        ...all.filter(d => d.kind === 'audiooutput').map(d => ({
          label: d.label || 'Speaker',
          value: d.deviceId,
        })),
      ]);
      this.cameraOptions.set([
        { label: 'None', value: '' },
        ...all.filter(d => d.kind === 'videoinput').map(d => ({
          label: d.label || 'Camera',
          value: d.deviceId,
        })),
      ]);
    } catch {
      this.permissionError.set(true);
    }
  }

  async toggleMicTest(): Promise<void> {
    if (this.isMicActive()) {
      this.stopMic();
    } else {
      await this.startMic();
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
    this.audioCtx  = null;
    this.analyser  = null;
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

  onVoiceTestChange(enabled: boolean): void {
    this.applyVoiceTest(enabled);
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

  isMicBarActive(index: number): boolean {
    return (index / this.micBars.length) * 100 < this.micLevel();
  }

  micBarClass(index: number): string {
    const pct = index / this.micBars.length;
    if (pct < 0.6)  return 'bg-emerald-400';
    if (pct < 0.82) return 'bg-amber-400';
    return 'bg-rose-500';
  }

  ngOnDestroy(): void {
    this.stopMic();
  }
}
