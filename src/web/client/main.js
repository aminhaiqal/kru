import { startApp } from './app.js';
const desktop = document.querySelector('meta[name="kru-desktop"]')?.content === 'true';
if (!desktop) startApp();
else window.addEventListener('kru:signed-in', startApp, { once: true });
// Clerk is a small, separate React island; the workspace stays framework-independent.
if (window.kruAccount) {
  const script = document.createElement('script');
  script.type = 'module';
  script.src = '/account.js';
  script.onerror = () => {
    document.getElementById('auth-gate').textContent =
      'Unable to load sign-in. Restart Kru to try again.';
  };
  document.head.append(script);
} else if (desktop) {
  document.getElementById('auth-gate').textContent =
    'Unable to load sign-in. Restart Kru to try again.';
}
