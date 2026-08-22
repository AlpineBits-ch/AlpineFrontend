import {ChangeDetectionStrategy, Component, computed, inject, input, output, signal} from '@angular/core';
import {toObservable, toSignal} from '@angular/core/rxjs-interop';
import {catchError, debounceTime, distinctUntilChanged, map, of, switchMap} from 'rxjs';
import {FormsModule} from '@angular/forms';
import {TranslateModule} from '@ngx-translate/core';
import {TagChipComponent} from '../../../components/tag-chip/tag-chip.component';
import {TopicDto} from '../../../dtos/response/discovery.dto';
import {DiscoveryApiService} from '../../../services/discovery-api.service';

const TOPIC_SEARCH_DEBOUNCE_MS = 250;

interface SearchOutcome {
    topics: TopicDto[];
    failed: boolean;
}

const EMPTY_OUTCOME: SearchOutcome = {topics: [], failed: false};

function sameTopic(a: TopicDto, b: TopicDto): boolean {
    return a.kind === b.kind && a.id === b.id;
}

/** Search-and-select over the topic catalog, capped by {@link cap} so the interest picker (25) and the listing editor (8) share one component. */
@Component({
    selector: 'app-topic-picker',
    imports: [FormsModule, TranslateModule, TagChipComponent],
    templateUrl: './topic-picker.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TopicPickerComponent {
    readonly selected = input.required<TopicDto[]>();
    readonly cap = input.required<number>();
    readonly selectedChange = output<TopicDto[]>();

    protected readonly query = signal('');
    private readonly api = inject(DiscoveryApiService);

    private readonly outcome = toSignal(
        toObservable(this.query).pipe(
            debounceTime(TOPIC_SEARCH_DEBOUNCE_MS),
            distinctUntilChanged(),
            switchMap(term => {
                const trimmed = term.trim();
                if (!trimmed) return of(EMPTY_OUTCOME);
                return this.api.searchTopics({q: trimmed}).pipe(
                    map((r): SearchOutcome => ({topics: r.topics, failed: false})),
                    catchError(() => of<SearchOutcome>({topics: [], failed: true})),
                );
            }),
        ),
        {initialValue: EMPTY_OUTCOME},
    );

    protected readonly results = computed(() => this.outcome().topics);
    protected readonly searchFailed = computed(() => this.outcome().failed);

    protected readonly atCap = computed(() => this.selected().length >= this.cap());

    protected isSelected(topic: TopicDto): boolean {
        return this.selected().some(t => sameTopic(t, topic));
    }

    protected toggle(topic: TopicDto): void {
        if (this.isSelected(topic)) {
            this.remove(topic);
            return;
        }
        if (this.atCap()) return;
        this.selectedChange.emit([...this.selected(), topic]);
    }

    protected remove(topic: TopicDto): void {
        this.selectedChange.emit(this.selected().filter(t => !sameTopic(t, topic)));
    }

    protected chipOf(topic: TopicDto): {name: string; color: string} {
        return {name: topic.name, color: ''};
    }
}
