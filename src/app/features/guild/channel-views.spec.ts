import {describe, expect, it} from 'vitest';
import {ChannelType} from '../../dtos/response/guild.dto';
import {CHANNEL_META} from './channel-types';
import {CHANNEL_VIEW_COMPONENTS, channelComponentFor} from './channel-views';

describe('CHANNEL_VIEW_COMPONENTS', () => {
    it('resolves every view to a class', () => {
        for (const [view, component] of Object.entries(CHANNEL_VIEW_COMPONENTS)) {
            expect(component, view).toBeTypeOf('function');
        }
    });

    it('gives each view its own component', () => {
        const components = Object.values(CHANNEL_VIEW_COMPONENTS);
        expect(new Set(components).size).toBe(components.length);
    });
});

describe('channelComponentFor', () => {
    it('follows CHANNEL_META for every shipped type', () => {
        for (const meta of CHANNEL_META) {
            expect(channelComponentFor(meta.type), meta.type).toBe(CHANNEL_VIEW_COMPONENTS[meta.view]);
        }
    });

    it('is the placeholder for a type this build does not know', () => {
        expect(channelComponentFor('Sauna' as ChannelType)).toBe(CHANNEL_VIEW_COMPONENTS.unsupported);
        expect(channelComponentFor('' as ChannelType)).toBe(CHANNEL_VIEW_COMPONENTS.unsupported);
    });

    it('never hands a household type the message view, which is the one with a composer', () => {
        for (const meta of CHANNEL_META) {
            if (!meta.household) continue;
            expect(channelComponentFor(meta.type), meta.type).not.toBe(CHANNEL_VIEW_COMPONENTS.message);
        }
    });
});
