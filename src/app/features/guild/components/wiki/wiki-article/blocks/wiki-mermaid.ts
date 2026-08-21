/** Mermaid, loaded on demand: it is the largest thing in the dependency tree by a wide margin and almost no page contains a diagram, so pulling it into the initial chunk would slow the app for everyone. A real dependency, not a CDN script, since this ships inside a Tauri shell that must work with no network at all. */

interface MermaidModule {
    initialize: (config: Record<string, unknown>) => void;
    render: (id: string, source: string) => Promise<{svg: string}>;
}

let loading: Promise<MermaidModule> | null = null;
let counter = 0;

/** Mermaid cannot read CSS custom properties, so the palette is sampled once and handed over as theme variables; read at load time, not baked in, so a runtime brand colour change from ThemeService is picked up the first time a diagram is drawn. */
function themeVariables(): Record<string, string> {
    const styles = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    const surface = read('--color-card', '#161b27');
    const accent = read('--color-brand-dim', '#9a84ff');
    return {
        background: surface,
        primaryColor: read('--color-hover', '#1d2333'),
        primaryTextColor: 'rgba(255, 255, 255, 0.88)',
        primaryBorderColor: accent,
        secondaryColor: read('--color-sidebar', '#111520'),
        secondaryTextColor: 'rgba(255, 255, 255, 0.75)',
        tertiaryColor: surface,
        tertiaryTextColor: 'rgba(255, 255, 255, 0.75)',
        lineColor: accent,
        textColor: 'rgba(255, 255, 255, 0.78)',
        mainBkg: read('--color-hover', '#1d2333'),
        nodeBorder: accent,
        clusterBkg: surface,
        clusterBorder: read('--color-border', '#252e42'),
        titleColor: 'rgba(255, 255, 255, 0.9)',
        fontFamily: 'Inter Variable, Inter, system-ui, sans-serif',
        fontSize: '14px',
    };
}

function load(): Promise<MermaidModule> {
    loading ??= import('mermaid')
        .then(module => {
            const mermaid = module.default as unknown as MermaidModule;
            mermaid.initialize({
                startOnLoad: false,
                // Wiki content is written by other guild members, so labels are never trusted to contain markup; strict is the level that actually sanitises them.
                securityLevel: 'strict',
                theme: 'base',
                themeVariables: themeVariables(),
                flowchart: {htmlLabels: false, curve: 'basis'},
                fontFamily: 'Inter Variable, Inter, system-ui, sans-serif',
            });
            return mermaid;
        })
        .catch(error => {
            // A failed chunk load must not poison every later attempt.
            loading = null;
            throw error;
        });
    return loading;
}

/** Renders to an SVG string. Throws with mermaid's own message when the source does not parse. */
export async function renderMermaid(source: string): Promise<string> {
    const mermaid = await load();
    counter += 1;
    const {svg} = await mermaid.render(`wiki-mermaid-${Date.now().toString(36)}-${counter}`, source);
    return svg;
}
