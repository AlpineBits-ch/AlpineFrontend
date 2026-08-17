import {describe, expect, it} from 'vitest';
import {placePopout, POPOUT_GAP, POPOUT_MARGIN, Rect} from './place-popout';

const CARD = {width: 340, height: 400};
const VIEWPORT = {width: 1280, height: 800};

function anchor(partial: Partial<Rect> = {}): Rect {
    return {left: 1000, right: 1240, top: 200, ...partial};
}

describe('placePopout', () => {
    it('sits to the left of the anchor', () => {
        const {left} = placePopout(anchor(), CARD, VIEWPORT);

        expect(left).toBe(1000 - CARD.width - POPOUT_GAP);
    });

    it('flips to the right when the left side cannot hold it', () => {
        const {left} = placePopout(anchor({left: 40, right: 280}), CARD, VIEWPORT);

        expect(left).toBe(280 + POPOUT_GAP);
    });

    it('clamps rather than flipping when neither side fits', () => {
        const narrow = {width: 400, height: 300};
        const {left} = placePopout(anchor({left: 100, right: 300}), CARD, narrow);

        expect(left).toBe(Math.max(POPOUT_MARGIN, narrow.width - CARD.width - POPOUT_MARGIN));
        expect(left).toBeGreaterThanOrEqual(POPOUT_MARGIN);
    });

    it('aligns its top to the anchor when there is room', () => {
        const {top} = placePopout(anchor({top: 200}), CARD, VIEWPORT);

        expect(top).toBe(200);
    });

    it('lifts a card that would run off the bottom', () => {
        const {top} = placePopout(anchor({top: 700}), CARD, VIEWPORT);

        expect(top).toBe(VIEWPORT.height - CARD.height - POPOUT_MARGIN);
    });

    it('pushes a card anchored above the top edge back into view', () => {
        const {top} = placePopout(anchor({top: -50}), CARD, VIEWPORT);

        expect(top).toBe(POPOUT_MARGIN);
    });

    it('pins a card taller than the viewport to the top', () => {
        const tall = {width: 340, height: 900};

        const {top} = placePopout(anchor({top: 400}), tall, VIEWPORT);

        expect(top).toBe(POPOUT_MARGIN);
    });
});
