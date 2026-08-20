import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {ChannelType} from '../../../../dtos/response/guild.dto';
import {channelIconDataFor, channelIconTint} from '../../channel-types';
import {LucideIconComponent} from '../../../../components/lucide-icon/lucide-icon.component';

/** The channel icon slot: a channel's own icon, else its type's, else the literal `#`. */
@Component({
    selector: 'app-channel-icon',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: {class: 'contents'},
    imports: [LucideIconComponent],
    template: `
        <span
            class="chan-icon pointer-events-none"
            [class.chan-icon-hash]="!icon()"
            [class.chan-icon-tinted]="!!tint()"
            [style.--chan-icon-tint]="tint()"
        >
            @if (icon(); as data) {
                <app-lucide-icon [icon]="data" />
            } @else if (fallbackHash()) {
                #
            }
        </span>
    `,
})
export class ChannelIconComponent {
    readonly channel = input.required<{type: ChannelType; icon?: string; iconColor?: string}>();
    /** Off for surfaces that would rather show nothing than a `#`, such as the type picker. */
    readonly fallbackHash = input(true);

    protected readonly icon = computed(() => channelIconDataFor(this.channel()));
    protected readonly tint = computed(() => channelIconTint(this.channel()));
}
