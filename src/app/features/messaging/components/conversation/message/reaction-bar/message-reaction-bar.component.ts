import {ChangeDetectionStrategy, Component, computed, inject, input, output} from '@angular/core';
import {NgClass} from '@angular/common';
import {MessageReaction} from '../../../../../../dtos/response/message.dto';
import {EmojiSelection, ReactionPickerComponent} from '../reaction-picker/reaction-picker.component';
import {TwemojiComponent} from '../../../../../../components/twemoji/twemoji.component';
import {GuildEmojiStore} from '../../../../../../stores/guild-emoji.store';

interface ReactionGroup {
    key: string;
    emoji: string;
    emojiId?: string | null;
    count: number;
    userIds: string[];
}

@Component({
    selector: 'app-message-reaction-bar',
    imports: [NgClass, ReactionPickerComponent, TwemojiComponent],
    templateUrl: './message-reaction-bar.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MessageReactionBarComponent {
    reactions = input.required<MessageReaction[]>();
    ownUserId = input<string | undefined>();
    guildId = input<string | undefined>();
    emojiToggled = output<EmojiSelection>();

    private guildEmojiStore = inject(GuildEmojiStore);

    groups = computed<ReactionGroup[]>(() => {
        const map = new Map<string, ReactionGroup>();
        for (const r of this.reactions()) {
            const key = r.emojiId ?? r.emoji;
            const g = map.get(key) ?? {key, emoji: r.emoji, emojiId: r.emojiId, count: 0, userIds: []};
            g.count++;
            g.userIds.push(r.userId);
            map.set(key, g);
        }
        return Array.from(map.values());
    });

    hasOwn(group: ReactionGroup): boolean {
        const own = this.ownUserId() ?? '';
        return this.reactions().some(r => (r.emojiId ?? r.emoji) === group.key && r.userId === own);
    }

    imageUrl(group: ReactionGroup): string | undefined {
        if (!group.emojiId) return undefined;
        const guildId = this.guildId();
        if (!guildId) return undefined;
        return this.guildEmojiStore.getEmojis(guildId).find(e => e.id === group.emojiId)?.imageUrl;
    }

    toggle(group: ReactionGroup): void {
        if (group.emojiId) {
            this.emojiToggled.emit({customEmojiId: group.emojiId, customEmojiName: group.emoji});
        } else {
            this.emojiToggled.emit({native: group.emoji});
        }
    }
}
