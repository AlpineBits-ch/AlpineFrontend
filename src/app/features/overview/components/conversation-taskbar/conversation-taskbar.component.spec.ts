import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ConversationTaskbarComponent } from './conversation-taskbar.component';

describe('ConversationTaskbarComponent', () => {
  let component: ConversationTaskbarComponent;
  let fixture: ComponentFixture<ConversationTaskbarComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConversationTaskbarComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(ConversationTaskbarComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
