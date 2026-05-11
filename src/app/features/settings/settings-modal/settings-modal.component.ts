import {Component, effect, model, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {Dialog} from "primeng/dialog";
import {Button} from "primeng/button";
import {ProfileSettingsComponent} from "./pages/profile-settings/profile-settings.component";
import {PrivacySettingsComponent} from "./pages/privacy-settings/privacy-settings.component";
import {OtherSettingsComponent} from "./pages/other-settings/other-settings.component";
import {NotificationSettingsComponent} from "./pages/notification-settings/notification-settings.component";
import {VoiceVideoSettingsComponent} from "./pages/voice-video-settings/voice-video-settings.component";
import {LogoutDialogComponent} from "../logout-dialog/logout-dialog.component";

export interface SettingsNavItem {
  id: string;
  label: string;
  icon: string;
}

export interface SettingsNavGroup {
  title: string;
  items: SettingsNavItem[];
}

@Component({
  selector: 'app-settings-modal',
  imports: [
    NgClass,
    Dialog,
    Button,
    ProfileSettingsComponent,
    PrivacySettingsComponent,
    OtherSettingsComponent,
    NotificationSettingsComponent,
    VoiceVideoSettingsComponent,
    LogoutDialogComponent,
  ],
  templateUrl: './settings-modal.component.html',
  styleUrl: './settings-modal.component.css',
})
export class SettingsModalComponent {
  public isVisible = model.required<boolean>();
  public activePage = signal('profile');
  public mobileView = signal<'nav' | 'content'>('nav');
  public showLogoutDialog = signal(false);

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
      'bg-indigo-500/15': active,
      'text-indigo-400': active,
      [inactiveText]: !active,
    };
  }

  public readonly navGroups: SettingsNavGroup[] = [
    {
      title: 'My Account',
      items: [
        { id: 'profile', label: 'Profile', icon: 'pi pi-user'   },
        { id: 'privacy', label: 'Privacy', icon: 'pi pi-shield' },
        { id: 'notifications', label: 'Notifications', icon: 'pi pi-bell' },
      ],
    },
    {
      title: 'App Settings',
      items: [
        { id: 'voice-video', label: 'Voice & Video', icon: 'pi pi-microphone' },
        { id: 'other',       label: 'Other',         icon: 'pi pi-cog'        },
      ],
    },
  ];
}
