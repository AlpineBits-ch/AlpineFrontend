import { inject, Injectable, signal } from '@angular/core';
import { MessagingWebsocketService } from './messaging-websocket.service';
import { MessagingService } from './messaging.service';
import { GuildWebsocketService } from './guild-websocket.service';

@Injectable({ providedIn: 'root' })
export class TypingService {
  private ws = inject(MessagingWebsocketService);
  private messagingService = inject(MessagingService);
  private guildWs = inject(GuildWebsocketService);

  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly _state = signal<Map<string, Set<string>>>(new Map());

  readonly state = this._state.asReadonly();

  constructor() {
    this.ws.userTypingObservable.subscribe(event => {
      this.markTyping(event.conversationId, event.userId);
    });

    // Clear typing indicator when a message is received from that user
    this.ws.messageObservable.subscribe(msg => {
      if (msg.conversationId && msg.authorId) {
        this.clearTyping(msg.conversationId, msg.authorId);
      }
    });

    // Clear own typing indicator when a message is sent
    this.messagingService.messageSentObservable.subscribe(msg => {
      const key = msg.conversationId ?? msg.channelId;
      if (key && msg.authorId) {
        this.clearTyping(key, msg.authorId);
      }
    });

    // Guild channel typing events
    this.guildWs.userTypingObservable.subscribe(event => {
      this.markTyping(event.channelId, event.userId);
    });

    this.guildWs.messageObservable.subscribe(msg => {
      if (msg.channelId && msg.authorId) {
        this.clearTyping(msg.channelId, msg.authorId);
      }
    });
  }

  markTyping(conversationId: string, userId: string): void {
    const key = `${conversationId}:${userId}`;
    clearTimeout(this.timeouts.get(key));
    this._state.update(map => {
      const next = new Map(map);
      const users = new Set(next.get(conversationId) ?? []);
      users.add(userId);
      next.set(conversationId, users);
      return next;
    });
    this.timeouts.set(key, setTimeout(() => this.clearTyping(conversationId, userId), 4000));
  }

  clearTyping(conversationId: string, userId: string): void {
    const key = `${conversationId}:${userId}`;
    clearTimeout(this.timeouts.get(key));
    this.timeouts.delete(key);
    this._state.update(map => {
      const next = new Map(map);
      const users = new Set(next.get(conversationId) ?? []);
      users.delete(userId);
      if (users.size === 0) next.delete(conversationId);
      else next.set(conversationId, users);
      return next;
    });
  }
}
