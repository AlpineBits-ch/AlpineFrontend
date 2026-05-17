import {Injectable, signal} from '@angular/core';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {PlatformService} from './platform.service';

@Injectable({providedIn: 'root'})
export class RichPresenceService {
    private readonly _currentGame = signal<string | null>(null);
    readonly currentGame = this._currentGame.asReadonly();

    private pollInterval?: ReturnType<typeof setInterval>;

    constructor(private platform: PlatformService) {
    }

    start(intervalMs = 15_000): void {
        if (!isTauri() || this.platform.isMobile) return;
        void this.scan();
        this.pollInterval = setInterval(() => this.scan(), intervalMs);
    }

    stop(): void {
        clearInterval(this.pollInterval);
        this.pollInterval = undefined;
        this._currentGame.set(null);
    }

    private async scan(): Promise<void> {
        try {
            const game = await invoke<string | null>('scan_game_process');
            this._currentGame.set(game ?? null);
        } catch (e) {
            console.warn('[RichPresence] scan_game_process failed', e);
        }
    }
}
