import {DomSanitizer} from '@angular/platform-browser';
import {MarkdownPipe} from './markdown.pipe';

function transform(value: string): string {
    const sanitizer = {bypassSecurityTrustHtml: (html: string) => html} as unknown as DomSanitizer;
    return new MarkdownPipe(sanitizer).transform(value) as unknown as string;
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
