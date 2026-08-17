import {inject, Injectable} from '@angular/core';
import {map, Observable, of, tap} from 'rxjs';
import {TranslateService} from '@ngx-translate/core';
import {ConversationDto} from '../dtos/response/conversation.dto';
import {ConversationEncryption} from '../enums/conversation-encryption.enum';
import {ConversationService} from './conversation.service';
import {ConversationStore} from '../stores/conversation.store';
import {ProfileService} from './profile.service';
import {ToastService} from './toast.service';
import {NavigationService} from '../features/main-page/navigation.service';
import {refusalMessageKey} from '../core/refusal-message';

/**
 * Opening a one to one conversation with somebody, from wherever their name appears.
 *
 * Conversations created here are {@link ConversationEncryption.Plain}: the MLS path can refuse over
 * devices with no key package left, and the surfaces that call this have no room to ask.
 */
@Injectable({providedIn: 'root'})
export class DirectMessageService {
    private conversationService = inject(ConversationService);
    private conversationStore = inject(ConversationStore);
    private profileService = inject(ProfileService);
    private navService = inject(NavigationService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    /**
     * The existing one to one conversation with `targetUserId`, or a new one.
     *
     * Emits without touching the network when the store already holds it. Adds whatever it resolves
     * to the store, and navigates nowhere: the caller decides.
     */
    openOrCreate(targetUserId: string): Observable<ConversationDto> {
        const existing = this.existingWith(targetUserId);
        if (existing) return of(existing);

        return this.conversationService
            .createConversation({
                members: [{userId: targetUserId}],
                name: undefined,
                encryption: ConversationEncryption.Plain,
                deviceWelcomes: [],
            })
            .pipe(
                map(result => result.conversation),
                tap(conversation => this.conversationStore.addConversation(conversation)),
            );
    }

    /** {@link openOrCreate}, then open it. */
    openOrCreateAndNavigate(targetUserId: string): void {
        this.openOrCreate(targetUserId).subscribe({
            next: conversation => this.navService.openConversation(conversation),
            // The recipient's DM policy or a block can refuse this (T0-2). Without a handler the
            // click simply did nothing, which reads as the app being broken rather than as an answer.
            error: (err: unknown) => this.reportFailure(err),
        });
    }

    /** Says why a conversation could not be opened, distinguishing a policy refusal from a fault. */
    reportFailure(err: unknown): void {
        const key = refusalMessageKey(err);
        if (key) this.toast.error(this.translate.instant(key));
        else this.toast.httpError('Could not open that conversation', err);
    }

    private existingWith(targetUserId: string): ConversationDto | undefined {
        const ownId = this.profileService.ownProfile()?.userId;
        return this.conversationStore
            .entities()
            .find(
                c =>
                    c.members.length === 2 &&
                    c.members.some(m => m.userId === ownId) &&
                    c.members.some(m => m.userId === targetUserId),
            );
    }
}
