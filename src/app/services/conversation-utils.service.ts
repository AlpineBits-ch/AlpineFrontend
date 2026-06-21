import {inject, Injectable} from '@angular/core';
import {ConversationDto, ConversationMemberDto} from '../dtos/response/conversation.dto';
import {OnlineStatus} from '../dtos/response/profile.dto';
import {ProfileService} from './profile.service';
import {TypingService} from './typing.service';

@Injectable({providedIn: 'root'})
export class ConversationUtilsService {
    private profileService = inject(ProfileService);
    private typingService = inject(TypingService);

    /** Every member who is not the current user. */
    getOtherMembers(conv: ConversationDto): ConversationMemberDto[] {
        const ownId = this.profileService.ownProfile()?.userId;
        return conv.members.filter(m => m.userId !== ownId);
    }

    /** The other participant in a 1-on-1 conversation, or null for group chats. */
    getPartnerMember(conv: ConversationDto): ConversationMemberDto | null {
        const others = this.getOtherMembers(conv);
        return others.length === 1 ? others[0] : null;
    }

    /** Online status of the DM partner, or null for group chats. */
    getPartnerStatus(conv: ConversationDto): OnlineStatus | null {
        const member = this.getPartnerMember(conv);
        return member ? this.profileService.getOnlineStatus(member.userId) : null;
    }

    /** Display title for the conversation header and list. */
    getChatTitle(conv: ConversationDto): string {
        if (!this.profileService.ownProfile()) return 'Loading…';
        const others = this.getOtherMembers(conv);
        if (others.length === 0) return 'Empty chat';
        if (others.length === 1) return others[0].cachedUserName;
        return conv.name ?? others.map(m => m.cachedUserName).join(', ');
    }

    /** Single-character fallback label for the conversation avatar. */
    getChatAvatarLabel(conv: ConversationDto): string {
        const others = this.getOtherMembers(conv);
        return (others[0]?.cachedUserName?.[0] ?? '?').toUpperCase();
    }

    /** Human-readable typing indicator, or null when nobody is typing. */
    getTypingLabel(conv: ConversationDto): string | null {
        const ownId = this.profileService.ownProfile()?.userId;
        const ids = [...(this.typingService.state().get(conv.id) ?? [])].filter(id => id !== ownId);
        if (ids.length === 0) return null;
        const names = ids.map(id => conv.members.find(m => m.userId === id)?.cachedUserName ?? 'Someone');
        if (names.length === 1) return `${names[0]} is typing…`;
        if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
        return 'Several people are typing…';
    }
}
