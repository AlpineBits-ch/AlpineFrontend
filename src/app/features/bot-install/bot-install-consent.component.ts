import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    inject,
    input,
    OnInit,
    output,
    signal,
} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {BotInstallService} from '../../services/bot-install.service';
import {GuildService} from '../../services/guild.service';
import {ToastService} from '../../services/toast.service';
import {BotAuthorizeInfoDto, BotInstallResultDto} from '../../dtos/response/bot-install.dto';
import {
    diffPermissions,
    hasPermission,
    parsePermissions,
    PERM_GROUPS,
    Permissions,
    permissionLabel,
} from '../../enums/permissions.enum';

type ConsentState = 'loading' | 'ready' | 'installing' | 'error';

@Component({
    selector: 'app-bot-install-consent',
    standalone: true,
    imports: [],
    templateUrl: './bot-install-consent.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BotInstallConsentComponent implements OnInit {
    readonly clientId = input.required<string>();
    readonly permissions = input.required<bigint>();
    readonly guildId = input.required<string>();
    readonly guildName = input<string>();
    readonly redirectUri = input<string>();

    back = output<void>();
    installed = output<BotInstallResultDto>();

    private readonly botInstallService = inject(BotInstallService);
    private readonly guildService = inject(GuildService);
    private readonly toastService = inject(ToastService);
    private readonly destroyRef = inject(DestroyRef);

    readonly info = signal<BotAuthorizeInfoDto | null>(null);
    readonly state = signal<ConsentState>('loading');
    readonly resolvedGuildName = signal<string | undefined>(undefined);
    readonly iconFailed = signal(false);

    readonly requestedMask = computed(() => parsePermissions(this.info()?.requestedPermissions));
    readonly grantableMask = computed(() => parsePermissions(this.info()?.grantablePermissions));
    readonly clampedAway = computed(() => diffPermissions(this.requestedMask(), this.grantableMask()));

    readonly grantedGroups = computed(() => {
        const mask = this.grantableMask();
        return PERM_GROUPS.map(group => ({
            label: group.label,
            perms: group.perms.filter(key => hasPermission(mask, Permissions[key])),
        })).filter(group => group.perms.length > 0);
    });

    ngOnInit(): void {
        this.resolvedGuildName.set(this.guildName());
        if (this.guildName() === undefined) {
            this.guildService
                .getGuild(this.guildId())
                .pipe(takeUntilDestroyed(this.destroyRef))
                .subscribe(guild => this.resolvedGuildName.set(guild.name));
        }

        this.botInstallService
            .getAuthorizeInfo(this.clientId(), this.permissions(), this.guildId())
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
                next: info => {
                    this.info.set(info);
                    this.state.set('ready');
                },
                error: () => this.state.set('error'),
            });
    }

    confirm(): void {
        if (this.state() !== 'ready') return;
        this.state.set('installing');
        this.botInstallService
            .authorize({
                clientId: this.clientId(),
                guildId: this.guildId(),
                permissions: this.permissions().toString(),
                redirectUri: this.redirectUri(),
            })
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
                next: result => this.installed.emit(result),
                error: err => {
                    this.toastService.httpError('Failed to install bot', err);
                    this.state.set('ready');
                },
            });
    }

    protected readonly permissionLabel = permissionLabel;
}
