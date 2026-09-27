import {AccountSlot, BOOTSTRAP_SLOT_ID} from '../../services/account-registry.service';
import {rememberedAccounts} from './remembered-accounts';

function slot(id: string, username: string): AccountSlot {
    return {
        id,
        userId: `user-${id}`,
        serverUrl: 'https://api.venta.gg',
        username,
        displayName: username,
        avatarUrl: null,
        lastUsedAt: 0,
    };
}

const ada = slot('a', 'ada');
const bob = slot('b', 'bob');

it('names the live account whose session expired and offers only the others', () => {
    const {expired, returnable} = rememberedAccounts([ada, bob], 'a');

    expect(expired).toBe(ada);
    expect(returnable).toEqual([bob]);
});

it('offers every account while one is being added', () => {
    const {expired, returnable} = rememberedAccounts([ada, bob], BOOTSTRAP_SLOT_ID);

    expect(expired).toBeNull();
    expect(returnable).toEqual([ada, bob]);
});
