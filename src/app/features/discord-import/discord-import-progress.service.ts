import {inject, Injectable, signal} from '@angular/core';
import {Router} from '@angular/router';
import {TranslateService} from '@ngx-translate/core';
import {AuthService} from '../../services/auth.service';
import {ToastService} from '../../services/toast.service';
import {DiscordImportLinkParams} from './discord-import-link.util';

export interface DiscordImportProgressRequest {
    jobId: string;
}

@Injectable({providedIn: 'root'})
export class DiscordImportProgressService {
    private authService = inject(AuthService);
    private router = inject(Router);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);

    /** Non-null while the import progress dialog should be visible. */
    readonly request = signal<DiscordImportProgressRequest | null>(null);

    /** Stashed when a link arrives while logged out; drained by resumeIfPending(). */
    private pendingJobId: string | null = null;

    async requestOpen(params: DiscordImportLinkParams): Promise<void> {
        if (params.error) {
            this.toastService.error(
                this.translate.instant('DISCORD_IMPORT.LINK_ERROR_TOAST', {error: params.error}),
            );
            return;
        }
        if (!params.jobId) return;

        if (await this.authService.isLoggedIn()) {
            this.request.set({jobId: params.jobId});
        } else {
            this.pendingJobId = params.jobId;
            void this.router.navigate(['/authentication']);
        }
    }

    resumeIfPending(): void {
        if (this.pendingJobId) {
            this.request.set({jobId: this.pendingJobId});
            this.pendingJobId = null;
        }
    }

    close(): void {
        this.request.set(null);
    }
}
