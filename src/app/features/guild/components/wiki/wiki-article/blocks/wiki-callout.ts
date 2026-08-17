import {InputRule, JSONContent, mergeAttributes, Node} from '@tiptap/core';
import {DEFAULT_WIKI_BLOCK_LABELS, WikiBlockLabels} from './wiki-block-labels';

export type CalloutVariant = 'info' | 'tip' | 'warning' | 'danger';

export const CALLOUT_VARIANTS: readonly CalloutVariant[] = ['info', 'tip', 'warning', 'danger'];

/** GitHub's alert syntax, chosen over a :::info fence because it is the one callout dialect that renders as something everywhere else: a plain markdown viewer shows a blockquote naming the severity, not three stray colons. */
const MARKERS: Record<CalloutVariant, string> = {
    info: 'NOTE',
    tip: 'TIP',
    warning: 'WARNING',
    danger: 'CAUTION',
};

/** Everything we are willing to read back, including the markers other tools emit. */
const ALIASES: Record<string, CalloutVariant> = {
    NOTE: 'info',
    INFO: 'info',
    ABSTRACT: 'info',
    SUMMARY: 'info',
    TIP: 'tip',
    HINT: 'tip',
    IMPORTANT: 'tip',
    SUCCESS: 'tip',
    WARNING: 'warning',
    ATTENTION: 'warning',
    ALERT: 'warning',
    CAUTION: 'danger',
    DANGER: 'danger',
    ERROR: 'danger',
    BUG: 'danger',
};

const ICONS: Record<CalloutVariant, string> = {
    info: 'pi-info-circle',
    tip: 'pi-lightbulb',
    warning: 'pi-exclamation-triangle',
    danger: 'pi-times-circle',
};

/** > [!TIP] typed at the head of a block; the "> " half is optional since Blockquote's own input rule usually swallows it first, leaving only the marker to match. */
const INPUT_REGEX = /^\s*(?:>\s)?\[!([A-Za-z]+)]\s$/;

/** The marker, and any body text the author left on the same line as it. */
const MARKER_REGEX = /^[ \t]*\[!([A-Za-z]+)][ \t]*(?:\r?\n)?/;

/** A run of consecutive > lines: the whole quote, before anything is stripped from it. */
const QUOTE_BLOCK_REGEX = /^((?: {0,3}>[^\n]*(?:\n|$))+)/;

const QUOTE_PREFIX_REGEX = /^ {0,3}> ?/;

export interface WikiCalloutOptions {
    labels: WikiBlockLabels;
    HTMLAttributes: Record<string, unknown>;
}

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        wikiCallout: {
            setCallout: (attributes?: {variant?: CalloutVariant}) => ReturnType;
            toggleCallout: (attributes?: {variant?: CalloutVariant}) => ReturnType;
            unsetCallout: () => ReturnType;
        };
    }
}

function variantOf(value: unknown): CalloutVariant {
    return CALLOUT_VARIANTS.includes(value as CalloutVariant) ? (value as CalloutVariant) : 'info';
}

function labelFor(labels: WikiBlockLabels, variant: CalloutVariant): string {
    switch (variant) {
        case 'tip':
            return labels.calloutTip;
        case 'warning':
            return labels.calloutWarning;
        case 'danger':
            return labels.calloutDanger;
        default:
            return labels.calloutInfo;
    }
}

