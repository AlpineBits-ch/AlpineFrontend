import {ChangeDetectionStrategy, Component, computed, effect, inject, input, untracked} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {ThreadRegistryService} from '../../../../../../services/thread-registry.service';
import {NavigationService} from '../../../../../main-page/navigation.service';
import {RelativeTimePipe} from '../../../../../../pipes/relative-time.pipe';

@Component({
    selector: 'app-message-thread-card',
    imports: [TranslateModule, RelativeTimePipe],
    templateUrl: './message-thread-card.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MessageThreadCardComponent {
    readonly threadId = input.required<string>();

    private readonly registry = inject(ThreadRegistryService);
    private readonly navService = inject(NavigationService);

    protected readonly thread = computed(() => this.registry.thread(this.threadId()));

    protected readonly messageCount = computed(() => this.thread()?.messageCount ?? 0);

    constructor() {
        effect(() => {
            const id = this.threadId();
            untracked(() => this.registry.ensureThread(id));
        });
    }

    protected open(): void {
        const thread = this.thread();
        if (thread) this.navService.openThread(thread);
    }
}
