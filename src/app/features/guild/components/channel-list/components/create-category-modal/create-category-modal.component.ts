import {ChangeDetectionStrategy, Component, inject, input, model, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule} from '@ngx-translate/core';
import {GuildService} from '../../../../../../services/guild.service';

@Component({
    selector: 'app-create-category-modal',
    imports: [FormsModule, Dialog, Button, InputText, PrimeTemplate, TranslateModule],
    templateUrl: './create-category-modal.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreateCategoryModalComponent {
    readonly isVisible = model.required<boolean>();
    readonly guildId = input.required<string>();

    protected readonly name = signal('');
    protected readonly creating = signal(false);
    private readonly position = signal(0);
    private guildService = inject(GuildService);

    open(position: number): void {
        this.name.set('');
        this.position.set(position);
        this.isVisible.set(true);
    }

    protected submit(): void {
        if (this.creating() || !this.name().trim()) return;
        this.creating.set(true);
        this.guildService
            .createCategory({
                guildId: this.guildId(),
                name: this.name().trim(),
                position: this.position(),
            })
            .subscribe({
                next: () => {
                    this.isVisible.set(false);
                    this.creating.set(false);
                },
                error: () => this.creating.set(false),
            });
    }
}
