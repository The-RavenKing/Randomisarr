const authTitle = document.getElementById('auth-title');
const authCopy = document.getElementById('auth-copy');
const authForm = document.getElementById('auth-form');
const authSubmit = document.getElementById('auth-submit');
const authStatus = document.getElementById('auth-status');
const setupFields = document.getElementById('setup-fields');

let setupMode = false;

function setStatus(message, isError = false) {
  authStatus.textContent = message;
  authStatus.style.color = isError ? '#ff98a3' : '';
}

async function fetchAuthStatus() {
  const response = await fetch('/api/auth/status');
  return response.json();
}

function applyMode(isSetupMode) {
  setupMode = isSetupMode;
  authTitle.textContent = isSetupMode ? 'Initial setup' : 'Sign in';
  authCopy.textContent = isSetupMode
    ? 'Create the mandatory admin username and password, then save your Radarr and Sonarr connection details.'
    : 'Authenticate before accessing the wheel or changing library settings.';
  authSubmit.textContent = isSetupMode ? 'Create Admin' : 'Sign In';
  setupFields.classList.toggle('hidden', !isSetupMode);
}

async function submitAuthForm(event) {
  event.preventDefault();

  authSubmit.disabled = true;
  setStatus(setupMode ? 'Saving initial configuration...' : 'Signing in...');

  try {
    const formData = new FormData(authForm);
    const payload = Object.fromEntries(formData.entries());
    const endpoint = setupMode ? '/api/auth/setup' : '/api/auth/login';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Authentication failed.');
    }

    window.location.href = '/index.html';
  } catch (error) {
    setStatus(error.message, true);
    authSubmit.disabled = false;
  }
}

async function init() {
  try {
    const status = await fetchAuthStatus();

    if (status.authenticated) {
      window.location.href = '/index.html';
      return;
    }

    applyMode(!status.adminConfigured);
    setStatus(setupMode ? 'No admin account found. Complete setup to continue.' : '');
  } catch (error) {
    setStatus('Unable to determine authentication status.', true);
  }
}

authForm.addEventListener('submit', submitAuthForm);
init();
