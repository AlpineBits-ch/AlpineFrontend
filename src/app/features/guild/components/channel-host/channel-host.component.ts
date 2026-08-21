import {NgComponentOutlet} from '@angular/common';
import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {ChannelDto} from '../../../../dtos/response/guild.dto';
import {channelComponentFor} from '../../channel-views';

/** Renders whichever view `CHANNEL_VIEW_COMPONENTS` names for the channel's type. */
@Component({
    selector: 'app-channel-host',
    changeDetection: ChangeDetectionStrategy.OnPush,
    // The views root on their own h-full box and expect the main pane as their parent.
    host: {class: 'contents'},
    imports: [NgComponentOutlet],
    template: `<ng-container [ngComponentOutlet]="component()" [ngComponentOutletInputs]="inputs()" />`,
})
export class ChannelHostComponent {
    readonly channel = input.required<ChannelDto>();

    protected readonly component = computed(() => channelComponentFor(this.channel().type));
    protected readonly inputs = computed(() => ({channel: this.channel()}));
}
