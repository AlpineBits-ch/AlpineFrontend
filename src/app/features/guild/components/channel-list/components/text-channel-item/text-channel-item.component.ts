import {Component, computed, inject, input, output} from '@angular/core';
import {ChannelDto, isForumLike} from '../../../../../../dtos/response/guild.dto';
import {GuildReadStateService} from '../../../../../../services/guild-read-state.service';
import {NavigationService} from '../../../../../main-page/navigation.service';
import {ChannelListDragService} from '../../channel-list-drag.service';
import {isHouseholdChannel} from '../../../../channel-types';
import {DraftService} from '../../../../../../services/draft.service';
import {TranslateModule} from '@ngx-translate/core';
import {ChannelIconComponent} from '../../../channel-icon/channel-icon.component';

/** A channel row in the channel sidebar: every type except Voice, which has its own row. */
@Component({
    selector: 'app-text-channel-item',
    host: {class: 'contents'},
    imports: [TranslateModule, ChannelIconComponent],
    templateUrl: './text-channel-item.component.html',
})
export class TextChannelItemComponent {
    readonly channel = input.required<ChannelDto>();
    readonly canReorder = input.required<boolean>();

    readonly open = output<void>();
    readonly openMenu = output<MouseEvent>();

    protected drag = inject(ChannelListDragService);
    private navService = inject(NavigationService);
    private readStateService = inject(GuildReadStateService);
    private drafts = inject(DraftService);

    /** A forum's own posts: every message in a forum lives in one of these, never on the forum itself, so a forum row reading only its own id would be permanently silent (no mention/unread ever reported). Empty for every other channel type. */
    private readonly rollupIds = computed(() => {
        const channel = this.channel();
        if (!isForumLike(channel.type)) return [];
        const ws = this.navService.workspace();
        if (ws.type !== 'server') return [];
        return ws.guild.channels.filter(c => c.parentChannelId === channel.id).map(c => c.id);
    });

    protected readonly readState = computed(() =>
        this.readStateService.aggregate([this.channel().id, ...this.rollupIds()]),
    );
    protected readonly isActive = computed(() => this.navService.isChannelActive(this.channel().id));

    /** Household channels carry no messages, so read state for them is meaningless: an unread weight or mention count on a shopping list could only ever be wrong. */
    protected readonly showsReadState = computed(() => !isHouseholdChannel(this.channel().type));

    /** Never on the open channel: its draft is on screen in the composer already. */
    protected readonly hasDraft = computed(() => !this.isActive() && this.drafts.hasDraft(this.channel().id));
}
