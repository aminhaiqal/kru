import { createElement as h, Component, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { ClerkProvider, SignIn, UserButton, useAuth, useUser } from '@clerk/electron/react';

const root = document.getElementById('account');
const gate = document.getElementById('auth-gate');
let entered = false;
const prompt = (content) => createPortal(content, gate);

class AccountBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed
      ? prompt(
          h(
            'button',
            { className: 'account-trigger', onClick: () => location.reload() },
            'Retry sign in',
          ),
        )
      : this.props.children;
  }
}

function Account() {
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn) {
      document.documentElement.classList.remove('account-required');
      gate.hidden = true;
      if (!entered) {
        entered = true;
        window.dispatchEvent(new Event('kru:signed-in'));
      }
    } else {
      document.documentElement.classList.add('account-required');
      gate.hidden = false;
      // Reload discards the previous account's rendered workspace and live listeners.
      if (entered) location.reload();
    }
  }, [isLoaded, isSignedIn]);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 12000);
    return () => clearTimeout(timer);
  }, []);
  if (!isLoaded)
    return prompt(
      h(
        'button',
        {
          className: 'account-trigger',
          disabled: !slow,
          title: slow ? 'Check your connection and retry' : 'Loading your account',
          onClick: () => location.reload(),
        },
        slow ? 'Retry sign in' : 'Account…',
      ),
    );
  if (isSignedIn)
    return h(
      'div',
      {
        className: 'account-signed-in',
        title: user?.primaryEmailAddress?.emailAddress || 'Your account',
      },
      h(UserButton),
    );
  return prompt(h(SignIn, { routing: 'virtual' }));
}

function appearance() {
  const styles = getComputedStyle(document.documentElement);
  const color = (name) => styles.getPropertyValue(name).trim();
  return {
    colorPrimary: color('--action'),
    colorPrimaryForeground: color('--action-foreground'),
    colorBackground: color('--surface'),
    colorForeground: color('--ink'),
    colorNeutral: color('--ink'),
    colorMuted: color('--canvas'),
    colorMutedForeground: color('--muted'),
    colorInput: color('--canvas'),
    colorInputForeground: color('--ink'),
    colorBorder: color('--line'),
    borderRadius: '12px',
  };
}

function AccountProvider({ publishableKey }) {
  const [variables, setVariables] = useState(appearance);
  useEffect(() => {
    const observer = new MutationObserver(() => setVariables(appearance()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  return h(
    ClerkProvider,
    {
      publishableKey,
      signInFallbackRedirectUrl: 'kru://app/',
      signUpFallbackRedirectUrl: 'kru://app/',
      appearance: { variables },
      telemetry: { disabled: true },
    },
    h(Account),
  );
}

async function startAccount() {
  if (!root || !window.kruAccount) return;
  root.hidden = false;
  gate.hidden = false;
  gate.replaceChildren();
  try {
    const { publishableKey } = await window.kruAccount.configuration();
    createRoot(root).render(h(AccountBoundary, null, h(AccountProvider, { publishableKey })));
  } catch {
    gate.textContent = 'Sign-in is unavailable. Restart Kru to try again.';
  }
}

void startAccount();
