import {Component, computed, inject, input, output} from '@angular/core';
import {NgClass} from '@angular/common';
import {ChannelDto, isForumLike} from '../../../../../../dtos/response/guild.dto';
import {GuildReadStateService} from '../../../../../../services/guild-read-state.service';
import {NavigationService} from '../../../../../main-page/navigation.service';
import {ChannelListDragService} from '../../channel-list-drag.service';
import {channelIcon, isHouseholdChannel} from '../../../../channel-types';

/** A channel row in the channel sidebar: every type except Voice, which has its own row. */
@Component({
    selector: 'app-text-channel-item',
    host: {class: 'contents'},
    imports: [NgClass],
    templateUrl: './text-channel-item.component.html',
})
export class TextChannelItemComponent {
    channel = input.required<ChannelDto>();
    canReorder = input.required<boolean>();

    readonly open = output<void>();
    readonly openMenu = output<MouseEvent>();

    protected drag = inject(ChannelListDragService);
    private navService = inject(NavigationService);
    private readStateService = inject(GuildReadStateService);

    /**
     * A forum's own posts. Every message in a forum lives in one of these, never on the
     * forum itself, so a forum row reading only its own id is permanently silent - it could
     * never report a mention or an unread post. Empty for every other channel type, which
     * leaves their read state exactly as it was.
     */
    private rollupIds = computed(() => {
        const channel = this.channel();
        if (!isForumLike(channel.type)) return [];
        const ws = this.navService.workspace();
        if (ws.type !== 'server') return [];
        return ws.guild.channels.filter(c => c.parentChannelId === channel.id).map(c => c.id);
    });

    protected readState = computed(() =>
        this.readStateService.aggregate([this.channel().id, ...this.rollupIds()]));
    protected isActive = computed(() => this.navService.isChannelActive(this.channel().id));

    /** `null` for Text, which renders a literal `#`. One table, no per-type ladder. */
    protected icon = computed(() => channelIcon(this.channel().type));

    /**
     * Household channels carry no messages, so read state for them is meaningless -
     * an unread weight or a mention count on a shopping list could only ever be wrong.
     */
    protected showsReadState = computed(() => !isHouseholdChannel(this.channel().type));
}
