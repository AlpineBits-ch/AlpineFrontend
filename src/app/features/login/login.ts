import {Component, inject, signal} from '@angular/core';
import { createClient } from '@workos-inc/authkit-js';
import {Card} from "primeng/card";
import {DatePicker} from "primeng/datepicker";
import {InputText} from "primeng/inputtext";
import {PasswordDirective} from "primeng/password";
import {Button} from "primeng/button";
import {AuthService} from "../../services/auth-service";
import {emit} from "@tauri-apps/api/event";
import {tap} from "rxjs";
@Component({
  selector: 'app-login',
  imports: [
    Card,
    DatePicker,
    InputText,
    PasswordDirective,
    Button
  ],
  templateUrl: './login.html',
  styleUrl: './login.css',
})
export class Login {
  protected isLoginMode = signal(false);
  protected authService = inject(AuthService);

  constructor() {
    this.authService.register('dominic.jaermann@icloud.com', '$T3st4ng').pipe(tap(d => {
      console.log(d);
    })).subscribe();
  }

}
