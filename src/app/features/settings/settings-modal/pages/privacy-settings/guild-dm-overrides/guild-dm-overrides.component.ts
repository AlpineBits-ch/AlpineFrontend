import {Component, computed, inject, OnInit, signal} from '@angular/core';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {GuildPrivacyService} from '../../../../../../services/guild-privacy.service';
import {GuildService} from '../../../../../../services/guild.service';
import {PrivacySettingsService} from '../../../../../../services/privacy-settings.service';
import {ToastService} from '../../../../../../services/toast.service';
import {DirectMessagePolicy} from '../../../../../../models/privacy-settings.model';

/** Per-server direct message overrides (T2-14). */
@Component({
    selector: 'app-guild-dm-overrides',
    imports: [ToggleSwitch, FormsModule, TranslateModule],
    templateUrl: './guild-dm-overrides.component.html',
})
export class GuildDmOverridesComponent implements OnInit {
    private readonly guildPrivacy = inject(GuildPrivacyService);
    private readonly guildService = inject(GuildService);
    private readonly privacy = inject(PrivacySettingsService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    protected readonly guilds = this.guildService.guilds;
    protected readonly pending = signal<ReadonlySet<string>>(new Set());

    protected readonly applies = computed(() =>
        this.privacy.isReady()
        && this.privacy.settings().directMessagePolicy === DirectMessagePolicy.FriendsAndServerMembers,
    );

    ngOnInit(): void {
        if (!this.guildPrivacy.loaded()) this.guildPrivacy.load().subscribe({error: () => void 0});
    }

    protected allows(guildId: string): boolean {
        return this.guildPrivacy.allowsDirectMessages()(guildId);
    }

    protected isPending(guildId: string): boolean {
        return this.pending().has(guildId);
    }

    protected toggle(guildId: string, allow: boolean): void {
        if (this.isPending(guildId)) return;
        this.markPending(guildId, true);

        this.guildPrivacy.setAllowDirectMessages(guildId, allow).subscribe({
            next: () => this.markPending(guildId, false),
            error: () => {
                this.markPending(guildId, false);
                this.toast.error(this.translate.instant('GUILD_SETTINGS.PRIVACY.SAVE_ERROR'));
            },
        });
    }

    private markPending(guildId: string, active: boolean): void {
        const next = new Set(this.pending());
        if (active) next.add(guildId); else next.delete(guildId);
        this.pending.set(next);
    }
}
