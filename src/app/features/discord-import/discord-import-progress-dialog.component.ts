import {ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Subscription, timer, switchMap, takeWhile, catchError, throwError, EMPTY} from 'rxjs';
import {DiscordImportProgressService} from './discord-import-progress.service';
import {DiscordImportService} from '../../services/discord-import.service';
import {GuildService} from '../../services/guild.service';
import {NavigationService} from '../main-page/navigation.service';
import {ToastService} from '../../services/toast.service';
import {ImportJobDto, ImportJobStatus} from '../../dtos/response/discord-import.dto';

const POLL_INTERVAL_MS = 1500;
const TERMINAL_STATUSES: ImportJobStatus[] = ['Completed', 'Failed'];
// A single poll tick failing (transient 502, brief network drop) shouldn't kill the whole
// poll chain - the import is very likely still running server-side. Only escalate to the
// fatal error handler after this many *consecutive* failed ticks.
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

@Component({
    selector: 'app-discord-import-progress-dialog',
    imports: [Dialog, Button, PrimeTemplate, TranslateModule],
    templateUrl: './discord-import-progress-dialog.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DiscordImportProgressDialogComponent {
    protected readonly dialogService = inject(DiscordImportProgressService);
    private readonly discordImportService = inject(DiscordImportService);
    private readonly guildService = inject(GuildService);
    private readonly navigationService = inject(NavigationService);
    private readonly toastService = inject(ToastService);
    private readonly translate = inject(TranslateService);
    private readonly destroyRef = inject(DestroyRef);

    protected readonly visible = computed(() => this.dialogService.request() !== null);
    protected readonly job = signal<ImportJobDto | null>(null);

    private pollSub: Subscription | null = null;

    protected readonly statusLabel = computed(() => {
        const status = this.job()?.status;
        switch (status) {
            case 'Pending':
                return this.translate.instant('DISCORD_IMPORT.STATUS_PENDING');
            case 'FetchingFromDiscord':
                return this.translate.instant('DISCORD_IMPORT.STATUS_FETCHING');
            case 'CreatingGuild':
                return this.translate.instant('DISCORD_IMPORT.STATUS_CREATING');
            case 'Completed':
                return this.translate.instant('DISCORD_IMPORT.STATUS_COMPLETED');
            case 'Failed':
                return this.translate.instant('DISCORD_IMPORT.STATUS_FAILED');
            default:
                return this.translate.instant('DISCORD_IMPORT.STATUS_PENDING');
        }
    });

    constructor() {
        effect(() => {
            const request = this.dialogService.request();
            this.pollSub?.unsubscribe();
            this.pollSub = null;
            this.job.set(null);
            if (!request) return;

            // timer(0, POLL_INTERVAL_MS) fires immediately, then every POLL_INTERVAL_MS after -
            // giving an instant first check without a second, uncoordinated subscription that
            // could race the interval and double-fire onCompleted().
            let consecutivePollFailures = 0;
            this.pollSub = timer(0, POLL_INTERVAL_MS).pipe(
                switchMap(() => this.discordImportService.getJob(request.jobId).pipe(
                    catchError(err => {
                        consecutivePollFailures++;
                        if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
                            return throwError(() => err);
                        }
                        // Skip this tick - the next timer interval will retry.
                        return EMPTY;
                    }),
                )),
                takeWhile(job => !TERMINAL_STATUSES.includes(job.status), true),
                takeUntilDestroyed(this.destroyRef),
            ).subscribe({
                next: job => {
                    consecutivePollFailures = 0;
                    this.job.set(job);
                    if (job.status === 'Completed') {
                        if (job.guildId) {
                            this.onCompleted(job.guildId);
                        } else {
                            // Terminal status with no guildId to navigate to - don't leave the
                            // dialog spinning forever, surface it as an error and let go.
                            this.toastService.error(this.translate.instant('DISCORD_IMPORT.GUILD_NOT_FOUND'));
                            this.dialogService.close();
                        }
                    }
                },
                error: err => {
                    this.toastService.httpError(this.translate.instant('DISCORD_IMPORT.POLL_ERROR'), err);
                    this.dialogService.close();
                },
            });
        });
    }

    protected dismiss(): void {
        this.dialogService.close();
    }

    private onCompleted(guildId: string): void {
        this.pollSub?.unsubscribe();
        this.pollSub = null;
        this.guildService.getGuild(guildId).subscribe({
            next: guild => {
                this.guildService.guildJoined$.next();
                this.navigationService.selectServer(guild);
                this.toastService.success(this.translate.instant('DISCORD_IMPORT.SUCCESS_TOAST', {name: guild.name}));
                this.dialogService.close();
            },
            error: err => {
                this.toastService.httpError(this.translate.instant('DISCORD_IMPORT.POLL_ERROR'), err);
                this.dialogService.close();
            },
        });
    }
}
