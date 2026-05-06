import { Component, input, output } from '@angular/core';
import { NgClass } from '@angular/common';
import { Avatar } from 'primeng/avatar';
import { CommandDef } from '../commands';
import { EmojiSuggestion, getFlagCode, isRegionalIndicator } from '../../../../../../services/emoji-data.service';
import { MentionCandidate } from '../composer-utils';

@Component({
  selector: 'app-suggestion-overlay',
  imports: [NgClass, Avatar],
  templateUrl: './suggestion-overlay.component.html',
  styleUrl: './suggestion-overlay.component.css',
})
export class SuggestionOverlayComponent {
  overlayType = input<'mention' | 'command' | 'emoji' | null>(null);
  filteredMentions = input<MentionCandidate[]>([]);
  filteredCommands = input<CommandDef[]>([]);
  filteredEmojis = input<EmojiSuggestion[]>([]);
  selectedIndex = input<number>(0);
  query = input<string>('');

  mentionSelected = output<MentionCandidate>();
  commandSelected = output<CommandDef>();
  emojiSelected = output<EmojiSuggestion>();

  flagCode(native: string): string | null {
    const chars = [...native];
    if (chars.length === 2 && isRegionalIndicator(chars[0]) && isRegionalIndicator(chars[1])) {
      return getFlagCode(chars[0], chars[1]);
    }
    return null;
  }
}
