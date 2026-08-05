import {Component, effect, model, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {Dialog} from "primeng/dialog";
import {Button} from "primeng/button";
import {ProfileSettingsComponent} from "./pages/profile-settings/profile-settings.component";
import {PrivacySettingsComponent} from "./pages/privacy-settings/privacy-settings.component";
import {ActivitySettingsComponent} from "./pages/activity-settings/activity-settings.component";
import {OtherSettingsComponent} from "./pages/other-settings/other-settings.component";
import {NotificationSettingsComponent} from "./pages/notification-settings/notification-settings.component";
import {VoiceVideoSettingsComponent} from "./pages/voice-video-settings/voice-video-settings.component";
import {KeybindsSettingsComponent} from "./pages/keybinds-settings/keybinds-settings.component";
import {AppearanceSettingsComponent} from "./pages/appearance-settings/appearance-settings.component";
import {SecuritySettingsComponent} from "./pages/security-settings/security-settings.component";
import {DevicesSettingsComponent} from "./pages/devices-settings/devices-settings.component";
import {AboutSettingsComponent} from "./pages/about-settings/about-settings.component";
import {LogoutDialogComponent} from "../logout-dialog/logout-dialog.component";
import {TranslateModule} from '@ngx-translate/core';

/**
 * One page in the settings nav.
 *
 * <p>`labelKey` is a translation key, not a label. It is named that way because it used to be a
 * label: the `SETTINGS.NAV.*` keys existed and were fully translated into de and fr, while this
 * array held English string literals that the template rendered directly - so the settings nav was
 * the one part of the app that stayed English in every language, and each new page quietly made it
 * worse. The type now makes the mistake unspellable.</p>
 */
export interface SettingsNavItem {
    id: string;
    labelKey: string;
    icon: string;
}

export interface SettingsNavGroup {
    titleKey: string;
    items: SettingsNavItem[];
}

/**
 * The nav table.
 *
 * <p>Module-level rather than a field on the component because it is static data that depends on
 * nothing - which also means a test can read it without standing up a component that wants an
 * injector, a `Dialog` and half the settings pages. See `settings-modal.component.spec.ts`.</p>
 */
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
        ],
    },
    {
        titleKey: 'SETTINGS.NAV.APP_SETTINGS',
        items: [
            {id: 'voice-video', labelKey: 'SETTINGS.NAV.VOICE_VIDEO', icon: 'pi pi-microphone'},
            {id: 'keybinds', labelKey: 'SETTINGS.NAV.KEYBINDS', icon: 'pi pi-key'},
            {id: 'appearance', labelKey: 'SETTINGS.NAV.APPEARANCE', icon: 'pi pi-palette'},
            {id: 'other', labelKey: 'SETTINGS.NAV.OTHER', icon: 'pi pi-cog'},
            {id: 'about', labelKey: 'SETTINGS.NAV.ABOUT', icon: 'pi pi-info-circle'},
        ],
    },
];

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
        LogoutDialogComponent,
        TranslateModule,
    ],
    templateUrl: './settings-modal.component.html',
    styleUrl: './settings-modal.component.css',
})
export class SettingsModalComponent {
    public isVisible = model.required<boolean>();
    public activePage = signal('profile');
    public mobileView = signal<'nav' | 'content'>('nav');
    public showLogoutDialog = signal(false);
    public readonly navGroups = SETTINGS_NAV_GROUPS;

    constructor() {
        effect(() => {
            if (!this.isVisible()) this.mobileView.set('nav');
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
