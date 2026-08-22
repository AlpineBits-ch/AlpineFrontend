import {ChangeDetectionStrategy, Component, computed, inject, output, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {TranslateModule} from '@ngx-translate/core';
import {TopicPickerComponent} from '../topic-picker/topic-picker.component';
import {TopicDto} from '../../../dtos/response/discovery.dto';
import {DiscoveryStore} from '../../../stores/discovery.store';

/** A profile carries up to 25 interests, per the topic model. */
const INTEREST_TOPIC_CAP = 25;

/** The interest picker shown instead of the feed when the caller has never set any. Saving updates `DiscoveryStore.interests`, which is what tells the feed to stop showing this screen. */
@Component({
    selector: 'app-interest-onboarding',
    imports: [FormsModule, Button, TranslateModule, TopicPickerComponent],
    templateUrl: './interest-onboarding.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InterestOnboardingComponent {
    /** Dismissed unsaved, so the feed can fall back to a query-only view for this session. */
    readonly skipped = output<void>();

    protected readonly cap = INTEREST_TOPIC_CAP;
    protected readonly topics = signal<TopicDto[]>([]);
    protected readonly visible = signal(true);
    protected readonly saving = signal(false);

    private readonly store = inject(DiscoveryStore);

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
                next: () => this.saving.set(false),
                error: () => this.saving.set(false),
            });
    }

    protected skip(): void {
        this.skipped.emit();
    }
}
