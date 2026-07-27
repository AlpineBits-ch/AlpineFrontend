import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';

import {ComposerComponent} from './composer.component';
import {ApiConfigService} from '../../../../../services/api-config.service';

describe('ComposerComponent', () => {
    let component: ComposerComponent;
    let fixture: ComponentFixture<ComposerComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [ComposerComponent],
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            ],
        })
            .compileComponents();

        fixture = TestBed.createComponent(ComposerComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });
});
