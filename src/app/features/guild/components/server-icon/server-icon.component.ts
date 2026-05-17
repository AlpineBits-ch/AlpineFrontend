import {ChangeDetectionStrategy, Component, effect, input, OnDestroy, signal} from '@angular/core';
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
                // Probe silently — only swap back to image if the retry actually loads.
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
