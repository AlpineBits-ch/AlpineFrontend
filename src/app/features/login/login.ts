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


interface LoginModel {
  email: string;
  password: string;
}

interface RegisterModel {
  email: string;
  password: string;
  birthdate: Date;
}
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

  protected loginModel = signal<LoginModel>({email: '', password: ''});
  protected registerModel = signal<RegisterModel>({email: '', password: '', birthdate: new Date()});

  protected loginForm = form(this.loginModel);

  constructor() {
    this.authService.register('dominic.jaermann@icloud.com', '$T3st4ng', new Date()).pipe(tap(d => {
      console.log(d);
    })).subscribe();
  }

}
