export type PaylynxToken = {
  nonce: string;
  expiryMonth: number;
  expiryYear: number;
  avsZip?: string;
};

type PaylynxCardForm = {
  on(event: 'ready', callback: () => void): PaylynxCardForm;
  getNonceToken(): Promise<PaylynxToken>;
  setStyles(styles: PaylynxFieldStyles): PaylynxCardForm;
  destroy(): void;
};

type PaylynxConstructor = new (
  publicKey: string,
  options: { target: HTMLElement; showZip: boolean; showFieldErrors: boolean; styles: PaylynxFieldStyles }
) => PaylynxCardForm;

// The hosted SDK accepts CSS declarations for each of these elements inside the frame.
type PaylynxFieldStyles = ReturnType<typeof paylynxFieldStyles>;

export function paylynxFieldStyles(dark: boolean, compact: boolean, surface: string) {
  const color = dark ? '#f1f5f9' : '#182433';
  const border = dark ? '#586575' : '#8795a5';
  const inputBackground = dark ? '#151e29' : '#ffffff';
  const field = 'box-sizing:border-box;display:block;min-width:0;padding-bottom:20px';
  const input = [
    'box-sizing:border-box;display:block;width:100%;height:44px;margin:0;padding:0 10px;border-radius:6px',
    'outline:revert;outline-offset:1px;font:400 16px system-ui,sans-serif',
    `color-scheme:${dark ? 'dark' : 'light'};color:${color};background:${inputBackground};border:1px solid ${border}`
  ].join(';');

  return {
    labelType: 'static-top',
    container: [
      'box-sizing:border-box;display:grid;align-content:start;min-height:100vh;padding:3px;gap:5px 12px;top:0',
      `color:${color};background:${surface};font-family:system-ui,sans-serif`,
      compact ? 'grid-template-columns:repeat(2,minmax(0,1fr))'
        : 'grid-template-columns:minmax(0,1.7fr) minmax(0,1fr) minmax(0,1.15fr)'
    ].join(';'),
    labels: `display:block;margin:0 0 5px;color:${color};font:600 13px/17px system-ui,sans-serif`,
    cardContainer: `${field};grid-column:1/-1`,
    card: input,
    expiryContainer: [
      field, 'display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:5px',
      compact ? 'grid-column:1/-1' : ''
    ].join(';'),
    expiryMonth: input,
    expirySeparator: 'float:none;margin:22px 0 0 !important;padding:0;font-size:15px;line-height:44px',
    expiryYear: input,
    cvv2Container: field,
    cvv2: input,
    avsZipContainer: field,
    avsZip: input,
    fieldErrors: `top:69px;bottom:auto;max-width:100%;white-space:normal;font:500 11px/1.2 system-ui,sans-serif;color:${dark ? '#ffadad' : '#a21d26'}`
  };
}

const SCRIPT_URLS = {
  test: 'https://tokenization.sandbox.paylynxgateway.com/tokenization/v0.3',
  live: 'https://tokenization.paylynxgateway.com/tokenization/v0.3'
};
const scriptLoads = new Map<string, Promise<PaylynxConstructor>>();

export function loadPaylynxTokenization(mode: 'test' | 'live' = 'test'): Promise<PaylynxConstructor> {
  const existing = scriptLoads.get(mode);
  if (existing) return existing;
  const scriptLoad = new Promise<PaylynxConstructor>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URLS[mode];
    script.async = true;
    const fail = () => {
      clearTimeout(timer);
      script.remove();
      reject(new Error('PayLynx secure card fields could not load.'));
    };
    const timer = setTimeout(fail, 15_000);
    script.onerror = fail;
    script.onload = () => {
      clearTimeout(timer);
      const sdk = (window as Window & { HostedTokenization?: PaylynxConstructor }).HostedTokenization;
      if (typeof sdk === 'function') resolve(sdk);
      else fail();
    };
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    scriptLoads.delete(mode);
    throw error;
  });
  scriptLoads.set(mode, scriptLoad);
  return scriptLoad;
}

export type { PaylynxCardForm };
