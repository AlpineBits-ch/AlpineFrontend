import {Component, inject, model, output, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {PrimeTemplate} from 'primeng/api';
import {GuildService} from '../../../../services/guild.service';
import {TranslateModule} from '@ngx-translate/core';
import {GuildDto} from '../../../../dtos/response/guild.dto';

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
    private guildService = inject(GuildService);

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
    }
}
