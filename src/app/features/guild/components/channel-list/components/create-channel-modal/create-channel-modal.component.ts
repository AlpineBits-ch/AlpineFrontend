import {Component, inject, input, model, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule} from '@ngx-translate/core';
import {ChannelType} from '../../../../../../dtos/response/guild.dto';
import {GuildService} from '../../../../../../services/guild.service';

@Component({
    selector: 'app-create-channel-modal',
    imports: [NgClass, Dialog, Button, InputText, PrimeTemplate, TranslateModule],
    templateUrl: './create-channel-modal.component.html',
})
export class CreateChannelModalComponent {
    isVisible = model.required<boolean>();
    guildId = input.required<string>();

    protected readonly ChannelType = ChannelType;
    protected name = signal('');
    protected type = signal<ChannelType>(ChannelType.Text);
    protected creating = signal(false);
    protected categoryId = signal<string | undefined>(undefined);
    private position = signal(0);
    private guildService = inject(GuildService);

    open(categoryId: string | undefined, position: number): void {
        this.name.set('');
        this.type.set(ChannelType.Text);
        this.categoryId.set(categoryId);
        this.position.set(position);
        this.isVisible.set(true);
    }

    /** Channel names carry no whitespace — every space becomes a dash as the user types. */
    protected onNameInput(event: Event): void {
        const el = event.target as HTMLInputElement;
        const sanitized = el.value.replace(/\s/g, '-');
        if (sanitized !== el.value) {
            const caret = el.selectionStart;
            el.value = sanitized;
            if (caret !== null) el.setSelectionRange(caret, caret);
        }
        this.name.set(sanitized);
    }

    protected submit(): void {
        if (this.creating() || !this.name().trim()) return;
        this.creating.set(true);
        this.guildService.createChannel({
            guildId: this.guildId(),
            name: this.name().trim(),
            type: this.type(),
            categoryId: this.categoryId(),
            position: this.position(),
        }).subscribe({
            next: () => {
                this.isVisible.set(false);
                this.creating.set(false);
            },
            error: () => this.creating.set(false),
        });
    }
}
