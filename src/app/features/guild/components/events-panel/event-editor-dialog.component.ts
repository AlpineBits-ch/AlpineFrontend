import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    model,
    signal,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Textarea} from 'primeng/textarea';
import {DatePicker} from 'primeng/datepicker';
import {Select} from 'primeng/select';
import {PrimeTemplate} from 'primeng/api';
import {ChannelType} from '../../../../dtos/response/guild.dto';
import {ScheduledEventDto} from '../../../../dtos/response/scheduled-event.dto';
import {CreateScheduledEventDto} from '../../../../dtos/request/scheduled-event.dto';
import {ScheduledEventStore} from '../../../../stores/scheduled-event.store';
import {NavigationService} from '../../../main-page/navigation.service';
import {ToastService} from '../../../../services/toast.service';

@Component({
    selector: 'app-event-editor-dialog',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        FormsModule,
        TranslateModule,
        Dialog,
        Button,
        InputText,
        Textarea,
        DatePicker,
        Select,
        PrimeTemplate,
    ],
    templateUrl: './event-editor-dialog.component.html',
})
export class EventEditorDialogComponent {
    readonly guildId = input.required<string>();
    readonly event = input<ScheduledEventDto | null>(null);
    readonly visible = model.required<boolean>();

    protected readonly title = signal('');
    protected readonly description = signal('');
    protected readonly startsAt = signal<Date | null>(null);
    protected readonly endsAt = signal<Date | null>(null);
    protected readonly location = signal('');
    protected readonly voiceChannelId = signal<string | null>(null);
    protected readonly saving = signal(false);

    protected readonly voiceChannelOptions = computed(() => {
        const ws = this.navService.workspace();
        if (ws.type !== 'server' || ws.guild.id !== this.guildId()) return [];
        return ws.guild.channels
            .filter(c => c.type === ChannelType.Voice)
            .map(c => ({label: c.name, value: c.id}));
    });

    protected readonly titleValid = computed(() => this.title().trim().length > 0);
    protected readonly dateValid = computed(() => {
        const start = this.startsAt();
        const end = this.endsAt();
        if (!start) return false;
        if (!end) return true;
        return end.getTime() > start.getTime();
    });
    protected readonly showDateError = computed(
        () => !!this.startsAt() && !!this.endsAt() && !this.dateValid(),
    );
    protected readonly canSave = computed(() => this.titleValid() && this.dateValid() && !this.saving());

    private readonly store = inject(ScheduledEventStore);
    private readonly navService = inject(NavigationService);
    private readonly toastService = inject(ToastService);
    private readonly translate = inject(TranslateService);

    constructor() {
        // Re-populate the form every time the dialog is (re-)opened: this only reads `visible()`/`event()` inputs, so it can't loop back on its own writes.
        effect(() => {
            if (!this.visible()) return;
            const evt = this.event();
            this.title.set(evt?.title ?? '');
            this.description.set(evt?.description ?? '');
            this.startsAt.set(evt ? new Date(evt.startsAt) : null);
            this.endsAt.set(evt?.endsAt ? new Date(evt.endsAt) : null);
            this.location.set(evt?.location ?? '');
            this.voiceChannelId.set(evt?.voiceChannelId ?? null);
        });
    }

    protected close(): void {
        this.visible.set(false);
        // Also runs from p-dialog's (onHide): clearing `saving` here means dismissing the dialog mid-save can't leave the Save button stuck in its spinner state next time it opens.
        this.saving.set(false);
    }

    protected save(): void {
        if (!this.canSave()) return;
        this.saving.set(true);

        const dto: CreateScheduledEventDto = {
            title: this.title().trim(),
            description: this.description().trim() || null,
            startsAt: this.startsAt()!.toISOString(),
            endsAt: this.endsAt() ? this.endsAt()!.toISOString() : null,
            location: this.location().trim() || null,
            voiceChannelId: this.voiceChannelId(),
        };

        const existing = this.event();
        const request = existing
            ? this.store.update(existing.id, dto)
            : this.store.create(this.guildId(), dto);

        request.subscribe({
            next: () => {
                this.saving.set(false);
                this.visible.set(false);
            },
            error: err => {
                this.saving.set(false);
                this.toastService.httpError(this.translate.instant('EVENTS.SAVE_ERROR'), err);
            },
        });
    }
}
