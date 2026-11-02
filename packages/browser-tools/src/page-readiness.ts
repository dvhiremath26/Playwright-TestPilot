/**
 * Wait for a full page load and try network-idle. SAP/Fiori shells can keep
 * long-polling requests open, so on network-idle timeout use a bounded DOM-quiet
 * window instead of failing every later browser step.
 */
export const PAGE_READINESS_CODE = `async page => {
  await page.waitForLoadState('load', { timeout: 10000 });
  try {
    await page.waitForLoadState('networkidle', { timeout: 12000 });
    return 'Page reached load and networkidle';
  } catch {
    const settling = await page.evaluate(async () => {
      if (!document.documentElement || !document.body) return 'document body unavailable';
      return await new Promise(resolve => {
        let observer;
        let quietTimer;
        const finish = result => {
          observer.disconnect();
          clearTimeout(quietTimer);
          clearTimeout(maxTimer);
          resolve(result);
        };
        const maxTimer = setTimeout(() => finish('DOM did not become quiet within 5 seconds'), 5000);
        const startQuietWindow = () => {
          clearTimeout(quietTimer);
          quietTimer = setTimeout(() => finish('DOM remained quiet for 1000ms'), 1000);
        };
        observer = new MutationObserver(startQuietWindow);
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        startQuietWindow();
      });
    });
    return 'Page reached load; networkidle timed out; ' + settling;
  }
}`
