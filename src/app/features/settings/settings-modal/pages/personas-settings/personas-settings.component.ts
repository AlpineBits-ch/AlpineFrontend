import {ChangeDetectionStrategy, Component, computed, inject, signal} from '@angular/core';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {PrimeTemplate} from 'primeng/api';
import {PersonaAvatarComponent} from '../../../../guild/personas/persona-avatar/persona-avatar.component';
import {
    PersonaEditorComponent,
    PersonaEditorTarget,
} from '../../../../guild/personas/persona-editor/persona-editor.component';
import {PersonaService} from '../../../../../services/persona.service';
import {ToastService} from '../../../../../services/toast.service';
import {PersonaDto} from '../../../../../dtos/response/persona.dto';
import {safeAccentColor} from '../../../../../models/profile-font.model';

/** The account's characters, which follow it into every guild. Per-guild overrides live in a guild. */
@Component({
    selector: 'app-personas-settings',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [PersonaAvatarComponent, PersonaEditorComponent, TranslateModule, Button, Dialog, PrimeTemplate],
    templateUrl: './personas-settings.component.html',
})
export class PersonasSettingsComponent {
    protected readonly personas = inject(PersonaService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    protected readonly editing = signal<PersonaEditorTarget | null>(null);
    protected readonly confirming = signal<PersonaDto | null>(null);
    protected readonly busyId = signal<string | null>(null);

    protected readonly active = computed(() => this.personas.ownPersonas().filter(p => !p.isRetired));
    protected readonly retired = computed(() => this.personas.ownPersonas().filter(p => p.isRetired));

    constructor() {
        this.personas.ensureOwn();
    }

    protected colorOf(persona: PersonaDto): string | null {
        return safeAccentColor(persona.color);
    }

    protected create(): void {
        this.editing.set({persona: null, entry: null, guildId: null});
    }

    protected edit(persona: PersonaDto): void {
        this.editing.set({persona, entry: null, guildId: null});
    }

    protected unretire(persona: PersonaDto): void {
        this.busyId.set(persona.id);
        this.personas.updateOwn(persona.id, {isRetired: false}).subscribe({
            next: () => this.busyId.set(null),
            error: err => {
                this.busyId.set(null);
                this.toast.httpError(this.translate.instant('PERSONA.ACCOUNT.UNRETIRE_FAILED'), err);
            },
        });
    }

    protected retire(persona: PersonaDto): void {
        this.busyId.set(persona.id);
        this.personas.updateOwn(persona.id, {isRetired: true}).subscribe({
            next: () => {
                this.busyId.set(null);
                this.toast.success(
                    this.translate.instant('PERSONA.ACCOUNT.RETIRED_TOAST', {name: persona.name}),
                );
            },
            error: err => {
                this.busyId.set(null);
                this.toast.httpError(this.translate.instant('PERSONA.ACCOUNT.RETIRE_FAILED'), err);
            },
        });
    }

    protected confirmDelete(persona: PersonaDto): void {
        this.confirming.set(persona);
    }

    /** The server retires instead when the character has already spoken, and says which it did. */
    protected remove(): void {
        const persona = this.confirming();
        if (!persona) return;

        this.busyId.set(persona.id);
        this.personas.deleteOwn(persona.id).subscribe({
            next: result => {
                this.busyId.set(null);
                this.confirming.set(null);
                this.toast.success(
                    this.translate.instant(
                        result.retired ? 'PERSONA.ACCOUNT.RETIRED_TOAST' : 'PERSONA.ACCOUNT.DELETED_TOAST',
                        {name: persona.name},
                    ),
                );
            },
            error: err => {
                this.busyId.set(null);
                this.toast.httpError(this.translate.instant('PERSONA.ACCOUNT.DELETE_FAILED'), err);
            },
        });
    }
}
