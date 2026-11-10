/**
 * Puts `text` on the clipboard. `navigator.clipboard` exists only in a secure context (HTTPS or
 * localhost), and this app is usually opened over plain HTTP on the LAN, so the old
 * select-and-copy command is the fallback. Rejects when neither works.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* e.g. permission denied: try the fallback */
    }
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
  const previous = document.activeElement as HTMLElement | null;
  document.body.appendChild(field);
  try {
    field.select();
    field.setSelectionRange(0, text.length);
    if (!document.execCommand?.('copy')) throw new Error('copy command refused');
  } finally {
    field.remove();
    previous?.focus?.();
  }
}
