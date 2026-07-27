import {inject, Injectable, signal} from '@angular/core';
import {Router} from '@angular/router';
import {Subject} from 'rxjs';
import {AuthService} from '../../services/auth.service';
import {InstallBotLinkParams} from './bot-install-link.util';

export type PendingInstallRequest = InstallBotLinkParams;

@Injectable({providedIn: 'root'})
export class BotInstallDialogService {
    private authService = inject(AuthService);
    private router = inject(Router);

    /** Non-null while the Install Bot modal should be visible. */
    readonly request = signal<PendingInstallRequest | null>(null);

    // Stopgap so open member lists can refresh themselves after a bot is installed into their
    // guild - there's no MemberJoined websocket event yet, so we broadcast this locally instead.
    // TODO: replace with a guild.MemberJoined websocket event once the backend sends one.
    readonly installedIntoGuild = new Subject<string>();

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
