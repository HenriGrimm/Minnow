/**
 * In-app QR scanning for a Home Screen app that lost its sign-in. Uses the
 * browser's built-in BarcodeDetector (Chromium on Android) and a secure context
 * for camera access; where either is missing the button is not offered and
 * Request access covers the same case.
 */

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorInstance {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorInstance;

function barcodeDetector(): BarcodeDetectorConstructor | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
  return typeof ctor === 'function' ? ctor : null;
}

export type ScanResult =
  | { kind: 'ticket'; ticket: string }
  | { kind: 'navigate'; url: string }
  | { kind: 'cancelled' };

const TICKET_RE = /^[A-Za-z0-9_-]{22}$/;

/** Accept only Minnow connect links: `<origin>/connect#t=<ticket>`. */
export function parseConnectUrl(raw: string, here: Location | URL = window.location): ScanResult | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.pathname !== '/connect') return null;
  const ticket = new URLSearchParams(url.hash.slice(1)).get('t') ?? '';
  if (!TICKET_RE.test(ticket)) return null;
  if (url.origin === here.origin) return { kind: 'ticket', ticket };
  return { kind: 'navigate', url: url.toString() };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Open the camera until a connect QR is read or the user cancels. */
export async function scanConnectQr(): Promise<ScanResult> {
  const Detector = barcodeDetector();
  if (!Detector) throw new Error('This browser cannot scan codes. Use Request access instead.');
  const detector = new Detector({ formats: ['qr_code'] });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });

  const overlay = el('div', 'companion-scanner');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Scan the QR on your computer');
  const video = el('video', 'companion-scanner__video');
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;
  const hint = el('p', 'companion-scanner__hint', 'Point your camera at the QR in Settings → Devices on your computer.');
  const cancel = el('button', 'companion-access__btn companion-access__btn--secondary', 'Cancel');
  cancel.type = 'button';
  overlay.append(video, hint, cancel);
  document.body.appendChild(overlay);

  return new Promise<ScanResult>((resolve) => {
    let done = false;
    let frame = 0;
    const finish = (result: ScanResult) => {
      if (done) return;
      done = true;
      cancelAnimationFrame(frame);
      for (const track of stream.getTracks()) track.stop();
      overlay.remove();
      resolve(result);
    };
    cancel.addEventListener('click', () => finish({ kind: 'cancelled' }));
    let lastScan = 0;
    let detecting = false;
    const scan = (now: number) => {
      if (done) return;
      frame = requestAnimationFrame(scan);
      if (detecting || now - lastScan < 200 || video.readyState < 2) return;
      lastScan = now;
      detecting = true;
      void detector
        .detect(video)
        .then((codes) => {
          for (const code of codes) {
            const parsed = parseConnectUrl(code.rawValue);
            if (parsed) {
              finish(parsed);
              return;
            }
          }
          if (codes.length) hint.textContent = "That isn't a Minnow connect code. Use the QR in Settings → Devices.";
        })
        .catch(() => {})
        .finally(() => { detecting = false; });
    };
    void video.play().catch(() => {});
    frame = requestAnimationFrame(scan);
  });
}
