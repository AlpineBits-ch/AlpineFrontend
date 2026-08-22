import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {AppAvatarComponent} from '../../../components/avatar/avatar.component';
import {TagChipComponent} from '../../../components/tag-chip/tag-chip.component';
import {DiscoveryCardDto, TopicDto} from '../../../dtos/response/discovery.dto';

/** A community's card in the feed: identity first, urgency never. See spec 13.2. */
@Component({
    selector: 'app-discovery-community-card',
    imports: [AppAvatarComponent, TagChipComponent, TranslateModule],
    templateUrl: './community-card.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CommunityCardComponent {
    readonly card = input.required<DiscoveryCardDto>();

    protected readonly initial = computed(() => this.card().guildName.charAt(0).toUpperCase());

    /** Everything not already shown in the matched row, so a topic never renders twice. */
    protected readonly otherTopics = computed((): TopicDto[] => {
        const matched = new Set(this.card().matchedTopics.map(topicKey));
        return this.card().topics.filter(t => !matched.has(topicKey(t)));
    });

    protected chipOf(topic: TopicDto): {name: string; color: string} {
        return {name: topic.name, color: ''};
    }
}

function topicKey(topic: TopicDto): string {
    return `${topic.kind}:${topic.id}`;
}
