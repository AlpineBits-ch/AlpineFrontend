import { Component } from '@angular/core';
import {InputText} from "primeng/inputtext";
import {Button} from "primeng/button";
import {isPermissionGranted, requestPermission, sendNotification} from "@tauri-apps/plugin-notification";
import {FriendshipModalComponent} from "../../../friendship/components/friendship-modal/friendship-modal.component";

@Component({
  selector: 'app-home',
  imports: [
    InputText,
    Button,
    FriendshipModalComponent
  ],
  templateUrl: './home.component.html',
  styleUrl: './home.component.css',
})
export class HomeComponent {


  async notifyUser(): Promise<void> {
    let permissionGranted = await isPermissionGranted();

    if (!permissionGranted) {
      const permission = await requestPermission();
      permissionGranted = permission === 'granted';
    }

    if (permissionGranted) {
      sendNotification({
        title: 'Tauri App',
        body: 'Success! Your notification is working.',
        icon: 'app-icon' // Optional: path to an icon
      });
    }
  }
}
