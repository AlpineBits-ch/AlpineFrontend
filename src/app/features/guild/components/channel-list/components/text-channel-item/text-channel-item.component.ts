import {Component, computed, inject, input, output} from '@angular/core';
import {NgClass} from '@angular/common';
import {ChannelDto} from '../../../../../../dtos/response/guild.dto';
import {GuildReadStateService} from '../../../../../../services/guild-read-state.service';
import {NavigationService} from '../../../../../main-page/navigation.service';
import {ChannelListDragService} from '../../channel-list-drag.service';

/** A text channel row in the channel sidebar. */
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

    protected readState = computed(() => this.readStateService.getChannelState(this.channel().id));
    protected isActive = computed(() => this.navService.isChannelActive(this.channel().id));
}
