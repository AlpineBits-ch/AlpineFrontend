import {Type} from '@angular/core';
import {Footprint, MAX_SPACERS} from '../../models/profile-canvas';
import {CurrentlyWidgetComponent} from './widgets/currently-widget.component';
import {GalleryWidgetComponent} from './widgets/gallery-widget.component';
import {InfoboxWidgetComponent} from './widgets/infobox-widget.component';
import {LocalTimeWidgetComponent} from './widgets/local-time-widget.component';
import {MarqueeWidgetComponent} from './widgets/marquee-widget.component';
import {MutualsWidgetComponent} from './widgets/mutuals-widget.component';
import {OpenToWidgetComponent} from './widgets/open-to-widget.component';
import {PhotoWidgetComponent} from './widgets/photo-widget.component';
import {QuoteWidgetComponent} from './widgets/quote-widget.component';
import {SpacerWidgetComponent} from './widgets/spacer-widget.component';

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
    {
        type: 'marquee',
        component: MarqueeWidgetComponent,
        footprints: [
            {w: 4, h: 1},
            {w: 2, h: 1},
        ],
        labelKey: 'PROFILE.CANVAS.WIDGET.MARQUEE',
        icon: 'pi-bolt',
        max: 1,
        fields: [{kind: 'text', key: 'text', labelKey: 'PROFILE.CANVAS.FIELD.MARQUEE_TEXT', maxLength: 120}],
        defaultConfig: () => ({text: ''}),
    },
    {
        type: 'local-time',
        component: LocalTimeWidgetComponent,
        footprints: [
            {w: 1, h: 1},
            {w: 2, h: 1},
        ],
        labelKey: 'PROFILE.CANVAS.WIDGET.LOCAL_TIME',
        icon: 'pi-clock',
        max: 1,
        fields: [{kind: 'timezone', key: 'timeZone', labelKey: 'PROFILE.CANVAS.FIELD.TIME_ZONE'}],
        defaultConfig: () => ({timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone}),
    },
    {
        type: 'open-to',
        component: OpenToWidgetComponent,
        footprints: [
            {w: 2, h: 1},
            {w: 2, h: 2},
        ],
        labelKey: 'PROFILE.CANVAS.WIDGET.OPEN_TO',
        icon: 'pi-check-circle',
        max: 1,
        fields: [
            {
                kind: 'rows',
                key: 'items',
                labelKey: 'PROFILE.CANVAS.FIELD.OPEN_TO_ITEMS',
                max: 8,
                columns: [
                    {key: 'label', labelKey: 'PROFILE.CANVAS.FIELD.OPEN_TO_LABEL', maxLength: 32},
                    {key: 'state', labelKey: 'PROFILE.CANVAS.FIELD.OPEN_TO_STATE', maxLength: 3},
                ],
            },
        ],
        defaultConfig: () => ({items: []}),
    },
    {
        type: 'mutuals',
        component: MutualsWidgetComponent,
        footprints: [{w: 2, h: 1}],
        labelKey: 'PROFILE.CANVAS.WIDGET.MUTUALS',
        icon: 'pi-users',
        max: 1,
        fields: [],
        defaultConfig: () => ({}),
    },
    {
        type: 'currently',
        component: CurrentlyWidgetComponent,
        footprints: [
            {w: 2, h: 2},
            {w: 2, h: 1},
        ],
        labelKey: 'PROFILE.CANVAS.WIDGET.CURRENTLY',
        icon: 'pi-bookmark',
        max: 1,
        fields: [
            {
                kind: 'rows',
                key: 'rows',
                labelKey: 'PROFILE.CANVAS.FIELD.CURRENTLY_ROWS',
                max: 6,
                columns: [
                    {key: 'verb', labelKey: 'PROFILE.CANVAS.FIELD.CURRENTLY_VERB', maxLength: 16},
                    {key: 'text', labelKey: 'PROFILE.CANVAS.FIELD.CURRENTLY_TEXT', maxLength: 64},
                ],
            },
        ],
        defaultConfig: () => ({rows: []}),
    },
    {
        type: 'infobox',
        component: InfoboxWidgetComponent,
        footprints: [
            {w: 2, h: 2},
            {w: 2, h: 1},
        ],
        labelKey: 'PROFILE.CANVAS.WIDGET.INFOBOX',
        icon: 'pi-list',
        max: 2,
        fields: [
            {kind: 'text', key: 'title', labelKey: 'PROFILE.CANVAS.FIELD.INFOBOX_TITLE', maxLength: 32},
            {
                kind: 'rows',
                key: 'rows',
                labelKey: 'PROFILE.CANVAS.FIELD.INFOBOX_ROWS',
                max: 10,
                columns: [
                    {key: 'label', labelKey: 'PROFILE.CANVAS.FIELD.INFOBOX_LABEL', maxLength: 24},
                    {key: 'value', labelKey: 'PROFILE.CANVAS.FIELD.INFOBOX_VALUE', maxLength: 64},
                ],
            },
        ],
        defaultConfig: () => ({title: '', rows: []}),
    },
    {
        type: 'photo',
        component: PhotoWidgetComponent,
        footprints: [
            {w: 1, h: 1},
            {w: 2, h: 2},
            {w: 4, h: 2},
        ],
        labelKey: 'PROFILE.CANVAS.WIDGET.PHOTO',
        icon: 'pi-image',
        max: 6,
        fields: [
            {kind: 'image', key: 'imageId', labelKey: 'PROFILE.CANVAS.FIELD.PHOTO_IMAGE'},
            {kind: 'text', key: 'alt', labelKey: 'PROFILE.CANVAS.FIELD.PHOTO_ALT', maxLength: 120},
            {kind: 'text', key: 'caption', labelKey: 'PROFILE.CANVAS.FIELD.PHOTO_CAPTION', maxLength: 80},
        ],
        defaultConfig: () => ({imageId: '', alt: '', caption: ''}),
    },
    {
        type: 'gallery',
        component: GalleryWidgetComponent,
        footprints: [
            {w: 4, h: 1},
            {w: 2, h: 2},
        ],
        labelKey: 'PROFILE.CANVAS.WIDGET.GALLERY',
        icon: 'pi-images',
        max: 2,
        fields: [{kind: 'images', key: 'items', labelKey: 'PROFILE.CANVAS.FIELD.GALLERY_ITEMS', max: 8}],
        defaultConfig: () => ({items: []}),
    },
    {
        // TODO(task 5, anchored widget editor): selection currently has to infer "not
        // selectable" from fields.length === 0. Decide there whether that needs its own flag.
        type: 'spacer',
        component: SpacerWidgetComponent,
        footprints: [
            {w: 1, h: 1},
            {w: 2, h: 1},
            {w: 2, h: 2},
            {w: 4, h: 1},
        ],
        labelKey: 'PROFILE.CANVAS.WIDGET.SPACER',
        icon: 'pi-stop',
        max: MAX_SPACERS,
        fields: [],
        defaultConfig: () => ({}),
    },
];

export function definitionFor(type: string): WidgetDefinition | undefined {
    return WIDGET_REGISTRY.find(definition => definition.type === type);
}
