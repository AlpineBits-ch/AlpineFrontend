import {Directive, inject, input, TemplateRef} from '@angular/core';
import {MenuItem} from './context-menu.model';

export interface MenuSlotContext {
    $implicit: MenuItem;
}

/** Consumer template rendered in place of a row whose item carries a matching `slot`. */
@Directive({selector: '[appMenuSlot]'})
export class MenuSlotDirective {
    readonly name = input.required<string>({alias: 'appMenuSlot'});
    readonly template = inject<TemplateRef<MenuSlotContext>>(TemplateRef);
}
