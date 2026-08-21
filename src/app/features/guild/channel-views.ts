import {InputSignal, Type} from '@angular/core';
import {ChannelDto, ChannelType} from '../../dtos/response/guild.dto';
import {ChannelView, channelViewFor} from './channel-types';
import {ChannelComponent} from './components/channel/channel.component';
import {ChoresChannelComponent} from './components/chores-channel/chores-channel.component';
import {DecisionsChannelComponent} from './components/decisions-channel/decisions-channel.component';
import {ForumChannelComponent} from './components/forum-channel/forum-channel.component';
import {LedgerChannelComponent} from './components/ledger-channel/ledger-channel.component';
import {ListChannelComponent} from './components/list-channel/list-channel.component';
import {MaintenanceChannelComponent} from './components/maintenance-channel/maintenance-channel.component';
import {MealsChannelComponent} from './components/meals-channel/meals-channel.component';
import {PantryChannelComponent} from './components/pantry-channel/pantry-channel.component';
import {UnsupportedChannelComponent} from './components/unsupported-channel/unsupported-channel.component';
import {VoiceChannelComponent} from './components/voice-channel/voice-channel.component';

/** The one input every channel view takes. `ngComponentOutletInputs` is stringly typed, so this is what keeps the key and the component honest. */
export interface ChannelViewComponent {
    channel: InputSignal<ChannelDto>;
}

/** Kept out of `channel-types.ts`: a component reference there would cycle back through `unsupported-channel.component.ts` and drag all eleven views into `channel-icon.component.ts`'s graph. */
export const CHANNEL_VIEW_COMPONENTS: Record<ChannelView, Type<ChannelViewComponent>> = {
    message: ChannelComponent,
    voice: VoiceChannelComponent,
    forum: ForumChannelComponent,
    list: ListChannelComponent,
    chores: ChoresChannelComponent,
    ledger: LedgerChannelComponent,
    pantry: PantryChannelComponent,
    decisions: DecisionsChannelComponent,
    meals: MealsChannelComponent,
    maintenance: MaintenanceChannelComponent,
    unsupported: UnsupportedChannelComponent,
};

export function channelComponentFor(type: ChannelType): Type<ChannelViewComponent> {
    return CHANNEL_VIEW_COMPONENTS[channelViewFor(type)];
}
