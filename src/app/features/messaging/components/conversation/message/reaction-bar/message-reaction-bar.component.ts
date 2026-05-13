import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NgClass } from '@angular/common';
import { MessageReaction } from '../../../../../../dtos/response/message.dto';
import { ReactionPickerComponent } from '../reaction-picker/reaction-picker.component';
import { TwemojiComponent } from '../../../../../../components/twemoji/twemoji.component';

interface ReactionGroup {
  emoji: string;
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
  emojiToggled = output<string>();

  groups = computed<ReactionGroup[]>(() => {
    const map = new Map<string, ReactionGroup>();
    for (const r of this.reactions()) {
      const g = map.get(r.emoji) ?? { emoji: r.emoji, count: 0, userIds: [] };
      g.count++;
      g.userIds.push(r.userId);
      map.set(r.emoji, g);
    }
    return Array.from(map.values());
  });

  hasOwn(emoji: string): boolean {
    const own = this.ownUserId() ?? '';
    return this.reactions().some(r => r.emoji === emoji && r.userId === own);
  }
}
