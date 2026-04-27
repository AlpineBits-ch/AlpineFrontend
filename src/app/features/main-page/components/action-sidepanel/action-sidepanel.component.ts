import {Component, output} from '@angular/core';
import {QuickSettingsComponent} from "../quick-settings/quick-settings.component";

@Component({
  selector: 'app-action-sidepanel',
  imports: [
    QuickSettingsComponent
  ],
  templateUrl: './action-sidepanel.component.html',
  styleUrl: './action-sidepanel.component.css',
})
export class ActionSidepanelComponent {
  public showFriends = output();
}
