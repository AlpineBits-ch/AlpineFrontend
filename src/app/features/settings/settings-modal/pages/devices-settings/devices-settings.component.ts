import {ChangeDetectionStrategy, Component, computed, inject, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {Tooltip} from 'primeng/tooltip';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {LoginSessionsService} from '../../../../../services/login-sessions.service';
import {DeviceService} from '../../../../../services/device.service';
import {DeviceIdentityService} from '../../../../../services/device-identity.service';
import {IdentityWebsocketService} from '../../../../../services/identity-websocket.service';
import {ToastService} from '../../../../../services/toast.service';
import {LoginSessionDto} from '../../../../../dtos/response/login-session.dto';
import {DeviceType} from '../../../../../dtos/response/user-device.dto';
import {KeyBackupRestoreComponent} from '../../../key-backup-restore/key-backup-restore.component';

@Component({
    selector: 'app-devices-settings',
    imports: [Button, Dialog, Tooltip, TranslateModule, KeyBackupRestoreComponent],
    templateUrl: './devices-settings.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DevicesSettingsComponent {
    protected readonly sessions = signal<LoginSessionDto[]>([]);
    protected readonly loading = signal(true);
    protected readonly loadFailed = signal(false);
    /** Id of the session a revoke request is currently in flight for. */
    protected readonly revoking = signal<string | null>(null);
    protected readonly pendingRevoke = signal<LoginSessionDto | null>(null);
    /** Client device id of this installation, used to mark our own row. */
    protected readonly ownDeviceId = signal<string | null>(null);
    /** Client device id a forget request is currently in flight for. */
    protected readonly forgetting = signal<string | null>(null);
    protected readonly pendingForget = signal<LoginSessionDto | null>(null);

    /** Current session first: it is the one the reader is trying to identify themselves against. */
    protected readonly ordered = computed(() =>
        [...this.sessions()].sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent)),
    );

    private sessionsService = inject(LoginSessionsService);
    private deviceService = inject(DeviceService);
    private deviceIdentity = inject(DeviceIdentityService);
    private identityEvents = inject(IdentityWebsocketService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    constructor() {
        this.load();
        // Marks the row belonging to this installation. `isCurrent` only identifies the token
        // that made the request; this identifies the machine, which is what the user recognises.
        void this.deviceIdentity
            .deviceId()
            .then(id => this.ownDeviceId.set(id))
            .catch(() => this.ownDeviceId.set(null));

        // Re-read rather than patch: the push names one device and this list is sessions, so there
        // is no row to insert, and a stale list here is the worst possible thing to show.
        this.identityEvents.deviceRosterChanged$.pipe(takeUntilDestroyed()).subscribe(() => this.load());
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

    protected isThisDevice(session: LoginSessionDto): boolean {
        const own = this.ownDeviceId();
        return session.isCurrent || (!!own && session.clientDeviceId === own);
    }

    protected confirmForget(session: LoginSessionDto): void {
        this.pendingForget.set(session);
    }

    protected forget(): void {
        const session = this.pendingForget();
        if (!session?.clientDeviceId || this.forgetting()) return;

        const clientDeviceId = session.clientDeviceId;
        this.forgetting.set(clientDeviceId);
        this.deviceService.deleteDevice(clientDeviceId).subscribe({
            next: () => {
                // Every session from that device is revoked server-side, so drop them all rather
                // than only the row that was clicked.
                this.sessions.update(list => list.filter(s => s.clientDeviceId !== clientDeviceId));
                this.forgetting.set(null);
                this.pendingForget.set(null);
                this.toast.success(
                    this.translate.instant('SETTINGS.DEVICES.FORGOTTEN', {device: session.deviceName}),
                );
            },
            error: err => {
                this.forgetting.set(null);
                this.pendingForget.set(null);
                this.toast.httpError(this.translate.instant('SETTINGS.DEVICES.FORGET_FAILED'), err);
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

    /** Coarse "2 hours ago" phrasing: a session list is scanned, not audited to the minute. */
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
