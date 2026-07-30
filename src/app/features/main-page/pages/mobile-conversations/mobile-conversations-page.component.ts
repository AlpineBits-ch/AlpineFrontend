import {Component, computed, inject, signal} from '@angular/core';
import {Button} from 'primeng/button';
import {ConversationListComponent} from '../../../messaging/components/conversation-list/conversation-list.component';
import {NavigationService} from '../../navigation.service';
import {ConversationDto} from '../../../../dtos/response/conversation.dto';
import {
    NewConversationDialogComponent
} from '../../components/dm-sidepanel/new-conversation-dialog/new-conversation-dialog.component';
import {RelationshipStore} from '../../../../stores/relationship.store';
import {ProfileService} from '../../../../services/profile.service';
import {OnlineStatus} from '../../../../dtos/response/profile.dto';
import {TranslateModule} from '@ngx-translate/core';

@Component({
    selector: 'app-mobile-conversations-page',
    imports: [Button, ConversationListComponent, NewConversationDialogComponent, TranslateModule],
    templateUrl: './mobile-conversations-page.component.html',
})
export class MobileConversationsPageComponent {
    protected navService = inject(NavigationService);
    protected showNewConversation = signal(false);
    private relationshipStore = inject(RelationshipStore);
    private profileService = inject(ProfileService);

    protected onlineFriendsCount = computed(() =>
        this.relationshipStore.friends()
            .filter(r => this.profileService.getOnlineStatus(r.other.userId) === OnlineStatus.Online)
            .length
    );

    constructor() {
        this.relationshipStore.load();
    }

    onConversationSelected(conv: ConversationDto): void {
        this.navService.openConversation(conv);
    }
}
