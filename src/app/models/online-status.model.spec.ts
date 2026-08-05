import {ONLINE_STATUS_LABEL_KEYS, SELECTABLE_STATUSES, statusLabelKey} from './online-status.model';
import {OnlineStatus} from '../dtos/response/profile.dto';

describe('statusLabelKey', () => {
    it('names each status the user can choose', () => {
        expect(statusLabelKey(OnlineStatus.Online)).toBe('STATUS.ONLINE');
        expect(statusLabelKey(OnlineStatus.Idle)).toBe('STATUS.IDLE');
        expect(statusLabelKey(OnlineStatus.DoNotDisturb)).toBe('STATUS.DND');
        expect(statusLabelKey(OnlineStatus.Hidden)).toBe('STATUS.INVISIBLE');
    });

    /** Hidden must be indistinguishable from Offline, or it is not hiding anything. */
    it('gives Offline the same label as Hidden', () => {
        expect(statusLabelKey(OnlineStatus.Offline)).toBe(statusLabelKey(OnlineStatus.Hidden));
    });

    it('names nothing when there is no status', () => {
        expect(statusLabelKey(null)).toBeNull();
        expect(statusLabelKey(undefined)).toBeNull();
    });

    it('covers every member of the enum', () => {
        for (const status of Object.values(OnlineStatus)) {
            expect(ONLINE_STATUS_LABEL_KEYS[status]).toBeDefined();
        }
    });
});

describe('SELECTABLE_STATUSES', () => {
    it('offers the four choosable statuses in order', () => {
        expect(SELECTABLE_STATUSES).toEqual([
            OnlineStatus.Online,
            OnlineStatus.Idle,
            OnlineStatus.DoNotDisturb,
            OnlineStatus.Hidden,
        ]);
    });

    /** Offline is observed, never set. Offering it would send a status the server does not accept. */
    it('never offers Offline', () => {
        expect(SELECTABLE_STATUSES).not.toContain(OnlineStatus.Offline);
    });
});
