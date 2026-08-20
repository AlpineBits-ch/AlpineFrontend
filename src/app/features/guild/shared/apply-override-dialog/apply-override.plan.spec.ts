import {mergeOverride, planApply} from './apply-override.plan';
import {Permissions} from '../../../../enums/permissions.enum';

const EMPTY = {allow: 0n, deny: 0n, allowModule: 0n, denyModule: 0n};

describe('apply override plan', () => {
    it('replaces whatever was there in replace mode', () => {
        const steps = planApply(
            [{channelId: 'c1', existing: {...EMPTY, deny: Permissions.SendMessages}}],
            {...EMPTY, allow: Permissions.AddReactions},
            'replace',
        );

        expect(steps[0].result).toEqual({...EMPTY, allow: Permissions.AddReactions});
    });

    it('unions both masks in merge mode', () => {
        const steps = planApply(
            [{channelId: 'c1', existing: {...EMPTY, deny: Permissions.SendMessages}}],
            {...EMPTY, allow: Permissions.AddReactions},
            'merge',
        );

        expect(steps[0].result.allow).toBe(Permissions.AddReactions);
        expect(steps[0].result.deny).toBe(Permissions.SendMessages);
    });

    // A bit cannot be on both sides. The incoming side wins, because it is the edit being made.
    it('lets the incoming side win a conflict', () => {
        const merged = mergeOverride(
            {...EMPTY, deny: Permissions.SendMessages},
            {...EMPTY, allow: Permissions.SendMessages},
        );

        expect(merged.allow & Permissions.SendMessages).toBe(Permissions.SendMessages);
        expect(merged.deny & Permissions.SendMessages).toBe(0n);
    });

    it('skips a channel whose result would be identical', () => {
        const same = {...EMPTY, allow: Permissions.AddReactions};

        const steps = planApply([{channelId: 'c1', existing: same}], same, 'replace');

        expect(steps[0].skipped).toBe(true);
    });

    it('does not skip a channel with no override yet', () => {
        const steps = planApply(
            [{channelId: 'c1', existing: null}],
            {...EMPTY, allow: Permissions.AddReactions},
            'replace',
        );

        expect(steps[0].skipped).toBe(false);
    });
});
