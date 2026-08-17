import {Component, computed, effect, inject, model, signal, untracked} from '@angular/core';
import {NgClass} from '@angular/common';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {ProfileSettingsComponent} from './pages/profile-settings/profile-settings.component';
import {PrivacySettingsComponent} from './pages/privacy-settings/privacy-settings.component';
import {ActivitySettingsComponent} from './pages/activity-settings/activity-settings.component';
import {OtherSettingsComponent} from './pages/other-settings/other-settings.component';
import {NotificationSettingsComponent} from './pages/notification-settings/notification-settings.component';
import {VoiceVideoSettingsComponent} from './pages/voice-video-settings/voice-video-settings.component';
import {KeybindsSettingsComponent} from './pages/keybinds-settings/keybinds-settings.component';
import {AppearanceSettingsComponent} from './pages/appearance-settings/appearance-settings.component';
import {SecuritySettingsComponent} from './pages/security-settings/security-settings.component';
import {DevicesSettingsComponent} from './pages/devices-settings/devices-settings.component';
import {AboutSettingsComponent} from './pages/about-settings/about-settings.component';
import {SupportSettingsComponent} from './pages/support-settings/support-settings.component';
import {PlatformStatusSettingsComponent} from './pages/platform-status-settings/platform-status-settings.component';
import {AiSettingsComponent} from './pages/ai-settings/ai-settings.component';
import {LogoutDialogComponent} from '../logout-dialog/logout-dialog.component';
import {PlanPanelComponent} from '../plan-panel/plan-panel.component';
import {TranslateModule} from '@ngx-translate/core';
import {EntitlementStore, MY_ENTITLEMENTS} from '../../../stores/entitlement.store';

/** One page in the settings nav. */
export interface SettingsNavItem {
    id: string;
    labelKey: string;
    icon: string;
}

export interface SettingsNavGroup {
    titleKey: string;
    items: SettingsNavItem[];
}

/** The nav table. */
export const SETTINGS_NAV_GROUPS: readonly SettingsNavGroup[] = [
    {
        titleKey: 'SETTINGS.NAV.MY_ACCOUNT',
        items: [
            {id: 'profile', labelKey: 'SETTINGS.NAV.PROFILE', icon: 'pi pi-user'},
            {id: 'privacy', labelKey: 'SETTINGS.NAV.PRIVACY', icon: 'pi pi-shield'},
            {id: 'activity', labelKey: 'SETTINGS.NAV.ACTIVITY', icon: 'pi pi-play-circle'},
            {id: 'security', labelKey: 'SETTINGS.NAV.SECURITY', icon: 'pi pi-lock'},
            {id: 'devices', labelKey: 'SETTINGS.NAV.DEVICES', icon: 'pi pi-desktop'},
            {id: 'notifications', labelKey: 'SETTINGS.NAV.NOTIFICATIONS', icon: 'pi pi-bell'},
            {id: 'billing', labelKey: 'SETTINGS.NAV.BILLING', icon: 'pi pi-credit-card'},
        ],
    },
    {
        titleKey: 'SETTINGS.NAV.APP_SETTINGS',
        items: [
            {id: 'voice-video', labelKey: 'SETTINGS.NAV.VOICE_VIDEO', icon: 'pi pi-microphone'},
            {id: 'keybinds', labelKey: 'SETTINGS.NAV.KEYBINDS', icon: 'pi pi-key'},
            {id: 'appearance', labelKey: 'SETTINGS.NAV.APPEARANCE', icon: 'pi pi-palette'},
            {id: 'ai', labelKey: 'SETTINGS.NAV.AI', icon: 'pi pi-sparkles'},
            {id: 'other', labelKey: 'SETTINGS.NAV.OTHER', icon: 'pi pi-cog'},
            {id: 'support', labelKey: 'SETTINGS.NAV.SUPPORT', icon: 'pi pi-question-circle'},
            {id: 'platform-status', labelKey: 'SETTINGS.NAV.PLATFORM_STATUS', icon: 'pi pi-wave-pulse'},
            {id: 'about', labelKey: 'SETTINGS.NAV.ABOUT', icon: 'pi pi-info-circle'},
        ],
    },
];

/** The pages that exist only where something can be bought. */
const BILLING_PAGE_IDS: readonly string[] = ['billing'];

/** The nav for one instance. */
export function visibleSettingsNavGroups(billingAvailable: boolean): SettingsNavGroup[] {
    if (billingAvailable) return SETTINGS_NAV_GROUPS as SettingsNavGroup[];

    return SETTINGS_NAV_GROUPS.map(group => ({
        ...group,
        items: group.items.filter(item => !BILLING_PAGE_IDS.includes(item.id)),
    })).filter(group => group.items.length > 0);
}

@Component({
    selector: 'app-settings-modal',
    imports: [
        NgClass,
        Dialog,
        Button,
        ProfileSettingsComponent,
        PrivacySettingsComponent,
        ActivitySettingsComponent,
        OtherSettingsComponent,
        NotificationSettingsComponent,
        VoiceVideoSettingsComponent,
        KeybindsSettingsComponent,
        AppearanceSettingsComponent,
        SecuritySettingsComponent,
        DevicesSettingsComponent,
        AboutSettingsComponent,
        SupportSettingsComponent,
        PlatformStatusSettingsComponent,
        AiSettingsComponent,
        LogoutDialogComponent,
        PlanPanelComponent,
        TranslateModule,
    ],
    templateUrl: './settings-modal.component.html',
    styleUrl: './settings-modal.component.css',
})
export class SettingsModalComponent {
    public readonly isVisible = model.required<boolean>();
    public readonly activePage = signal('profile');
    public readonly mobileView = signal<'nav' | 'content'>('nav');
    public readonly showLogoutDialog = signal(false);

    /** The subject the billing page reads. A constant, so the input never churns. */
    public readonly mySubject = MY_ENTITLEMENTS;

    private entitlements = inject(EntitlementStore);

    public readonly navGroups = computed(() =>
        visibleSettingsNavGroups(this.entitlements.upgradesAvailable()),
    );

    constructor() {
        effect(() => {
            if (!this.isVisible()) this.mobileView.set('nav');
        });

        // Read before the nav is drawn, not when Billing is opened: `upgradesAvailable` is what
        // decides whether the entry exists at all, and it is false until something has been read.
        effect(() => {
            if (this.isVisible()) untracked(() => this.entitlements.ensureLoaded(MY_ENTITLEMENTS));
        });

        // Switching instance can take Billing away underneath the reader - a self-hosted instance
        // has no such page - and a `@switch` with no matching case renders nothing at all.
        effect(() => {
            const shown = this.navGroups().some(g => g.items.some(i => i.id === this.activePage()));
            if (!shown) untracked(() => this.activePage.set('profile'));
        });
    }

    selectPage(id: string): void {
        this.activePage.set(id);
        this.mobileView.set('content');
    }

    confirmLogout(): void {
        this.showLogoutDialog.set(true);
    }

    /** Add a new page: create its component, add an entry here, add a @case below. */
    navItemClasses(id: string, inactiveText = 'text-white/50'): Record<string, boolean> {
        const active = this.activePage() === id;
        return {
            'bg-[color-mix(in_srgb,var(--color-brand)_15%,transparent)]': active,
            'text-[var(--color-brand-dim)]': active,
            [inactiveText]: !active,
        };
    }
}
