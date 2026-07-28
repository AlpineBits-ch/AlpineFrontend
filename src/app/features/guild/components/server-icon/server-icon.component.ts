import {ChangeDetectionStrategy, Component, computed, effect, input, OnDestroy, signal} from '@angular/core';
import {NgClass} from '@angular/common';

export interface ServerData {
    id: string;
    name: string;
    icon?: string;
    isHome: boolean;
    badge?: number;
    isActive?: boolean;
    hasUnread?: boolean;
}

// Flat fallback colors for guilds without a custom icon, so the rail doesn't read as one
// uniform gray strip. Picked to sit comfortably next to the brand accent in dark mode.
const FALLBACK_PALETTE = [
    'bg-rose-500/70 text-white',
    'bg-amber-500/70 text-white',
    'bg-emerald-500/70 text-white',
    'bg-sky-500/70 text-white',
    'bg-violet-500/70 text-white',
    'bg-fuchsia-500/70 text-white',
] as const;

function hashToIndex(id: string, bucketCount: number): number {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
        hash = (hash * 31 + id.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % bucketCount;
}

@Component({
    selector: 'app-server-icon',
    imports: [NgClass],
    templateUrl: './server-icon.component.html',
    styleUrl: './server-icon.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServerIconComponent implements OnDestroy {
    serverData = input.required<ServerData>();

    protected imgSrc = signal('');
    protected imgFailed = signal(false);
    protected fallbackColorClass = computed(() =>
        FALLBACK_PALETTE[hashToIndex(this.serverData().id, FALLBACK_PALETTE.length)]
    );

    private retryCount = 0;
    private retryTimers: ReturnType<typeof setTimeout>[] = [];
    private probes: HTMLImageElement[] = [];

    constructor() {
        effect(() => {
            const newUrl = this.serverData().icon ?? '';
            if (newUrl !== this.imgSrc()) {
                this.reset(newUrl);
            }
        }, {allowSignalWrites: true});
    }

    ngOnDestroy(): void {
        this.retryTimers.forEach(t => clearTimeout(t));
        this.probes.forEach(p => {
            p.onload = null;
            p.onerror = null;
        });
    }

    protected onImgError(): void {
        this.imgFailed.set(true);
        const delays = [2000, 4000];
        if (this.retryCount < delays.length) {
            const delay = delays[this.retryCount++];
            const base = this.serverData().icon ?? '';
            const timer = setTimeout(() => {
                const sep = base.includes('?') ? '&' : '?';
                const url = `${base}${sep}_t=${Date.now()}`;
                // Probe silently -only swap back to image if the retry actually loads.
                // This prevents the fallback letter from flickering on each retry attempt.
                const probe = new Image();
                probe.onload = () => {
                    this.imgSrc.set(url);
                    this.imgFailed.set(false);
                };
                probe.src = url;
                this.probes.push(probe);
            }, delay);
            this.retryTimers.push(timer);
        }
    }

    private reset(url: string): void {
        this.retryTimers.forEach(t => clearTimeout(t));
        this.retryTimers = [];
        this.probes.forEach(p => {
            p.onload = null;
            p.onerror = null;
        });
        this.probes = [];
        this.retryCount = 0;
        this.imgFailed.set(false);
        this.imgSrc.set(url);
    }
}
