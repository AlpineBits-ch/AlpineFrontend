import {inject, Injectable, signal} from '@angular/core';
import {Router} from '@angular/router';
import {AuthService} from '../../services/auth.service';
import {InstallBotLinkParams} from './bot-install-link.util';

export type PendingInstallRequest = InstallBotLinkParams;

@Injectable({providedIn: 'root'})
export class BotInstallDialogService {
    private authService = inject(AuthService);
    private router = inject(Router);

    /** Non-null while the Install Bot modal should be visible. */
    readonly request = signal<PendingInstallRequest | null>(null);

    /** Stashed when a link arrives while logged out; drained by resumeIfPending(). */
    private pendingLink: PendingInstallRequest | null = null;

    async requestOpen(params: PendingInstallRequest): Promise<void> {
        if (await this.authService.isLoggedIn()) {
            this.request.set(params);
        } else {
            this.pendingLink = params;
            void this.router.navigate(['/authentication']);
        }
    }

    resumeIfPending(): void {
        if (this.pendingLink) {
            this.request.set(this.pendingLink);
            this.pendingLink = null;
        }
    }

    close(): void {
        this.request.set(null);
    }
}
