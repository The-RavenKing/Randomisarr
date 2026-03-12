const apiSettingsForm = document.getElementById('api-settings-form');
const accountSettingsForm = document.getElementById('account-settings-form');
const settingsStatus = document.getElementById('settings-status');
const logoutButton = document.getElementById('logout-button');
const testEmbyButton = document.getElementById('test-emby-button');
const embyTestStatus = document.getElementById('emby-test-status');

function setStatus(message, isError = false) {
  settingsStatus.textContent = message;
  settingsStatus.style.color = isError ? '#ff98a3' : '';
}

function setEmbyStatus(message, isError = false) {
  embyTestStatus.textContent = message;
  embyTestStatus.style.color = isError ? '#ff98a3' : '';
}

async function handleAuthFailure(response, payload) {
  if (payload?.requiresLogin) {
    window.location.href = '/login.html';
    return true;
  }

  return false;
}

async function fetchSettings() {
  const response = await fetch('/api/settings');
  const payload = await response.json();

  if (await handleAuthFailure(response, payload)) {
    return null;
  }

  if (!response.ok) {
    throw new Error(payload.error || 'Unable to load settings.');
  }

  return payload.settings;
}

function populateForms(settings) {
  document.getElementById('radarr-url').value = settings.radarr.url || '';
  document.getElementById('radarr-api-key').value = settings.radarr.apiKey || '';
  document.getElementById('sonarr-url').value = settings.sonarr.url || '';
  document.getElementById('sonarr-api-key').value = settings.sonarr.apiKey || '';
  document.getElementById('emby-url').value = settings.providers.emby.url || '';
  document.getElementById('emby-api-key').value = settings.providers.emby.apiKey || '';
  document.getElementById('emby-user-id').value = settings.providers.emby.userId || '';
  document.getElementById('jellyfin-url').value = settings.providers.jellyfin.url || '';
  document.getElementById('jellyfin-api-key').value = settings.providers.jellyfin.apiKey || '';
  document.getElementById('jellyfin-user-id').value = settings.providers.jellyfin.userId || '';
  document.getElementById('plex-url').value = settings.providers.plex.url || '';
  document.getElementById('plex-token').value = settings.providers.plex.token || '';
  document.getElementById('selection-count').value = settings.preferences.selectionCount ?? '';
  document.getElementById('watch-mode').value = settings.preferences.watchMode || 'everything';
  document.getElementById('watch-source').value = settings.preferences.watchSource || 'auto';
  document.getElementById('username').value = settings.auth.username || '';
}

async function saveSettings(payload, successMessage) {
  const response = await fetch('/api/settings', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const result = await response.json();

  if (await handleAuthFailure(response, result)) {
    return;
  }

  if (!response.ok) {
    throw new Error(result.error || 'Unable to save settings.');
  }

  populateForms(result.settings);
  document.getElementById('new-password').value = '';
  setStatus(successMessage);
}

apiSettingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus('Saving API settings...');

  try {
    await saveSettings(
      {
        radarrUrl: document.getElementById('radarr-url').value,
        radarrApiKey: document.getElementById('radarr-api-key').value,
        sonarrUrl: document.getElementById('sonarr-url').value,
        sonarrApiKey: document.getElementById('sonarr-api-key').value,
        embyUrl: document.getElementById('emby-url').value,
        embyApiKey: document.getElementById('emby-api-key').value,
        embyUserId: document.getElementById('emby-user-id').value,
        jellyfinUrl: document.getElementById('jellyfin-url').value,
        jellyfinApiKey: document.getElementById('jellyfin-api-key').value,
        jellyfinUserId: document.getElementById('jellyfin-user-id').value,
        plexUrl: document.getElementById('plex-url').value,
        plexToken: document.getElementById('plex-token').value,
        selectionCount: document.getElementById('selection-count').value,
        watchMode: document.getElementById('watch-mode').value,
        watchSource: document.getElementById('watch-source').value,
        username: document.getElementById('username').value
      },
      'API settings saved.'
    );
  } catch (error) {
    setStatus(error.message, true);
  }
});

accountSettingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus('Saving access settings...');

  try {
    await saveSettings(
      {
        radarrUrl: document.getElementById('radarr-url').value,
        radarrApiKey: document.getElementById('radarr-api-key').value,
        sonarrUrl: document.getElementById('sonarr-url').value,
        sonarrApiKey: document.getElementById('sonarr-api-key').value,
        embyUrl: document.getElementById('emby-url').value,
        embyApiKey: document.getElementById('emby-api-key').value,
        embyUserId: document.getElementById('emby-user-id').value,
        jellyfinUrl: document.getElementById('jellyfin-url').value,
        jellyfinApiKey: document.getElementById('jellyfin-api-key').value,
        jellyfinUserId: document.getElementById('jellyfin-user-id').value,
        plexUrl: document.getElementById('plex-url').value,
        plexToken: document.getElementById('plex-token').value,
        selectionCount: document.getElementById('selection-count').value,
        watchMode: document.getElementById('watch-mode').value,
        watchSource: document.getElementById('watch-source').value,
        username: document.getElementById('username').value,
        newPassword: document.getElementById('new-password').value
      },
      'Access settings saved.'
    );
  } catch (error) {
    setStatus(error.message, true);
  }
});

logoutButton.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

testEmbyButton.addEventListener('click', async () => {
  testEmbyButton.disabled = true;
  setStatus('Testing Emby connection...');
  setEmbyStatus('Testing Emby connection...');

  try {
    const response = await fetch('/api/providers/test/emby', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        embyUrl: document.getElementById('emby-url').value,
        embyApiKey: document.getElementById('emby-api-key').value,
        embyUserId: document.getElementById('emby-user-id').value
      })
    });
    const result = await response.json();

    if (await handleAuthFailure(response, result)) {
      return;
    }

    if (!response.ok) {
      throw new Error(result.error || 'Emby test failed.');
    }

    setStatus(result.message);
    setEmbyStatus(result.message);
  } catch (error) {
    setStatus(error.message, true);
    setEmbyStatus(error.message, true);
  } finally {
    testEmbyButton.disabled = false;
  }
});

async function init() {
  try {
    const settings = await fetchSettings();

    if (!settings) {
      return;
    }

    populateForms(settings);
    setStatus('Settings loaded.');
  } catch (error) {
    setStatus(error.message, true);
  }
}

init();
