import {ChangeDetectionStrategy, Component, computed, inject, signal} from '@angular/core';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {Tooltip} from 'primeng/tooltip';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {LoginSessionsService} from '../../../../../services/login-sessions.service';
import {ToastService} from '../../../../../services/toast.service';
import {LoginSessionDto} from '../../../../../dtos/response/login-session.dto';
import {DeviceType} from '../../../../../dtos/response/user-device.dto';

@Component({
    selector: 'app-devices-settings',
    imports: [Button, Dialog, Tooltip, TranslateModule],
    templateUrl: './devices-settings.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DevicesSettingsComponent {
    protected sessions = signal<LoginSessionDto[]>([]);
    protected loading = signal(true);
    protected loadFailed = signal(false);
    /** Id of the session a revoke request is currently in flight for. */
    protected revoking = signal<string | null>(null);
    protected pendingRevoke = signal<LoginSessionDto | null>(null);

    /** Current session first -it is the one the reader is trying to identify themselves against. */
    protected ordered = computed(() =>
        [...this.sessions()].sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent)),
    );

    private sessionsService = inject(LoginSessionsService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    constructor() {
        this.load();
    }

    protected load(): void {
        this.loading.set(true);
        this.loadFailed.set(false);
        this.sessionsService.list().subscribe({
            next: sessions => {
                this.sessions.set(sessions);
                this.loading.set(false);
            },
            error: err => {
                this.loading.set(false);
                this.loadFailed.set(true);
                this.toast.httpError(this.translate.instant('SETTINGS.DEVICES.LOAD_FAILED'), err);
            },
        });
    }

    protected confirmRevoke(session: LoginSessionDto): void {
        this.pendingRevoke.set(session);
    }

    protected revoke(): void {
        const session = this.pendingRevoke();
        if (!session || this.revoking()) return;

        this.revoking.set(session.id);
        this.sessionsService.revoke(session.id).subscribe({
            next: () => {
                this.sessions.update(list => list.filter(s => s.id !== session.id));
                this.revoking.set(null);
                this.pendingRevoke.set(null);
                this.toast.success(
                    this.translate.instant('SETTINGS.DEVICES.REVOKED', {device: session.deviceName}),
                );
            },
            error: err => {
                this.revoking.set(null);
                this.pendingRevoke.set(null);
                this.toast.httpError(this.translate.instant('SETTINGS.DEVICES.REVOKE_FAILED'), err);
            },
        });
    }

    protected icon(type: DeviceType): string {
        switch (type) {
            case DeviceType.Mobile:
                return 'pi pi-mobile';
            case DeviceType.Web:
                return 'pi pi-globe';
            default:
                return 'pi pi-desktop';
        }
    }

    /** Coarse "2 hours ago" phrasing -a session list is scanned, not audited to the minute. */
    protected relative(iso: string): string {
        const then = new Date(iso).getTime();
        if (Number.isNaN(then)) return '';

        const seconds = Math.round((then - Date.now()) / 1000);
        const units: [Intl.RelativeTimeFormatUnit, number][] = [
            ['year', 31_536_000],
            ['month', 2_592_000],
            ['day', 86_400],
            ['hour', 3_600],
            ['minute', 60],
        ];
        const fmt = new Intl.RelativeTimeFormat(this.translate.currentLang || 'en', {numeric: 'auto'});

        for (const [unit, size] of units) {
            if (Math.abs(seconds) >= size) return fmt.format(Math.round(seconds / size), unit);
        }
        return fmt.format(0, 'minute');
    }

    protected absolute(iso: string): string {
        const date = new Date(iso);
        return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
    }
}
