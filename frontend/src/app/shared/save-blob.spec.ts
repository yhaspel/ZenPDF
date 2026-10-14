import { saveBlob } from './save-blob';

describe('saveBlob', () => {
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  let revoked: string[];
  let clicked: HTMLAnchorElement[];
  let connectedAtClick: boolean[];

  beforeEach(() => {
    vi.useFakeTimers();
    revoked = [];
    clicked = [];
    connectedAtClick = [];
    URL.createObjectURL = () => 'blob:zenpdf/abc';
    URL.revokeObjectURL = (url: string) => { revoked.push(url); };
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
      connectedAtClick.push(this.isConnected);
    });
  });

  afterEach(() => {
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('clicks a download link for the blob under the given name while it is attached, then removes it', () => {
    saveBlob(new Blob(['%PDF'], { type: 'application/pdf' }), 'merged.pdf');

    expect(clicked.length).toBe(1);
    const link = clicked[0];
    expect(link.href).toBe('blob:zenpdf/abc');
    expect(link.download).toBe('merged.pdf');
    // Attached for the click (Firefox needs it in the document) and gone after.
    expect(connectedAtClick).toEqual([true]);
    expect(link.isConnected).toBe(false);
    expect(document.querySelectorAll('a[download]').length).toBe(0);
  });

  it('revokes the object URL only after the browser has had a second to start the download', () => {
    saveBlob(new Blob(['x']), 'x.txt');
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(999);
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(revoked).toEqual(['blob:zenpdf/abc']);
  });
});
