import {
    ChangeDetectionStrategy,
    Component,
    computed,
    inject,
    input,
    model,
    output,
    signal,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {TopicPickerComponent} from '../topic-picker/topic-picker.component';
import {TopicDto} from '../../../dtos/response/discovery.dto';
import {DiscoveryStore} from '../../../stores/discovery.store';
import {ToastService} from '../../../services/toast.service';

/** A profile carries up to 25 interests, per the topic model. */
const INTEREST_TOPIC_CAP = 25;

/** The interest picker: first-run acquisition from Discover's empty state, or a later edit reopened from its header. */
@Component({
    selector: 'app-interest-onboarding',
    imports: [FormsModule, Button, TranslateModule, TopicPickerComponent],
    templateUrl: './interest-onboarding.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InterestOnboardingComponent {
    readonly mode = input<'onboarding' | 'edit'>('onboarding');
    /** Two-way so the edit dialog can seed it from `DiscoveryStore.interests` before opening. */
    readonly topics = model<TopicDto[]>([]);
    readonly visible = model(true);

    /** Dismissed without saving. */
    readonly skipped = output<void>();
    /** Saved successfully; the caller closes whatever hosts this. */
    readonly saved = output<void>();

    protected readonly cap = INTEREST_TOPIC_CAP;
    protected readonly saving = signal(false);

    protected readonly titleKey = computed(() =>
        this.mode() === 'edit' ? 'DISCOVERY.INTERESTS.EDIT_TITLE' : 'DISCOVERY.ONBOARDING.TITLE',
    );
    protected readonly secondaryLabelKey = computed(() =>
        this.mode() === 'edit' ? 'DISCOVERY.INTERESTS.CANCEL' : 'DISCOVERY.ONBOARDING.SKIP',
    );

    private readonly store = inject(DiscoveryStore);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    protected readonly canSave = computed(() => this.topics().length > 0 && !this.saving());

    protected save(): void {
        if (!this.canSave()) return;
        this.saving.set(true);
        this.store
            .saveInterests({
                topics: this.topics().map(t => ({kind: t.kind, id: t.id})),
                visible: this.visible(),
            })
            .subscribe({
                next: () => {
                    this.saving.set(false);
                    this.saved.emit();
                },
                error: () => {
                    this.saving.set(false);
                    this.toast.error(this.translate.instant('DISCOVERY.ONBOARDING.SAVE_FAILED'));
                },
            });
    }

    protected skip(): void {
        this.skipped.emit();
    }
}
