import {Component, inject, input, output} from '@angular/core';
import {ChannelDto, ChannelType, isForumLike} from '../../../../../../dtos/response/guild.dto';
import {ForumPostRowsComponent} from '../forum-post-rows/forum-post-rows.component';
import {ChannelListDragService} from '../../channel-list-drag.service';
import {ChannelMenuRequest, ParticipantMenuRequest} from '../channel-item.types';
import {ChannelDropIndicatorComponent} from '../channel-drop-indicator/channel-drop-indicator.component';
import {TextChannelItemComponent} from '../text-channel-item/text-channel-item.component';
import {VoiceChannelItemComponent} from '../voice-channel-item/voice-channel-item.component';

/**
 * Renders an ordered run of channel rows (uncategorized section or the body of a
 * category) together with the drag-and-drop insertion indicators.
 */
@Component({
    selector: 'app-channel-list-items',
    host: {class: 'contents'},
    imports: [
        ChannelDropIndicatorComponent, TextChannelItemComponent, VoiceChannelItemComponent,
        ForumPostRowsComponent,
    ],
    templateUrl: './channel-list-items.component.html',
})
export class ChannelListItemsComponent {
    readonly channels = input.required<ChannelDto[]>();
    readonly canReorder = input.required<boolean>();

    readonly openTextChannel = output<ChannelDto>();
    readonly openVoiceChannel = output<ChannelDto>();
    readonly openChannelMenu = output<ChannelMenuRequest>();
    readonly openParticipantMenu = output<ParticipantMenuRequest>();
    /** A LIVE badge was clicked; carries which channel so the host can build a focus scope. */
    readonly watchVoiceStream = output<{channel: ChannelDto; userId: string}>();
    /** The invite-friends row was clicked; carries the event so the host can anchor its panel. */
    readonly openInvitePanel = output<ChannelMenuRequest>();

    protected readonly ChannelType = ChannelType;
    protected readonly isForumLike = isForumLike;
    protected drag = inject(ChannelListDragService);
}
