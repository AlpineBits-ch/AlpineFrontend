# Wiki UX Overhaul — Shared Contract

**Date:** 2026-08-06
**Status:** In flight, parallel workstreams

Every agent working on this reads this file first. It exists so ten concurrent streams can land in
one tree without colliding.

## Hard rules

1. **Touch only the files your stream owns.** The ownership table below is exhaustive. If you need a
   change in a file you do not own, do not make it — write the request into
   `HANDOFF.md` in your stream's scratchpad dir (path given in your brief) and carry on.
2. **Never edit `src/assets/i18n/locales/*.json`.** That directory is a git submodule and every
   stream would conflict in it. Use translation keys freely in templates
   (`{{ 'WIKI.FOO.BAR' | translate }}`), and record each new key in your stream's
   `i18n.json` as a flat `{"WIKI.FOO.BAR": "English string"}` map. The integrator merges them.
3. **Do not run `ng build` or `ng test`.** Both type-check the whole app, and other streams are
   mid-edit — you will get failures that are not yours and waste a long cycle on them. Write
   carefully instead; the integrator does one build-and-fix pass at the end.
4. **Do not commit.** The integrator commits.
5. Follow the existing house style: Angular 21 signals, `input()`/`output()`, `@if`/`@for`, standalone
   components with `imports:`, PrimeNG `p-button` with `(onClick)`, Tailwind tokens
   (`bg-card`, `text-white/60`, `border-border`) never raw hex. Comments explain *why*, not *what* —
   match the density of the file you are in.

## Where things are

Wiki feature root: `src/app/features/guild/components/wiki/`.
Read `docs/superpowers/specs/2026-08-05-wiki-redesign-design.md` for how the current wiki got its
shape — it explains decisions you should not silently reverse (one TipTap instance for read *and*
edit, links as `Link` marks with a `wiki:` protocol rather than custom nodes, explicit publish
rather than server autosave, permissions fail closed).

## The AI capability interface

`W3` implements it, `W4` consumes it. Both code against this signature from the start; neither waits
for the other.

```ts
// src/app/services/ai-provider.ts

export type AiTransformOp =
    | 'improve' | 'shorten' | 'expand' | 'grammar' | 'tone' | 'translate'
    | 'summarize' | 'continue';

export interface AiTransformRequest {
    op: AiTransformOp;
    /** The markdown the op applies to. */
    text: string;
    /** Extra instruction: a tone name, a target language, or the user's own words. */
    instruction?: string;
    title: string;
    pageTitles: readonly string[];
}

export interface AiAskSource { id: string; title: string; content: string; }

export interface AiAskRequest {
    question: string;
    /** Candidate pages with bodies. The caller trims these to a sane budget. */
    sources: readonly AiAskSource[];
}

export interface AiCompleteRequest {
    /** Markdown immediately before the caret, tail-trimmed by the caller. */
    before: string;
    /** Markdown immediately after the caret, head-trimmed by the caller. */
    after: string;
    title: string;
}

export interface AiMetadataRequest {
    title: string;
    content: string;
    existingTags: readonly string[];
}

export interface AiMetadata {
    tags: string[];
    /** One-line description of the page. */
    summary: string;
    /** What this edit changed, for the revision summary field. */
    editSummary: string;
}

export interface AiProvider extends AiProviderMeta {
    draft(req: AiDraftRequest, key: string, model: string, signal: AbortSignal): AsyncIterable<string>;
    transform(req: AiTransformRequest, key: string, model: string, signal: AbortSignal): AsyncIterable<string>;
    /**
     * Answers from wiki content. Cites sources as ordinary wiki links —
     * `[Page title](wiki:<pageId>)` — so the existing renderer resolves them with no new syntax.
     */
    ask(req: AiAskRequest, key: string, model: string, signal: AbortSignal): AsyncIterable<string>;
    /** Ghost text. One short shot, not streamed: a half-rendered suggestion is worse than none. */
    complete(req: AiCompleteRequest, key: string, model: string, signal: AbortSignal): Promise<string>;
    suggestMetadata(req: AiMetadataRequest, key: string, model: string, signal: AbortSignal): Promise<AiMetadata>;
}
```

