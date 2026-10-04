const form = document.getElementById('ai-help-form');
if (form) {
  const question = document.getElementById('ai-question');
  const code = document.getElementById('ai-code');
  const output = document.getElementById('ai-output');
  const status = document.getElementById('ai-status');
  const submit = document.getElementById('ai-submit');
  const cancel = document.getElementById('ai-cancel');
  let controller = null;
  document.getElementById('ai-use-draft').addEventListener('click', () => {
    const draft = document.getElementById('userscript-code').value;
    if (draft.length > 6000) { status.textContent = 'The draft is longer than 6,000 characters. Paste the relevant section below.'; return; }
    code.value = draft;
    status.textContent = 'Draft copied here. Review it before sending.';
  });
  document.getElementById('ai-clear').addEventListener('click', () => {
    controller?.abort();
    question.value = code.value = output.textContent = '';
    status.textContent = 'Cleared.';
  });
  cancel.addEventListener('click', () => controller?.abort());
  window.addEventListener('monkeh:privacy', event => {
    if (!event.detail.aiEnabled) controller?.abort();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (controller) return;
    if (!window.MonkehPrivacy?.get().aiEnabled) { status.textContent = 'Coding help is disabled in Settings.'; return; }
    const prompt = question.value.trim();
    const codeSnapshot = code.value;
    if (!prompt || prompt.length > 2000 || codeSnapshot.length > 6000) { status.textContent = 'Enter a question up to 2,000 characters and code up to 6,000 characters.'; return; }
    controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]);
    submit.disabled = true;
    cancel.hidden = false;
    output.textContent = '';
    status.textContent = 'Asking coding help…';
    try {
      const config = await globalThis.MonkehConfig.fetchConfig();
      const response = await fetch(new URL('/api/assist', config.proxyOrigin), {
        method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error',
        referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: prompt, code: codeSnapshot }), signal
      });
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Coding help is not available on this deployment yet.');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Coding help returned HTTP ${response.status}.`);
      if (typeof result.answer !== 'string' || result.answer.length > 24000) throw new Error('Coding help returned an invalid response.');
      output.textContent = result.answer;
      status.textContent = 'Review suggestions before running code. Answers can be incorrect.';
    } catch (error) {
      status.textContent = signal.aborted ? 'Request stopped or timed out. You can try again.' : error instanceof TypeError ? 'Cannot reach coding help. Check your connection; this deployment needs the Worker coding-help API.' : error.message;
    } finally { controller = null; submit.disabled = false; cancel.hidden = true; }
  });
}
