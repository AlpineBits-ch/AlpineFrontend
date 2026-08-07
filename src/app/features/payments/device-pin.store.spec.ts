import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {TestBed} from '@angular/core/testing';
import {installMemoryStorage} from '../../testing/memory-storage';
import {DevicePinStore} from './device-pin.store';

const USER = 'user_anna';
const GUILD = 'guild_ahorn';
const KEY = `alpine.payments.pins.${USER}.${GUILD}`;

let store: DevicePinStore;
let restoreStorage: () => void;

beforeEach(() => {
    restoreStorage = installMemoryStorage();
    TestBed.resetTestingModule();
    store = TestBed.inject(DevicePinStore);
});

afterEach(() => restoreStorage());

describe('DevicePinStore', () => {
    it('round-trips a pin with its identity key version', () => {
        store.write(USER, GUILD, {dev_a: {publicKey: 'k', identityKeyVersion: 3}});
        expect(store.read(USER, GUILD)).toEqual({dev_a: {publicKey: 'k', identityKeyVersion: 3}});
    });

    it('reads nothing for a household nothing was ever sealed in', () => {
        expect(store.read(USER, GUILD)).toEqual({});
    });

    it('keeps two households apart', () => {
        // The same person on the same device is legitimately in two houses, and neither should be
        // able to clobber the other's record of what it has seen.
        store.write(USER, GUILD, {dev_a: {publicKey: 'k1'}});
        store.write(USER, 'guild_other', {dev_a: {publicKey: 'k2'}});

        expect(store.read(USER, GUILD)['dev_a']?.publicKey).toBe('k1');
        expect(store.read(USER, 'guild_other')['dev_a']?.publicKey).toBe('k2');
    });

    it('keeps two accounts on one machine apart', () => {
        store.write(USER, GUILD, {dev_a: {publicKey: 'k1'}});
        expect(store.read('user_ben', GUILD)).toEqual({});
    });

    /**
     * The first version of this store held a bare base64 string per device. Dropping those entries
     * on upgrade would have re-prompted about every device somebody had already vouched for, which
     * is how people are taught to click through the one warning that matters.
     */
    it('reads a legacy bare-string pin as a pin with no version', () => {
        localStorage.setItem(KEY, JSON.stringify({dev_a: 'legacy-key'}));
        expect(store.read(USER, GUILD)).toEqual({dev_a: {publicKey: 'legacy-key'}});
    });

    it('reads a mixture of old and new entries', () => {
        localStorage.setItem(KEY, JSON.stringify({
            dev_old: 'legacy-key',
            dev_new: {publicKey: 'k', identityKeyVersion: 2},
        }));

        expect(store.read(USER, GUILD)).toEqual({
            dev_old: {publicKey: 'legacy-key'},
            dev_new: {publicKey: 'k', identityKeyVersion: 2},
        });
    });

    it('drops a malformed entry instead of pinning something unusable', () => {
        // Degrading to "we have not seen this device" prompts, which is right. A pin of `undefined`
        // would compare unequal to every real key and cry attack on all of them.
        localStorage.setItem(KEY, JSON.stringify({
            dev_bad: {identityKeyVersion: 1},
            dev_empty: '',
            dev_null: null,
            dev_ok: {publicKey: 'k'},
        }));

        expect(store.read(USER, GUILD)).toEqual({dev_ok: {publicKey: 'k'}});
    });

    it('ignores a non-numeric version rather than storing it', () => {
        localStorage.setItem(KEY, JSON.stringify({dev_a: {publicKey: 'k', identityKeyVersion: 'two'}}));
        expect(store.read(USER, GUILD)).toEqual({dev_a: {publicKey: 'k'}});
    });

    it('survives a value that is not JSON at all', () => {
        localStorage.setItem(KEY, '{not json');
        expect(store.read(USER, GUILD)).toEqual({});
    });

    it('forgets a household on clear', () => {
        store.write(USER, GUILD, {dev_a: {publicKey: 'k'}});
        store.clear(USER, GUILD);
        expect(store.read(USER, GUILD)).toEqual({});
    });
});
