import {Component, inject} from '@angular/core';
import {InputText} from "primeng/inputtext";
import {Button} from "primeng/button";
import {isPermissionGranted, requestPermission, sendNotification} from "@tauri-apps/plugin-notification";
import {FriendshipModalComponent} from "../../../friendship/components/friendship-modal/friendship-modal.component";
import {AuthService} from "../../../../services/auth.service";
import {OAuthService} from "angular-oauth2-oidc";
import {NotificationService, NotificationSound} from "../../../../services/notification.service";

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

  private authService = inject(AuthService);
  private oAuth = inject(OAuthService);
  private notificationService = inject(NotificationService);
  async notifyUser(): Promise<void> {
    await this.notificationService.createNotification({
      message: 'Test Nachricht',
      title: 'Echo',
      icon: '/assets/tauri.svg',
      sound: NotificationSound.NewMessage
    })
  }

  public logout(): void{
    this.authService.logout();
  }

  public refreshToken(){
    this.oAuth.refreshToken();
  }
}
