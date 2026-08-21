import {InjectionToken, Provider, ProviderToken} from '@angular/core';
import {AbsenceService} from './absence.service';
import {BillService} from './bill.service';
import {ChoreService} from './chore.service';
import {DecisionService} from './decision.service';
import {HomeStatusService} from './home-status.service';
import {HouseholdAlertService} from './household-alert.service';
import {InboxService} from './inbox.service';
import {MaintenanceService} from './maintenance.service';
import {MealService} from './meal.service';
import {VoiceRingStateService} from './voice-ring-state.service';
import {ConversationStore} from '../stores/conversation.store';
import {EntitlementStore} from '../stores/entitlement.store';
import {GuildEmojiStore} from '../stores/guild-emoji.store';
import {LedgerStore} from '../stores/ledger.store';
import {ListStore} from '../stores/list.store';
import {MessageStore} from '../stores/message.store';
import {PantryStore} from '../stores/pantry.store';
import {RelationshipStore} from '../stores/relationship.store';
import {ScheduledEventStore} from '../stores/scheduled-event.store';

/**
 * Everything root-provided whose realtime handlers must be live before a user opens anything.
 *
 * Resolving the token is what constructs them, so being on this list and being registered are the
 * same act. A listener left off it starts listening when the first view that injects it opens, and
 * every event before that lands nowhere.
 *
 * Registering a handler must stay cheap. Nothing here may fetch, read storage or touch crypto while
 * being constructed; split the registration out of the service rather than making launch pay for it.
 */
export const REALTIME_LISTENER = new InjectionToken<readonly unknown[]>('REALTIME_LISTENER');

const LISTENERS: ProviderToken<unknown>[] = [
    AbsenceService,
    BillService,
    ChoreService,
    DecisionService,
    HomeStatusService,
    // Not folded into the modules it serves: one `guild.HouseholdAlert` covers chores, decisions
    // and bills, and the dedupe behind it is per session, not per module.
    HouseholdAlertService,
    InboxService,
    MaintenanceService,
    MealService,
    VoiceRingStateService,
    // The signal stores register in `withHooks({onInit})`, which a root store runs on first inject.
    ConversationStore,
    EntitlementStore,
    GuildEmojiStore,
    LedgerStore,
    ListStore,
    MessageStore,
    PantryStore,
    RelationshipStore,
    ScheduledEventStore,
];

export function provideRealtimeListeners(): Provider[] {
    return LISTENERS.map(listener => ({provide: REALTIME_LISTENER, multi: true, useExisting: listener}));
}
