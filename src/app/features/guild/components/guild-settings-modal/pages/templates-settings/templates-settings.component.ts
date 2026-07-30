import {ChangeDetectionStrategy, Component, inject, input, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Tooltip} from 'primeng/tooltip';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {CreatedTemplateDto, GuildTemplateService} from '../../../../../../services/guild-template.service';
import {ToastService} from '../../../../../../services/toast.service';

@Component({
    selector: 'app-templates-settings',
    imports: [FormsModule, Button, InputText, Tooltip, TranslateModule],
    templateUrl: './templates-settings.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplatesSettingsComponent {
    guild = input.required<GuildDto>();

    name = signal('');
    description = signal('');
    saving = signal(false);
    created = signal<CreatedTemplateDto | null>(null);
    copied = signal(false);

    private guildTemplateService = inject(GuildTemplateService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);

    save(): void {
        const trimmedName = this.name().trim();
        if (!trimmedName || this.saving()) return;
        this.saving.set(true);
        this.guildTemplateService.createFromGuild(this.guild().id, {
            name: trimmedName,
            description: this.description().trim() || undefined,
        }).subscribe({
            next: template => {
                this.saving.set(false);
                this.created.set(template);
            },
            error: err => {
                this.saving.set(false);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.TEMPLATES.SAVE_ERROR_TOAST'), err);
            },
        });
    }

    copyId(): void {
        const template = this.created();
        if (!template) return;
        navigator.clipboard.writeText(template.id).then(() => {
            this.copied.set(true);
            setTimeout(() => this.copied.set(false), 2000);
        });
    }

    createAnother(): void {
        this.created.set(null);
        this.name.set('');
        this.description.set('');
    }
}
