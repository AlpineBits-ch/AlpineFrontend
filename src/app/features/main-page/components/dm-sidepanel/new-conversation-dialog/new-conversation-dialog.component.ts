import { Component, computed, inject, model, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgClass } from '@angular/common';
import { Dialog } from 'primeng/dialog';
import { Button } from 'primeng/button';
import { InputText } from 'primeng/inputtext';
import { Avatar } from 'primeng/avatar';
import { RelationshipService } from '../../../../../services/relationship.service';
import { ConversationService } from '../../../../../services/conversation.service';
import { ConversationStore } from '../../../../../stores/conversation.store';
import { NavigationService } from '../../../navigation.service';
import { ProfileService } from '../../../../../services/profile.service';
import {
  MinimalProfileId,
  RelationshipModel,
  RelationshipStatus,
} from '../../../../friendship/components/friendship-modal/dto/relationship.model';
import { ConversationEncryption } from '../../../../../enums/conversation-encryption.enum';
import {PrimeTemplate} from "primeng/api";

@Component({
  selector: 'app-new-conversation-dialog',
  imports: [Dialog, Button, InputText, Avatar, FormsModule, PrimeTemplate, NgClass],
  templateUrl: './new-conversation-dialog.component.html',
})
export class NewConversationDialogComponent {
  readonly visible = model.required<boolean>();

  private relationshipService = inject(RelationshipService);
  private conversationService = inject(ConversationService);
  private conversationStore = inject(ConversationStore);
  private navService = inject(NavigationService);
  private profileService = inject(ProfileService);

  readonly friends = signal<MinimalProfileId[]>([]);
  readonly search = signal('');
  readonly selectedIds = signal(new Set<string>());
  readonly groupName = signal('');
  readonly creating = signal(false);

  readonly filteredFriends = computed(() => {
    const q = this.search().toLowerCase();
    return q
      ? this.friends().filter(f => `${f.userName}#${f.hash}`.toLowerCase().includes(q))
      : this.friends();
  });

  readonly selectedFriends = computed(() =>
    this.friends().filter(f => this.selectedIds().has(f.userId))
  );

  readonly isGroup = computed(() => this.selectedIds().size >= 2);

  readonly canCreate = computed(() => this.selectedIds().size >= 1 && !this.creating());

  constructor() {
    this.relationshipService.getRelationships().subscribe((rels: RelationshipModel[]) => {
      const ownId = this.profileService.ownProfile()?.userId;
      const friends = rels
        .filter(r => r.status === RelationshipStatus.Friends)
        .map(r => (r.owner.userId === ownId ? r.target : r.owner));
      this.friends.set(friends);
    });
  }

  toggleFriend(userId: string): void {
    this.selectedIds.update(prev => {
      const next = new Set(prev);
      next.has(userId) ? next.delete(userId) : next.add(userId);
      return next;
    });
  }

  isSelected(userId: string): boolean {
    return this.selectedIds().has(userId);
  }

  create(): void {
    if (!this.canCreate()) return;
    this.creating.set(true);

    const members = Array.from(this.selectedIds()).map(userId => ({ userId }));
    const name = this.isGroup() && this.groupName().trim() ? this.groupName().trim() : undefined;

    this.conversationService
      .createConversation({ name, members, encryption: ConversationEncryption.Plain })
      .subscribe({
        next: conv => {
          this.conversationStore.addConversation(conv);
          this.navService.openConversation(conv);
          this.close();
        },
        error: () => this.creating.set(false),
      });
  }

  close(): void {
    this.visible.set(false);
    this.selectedIds.set(new Set());
    this.groupName.set('');
    this.search.set('');
    this.creating.set(false);
  }
}
