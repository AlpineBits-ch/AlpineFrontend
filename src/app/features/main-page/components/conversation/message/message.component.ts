import {ChangeDetectionStrategy, Component, computed, inject, input} from '@angular/core';
import {MessageDto} from "../../../../../dtos/response/message.dto";
import {Avatar} from "primeng/avatar";
import {AsyncPipe, DatePipe} from "@angular/common";
import {ProfileService} from "../../../../../services/profile.service";
import {Observable} from "rxjs";
import {ProfileDto} from "../../../../../dtos/response/profile.dto";
import {rxResource} from "@angular/core/rxjs-interop";

@Component({
  selector: 'app-message',
  imports: [
    Avatar,
    DatePipe,
    AsyncPipe
  ],
  templateUrl: './message.component.html',
  styleUrl: './message.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MessageComponent {
  public profileService = inject(ProfileService);

  public message = input.required<MessageDto>();

  public content = computed(() => {
    const message = this.message();
    return atob(message.content)
  })




  public getProfile(): Observable<ProfileDto>{
    return this.profileService.getByUserId(this.message().authorId);
  }
}
