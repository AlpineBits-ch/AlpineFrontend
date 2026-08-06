import {TranslateService} from '@ngx-translate/core';

/**
 * Strings the block extensions need.
 *
 * They live in a plain object rather than being looked up through `TranslateService` at the point
 * of use because these labels are written by ProseMirror node views and plugins - code that runs
 * outside Angular's injector and outside its change detection, so a pipe is not available and an
 * injected service would have to be threaded through every closure.
 *
 * The English defaults are the fallback, not the source of truth: `wikiBlockLabels()` overlays the
 * translated values when the caller has a `TranslateService` to hand.
 */
export interface WikiBlockLabels {
    calloutInfo: string;
    calloutTip: string;
    calloutWarning: string;
    calloutDanger: string;
    calloutChangeType: string;
    toggleSummaryPlaceholder: string;
    toggleExpand: string;
    codeCopy: string;
    codeCopied: string;
    codeLanguage: string;
    codePlain: string;
    diagramRendering: string;
    diagramFailed: string;
    imageCaption: string;
    imageClose: string;
    tableAddRowAbove: string;
    tableAddRowBelow: string;
    tableAddColumnLeft: string;
    tableAddColumnRight: string;
    tableDeleteRow: string;
    tableDeleteColumn: string;
    tableToggleHeaderRow: string;
    tableDelete: string;
}

export const DEFAULT_WIKI_BLOCK_LABELS: WikiBlockLabels = {
    calloutInfo: 'Note',
    calloutTip: 'Tip',
    calloutWarning: 'Warning',
    calloutDanger: 'Caution',
    calloutChangeType: 'Change callout type',
    toggleSummaryPlaceholder: 'Toggle title',
    toggleExpand: 'Expand or collapse',
    codeCopy: 'Copy code',
    codeCopied: 'Copied',
    codeLanguage: 'Language',
    codePlain: 'Plain text',
    diagramRendering: 'Rendering diagram…',
    diagramFailed: 'This diagram could not be rendered',
    imageCaption: 'Add a caption',
    imageClose: 'Close',
    tableAddRowAbove: 'Insert row above',
    tableAddRowBelow: 'Insert row below',
    tableAddColumnLeft: 'Insert column left',
    tableAddColumnRight: 'Insert column right',
    tableDeleteRow: 'Delete row',
    tableDeleteColumn: 'Delete column',
    tableToggleHeaderRow: 'Toggle header row',
    tableDelete: 'Delete table',
};

const LABEL_KEYS: Record<keyof WikiBlockLabels, string> = {
    calloutInfo: 'WIKI.CALLOUT.INFO',
    calloutTip: 'WIKI.CALLOUT.TIP',
    calloutWarning: 'WIKI.CALLOUT.WARNING',
    calloutDanger: 'WIKI.CALLOUT.DANGER',
    calloutChangeType: 'WIKI.CALLOUT.CHANGE_TYPE',
    toggleSummaryPlaceholder: 'WIKI.TOGGLE.SUMMARY_PLACEHOLDER',
    toggleExpand: 'WIKI.TOGGLE.EXPAND',
    codeCopy: 'WIKI.CODE.COPY',
    codeCopied: 'WIKI.CODE.COPIED',
    codeLanguage: 'WIKI.CODE.LANGUAGE',
    codePlain: 'WIKI.CODE.PLAIN',
    diagramRendering: 'WIKI.DIAGRAM.RENDERING',
    diagramFailed: 'WIKI.DIAGRAM.FAILED',
    imageCaption: 'WIKI.IMAGE.CAPTION',
    imageClose: 'WIKI.IMAGE.CLOSE',
    tableAddRowAbove: 'WIKI.TABLE.ADD_ROW_ABOVE',
    tableAddRowBelow: 'WIKI.TABLE.ADD_ROW_BELOW',
    tableAddColumnLeft: 'WIKI.TABLE.ADD_COLUMN_LEFT',
    tableAddColumnRight: 'WIKI.TABLE.ADD_COLUMN_RIGHT',
    tableDeleteRow: 'WIKI.TABLE.DELETE_ROW',
    tableDeleteColumn: 'WIKI.TABLE.DELETE_COLUMN',
    tableToggleHeaderRow: 'WIKI.TABLE.TOGGLE_HEADER_ROW',
    tableDelete: 'WIKI.TABLE.DELETE',
};

/**
 * Resolves the labels once, at editor construction.
 *
 * `instant` returns the key itself when a translation is missing, which would put `WIKI.CODE.COPY`
 * in a tooltip - so a miss falls back to the English default instead.
 */
export function wikiBlockLabels(translate: TranslateService): WikiBlockLabels {
    const resolved = {...DEFAULT_WIKI_BLOCK_LABELS};
    for (const name of Object.keys(LABEL_KEYS) as (keyof WikiBlockLabels)[]) {
        const key = LABEL_KEYS[name];
        const value = translate.instant(key) as unknown;
        if (typeof value === 'string' && value && value !== key) resolved[name] = value;
    }
    return resolved;
}
