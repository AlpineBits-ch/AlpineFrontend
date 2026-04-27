import {Component, model, signal} from '@angular/core';
import {Dialog} from "primeng/dialog";
import {Button} from "primeng/button";
import {ProfileSettingsComponent} from "./pages/profile-settings/profile-settings.component";
import {PrivacySettingsComponent} from "./pages/privacy-settings/privacy-settings.component";
import {OtherSettingsComponent} from "./pages/other-settings/other-settings.component";

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
    Dialog,
    Button,
    ProfileSettingsComponent,
    PrivacySettingsComponent,
    OtherSettingsComponent,
  ],
  templateUrl: './settings-modal.component.html',
  styleUrl: './settings-modal.component.css',
})
export class SettingsModalComponent {
  public isVisible = model.required<boolean>();
  public activePage = signal('profile');

  /** Add a new page: create its component, add an entry here, add a @case below. */
  public readonly navGroups: SettingsNavGroup[] = [
    {
      title: 'My Account',
      items: [
        { id: 'profile', label: 'Profile', icon: 'pi pi-user'   },
        { id: 'privacy', label: 'Privacy', icon: 'pi pi-shield' },
      ],
    },
    {
      title: 'App Settings',
      items: [
        { id: 'other', label: 'Other', icon: 'pi pi-cog' },
      ],
    },
  ];
}
