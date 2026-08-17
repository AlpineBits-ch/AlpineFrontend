import {
    ChangeDetectionStrategy,
    Component,
    computed,
    EventEmitter,
    inject,
    NgZone,
    OnDestroy,
    Output,
    signal,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {NgClass} from '@angular/common';
import {Select} from 'primeng/select';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {Slider} from 'primeng/slider';
import {Button} from 'primeng/button';
import {RadioButton} from 'primeng/radiobutton';
import {TranslateModule} from '@ngx-translate/core';
import {AudioSettings, AudioSettingsService} from '../../../../../services/audio-settings.service';
import {DeviceOption, MediaDeviceCatalogService} from '../../../../../services/media-device-catalog.service';
import {IsleProximityService} from '../../../../../services/isle-proximity.service';
import {SILENCE_DBFS, VoiceEngineService} from '../../../../../services/voice-engine.service';
import {vadMeterScale, VoiceActivityService} from '../../../../../services/voice-activity.service';
import {StreamSrcDirective} from '../../../../../directives/stream-src.directive';
import {MediaDeviceSource} from '../../../../../platform/ports/media-devices.port';
import {PlatformCapabilities} from '../../../../../platform/capabilities';

type NoiseSuppressionMode = AudioSettings['noiseSuppressionMode'];

/** How far above the room's noise floor the gate opens at each end of the slider, in decibels. */
const MARGIN_MIN_DB = 3;
const MARGIN_MAX_DB = 18;

/** The width of the meter, in decibels above the noise floor. */
const METER_RANGE_DB = 24;

function marginFor(threshold: number): number {
    return MARGIN_MIN_DB + ((MARGIN_MAX_DB - MARGIN_MIN_DB) * clamp(threshold, 0, 100)) / 100;
}

function clamp(value: number, low: number, high: number): number {
    return Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : low;
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

    private readonly engine = inject(VoiceEngineService);

    /**
     * What this host can do, for the three gates on this page: the output picker, push-to-talk, and
     * whether voice activity is the substitute for a bound key rather than one mode among two.
     */
    protected readonly capabilities = inject(PlatformCapabilities);

    /** The browser's own speech gate, read for its live level and its threshold. */
    protected readonly vad = inject(VoiceActivityService);

    /**
     * Mic and speaker lists come from the shared catalog, so this page and the bottom bar's device
     * chevrons can never disagree about what is plugged in.
     */
    readonly micOptions = computed<DeviceOption[]>(() =>
        this.catalog.mics().length ? this.catalog.mics() : [{label: 'Default', value: 'default'}]);
    readonly speakerOptions = computed<DeviceOption[]>(() =>
        this.catalog.speakers().length ? this.catalog.speakers() : [{label: 'Default', value: 'default'}]);

    /** Whether choosing an output device does anything on this host. */
    readonly outputSelectable = computed(() => this.catalog.outputSupport().selectable);

    /** Whether the device lists are showing stand-in names. */
    readonly deviceNamesWithheld = computed(() => this.catalog.namesWithheld());
    readonly cameraOptions = signal<DeviceOption[]>([{label: 'None', value: ''}]);
    /** Mirrors Discord's None / Standard / Krisp. */
    readonly noiseSuppressionOptions: { label: string; value: NoiseSuppressionMode }[] = [
        {label: 'None', value: 'none'},
        {label: 'Standard', value: 'standard'},
        {label: 'Enhanced (RNNoise)', value: 'enhanced'},
    ];
    readonly inputModeOptions: {value: 'voice-activity' | 'push-to-talk'; label: string; desc: string}[] = [
        {value: 'voice-activity', label: 'Voice Activity', desc: 'Transmit automatically when your mic level crosses the sensitivity threshold below'},
        {value: 'push-to-talk', label: 'Push to Talk', desc: 'Only transmit while your bound key is held - bind it on the Keybinds page'},
    ];

    /** Whether push-to-talk can be chosen at all. */
    readonly canPushToTalk = this.capabilities.globalHotkeys;

    /** Whether voice activity is what actually keys the microphone. */
    readonly voiceActivityInForce = computed(() =>
        !this.canPushToTalk || this.inputMode === 'voice-activity');
    readonly micLevel = signal(0);
    readonly isMicActive = signal(false);
    readonly isCameraActive = signal(false);
    readonly cameraStream = signal<MediaStream | null>(null);

    // ── Persisted settings: setters write through to AudioSettingsService ───
    readonly isVoiceTesting = signal(false);
    readonly permissionError = signal(false);
    readonly micBars = Array.from({length: 24}, (_, i) => i);
    private audioSettings = inject(AudioSettingsService);
    private catalog = inject(MediaDeviceCatalogService);
    /**
     * Cameras come straight from the port rather than from the catalog: this is the only surface
     * that picks one, so there is nothing yet for a shared list to keep in agreement.
     */
    private deviceSource = inject(MediaDeviceSource);
    private proximity = inject(IsleProximityService);
    private zone = inject(NgZone);
    private audioCtx: AudioContext | null = null;
    private analyser: AnalyserNode | null = null;
    private gainNode: GainNode | null = null;
    private micStream: MediaStream | null = null;
    private animFrameId: number | null = null;
    private lastTick = 0;
    private cameraTestGeneration = 0;
    /** Whether the mic test, rather than a call, is what started the browser gate. */
    private vadOwnedByMicTest = false;

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

    get noiseSuppressionMode(): NoiseSuppressionMode {
        return this.audioSettings.settings().noiseSuppressionMode;
    }

    set noiseSuppressionMode(v: NoiseSuppressionMode) {
        this.audioSettings.update({noiseSuppressionMode: v});
    }

    get inputVolume(): number {
        return this.audioSettings.settings().inputVolume;
    }

    set inputVolume(v: number) {
        this.audioSettings.update({inputVolume: v});
    }

    get outputVolume(): number {
        return this.audioSettings.settings().outputVolume;
    }

    set outputVolume(v: number) {
        this.audioSettings.update({outputVolume: v});
    }

    get inputMode(): 'voice-activity' | 'push-to-talk' {
        return this.audioSettings.settings().inputMode;
    }

    set inputMode(v: 'voice-activity' | 'push-to-talk') {
        this.audioSettings.update({inputMode: v});
    }

    get voiceThreshold(): number {
        return this.audioSettings.settings().voiceThreshold;
    }

    set voiceThreshold(v: number) {
        this.audioSettings.update({voiceThreshold: Math.round(clamp(v, 0, 100))});
    }

    /** Where the handle sits on the meter, as a percentage of its width. */
    readonly cutoffPercent = computed(() => (marginFor(this.thresholdSetting()) / METER_RANGE_DB) * 100);

    /** How far the live level has filled the meter, as a percentage of its width. */
    readonly levelPercent = computed(() => {
        const level = this.engine.levelDb();
        if (level <= SILENCE_DBFS) return 0;
        return clamp(((level - this.floorDb()) / METER_RANGE_DB) * 100, 0, 100);
    });

    /** Whether the level has reached the handle - the same condition as the gate being open. */
    readonly overCutoff = computed(() => this.levelPercent() > this.cutoffPercent());

    /** Green only once the bar is past the handle; the part below it stays amber. */
    readonly greenPercent = computed(() => Math.max(0, this.levelPercent() - this.cutoffPercent()));
    readonly amberPercent = computed(() => Math.min(this.levelPercent(), this.cutoffPercent()));

    /** Whether the engine is running, and so whether the bar means anything yet. */
    readonly metering = computed(() => this.engine.active());

    // ── The browser gate's own meter ─────────────────────────────────────────
    //
    // A separate meter, not a branch on the one above: the two gates measure against different
    // reference points, so a shared axis would misplace the handle. Both must be drawn through
    // `vadMeterScale`, the same mapping the threshold and level are compared under.

    /** How far the live input has filled the browser gate's meter, as a percentage of its width. */
    readonly vadLevelPercent = computed(() => this.vad.meter() * 100);

    /** Where the cutoff sits on that meter. Driven by the gate's own threshold, not by the setting. */
    readonly vadCutoffPercent = computed(() => vadMeterScale(this.vad.threshold()) * 100);

    /** Green past the handle, amber below it. Same split as the desktop meter. */
    readonly vadGreenPercent = computed(() => Math.max(0, this.vadLevelPercent() - this.vadCutoffPercent()));
    readonly vadAmberPercent = computed(() => Math.min(this.vadLevelPercent(), this.vadCutoffPercent()));

    /** The gate itself, so the handle can show the moment it opens. */
    readonly vadOpen = computed(() => this.vad.speaking());

    /** Whether anything is feeding the gate, and so whether its bar means anything. */
    readonly vadRunning = computed(() => this.vad.running());

    /** The room's noise floor, in dBFS, backed out of the cutoff the engine reports. */
    private readonly floorDb = computed(() => this.engine.thresholdDb() - marginFor(this.thresholdSetting()));

    /** The stored setting as a signal, so the computeds above recompute when it is dragged. */
    private readonly thresholdSetting = computed(() => this.audioSettings.settings().voiceThreshold);

    private dragging = false;

    /** Follow the pointer for as long as it is down, wherever it goes. */
    onMeterPointerDown(event: PointerEvent, track: HTMLElement): void {
        this.dragging = true;
        (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
        this.applyPointer(event, track);
        event.preventDefault();
    }

    onMeterPointerMove(event: PointerEvent, track: HTMLElement): void {
        if (this.dragging) this.applyPointer(event, track);
    }

    onMeterPointerUp(): void {
        this.dragging = false;
    }

    /** Arrow keys move the handle, so the control is not pointer-only. */
    onMeterKeyDown(event: KeyboardEvent): void {
        const step = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -5
            : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 5
                : event.key === 'Home' ? -100
                    : event.key === 'End' ? 100 : 0;
        if (!step) return;
        this.voiceThreshold = this.voiceThreshold + step;
        event.preventDefault();
    }

    private applyPointer(event: PointerEvent, track: HTMLElement): void {
        const {left, width} = track.getBoundingClientRect();
        if (!width) return;
        // The pointer lands on the meter's dB axis; the setting is the margin that puts the cutoff
        // there. Inverse of `cutoffPercent`, and the only place the mapping runs backwards.
        const margin = (clamp((event.clientX - left) / width, 0, 1)) * METER_RANGE_DB;
        this.voiceThreshold = ((margin - MARGIN_MIN_DB) / (MARGIN_MAX_DB - MARGIN_MIN_DB)) * 100;
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
        // Audio goes through the shared catalog; cameras through the port directly.
        void this.catalog.refresh();

        try {
            const cameras = await this.deviceSource.cameras();
            this.cameraOptions.set([
                {label: 'None', value: ''},
                ...cameras.map(d => ({label: d.label, value: d.id})),
            ]);
        } catch (e) {
            console.error('[devices] camera enumeration failed', e);
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
            // The browser gate, fed from the test stream so its threshold can be set outside a call.
            // Skipped while a call is live: the publisher owns the gate then, and repointing it at the
            // test capture would gate the call on the wrong microphone.
            if (this.capabilities.voiceActivityDetection && !this.engine.active()) {
                this.vad.start(this.micStream);
                this.vadOwnedByMicTest = true;
            }
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
        if (this.vadOwnedByMicTest) {
            this.vad.stop();
            this.vadOwnedByMicTest = false;
        }
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
