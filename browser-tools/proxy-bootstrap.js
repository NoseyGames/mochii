const nonce = new URL(location.href).searchParams.get('nonce');

async function identify() {
  if (window.parent === window || !/^[a-f0-9]{32}$/.test(nonce || '') || !navigator.serviceWorker) return;
  let listener;
  let timer;
  let channel;
  try {
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Proxy control timed out.')), 5000);
        listener = () => { if (navigator.serviceWorker.controller) resolve(); };
        navigator.serviceWorker.addEventListener('controllerchange', listener);
        listener();
      });
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('controllerchange', listener);
    }
    channel = new MessageChannel();
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Proxy identity timed out.')), 5000);
      channel.port1.onmessage = ({ data }) => {
        if (data?.ok === true && typeof data.clientId === 'string' && data.clientId.length <= 128) resolve(data.clientId);
        else reject(new Error('Proxy identity was rejected.'));
      };
      channel.port1.start();
      navigator.serviceWorker.controller.postMessage({ type: 'monkeh:identity:client', nonce }, [channel.port2]);
    });
    window.parent.postMessage({ type: 'monkeh-proxy:identity-ready', nonce, clientId: result }, location.origin);
  } catch {
    window.parent.postMessage({ type: 'monkeh-proxy:identity-ready', nonce, failed: true }, location.origin);
  } finally {
    clearTimeout(timer);
    if (listener) navigator.serviceWorker.removeEventListener('controllerchange', listener);
    channel?.port1.close();
    channel?.port2.close();
  }
}

void identify();