/** Info / tip / warning / danger boxes. */
export const WikiCallout = Node.create<WikiCalloutOptions>({
    name: 'callout',

    group: 'block',

    content: 'block+',

    defining: true,

    addOptions() {
        return {labels: DEFAULT_WIKI_BLOCK_LABELS, HTMLAttributes: {}};
    },

    addAttributes() {
        return {
            variant: {
                default: 'info' as CalloutVariant,
                parseHTML: element => variantOf(element.getAttribute('data-variant')),
                renderHTML: attributes => ({'data-variant': variantOf(attributes['variant'])}),
            },
        };
    },

    parseHTML() {
        return [{tag: 'div[data-callout]'}];
    },

    renderHTML({HTMLAttributes}) {
        return [
            'div',
            mergeAttributes({'data-callout': ''}, this.options.HTMLAttributes, HTMLAttributes, {
                class: 'wiki-callout',
            }),
            ['div', {class: 'wiki-callout-body'}, 0],
        ];
    },

    /** The icon is a node view, not part of renderHTML: it doubles as the control that cycles the variant, and a decorative span in the render spec could not carry a click handler. */
    addNodeView() {
        const labels = this.options.labels;
        return ({node, editor, getPos}) => {
            const dom = document.createElement('div');
            dom.className = 'wiki-callout';
            dom.setAttribute('data-callout', '');

            const marker = document.createElement('div');
            marker.className = 'wiki-callout-mark';
            marker.contentEditable = 'false';
            marker.title = labels.calloutChangeType;
            const icon = document.createElement('i');
            marker.appendChild(icon);

            const body = document.createElement('div');
            body.className = 'wiki-callout-body';

            dom.append(marker, body);

            let variant = variantOf(node.attrs['variant']);
            const paint = () => {
                dom.setAttribute('data-variant', variant);
                icon.className = `pi ${ICONS[variant]}`;
                marker.setAttribute('aria-label', labelFor(labels, variant));
            };
            paint();

            marker.addEventListener('mousedown', event => {
                if (!editor.isEditable) return;
                // Before the click lands: mousedown inside the editor would otherwise move the
                // caret out of the callout body and fight the transaction below.
                event.preventDefault();
                const pos = getPos();
                if (pos === undefined) return;
                const next =
                    CALLOUT_VARIANTS[(CALLOUT_VARIANTS.indexOf(variant) + 1) % CALLOUT_VARIANTS.length];
                editor
                    .chain()
                    .focus()
                    .command(({tr}) => {
                        tr.setNodeAttribute(pos, 'variant', next);
                        return true;
                    })
                    .run();
            });

            return {
                dom,
                contentDOM: body,
                update: updated => {
                    if (updated.type.name !== 'callout') return false;
                    variant = variantOf(updated.attrs['variant']);
                    paint();
                    return true;
                },
                ignoreMutation: mutation => !body.contains(mutation.target as globalThis.Node),
            };
        };
    },

    markdownTokenName: 'wikiCallout',

    /** Its own token type, not a second handler on blockquote: sharing the token name parsed fine, but the serialiser resolves a node's renderer through the same registry, so an ordinary blockquote came back out as "> [!NOTE]". Extension tokenizers still run ahead of every built-in block rule, so this gets first look and hands non-alerts back to marked's own blockquote rule. */
    markdownTokenizer: {
        name: 'wikiCallout',
        level: 'block',
        start: source => source.search(/^ {0,3}> ?\[!/m),
        tokenize: (source, _tokens, lexer) => {
            const quote = QUOTE_BLOCK_REGEX.exec(source);
            if (!quote) return undefined;

            const raw = quote[1];
            const body = raw
                .split('\n')
                .map(line => line.replace(QUOTE_PREFIX_REGEX, ''))
                .join('\n');

            const marker = MARKER_REGEX.exec(body);
            if (!marker) return undefined;
            const variant = ALIASES[marker[1].toUpperCase()];
            if (!variant) return undefined;

            const rest = body.slice(marker[0].length).replace(/\s+$/, '');
            return {
                type: 'wikiCallout',
                raw,
                variant,
                tokens: rest ? lexer.blockTokens(`${rest}\n`) : [],
            };
        },
    },

    parseMarkdown: (token, helpers) => {
        const variant = variantOf(token['variant']);
        const content = helpers.parseChildren(Array.isArray(token.tokens) ? token.tokens : []);
        return helpers.createNode(
            'callout',
            {variant},
            content.length ? content : [helpers.createNode('paragraph')],
        );
    },

    renderMarkdown: (node, helpers) => {
        const variant = variantOf(node.attrs?.['variant']);
        const blocks: string[] = [];
        (node.content ?? []).forEach((child: JSONContent, index: number) => {
            blocks.push(helpers.renderChild?.(child, index) ?? helpers.renderChildren([child]));
        });
        const lines = [`[!${MARKERS[variant]}]`, ...blocks.join('\n\n').split('\n')];
        // A callout the author has not filled in yet would otherwise trail a bare `>` line.
        while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
        return lines.map(line => (line.trim() ? `> ${line}` : '>')).join('\n');
    },

    addCommands() {
        return {
            setCallout:
                (attributes = {}) =>
                ({commands}) =>
                    commands.wrapIn(this.name, {variant: variantOf(attributes.variant)}),
            toggleCallout:
                (attributes = {}) =>
                ({commands}) =>
                    commands.toggleWrap(this.name, {variant: variantOf(attributes.variant)}),
            unsetCallout:
                () =>
                ({commands}) =>
                    commands.lift(this.name),
        };
    },

    addInputRules() {
        return [
            new InputRule({
                find: INPUT_REGEX,
                handler: ({state, range, match, chain}) => {
                    const variant = ALIASES[(match[1] ?? '').toUpperCase()];
                    if (!variant) return null;

                    // Blockquote's "> " rule has almost always already fired by this point, so
                    // the caret sits inside a quote; retyping that quote as a callout keeps one
                    // box instead of nesting a callout inside a blockquote.
                    const $start = state.doc.resolve(range.from);
                    let quotePos: number | null = null;
                    for (let depth = $start.depth; depth > 0; depth -= 1) {
                        if ($start.node(depth).type.name === 'blockquote') {
                            quotePos = $start.before(depth);
                            break;
                        }
                    }

                    if (quotePos === null) {
                        chain().deleteRange(range).wrapIn(this.name, {variant}).run();
                        return;
                    }

                    const calloutType = state.schema.nodes['callout'];
                    if (!calloutType) return null;
                    const at = quotePos;
                    chain()
                        .deleteRange(range)
                        // `at` is before the deleted range, so it needs no mapping.
                        .command(({tr}) => {
                            tr.setNodeMarkup(at, calloutType, {variant});
                            return true;
                        })
                        .run();
                    return;
                },
            }),
        ];
    },
});
