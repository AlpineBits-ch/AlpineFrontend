import {Component, inject, model, output, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {PrimeTemplate} from 'primeng/api';
import {GuildService} from '../../../../services/guild.service';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {GuildDto} from '../../../../dtos/response/guild.dto';
import {DiscordImportService} from '../../../../services/discord-import.service';
import {ExternalLinkService} from '../../../../services/external-link.service';
import {ToastService} from '../../../../services/toast.service';

@Component({
    selector: 'app-create-guild-modal',
    imports: [Dialog, Button, InputText, FormsModule, PrimeTemplate, TranslateModule],
    templateUrl: './create-guild-modal.component.html',
})
export class CreateGuildModalComponent {
    readonly visible = model.required<boolean>();
    readonly guildCreated = output<GuildDto>();
    readonly name = signal('');
    readonly description = signal('');
    readonly loading = signal(false);
    readonly importingFromDiscord = signal(false);
    private guildService = inject(GuildService);
    private discordImportService = inject(DiscordImportService);
    private externalLinkService = inject(ExternalLinkService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);

    startDiscordImport(): void {
        if (this.importingFromDiscord() || this.loading()) return;
        this.importingFromDiscord.set(true);
        this.discordImportService.startImport().subscribe({
            next: res => {
                this.importingFromDiscord.set(false);
                // The user may have already cancelled/closed the modal while this request was
                // in flight - don't slam it shut again or launch the OAuth browser in that case.
                if (!this.visible()) return;
                this.close();
                void this.externalLinkService.openExternalLink(res.authorizeUrl);
            },
            error: err => {
                this.importingFromDiscord.set(false);
                this.toastService.httpError(this.translate.instant('CREATE_GUILD.IMPORT_ERROR_TOAST'), err);
            },
        });
    }

    submit(): void {
        const trimmed = this.name().trim();
        if (!trimmed || this.loading()) return;
        this.loading.set(true);
        this.guildService.createGuild(trimmed, this.description().trim() || undefined).subscribe({
            next: guild => {
                this.loading.set(false);
                this.guildCreated.emit(guild);
                this.close();
            },
            error: () => this.loading.set(false),
        });
    }

    close(): void {
        this.visible.set(false);
        this.name.set('');
        this.description.set('');
        this.loading.set(false);
        this.importingFromDiscord.set(false);
    }
}
