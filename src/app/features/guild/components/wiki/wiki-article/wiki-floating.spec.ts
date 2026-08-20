import {anchorTo, AnchorRect} from './wiki-floating';

/** 1000x800, so every expectation below reads against round numbers. */
const VIEWPORT = {width: 1000, height: 800};

function rect(left: number, top: number, width = 4, height = 18): AnchorRect {
    return {left, top, right: left + width, bottom: top + height};
}

describe('anchorTo', () => {
    const size = {width: 320, height: 320};

    it('sits below the anchor when there is room', () => {
        const result = anchorTo(rect(100, 100), size, {viewport: VIEWPORT});

        expect(result.placement).toBe('below');
        expect(result.top).toBe(124);
        expect(result.left).toBe(100);
    });

    it('flips above when the space below cannot hold it', () => {
        const result = anchorTo(rect(100, 700), size, {viewport: VIEWPORT});

        expect(result.placement).toBe('above');
        // Bottom edge of the surface sits one gap above the anchor's top.
        expect(result.top).toBe(700 - 6 - 320);
    });

    it('clamps to the left margin for an anchor left of the viewport', () => {
        const result = anchorTo(rect(-40, 100), size, {viewport: VIEWPORT});

        expect(result.left).toBe(8);
    });

    it('clamps to the right margin rather than overflowing', () => {
        const result = anchorTo(rect(950, 100), size, {viewport: VIEWPORT});

        expect(result.left).toBe(1000 - 320 - 8);
    });

    it('takes the roomier side and clamps when neither side can hold it', () => {
        const tall = {width: 320, height: 700};

        const nearTop = anchorTo(rect(100, 300), tall, {viewport: VIEWPORT});
        expect(nearTop.placement).toBe('below');
        expect(nearTop.top).toBe(800 - 700 - 8);

        const nearBottom = anchorTo(rect(100, 600), tall, {viewport: VIEWPORT});
        expect(nearBottom.placement).toBe('above');
        expect(nearBottom.top).toBe(8);
    });

    it('pins a surface bigger than the viewport to the top-left margin', () => {
        const huge = {width: 1200, height: 900};

        const result = anchorTo(rect(400, 400), huge, {viewport: VIEWPORT});

        expect(result.top).toBe(8);
        expect(result.left).toBe(8);
    });

    it('keeps a partially off-screen anchor inside the viewport on both axes', () => {
        const result = anchorTo(rect(-20, 790), size, {viewport: VIEWPORT});

        expect(result.left).toBe(8);
        expect(result.top).toBeGreaterThanOrEqual(8);
        expect(result.top + size.height).toBeLessThanOrEqual(VIEWPORT.height - 8);
    });

    it('centres on the anchor when asked, before clamping', () => {
        const centred = anchorTo(rect(500, 100, 100), size, {viewport: VIEWPORT, align: 'center'});
        expect(centred.left).toBe(550 - 160);

        const clamped = anchorTo(rect(0, 100, 20), size, {viewport: VIEWPORT, align: 'center'});
        expect(clamped.left).toBe(8);
    });
});
