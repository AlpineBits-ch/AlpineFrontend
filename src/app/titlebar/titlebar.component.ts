import {Component, computed, inject, OnDestroy, OnInit, signal, ViewChild} from '@angular/core';
import {NavigationEnd, Router} from '@angular/router';
import {takeUntilDestroyed, toSignal} from '@angular/core/rxjs-interop';
import {filter} from 'rxjs';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Popover} from 'primeng/popover';
import {ContextMenuComponent} from '../shared/context-menu/context-menu.component';
import {MenuItem} from '../shared/context-menu/context-menu.model';
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
    /** Literal text: a guild or conversation name, which is never translated. */
    label?: string;
    /** i18n key, for the labels that are fixed phrases. Translated in the template so a language switch redraws them. */
    labelKey?: string;
    /** The place inside the context (a channel, the wiki), or absent at its root. */
    detail?: string;
    detailKey?: string;
}

@Component({
    selector: 'app-titlebar',
    imports: [TranslateModule, Popover, ContextMenuComponent, InboxPanelComponent],
    templateUrl: './titlebar.component.html',
    styleUrl: './titlebar.component.css',
})
export class TitlebarComponent implements OnInit, OnDestroy {
    /** Whether to draw a window frame at all. */
    protected readonly showChrome = signal(false);
    protected readonly isMac = signal(false);
    protected readonly isMaximized = signal(false);
    protected macHover = false;

    protected nav = inject(NavigationService);
    protected inbox = inject(InboxService);
    /** Do not remove: injected only for its constructor, which registers the `identity.*` handlers. */
    private identityEvents = inject(IdentityWebsocketService);
    private settingsUi = inject(SettingsUiService);
    private convUtils = inject(ConversationUtilsService);
    private apiConfig = inject(ApiConfigService);
    private translate = inject(TranslateService);
    private router = inject(Router);
    private chrome = inject(WindowChrome);

    /** Must use `stream`, not `translate.instant`: this component is built before the language file loads. */
    private readonly keybindsLabel = toSignal(this.translate.stream('TITLEBAR.HELP_KEYBINDS'), {
        initialValue: '',
    });
    private readonly aboutLabel = toSignal(this.translate.stream('TITLEBAR.HELP_ABOUT'), {initialValue: ''});

    @ViewChild('inboxPopover') private inboxPopover?: Popover;

    /** Whether the app shell is on screen. */
    protected readonly inAppShell = signal(false);

    protected readonly context = computed<TitlebarContext>(() => {
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
                label: this.convUtils.getChatTitle(this.nav.activeConversation() ?? view.conversation),
                detailKey: 'TITLEBAR.DIRECT_MESSAGE',
            };
        }

        return {icon: 'pi-comments', labelKey: 'TITLEBAR.DIRECT_MESSAGES'};
    });

    protected readonly helpItems = computed<MenuItem[]>(() => [
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

    /** Guild icon URLs that errored, so the initial takes over. Keyed by URL so one server's failure never carries to another. */
    private readonly failedIcons = signal<ReadonlySet<string>>(new Set());
    protected readonly iconFailed = computed(() => {
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
        this.router.events
            .pipe(
                filter((e): e is NavigationEnd => e instanceof NavigationEnd),
                takeUntilDestroyed(),
            )
            .subscribe(e => this.inAppShell.set(e.urlAfterRedirects.startsWith('/overview')));
    }

    async ngOnInit(): Promise<void> {
        if (!this.chrome.supported) return;

        // A phone build owns its frame too, it just has a system bar of its own and no room for ours.
        const ua = navigator.userAgent.toLowerCase();
        if (/android|iphone|ipad|ipod/.test(ua)) return;

        this.showChrome.set(true);
        this.isMac.set(ua.includes('mac os') || ua.includes('macos'));

        // Mouse back/forward buttons.
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

    /** Asks the window to close, and says so out loud when it cannot. Resolving means dispatched, not closed. */
    protected close(): void {
        this.chrome.close().catch(err => console.error('Could not close the window', err));
    }

    protected onIconError(url: string): void {
        this.failedIcons.update(set => new Set(set).add(url));
    }

    /** The inbox fetch is on the popover's `onShow`, not here. */
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
