import {ChangeDetectionStrategy, Component, computed, effect, inject, signal, viewChild} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PrimeTemplate} from 'primeng/api';
import {BotInstallDialogService} from './bot-install-dialog.service';
import {BotInstallGuildPickerComponent} from './bot-install-guild-picker.component';
import {BotInstallConsentComponent} from './bot-install-consent.component';
import {ToastService} from '../../services/toast.service';
import {ExternalLinkService} from '../../services/external-link.service';
import {BotInstallResultDto, ManageableGuildDto} from '../../dtos/response/bot-install.dto';

type Step = 'picker' | 'consent';

@Component({
    selector: 'app-bot-install-dialog',
    standalone: true,
    imports: [Dialog, Button, PrimeTemplate, BotInstallGuildPickerComponent, BotInstallConsentComponent],
    templateUrl: './bot-install-dialog.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BotInstallDialogComponent {
    protected readonly dialogService = inject(BotInstallDialogService);
    private readonly toastService = inject(ToastService);
    private readonly externalLinkService = inject(ExternalLinkService);

    protected readonly step = signal<Step>('picker');
    protected readonly selectedGuildId = signal<string | null>(null);
    protected readonly selectedGuildName = signal<string | undefined>(undefined);

    // Queried by type rather than referenced positionally, since the footer buttons live in
    // p-dialog's `pTemplate="footer"` ng-template - a sibling template, not a descendant of the
    // body content, so a lexical `#consent` reference wouldn't resolve there.
    protected readonly consentComponent = viewChild(BotInstallConsentComponent);

    protected readonly visible = computed(() => this.dialogService.request() !== null);
    protected readonly canGoBack = computed(() => this.step() === 'consent' && !this.dialogService.request()?.guildId);

    constructor() {
        effect(() => {
            const request = this.dialogService.request();
            if (!request) return;
            this.selectedGuildId.set(request.guildId ?? null);
            this.selectedGuildName.set(undefined);
            this.step.set(request.guildId ? 'consent' : 'picker');
        });
    }

    protected onGuildSelected(guildId: string, guilds: ManageableGuildDto[] | null): void {
        this.selectedGuildId.set(guildId);
        this.selectedGuildName.set(guilds?.find(g => g.id === guildId)?.name);
        this.step.set('consent');
    }

    protected onBack(): void {
        this.step.set('picker');
        this.selectedGuildId.set(null);
    }

    protected confirmInstall(): void {
        this.consentComponent()?.confirm();
    }

    protected onInstalled(result: BotInstallResultDto): void {
        const request = this.dialogService.request();
        this.dialogService.close();
        this.toastService.success('Bot installed');

        if (request?.redirectUri) {
            const url = new URL(request.redirectUri);
            url.searchParams.set('guild_id', result.guildId);
            url.searchParams.set('permissions', result.grantedPermissions);
            if (request.state) url.searchParams.set('state', request.state);
            void this.externalLinkService.openExternalLink(url.toString());
        }
    }

    protected dismiss(): void {
        this.dialogService.close();
    }
}
