import {ChangeDetectionStrategy, Component, computed, DestroyRef, inject, input, OnInit, output, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {InputText} from 'primeng/inputtext';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {BotInstallService} from '../../services/bot-install.service';
import {ApiConfigService} from '../../services/api-config.service';
import {ManageableGuildDto} from '../../dtos/response/bot-install.dto';

@Component({
    selector: 'app-bot-install-guild-picker',
    standalone: true,
    imports: [InputText, FormsModule, Button],
    templateUrl: './bot-install-guild-picker.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BotInstallGuildPickerComponent implements OnInit {
    readonly clientId = input.required<string>();
    guildSelected = output<string>();

    protected readonly botInstallService = inject(BotInstallService);
    private readonly apiConfig = inject(ApiConfigService);
    private readonly destroyRef = inject(DestroyRef);

    readonly guilds = signal<ManageableGuildDto[] | null>(null);
    readonly error = signal(false);
    readonly search = signal('');
    readonly iconFailedFor = signal<Set<string>>(new Set());

    readonly filteredGuilds = computed(() => {
        const list = this.guilds() ?? [];
        const query = this.search().trim().toLowerCase();
        if (!query) return list;
        return list.filter(g => g.name.toLowerCase().includes(query));
    });

    ngOnInit(): void {
        this.fetchGuilds();
    }

    fetchGuilds(): void {
        this.error.set(false);
        this.guilds.set(null);
        this.botInstallService.getManageableGuilds(this.clientId())
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
                next: guilds => this.guilds.set(guilds),
                error: () => this.error.set(true),
            });
    }

    selectGuild(guild: ManageableGuildDto): void {
        this.guildSelected.emit(guild.id);
    }

    iconUrl(guild: ManageableGuildDto): string {
        return `${this.apiConfig.baseUrl()}/api/v1/guild/guilds/${guild.id}/icon`;
    }

    iconFailed(guild: ManageableGuildDto): boolean {
        return this.iconFailedFor().has(guild.id);
    }

    onIconError(guild: ManageableGuildDto): void {
        this.iconFailedFor.update(set => new Set(set).add(guild.id));
    }

    initials(name: string): string {
        return name.split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('');
    }
}
