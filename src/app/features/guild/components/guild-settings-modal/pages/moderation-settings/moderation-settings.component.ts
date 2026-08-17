import {ChangeDetectionStrategy, Component, inject, input, OnInit, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {InputNumber} from 'primeng/inputnumber';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {AutoModConfig} from '../../../../../../dtos/response/guild-safety.dto';
import {GuildSafetyService} from '../../../../../../services/guild-safety.service';
import {ToastService} from '../../../../../../services/toast.service';

@Component({
    selector: 'app-moderation-settings',
    imports: [FormsModule, Button, InputText, InputNumber, ToggleSwitch, TranslateModule],
    templateUrl: './moderation-settings.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModerationSettingsComponent implements OnInit {
    readonly guild = input.required<GuildDto>();

    protected readonly loading = signal(true);
    protected readonly saving = signal(false);
    protected readonly enabled = signal(false);
    protected readonly blockedWords = signal<string[]>([]);
    protected readonly wordDraft = signal('');
    protected readonly rateLimitOn = signal(false);
    protected readonly maxMessages = signal<number | null>(null);
    protected readonly intervalSeconds = signal<number | null>(null);

    private safety = inject(GuildSafetyService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    ngOnInit(): void {
        this.safety.getAutoModConfig(this.guild().id).subscribe({
            next: cfg => {
                this.enabled.set(cfg.enabled);
                this.blockedWords.set(cfg.blockedWords ?? []);
                const hasRate = cfg.maxMessagesPerInterval != null && cfg.intervalSeconds != null;
                this.rateLimitOn.set(hasRate);
                this.maxMessages.set(cfg.maxMessagesPerInterval ?? null);
                this.intervalSeconds.set(cfg.intervalSeconds ?? null);
                this.loading.set(false);
            },
            error: err => {
                this.loading.set(false);
                this.toast.httpError(this.translate.instant('GUILD_SETTINGS.MODERATION.LOAD_ERROR'), err);
            },
        });
    }

    protected addWord(): void {
        const word = this.wordDraft().trim();
        if (!word) return;
        // Matching is case-insensitive server-side, so fold case here too rather than letting "Spam" and "spam" both sit in the list looking like distinct rules.
        if (this.blockedWords().some(w => w.toLowerCase() === word.toLowerCase())) {
            this.wordDraft.set('');
            return;
        }
        this.blockedWords.update(list => [...list, word]);
        this.wordDraft.set('');
    }

    protected removeWord(word: string): void {
        this.blockedWords.update(list => list.filter(w => w !== word));
    }

    protected save(): void {
        if (this.saving()) return;

        // The backend rejects a half-configured rate limit (one field set, the other null), so treat the toggle as authoritative and send both or neither.
        if (this.rateLimitOn() && (!this.maxMessages() || !this.intervalSeconds())) {
            this.toast.error(this.translate.instant('GUILD_SETTINGS.MODERATION.RATE_LIMIT_INCOMPLETE'));
            return;
        }

        const config: AutoModConfig = {
            enabled: this.enabled(),
            blockedWords: this.blockedWords(),
            maxMessagesPerInterval: this.rateLimitOn() ? this.maxMessages() : null,
            intervalSeconds: this.rateLimitOn() ? this.intervalSeconds() : null,
        };

        this.saving.set(true);
        this.safety.updateAutoModConfig(this.guild().id, config).subscribe({
            next: () => {
                this.saving.set(false);
                this.toast.success(this.translate.instant('GUILD_SETTINGS.MODERATION.SAVE_SUCCESS'));
            },
            error: err => {
                this.saving.set(false);
                this.toast.httpError(this.translate.instant('GUILD_SETTINGS.MODERATION.SAVE_ERROR'), err);
            },
        });
    }
}