And the façade that resolves provider + key + model, so no component repeats that dance (the AI
dialog's `activeProvider()` / `getKey()` logic moves here):

```ts
// src/app/features/guild/components/wiki/wiki-ai.service.ts
@Injectable({providedIn: 'root'})
export class WikiAiService {
    /** True when some provider is connected and a request could actually be made. */
    readonly available: Signal<boolean>;
    /** Off by default. Ghost text spends the user's own API credit on every pause. */
    readonly ghostTextEnabled: WritableSignal<boolean>;

    draft(req: AiDraftRequest, signal: AbortSignal): AsyncIterable<string>;
    transform(req: AiTransformRequest, signal: AbortSignal): AsyncIterable<string>;
    ask(req: AiAskRequest, signal: AbortSignal): AsyncIterable<string>;
    complete(req: AiCompleteRequest, signal: AbortSignal): Promise<string>;
    suggestMetadata(req: AiMetadataRequest, signal: AbortSignal): Promise<AiMetadata>;
}
```

Every method throws `NoAiProviderError` (exported from `ai-provider.ts`) when nothing is connected,
so callers can offer the connect flow rather than failing mutely.

## The editor trigger interface

`W2` owns the trigger plugin and its menus. Today it emits `SuggestState | null` for `/` and `[[`.
It grows two triggers and a grouping model:

```ts
export type SuggestTrigger = '/' | '[[' | ':' | '@';

export interface SuggestState {
    trigger: SuggestTrigger;
    query: string;
    /** Offset within the block where the trigger starts, so the menu can replace it on select. */
    from: number;
}
```

`/` must match mid-line, not only at the start of a block. `:` needs at least two characters of
query before it opens, or every colon in prose pops a menu.

Each menu component keeps the shape the article already wires to: `open`, `query`, `position`
inputs, a `selected` output, and public `handleKey(key: string): boolean` / `reset(): void`.
That is the contract — do not change it, because one keydown handler in the article drives all four.

## Ownership

| Stream | Owns (exclusively) |
|---|---|
| W1 blocks | `wiki-article/blocks/**` (new), `wiki-article/wiki-extensions.ts`, `wiki-article/wiki-article.component.css` |
| W2 triggers | `wiki-article/wiki-suggest.plugin.ts` (+spec), `wiki-article/wiki-slash-menu.component.ts`, `wiki-article/wiki-emoji-menu.component.ts` (new), `wiki-article/wiki-mention-menu.component.ts` (new) |
| W3 ai-core | `src/app/services/ai-provider.ts`, `src/app/services/ai-providers/**`, `wiki/wiki-ai.service.ts` (new) |
| W4 ai-ui | `wiki/wiki-ai/**`, `wiki-article/wiki-bubble-menu.component.ts`, `wiki-article/wiki-ghost-text.plugin.ts` (new) |
| W5 rail | `wiki/wiki-rail/**`, `wiki/wiki-links.ts`, `wiki/wiki-toc.ts` (+specs) |
| W6 nav+search | `wiki/wiki-nav/**`, `wiki/wiki-search/**`, `wiki/wiki-search.ts` (+specs) |
| W7 history+graph | `wiki/wiki-history/**`, `wiki/wiki-home/**`, `wiki/wiki-graph/**` (new), `wiki/wiki-activity/**` (new) |
| W8 chat | `src/app/features/messaging/**`, `wiki/wiki-share/**` (new) |
| W9 templates | `wiki/wiki-templates/**` (new), `wiki/wiki-shortcuts/**` (new) |
| W10 server | the Echo repo only — no file in this repo |
| **integrator** | `wiki.component.*`, `wiki-article.component.ts/html`, `wiki-state.service.ts`, `wiki.service.ts`, `wiki-breadcrumbs/**`, `dtos/**`, `wiki-toolbar.component.ts`, locales |

Anything not listed is the integrator's. Ask, don't assume.

## Handoff

When your stream needs the integrator to wire something (register an extension you cannot register,
add a menu to the article, add a route, add a DTO field), write it in your scratchpad `HANDOFF.md`
as a short numbered list: the file, what to add, and why. Be specific enough to apply without
re-deriving your work.
