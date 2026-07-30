import {ChangeDetectionStrategy, Component, computed, inject, input, OnInit, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {Textarea} from 'primeng/textarea';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {MultiSelect} from 'primeng/multiselect';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {ChannelType, GuildDto} from '../../../../../../dtos/response/guild.dto';
import {OnboardingConfig} from '../../../../../../dtos/response/guild-safety.dto';
import {GuildSafetyService} from '../../../../../../services/guild-safety.service';
import {ToastService} from '../../../../../../services/toast.service';

@Component({
    selector: 'app-onboarding-settings',
    imports: [FormsModule, Button, Textarea, ToggleSwitch, MultiSelect, TranslateModule],
    templateUrl: './onboarding-settings.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OnboardingSettingsComponent implements OnInit {
    guild = input.required<GuildDto>();

    protected loading = signal(true);
    protected saving = signal(false);
    protected enabled = signal(false);
    protected rulesText = signal('');
    protected defaultChannelIds = signal<string[]>([]);
    protected rulesRequiredError = signal(false);

    protected channelOptions = computed(() =>
        this.guild().channels
            .filter(c => c.type === ChannelType.Text)
            .map(c => ({label: c.name, value: c.id}))
    );

    private safety = inject(GuildSafetyService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    ngOnInit(): void {
        this.safety.getOnboardingConfig(this.guild().id).subscribe({
            next: cfg => {
                this.enabled.set(cfg.enabled);
                this.rulesText.set(cfg.rulesText ?? '');
                this.defaultChannelIds.set(cfg.defaultChannelIds ?? []);
                this.loading.set(false);
            },
            error: err => {
                this.loading.set(false);
                this.toast.httpError(this.translate.instant('GUILD_SETTINGS.ONBOARDING.LOAD_ERROR'), err);
            },
        });
    }

    protected onRulesTextChange(value: string): void {
        this.rulesText.set(value);
        if (this.rulesRequiredError()) this.rulesRequiredError.set(false);
    }

    protected save(): void {
        if (this.saving()) return;

        // Mirrors the server: enabling onboarding without rules text 400s, so catch it
        // here instead of round-tripping for an error the client already knows about.
        if (this.enabled() && !this.rulesText().trim()) {
            this.rulesRequiredError.set(true);
            return;
        }
        this.rulesRequiredError.set(false);

        const config: OnboardingConfig = {
            enabled: this.enabled(),
            rulesText: this.rulesText().trim() ? this.rulesText() : null,
            defaultChannelIds: this.defaultChannelIds(),
        };

        this.saving.set(true);
        this.safety.updateOnboardingConfig(this.guild().id, config).subscribe({
            next: () => {
                this.saving.set(false);
                this.toast.success(this.translate.instant('GUILD_SETTINGS.ONBOARDING.SAVE_SUCCESS'));
            },
            error: err => {
                this.saving.set(false);
                this.toast.httpError(this.translate.instant('GUILD_SETTINGS.ONBOARDING.SAVE_ERROR'), err);
            },
        });
    }
}
