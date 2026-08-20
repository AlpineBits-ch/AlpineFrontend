import {PERMISSION_PRESETS, presetOverride, presetsFor} from './permission-presets';
import {Permissions} from '../../../enums/permissions.enum';
import {ChannelType} from '../../../dtos/response/guild.dto';

describe('permission presets', () => {
    it('turns a preset into the masks the grid would write', () => {
        const readOnly = PERMISSION_PRESETS.find(p => p.id === 'read-only')!;

        const override = presetOverride(readOnly);

        expect(override.allow & Permissions.ViewChannel).toBe(Permissions.ViewChannel);
        expect(override.allow & Permissions.ReadMessageHistory).toBe(Permissions.ReadMessageHistory);
        expect(override.deny & Permissions.SendMessages).toBe(Permissions.SendMessages);
    });

    it('leaves the module masks untouched', () => {
        const override = presetOverride(PERMISSION_PRESETS[0]);

        expect(override.allowModule).toBe(0n);
        expect(override.denyModule).toBe(0n);
    });

    it('offers the voice preset on a voice channel and nowhere else', () => {
        expect(presetsFor(ChannelType.Voice).map(p => p.id)).toContain('listen-only');
        expect(presetsFor(ChannelType.Text).map(p => p.id)).not.toContain('listen-only');
    });

    it('offers the text presets on a category, which has no type', () => {
        expect(presetsFor(null).map(p => p.id)).toContain('read-only');
    });

    it('never lets a preset allow and deny the same bit', () => {
        for (const preset of PERMISSION_PRESETS) {
            const override = presetOverride(preset);
            expect(override.allow & override.deny).toBe(0n);
        }
    });
});
