import {Component, computed, inject, OnDestroy, OnInit, signal, ViewChild} from '@angular/core';
import {NavigationEnd, Router} from '@angular/router';
import {takeUntilDestroyed, toSignal} from '@angular/core/rxjs-interop';
import {filter} from 'rxjs';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Popover} from 'primeng/popover';
import {Menu} from 'primeng/menu';
import {MenuItem} from 'primeng/api';
import {NavigationService} from '../features/main-page/navigation.service';
import {InboxService} from '../services/inbox.service';
import {IdentityWebsocketService} from '../services/identity-websocket.service';
import {InboxPanelComponent} from './inbox-panel/inbox-panel.component';
import {SettingsUiService} from '../services/settings-ui.service';
import {ConversationUtilsService} from '../services/conversation-utils.service';
import {ApiConfigService} from '../services/api-config.service';
import {WindowChrome} from '../platform/ports/window-chrome.port';
import {ChannelType} from '../dtos/response/guild.dto';

/** What the centre of the titlebar names: where the user is, not what the app is called. */
interface TitlebarContext {
    /** Guild icon, when the context is a server. */
    iconUrl?: string;
    /** PrimeIcons class, when there is no image to show. */
    icon?: string;
    /** Single letter behind a guild icon that fails to load. */
    initial?: string;
    /** Literal text - a guild or conversation name, which is never translated. */
    label?: string;
    /** i18n key, for the labels that are fixed phrases. Translated in the template so a
     *  language switch redraws them. */
    labelKey?: string;
    /** The place inside the context - a channel, the wiki - or absent at its root. */
    detail?: string;
    detailKey?: string;
}

@Component({
    selector: 'app-titlebar',
    imports: [TranslateModule, Popover, Menu, InboxPanelComponent],
    templateUrl: './titlebar.component.html',
    styleUrl: './titlebar.component.css',
})
export class TitlebarComponent implements OnInit, OnDestroy {
    /**
     * Whether to draw a window frame at all.
     *
     * <p>Was `isTauri`, which is no longer what it means: it is set from {@link WindowChrome.supported}
     * and then narrowed by a user-agent test, so a Tauri phone build has it false while being every bit
     * as much a Tauri host. "Does this host let the app own its frame, and is there room for one" is the
     * question, and the name now asks it. It is what the template's outermost `@if` reads, and what
     * `titlebar.component.spec.ts` flips by hand to render the bar without standing up a host.</p>
     *
     * <p>On web it stays false and the bar is *hidden*, per the design spec's rule that a missing
     * minimise button needs no explanation.</p>
     */
    protected showChrome = signal(false);
    protected isMac = signal(false);
    protected isMaximized = signal(false);
    protected macHover = false;

    protected nav = inject(NavigationService);
    protected inbox = inject(InboxService);
    /**
     * Injected for its constructor, which is the only place the `identity.*` handlers are
     * registered.
     *
     * <p>Nothing here reads it. It lives on the titlebar for the same reason {@link InboxService}
     * does - this is the one component drawn on every route, so it is the earliest point at which a
     * root singleton is reliably built exactly once, and `RealtimeConnectionService.on` is safe
     * before `start`. Registering from a screen instead would mean "your key backup was read" only
     * arrives while that screen happens to be open, which is not a property a security notice may
     * have.</p>
     */
    private identityEvents = inject(IdentityWebsocketService);
    private settingsUi = inject(SettingsUiService);
    private convUtils = inject(ConversationUtilsService);
    private apiConfig = inject(ApiConfigService);
    private translate = inject(TranslateService);
    private router = inject(Router);
    private chrome = inject(WindowChrome);

    /**
     * Menu labels, streamed rather than read.
     *
     * <p>PrimeNG menu items are plain strings with no pipe to re-run, so the obvious
     * `translate.instant` is what the rest of the app uses for them - and it is wrong *here*.
     * `instant` hands back the key itself when the language file is still in flight, and this
     * component is built during bootstrap, before the loader has fetched anything. Every other
     * label in this bar goes through the `translate` pipe and was fine; these two rendered as
     * `TITLEBAR.HELP_KEYBINDS` and stayed that way, because the computed's only dependency was
     * `onLangChange`, which had already fired by the time it subscribed.</p>
     *
     * <p>`stream` waits on the pending load and re-emits on a language switch, which is the same
     * path the pipe takes.</p>
     */
    private keybindsLabel = toSignal(this.translate.stream('TITLEBAR.HELP_KEYBINDS'), {initialValue: ''});
    private aboutLabel = toSignal(this.translate.stream('TITLEBAR.HELP_ABOUT'), {initialValue: ''});

    @ViewChild('inboxPopover') private inboxPopover?: Popover;

    /**
     * Whether the app shell is on screen.
     *
     * <p>The titlebar is drawn for every route, including the login page - and back, forward, the
     * inbox and the context title are all statements about a workspace that does not exist until
     * the user is inside one. Shown there they would be dead controls at best.</p>
     */
    protected inAppShell = signal(false);

