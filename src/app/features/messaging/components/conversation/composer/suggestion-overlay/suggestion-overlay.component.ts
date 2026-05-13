import { Component, input, output } from '@angular/core';
import { NgClass } from '@angular/common';
import { Avatar } from 'primeng/avatar';
import { CommandDef } from '../commands';
import { EmojiSuggestion } from '../../../../../../services/emoji-data.service';
import { MentionCandidate } from '../composer-utils';
import { TwemojiComponent } from '../../../../../../components/twemoji/twemoji.component';

@Component({
  selector: 'app-suggestion-overlay',
  imports: [NgClass, Avatar, TwemojiComponent],
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
}
