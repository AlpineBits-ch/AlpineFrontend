import {Component, computed, inject, input, output} from '@angular/core';
import {NgClass} from '@angular/common';
import {ChannelDto, ChannelType} from '../../../../../../dtos/response/guild.dto';
import {GuildReadStateService} from '../../../../../../services/guild-read-state.service';
import {NavigationService} from '../../../../../main-page/navigation.service';
import {ChannelListDragService} from '../../channel-list-drag.service';
import {channelIcon, isHouseholdChannel} from '../../../../channel-types';

/** A text or Forum channel row in the channel sidebar. */
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

    protected readonly ChannelType = ChannelType;

    protected drag = inject(ChannelListDragService);
    private navService = inject(NavigationService);
    private readStateService = inject(GuildReadStateService);

    protected readState = computed(() => this.readStateService.getChannelState(this.channel().id));
    protected isActive = computed(() => this.navService.isChannelActive(this.channel().id));

    /** `null` for Text, which renders a literal `#`. One table, no per-type ladder. */
    protected icon = computed(() => channelIcon(this.channel().type));

    /**
     * Household channels carry no messages, so read state for them is meaningless -
     * an unread weight or a mention count on a shopping list could only ever be wrong.
     */
    protected showsReadState = computed(() => !isHouseholdChannel(this.channel().type));
}