    protected context = computed<TitlebarContext>(() => {
        const workspace = this.nav.workspace();
        const view = this.nav.mainView();

        if (workspace.type === 'server') {
            const guild = workspace.guild;
            return {
                iconUrl: `${this.apiConfig.baseUrl()}/api/v1/guild/guilds/${guild.id}/icon/thumbnail`,
                initial: guild.name[0]?.toUpperCase() ?? '?',
                label: guild.name,
                ...(view.type === 'channel'
                    ? {detail: `${TitlebarComponent.channelPrefix(view.channel.type)}${view.channel.name}`}
                    : view.type === 'wiki'
                        ? {detailKey: 'TITLEBAR.WIKI'}
                        : {}),
            };
        }

        if (view.type === 'conversation') {
            return {
                icon: 'pi-at',
                label: this.convUtils.getChatTitle(view.conversation),
                detailKey: 'TITLEBAR.DIRECT_MESSAGE',
            };
        }

        return {icon: 'pi-comments', labelKey: 'TITLEBAR.DIRECT_MESSAGES'};
    });

    protected helpItems = computed<MenuItem[]>(() => [
        {
            label: this.keybindsLabel(),
            icon: 'pi pi-key',
            command: () => this.settingsUi.open('keybinds'),
        },
        {
            label: this.aboutLabel(),
            icon: 'pi pi-info-circle',
            command: () => this.settingsUi.open('about'),
        },
    ]);

    /**
     * Guild icon URLs that answered with an error, so the initial takes over instead of a broken
     * image. Keyed by URL rather than a single flag: switching servers must not inherit the last
     * one's failure, and switching back must not re-request an icon already known to be missing.
     */
    private failedIcons = signal<ReadonlySet<string>>(new Set());
    protected iconFailed = computed(() => {
        const url = this.context().iconUrl;
        return !!url && this.failedIcons().has(url);
    });

    private unlisten?: () => void;

    /** `#`, `🔊` and friends, so a channel name in the titlebar reads like it does in the sidebar. */
    private static channelPrefix(type: ChannelType): string {
        switch (type) {
            case ChannelType.Voice:
                return '🔊 ';
            case ChannelType.Thread:
                return '↳ ';
            case ChannelType.Forum:
            case ChannelType.Media:
                return '💬 ';
            case ChannelType.Announcement:
                return '📢 ';
            default:
                return '# ';
        }
    }

    constructor() {
        this.inAppShell.set(this.router.url.startsWith('/overview'));
        this.router.events.pipe(
            filter((e): e is NavigationEnd => e instanceof NavigationEnd),
            takeUntilDestroyed(),
        ).subscribe(e => this.inAppShell.set(e.urlAfterRedirects.startsWith('/overview')));
    }

    async ngOnInit(): Promise<void> {
        if (!this.chrome.supported) return;

        // Still a user-agent test, and still separate from the host question: a phone build runs in
        // Tauri and does own its frame, it just has a system bar of its own and no room for ours.
        const ua = navigator.userAgent.toLowerCase();
        if (/android|iphone|ipad|ipod/.test(ua)) return;

        this.showChrome.set(true);
        this.isMac.set(ua.includes('mac os') || ua.includes('macos'));

        // Mice have had these two buttons for twenty years and every app that has a history
        // honours them; a titlebar arrow the user has to aim at is the fallback, not the path.
        window.addEventListener('mouseup', this.onMouseUp);

        this.isMaximized.set(await this.chrome.isMaximized());
        this.unlisten = await this.chrome.onResized(async () => {
            this.isMaximized.set(await this.chrome.isMaximized());
        });
    }

    ngOnDestroy(): void {
        window.removeEventListener('mouseup', this.onMouseUp);
        this.unlisten?.();
    }

    protected minimize(): void {
        this.chrome.minimize().catch(err => console.error('Could not minimize the window', err));
    }

    protected toggleMaximize(): void {
        this.chrome.toggleMaximize().catch(err => console.error('Could not maximize the window', err));
    }

    /**
     * Asks the window to close, and says so out loud when it cannot.
     *
     * <p>Not a bare `void`. A close that fails here fails silently and invisibly - the button
     * looks pressed and nothing happens - which is exactly how the ACL gap behind
     * `core:window:allow-destroy` went unnoticed: {@link RichPresenceService} registers a JS
     * `close-requested` listener, Tauri therefore prevents the native close and delegates to JS,
     * and the `destroy()` the JS wrapper follows up with was denied by the capability set. The
     * rejection landed inside an event callback with nobody reading it.</p>
     *
     * <p>Note that `close()` resolving means the request was dispatched, not that the window went
     * away: a listener is still free to prevent it. That is deliberate - it is what a future
     * close-to-tray would hang off - so this reports failures rather than forcing a destroy.</p>
     */
    protected close(): void {
        this.chrome.close().catch(err => console.error('Could not close the window', err));
    }

    protected onIconError(url: string): void {
        this.failedIcons.update(set => new Set(set).add(url));
    }

    /**
     * The fetch is on the popover's `onShow`, not here.
     *
     * <p>Both tabs and the badge are loaded when the panel appears rather than at launch: the
     * inbox spans every guild, and paying for that on a cold start buys a number nobody is
     * looking at yet.</p>
     */
    protected toggleInbox(event: Event): void {
        this.inboxPopover?.toggle(event);
    }

    private readonly onMouseUp = (event: MouseEvent): void => {
        if (!this.inAppShell()) return;
        if (event.button === 3) {
            event.preventDefault();
            this.nav.back();
        } else if (event.button === 4) {
            event.preventDefault();
            this.nav.forward();
        }
    };
}
