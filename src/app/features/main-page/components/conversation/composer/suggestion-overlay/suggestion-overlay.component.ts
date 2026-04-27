import { Component, input, output } from '@angular/core';
import { NgClass } from '@angular/common';
import { Avatar } from 'primeng/avatar';
import { RelationshipModel } from '../../../../../friendship/components/friendship-modal/dto/relationship.model';
import { CommandDef } from '../commands';

@Component({
  selector: 'app-suggestion-overlay',
  imports: [NgClass, Avatar],
  templateUrl: './suggestion-overlay.component.html',
  styleUrl: './suggestion-overlay.component.css',
})
export class SuggestionOverlayComponent {
  overlayType = input<'mention' | 'command' | null>(null);
  filteredFriends = input<RelationshipModel[]>([]);
  filteredCommands = input<CommandDef[]>([]);
  selectedIndex = input<number>(0);
  query = input<string>('');

  mentionSelected = output<RelationshipModel>();
  commandSelected = output<CommandDef>();
}
