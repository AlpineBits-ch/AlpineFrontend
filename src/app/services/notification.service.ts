import { Injectable } from '@angular/core';
import {isPermissionGranted, requestPermission, sendNotification} from "@tauri-apps/plugin-notification";

export enum NotificationSound {
  None,
  NewMessage
}

@Injectable({
  providedIn: 'root',
})
export class NotificationService {

  private async getPermission(): Promise<void>{
    let permissionGranted = await isPermissionGranted();

    if (!permissionGranted) {
      const permission = await requestPermission();
      permissionGranted = permission === 'granted';
    }

  }
  public async createNotification(params: {message: string, title: string, icon: string | undefined, sound: NotificationSound } ): Promise<void>{

    await this.getPermission();
    sendNotification({
      title: params.title,
      body: params.message,
      icon: params.icon // Optional: path to an icon
    });
    this.playSoundNotifiaction(params.sound);
  }

  private playSoundNotifiaction(sound: NotificationSound){
    if(sound === NotificationSound.NewMessage){
      const audio = new Audio('/assets/sounds/new_message.wav');
      audio.play().then();
    }
  }
}
