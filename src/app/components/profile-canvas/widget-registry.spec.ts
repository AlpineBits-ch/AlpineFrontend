import {describe, expect, it} from 'vitest';
import {WIDGET_REGISTRY, definitionFor} from './widget-registry';
import {FOOTPRINTS, MAX_WIDGETS} from '../../models/profile-canvas';
import en from '../../../assets/i18n/locales/en.json';

const KEYS = en as Record<string, string>;

function isLegal(footprint: {w: number; h: number}): boolean {
    return FOOTPRINTS.some(legal => legal.w === footprint.w && legal.h === footprint.h);
}

describe('WIDGET_REGISTRY', () => {
    it('holds every widget type exactly once', () => {
        const types = WIDGET_REGISTRY.map(d => d.type);
        expect(new Set(types).size).toBe(types.length);
    });

    it('offers only legal footprints', () => {
        for (const definition of WIDGET_REGISTRY) {
            expect(definition.footprints.length).toBeGreaterThan(0);
            for (const footprint of definition.footprints) {
                expect(isLegal(footprint), `${definition.type} ${footprint.w}x${footprint.h}`).toBe(true);
            }
        }
    });

    it('names a translation key that exists, for itself and every field', () => {
        for (const definition of WIDGET_REGISTRY) {
            expect(KEYS[definition.labelKey], definition.labelKey).toBeDefined();
            for (const field of definition.fields) {
                expect(KEYS[field.labelKey], field.labelKey).toBeDefined();
                if (field.kind === 'rows') {
                    for (const column of field.columns) {
                        expect(KEYS[column.labelKey], column.labelKey).toBeDefined();
                    }
                }
            }
        }
    });

    it('allows at least one of each type and never more than the canvas holds', () => {
        for (const definition of WIDGET_REGISTRY) {
            expect(definition.max).toBeGreaterThan(0);
            expect(definition.max).toBeLessThanOrEqual(MAX_WIDGETS);
        }
    });

    it('gives every type a default config that is an object', () => {
        for (const definition of WIDGET_REGISTRY) {
            expect(typeof definition.defaultConfig()).toBe('object');
            expect(definition.defaultConfig()).not.toBeNull();
        }
    });

    it('gives every declared field a matching key in the default config', () => {
        for (const definition of WIDGET_REGISTRY) {
            const config = definition.defaultConfig() as Record<string, unknown>;
            for (const field of definition.fields) {
                expect(config, `${definition.type}.${field.key}`).toHaveProperty(field.key);
                const value = config[field.key];

                switch (field.kind) {
                    case 'text':
                    case 'textarea':
                    case 'timezone':
                    case 'image':
                        expect(typeof value, `${definition.type}.${field.key}`).toBe('string');
                        break;
                    case 'images':
                    case 'rows':
                        expect(Array.isArray(value), `${definition.type}.${field.key}`).toBe(true);
                        break;
                }
            }
        }
    });

    it('definitionFor resolves a known type and answers undefined for an unknown one', () => {
        expect(definitionFor('quote')?.type).toBe('quote');
        expect(definitionFor('from-the-future')).toBeUndefined();
    });
});
