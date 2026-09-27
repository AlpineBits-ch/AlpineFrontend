import type {AccountSlot} from '../../services/account-registry.service';

export interface RememberedAccounts {
    /** The live slot, on the login screen only because its session ended. */
    expired: AccountSlot | null;
    /** Other accounts to switch back to. Switching to the live slot is a no-op. */
    returnable: AccountSlot[];
}

export function rememberedAccounts(slots: AccountSlot[], liveSlotId: string): RememberedAccounts {
    const expired = slots.find(s => s.id === liveSlotId) ?? null;
    return {expired, returnable: slots.filter(s => s !== expired)};
}
