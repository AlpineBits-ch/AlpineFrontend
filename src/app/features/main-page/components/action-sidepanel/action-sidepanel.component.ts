import { Component, inject } from '@angular/core';
import { QuickSettingsComponent } from '../quick-settings/quick-settings.component';
import { DmSidepanelComponent } from '../dm-sidepanel/dm-sidepanel.component';
import { ChannelListComponent } from '../channel-list/channel-list.component';
import { NavigationService } from '../../navigation.service';

@Component({
  selector: 'app-action-sidepanel',
  imports: [QuickSettingsComponent, DmSidepanelComponent, ChannelListComponent],
  templateUrl: './action-sidepanel.component.html',
  styleUrl: './action-sidepanel.component.css',
})
export class ActionSidepanelComponent {
  protected navService = inject(NavigationService);
}
