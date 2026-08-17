import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    effect,
    ElementRef,
    inject,
    input,
    output,
    signal,
    viewChild,
} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {firstValueFrom} from 'rxjs';
import {TranslateModule} from '@ngx-translate/core';
import {FileService} from '../../../../../../services/file.service';

/** Playback level, shared by every player in the session. */
const sharedVolume = signal(1);

/** `MediaError.code` in words, so a failure says which kind it was instead of a bare number. */
const MEDIA_ERROR_NAMES: Record<number, string> = {
    1: 'aborted',
    2: 'network',
    3: 'decode',
    4: 'format not supported',
};

/** Filled-to-`percent` track, since `appearance: none` drops the browser's own fill. */
function fillStyle(percent: number): string {
    const p = Math.min(100, Math.max(0, percent));
    return `linear-gradient(to right, var(--color-brand) ${p}%, var(--color-border) ${p}%)`;
}

/** An inline player for an audio attachment. */
@Component({
    selector: 'app-audio-attachment',
    imports: [TranslateModule],
    templateUrl: './audio-attachment.component.html',
    styleUrl: './audio-attachment.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AudioAttachmentComponent {
    /** The attachment id, not a URL. */
    readonly attachmentId = input.required<string>();
    readonly fileName = input.required<string>();
    /** The type the server recorded at upload. */
    readonly contentType = input<string>('');
    /** Mirrors the parent's save-in-flight latch, so this button greys out with the others. */
    readonly downloadDisabled = input(false);
    readonly download = output<void>();

    protected readonly playing = signal(false);
    protected readonly loading = signal(false);
    protected readonly failed = signal(false);
    /** Why it failed, in as many words as we actually have. Shown next to the message. */
    protected readonly failureDetail = signal('');
    protected readonly currentTime = signal(0);
    protected readonly duration = signal(0);
    protected readonly volume = sharedVolume;
    protected readonly muted = signal(false);

    protected readonly progressBackground = computed(() =>
        fillStyle(this.duration() > 0 ? (this.currentTime() / this.duration()) * 100 : 0),
    );
    protected readonly volumeBackground = computed(() => fillStyle((this.muted() ? 0 : this.volume()) * 100));
    protected readonly volumeIcon = computed(() => {
        if (this.muted() || this.volume() === 0) return 'pi-volume-off';
        return this.volume() < 0.5 ? 'pi-volume-down' : 'pi-volume-up';
    });

    private readonly audioRef = viewChild<ElementRef<HTMLAudioElement>>('audio');
    private readonly files = inject(FileService);
    private objectUrl: string | null = null;
    /** Set once the element has a source, so pausing and resuming does not fetch the file again. */
    private loaded = false;

    constructor() {
        effect(() => {
            const el = this.audioRef()?.nativeElement;
            if (!el) return;
            // `muted` rather than volume 0, so unmuting restores the level without storing it twice.
            el.volume = this.volume();
            el.muted = this.muted();
        });
        inject(DestroyRef).onDestroy(() => {
            this.audioRef()?.nativeElement.pause();
            this.releaseObjectUrl();
        });
    }

    private releaseObjectUrl(): void {
        if (!this.objectUrl) return;
        URL.revokeObjectURL(this.objectUrl);
        this.objectUrl = null;
    }

    protected async toggle(): Promise<void> {
        const el = this.audioRef()?.nativeElement;
        if (!el || this.loading()) return;

        if (this.playing()) {
            el.pause();
            return;
        }
        if (!this.loaded && !(await this.load())) return;
        // `play()` rejects on a codec the webview cannot decode, which is a failure to report and
        // not one to leave the button stuck showing pause.
        await el.play().catch((err: unknown) => this.fail(true, err instanceof Error ? err.name : ''));
    }

    /** The element gave up on the source. */
    protected onMediaError(): void {
        if (!this.loaded) return;
        const code = this.audioRef()?.nativeElement.error?.code;
        this.fail(true, code ? (MEDIA_ERROR_NAMES[code] ?? `code ${code}`) : '');
        // Dropped so pressing play again re-fetches rather than re-failing on a dead element.
        this.loaded = false;
        this.releaseObjectUrl();
    }

    protected onSeek(event: Event): void {
        const el = this.audioRef()?.nativeElement;
        const seconds = Number((event.target as HTMLInputElement).value);
        this.currentTime.set(seconds);
        if (el && Number.isFinite(el.duration)) el.currentTime = seconds;
    }

    protected onVolume(event: Event): void {
        // Dragging the slider is itself an unmute - leaving it muted would make the drag do nothing.
        this.muted.set(false);
        this.volume.set(Number((event.target as HTMLInputElement).value));
    }

    protected toggleMute(): void {
        // Muting at zero would be a no-op the icon claims it undid, so bring it back to audible.
        if (!this.muted() && this.volume() === 0) this.volume.set(1);
        else this.muted.update(m => !m);
    }

    protected onLoadedMetadata(): void {
        const el = this.audioRef()?.nativeElement;
        // A stream of unknown length reports Infinity; a slider cannot be drawn against that.
        this.duration.set(el && Number.isFinite(el.duration) ? el.duration : 0);
    }

    protected onTimeUpdate(): void {
        this.currentTime.set(this.audioRef()?.nativeElement.currentTime ?? 0);
    }

    protected onEnded(): void {
        this.playing.set(false);
        this.currentTime.set(0);
    }

    /** `h:mm:ss` past the hour, `m:ss` below it. */
    protected clock(seconds: number): string {
        if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
        const total = Math.floor(seconds);
        const s = (total % 60).toString().padStart(2, '0');
        const m = Math.floor(total / 60) % 60;
        const h = Math.floor(total / 3600);
        return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
    }

    private async load(): Promise<boolean> {
        const el = this.audioRef()?.nativeElement;
        if (!el) return false;

        this.loading.set(true);
        this.fail(false);
        try {
            const blob = await firstValueFrom(this.files.downloadAttachmentById(this.attachmentId()));
            this.objectUrl = URL.createObjectURL(this.retyped(blob));
            el.src = this.objectUrl;
            this.loaded = true;
            return true;
        } catch (err) {
            this.fail(true, err instanceof HttpErrorResponse ? `HTTP ${err.status}` : '');
            return false;
        } finally {
            this.loading.set(false);
        }
    }

    /** The same bytes, labelled with the type the attachment says it is. */
    private retyped(blob: Blob): Blob {
        const declared = this.contentType();
        if (blob.type.startsWith('audio/') || !declared) return blob;
        return new Blob([blob], {type: declared});
    }

    private fail(failed: boolean, detail = ''): void {
        this.failed.set(failed);
        this.failureDetail.set(failed ? detail : '');
    }
}
