import {Type} from '@angular/core';
import {Footprint} from '../../models/profile-canvas';
import {QuoteWidgetComponent} from './widgets/quote-widget.component';

/** What the properties panel draws. One panel serves every widget type. */
export type WidgetField =
    | {kind: 'text'; key: string; labelKey: string; maxLength: number}
    | {kind: 'textarea'; key: string; labelKey: string; maxLength: number}
    | {kind: 'timezone'; key: string; labelKey: string}
    | {kind: 'image'; key: string; labelKey: string}
    | {kind: 'images'; key: string; labelKey: string; max: number}
    | {
          kind: 'rows';
          key: string;
          labelKey: string;
          max: number;
          columns: {key: string; labelKey: string; maxLength: number}[];
      };

export interface WidgetDefinition {
    type: string;
    component: Type<unknown>;
    /** Offered by the editor. The first is what an insert uses. */
    footprints: readonly Footprint[];
    labelKey: string;
    /** PrimeIcons class, without the `pi ` prefix. */
    icon: string;
    /** How many of this type one canvas may hold. */
    max: number;
    fields: readonly WidgetField[];
    /** What a freshly inserted widget of this type holds. */
    defaultConfig: () => unknown;
}

export const WIDGET_REGISTRY: readonly WidgetDefinition[] = [
    {
        type: 'quote',
        component: QuoteWidgetComponent,
        footprints: [
            {w: 2, h: 1},
            {w: 4, h: 1},
            {w: 2, h: 2},
        ],
        labelKey: 'PROFILE.CANVAS.WIDGET.QUOTE',
        icon: 'pi-comment',
        max: 4,
        fields: [
            {kind: 'textarea', key: 'text', labelKey: 'PROFILE.CANVAS.FIELD.QUOTE_TEXT', maxLength: 240},
            {
                kind: 'text',
                key: 'attribution',
                labelKey: 'PROFILE.CANVAS.FIELD.QUOTE_ATTRIBUTION',
                maxLength: 80,
            },
        ],
        defaultConfig: () => ({text: '', attribution: ''}),
    },
];

export function definitionFor(type: string): WidgetDefinition | undefined {
    return WIDGET_REGISTRY.find(definition => definition.type === type);
}
