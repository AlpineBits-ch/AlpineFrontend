import {Component, computed, input} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {ChannelDto} from '../../../../dtos/response/guild.dto';
import {householdChannelMeta} from '../../channel-types';

/**
 * Shown for a channel this build cannot render: a household type whose module has not
 * shipped yet, or a type from a newer server. Inert by construction - no inputs beyond
 * the channel, no outputs, no fetching, and above all no composer.
 */
@Component({
    selector: 'app-unsupported-channel',
    imports: [TranslateModule],
    templateUrl: './unsupported-channel.component.html',
})
export class UnsupportedChannelComponent {
    channel = input.required<ChannelDto>();

    private meta = computed(() => householdChannelMeta(this.channel().type));

    /**
     * A household channel keeps its own icon and noun, so a shopping list opened before
     * the Lists module lands still reads as a shopping list - just not an interactive
     * one. A genuinely unknown type falls back to a neutral glyph.
     */
    protected icon = computed(() => this.meta()?.icon ?? 'pi pi-question-circle');
    protected typeLabelKey = computed(() => this.meta()?.labelKey ?? null);
    protected typeDescKey = computed(() => this.meta()?.descKey ?? null);
}
