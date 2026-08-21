import {TestBed} from '@angular/core/testing';
import {DomSanitizer} from '@angular/platform-browser';
import {MarkdownPipe} from './markdown.pipe';

function transform(value: string): string {
    TestBed.configureTestingModule({
        providers: [{provide: DomSanitizer, useValue: {bypassSecurityTrustHtml: (html: string) => html}}],
    });
    const pipe = TestBed.runInInjectionContext(() => new MarkdownPipe());
    return pipe.transform(value) as unknown as string;
}

describe('MarkdownPipe', () => {
    it('strips leading/trailing whitespace from each line', () => {
        // Untrimmed, a browser renders one collapsed space after the <br>
        // preceding "123"/"534"/"44343", visually indenting them relative
        // to the flush-left "test" lines.
        const html = transform('test\n\n  123\n  534\n  44343\n\ntest 1234');
        expect(html).toBe('test<br><br>123<br>534<br>44343<br><br>test 1234');
    });
});
