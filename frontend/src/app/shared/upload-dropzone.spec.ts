import { Component, input } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UploadDropzone } from './upload-dropzone';

@Component({
  imports: [UploadDropzone],
  template: `
    <app-upload-dropzone
      [accept]="accept()"
      [prompt]="prompt()"
      [hint]="hint()"
      (filesPicked)="picked.push($event)" />
  `,
})
class Host {
  readonly accept = input('application/pdf,.pdf');
  readonly prompt = input('Drop PDFs here, or click to browse');
  readonly hint = input('Only PDF files are accepted');
  readonly picked: File[][] = [];
}

const pdf = (name = 'report.pdf') => new File(['%PDF-1.4'], name, { type: 'application/pdf' });
const png = (name = 'photo.png') => new File([new Uint8Array([1])], name, { type: 'image/png' });

/**
 * jsdom has no `DragEvent` or `DataTransfer`. A plain event with a
 * `dataTransfer` property is what the handler reads, and the only thing it
 * reads from it is `files`.
 */
function dragEvent(type: 'dragover' | 'dragleave' | 'drop', files: File[] = []): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files } });
  return event;
}

/**
 * Paper laid on a desk (design contract §3). The zone lights up while a file
 * hovers it, a dropped file goes through the same `accept` gate the picker
 * uses, and a refusal is silent — the hint already says what is accepted.
 */
describe('UploadDropzone', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;

  function build(inputs: { accept?: string; prompt?: string; hint?: string } = {}): void {
    fixture = TestBed.createComponent(Host);
    for (const [key, value] of Object.entries(inputs)) fixture.componentRef.setInput(key, value);
    fixture.detectChanges();
    host = fixture.componentInstance;
  }

  function zone(): HTMLLabelElement {
    return fixture.nativeElement.querySelector('[data-test=dropzone]');
  }

  function fileInput(): HTMLInputElement {
    return fixture.nativeElement.querySelector('[data-test=file-input]');
  }

  beforeEach(() => {
    TestBed.configureTestingModule({});
  });

  it('renders its prompt and hint, and a labelled picker that takes several files', () => {
    build({ prompt: 'Drop a document here', hint: 'Word files only' });
    expect(zone().querySelector('.dz-prompt')?.textContent).toBe('Drop a document here');
    expect(zone().querySelector('.dz-hint')?.textContent).toBe('Word files only');
    const input = fileInput();
    // That it has a name, not which words: the fixed aria-label says "PDF"
    // whatever `accept` is, and the label's own text would name it as well.
    expect((input.getAttribute('aria-label') || input.closest('label')?.textContent || '').trim()).not.toBe('');
    expect(input.multiple).toBe(true);
    // The whole sheet is the click target: the input is inside the label.
    expect(zone().contains(input)).toBe(true);
  });

  it('passes the accept list through to the picker', () => {
    build({ accept: 'image/*,.docx' });
    expect(fileInput().getAttribute('accept')).toBe('image/*,.docx');
  });

  it('lights up while a file hovers and settles when it leaves', () => {
    build();
    expect(zone().classList.contains('dragging')).toBe(false);

    const over = dragEvent('dragover');
    zone().dispatchEvent(over);
    fixture.detectChanges();
    expect(zone().classList.contains('dragging')).toBe(true);
    // Without this the browser navigates to the dropped file.
    expect(over.defaultPrevented).toBe(true);

    zone().dispatchEvent(dragEvent('dragleave'));
    fixture.detectChanges();
    expect(zone().classList.contains('dragging')).toBe(false);
  });

  it('emits a dropped PDF and settles the sheet', () => {
    build();
    zone().dispatchEvent(dragEvent('dragover'));
    fixture.detectChanges();

    const drop = dragEvent('drop', [pdf()]);
    zone().dispatchEvent(drop);
    fixture.detectChanges();

    expect(drop.defaultPrevented).toBe(true);
    expect(zone().classList.contains('dragging')).toBe(false);
    expect(host.picked).toHaveLength(1);
    expect(host.picked[0].map((f) => f.name)).toEqual(['report.pdf']);
  });

  it('emits several dropped PDFs together, in order', () => {
    build();
    zone().dispatchEvent(dragEvent('drop', [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')]));
    expect(host.picked).toHaveLength(1);
    expect(host.picked[0].map((f) => f.name)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
  });

  it('drops a file the accept list refuses, and emits nothing when none survive', () => {
    build();
    zone().dispatchEvent(dragEvent('drop', [png()]));
    expect(host.picked).toHaveLength(0);

    zone().dispatchEvent(dragEvent('drop', [png(), pdf('keep.pdf')]));
    expect(host.picked).toHaveLength(1);
    expect(host.picked[0].map((f) => f.name)).toEqual(['keep.pdf']);
  });

  it.each([
    ['a .pdf extension with no MIME type', 'application/pdf,.pdf', new File([''], 'SCAN.PDF'), true],
    ['a PDF MIME type under a foreign name', 'application/pdf,.pdf', new File([''], 'x.bin', { type: 'application/pdf' }), true],
    ['a wildcard MIME family', 'image/*', png('p.jpeg'), true],
    ['a wildcard that does not match', 'image/*', pdf(), false],
    ['an uppercase extension in the list', '.DOCX', new File([''], 'cv.docx'), true],
    ['a file matching nothing in the list', 'application/pdf,.pdf', new File([''], 'notes.txt', { type: 'text/plain' }), false],
  ])('judges %s the way the picker would', (_what, accept, file, accepted) => {
    build({ accept });
    zone().dispatchEvent(dragEvent('drop', [file]));
    expect(host.picked).toHaveLength(accepted ? 1 : 0);
  });

  it('emits what the picker chose and clears the picker after each pick', () => {
    build();
    const input = fileInput();
    // jsdom reads `value` from its own empty file list, never from the stubbed
    // `files`, so it reads '' with or without the reset: watch the write instead.
    const valueWrites = vi.spyOn(input, 'value', 'set');
    Object.defineProperty(input, 'files', { value: [pdf('one.pdf')], configurable: true });
    input.dispatchEvent(new Event('change'));
    expect(host.picked).toHaveLength(1);
    expect(host.picked[0][0].name).toBe('one.pdf');
    // Browsers do not fire `change` when the same path is picked again unless
    // the value was cleared — so the reset is what makes re-adding possible.
    expect(valueWrites).toHaveBeenCalledTimes(1);
    expect(valueWrites).toHaveBeenCalledWith('');

    // The next pick is emitted, and cleared, the same way.
    input.dispatchEvent(new Event('change'));
    expect(host.picked).toHaveLength(2);
    expect(valueWrites).toHaveBeenCalledTimes(2);
    expect(valueWrites).toHaveBeenLastCalledWith('');
  });

  it('emits nothing when the picker was cancelled', () => {
    build();
    const input = fileInput();
    Object.defineProperty(input, 'files', { value: [], configurable: true });
    input.dispatchEvent(new Event('change'));
    expect(host.picked).toHaveLength(0);
  });

  it('opens the picker from a click anywhere on the sheet', () => {
    build();
    let opened = 0;
    fileInput().addEventListener('click', () => { opened += 1; });
    zone().querySelector<HTMLElement>('.dz-prompt')!.click();
    expect(opened).toBe(1);
  });
});
