const apiSettingsForm = document.getElementById('api-settings-form');
const accountSettingsForm = document.getElementById('account-settings-form');
const settingsStatus = document.getElementById('settings-status');
const logoutButton = document.getElementById('logout-button');
const testEmbyButton = document.getElementById('test-emby-button');
const testJellyfinButton = document.getElementById('test-jellyfin-button');
const testPlexButton = document.getElementById('test-plex-button');
const embyTestStatus = document.getElementById('emby-test-status');
const jellyfinTestStatus = document.getElementById('jellyfin-test-status');
const plexTestStatus = document.getElementById('plex-test-status');

const providerTestConfigs = {
  emby: {
    label: 'Emby',
    button: testEmbyButton,
    statusElement: embyTestStatus,
    buildPayload: () => ({
      embyUrl: document.getElementById('emby-url').value,
      embyApiKey: document.getElementById('emby-api-key').value,
      embyUserId: document.getElementById('emby-user-id').value
    })
  },
  jellyfin: {
    label: 'Jellyfin',
    button: testJellyfinButton,
    statusElement: jellyfinTestStatus,
    buildPayload: () => ({
      jellyfinUrl: document.getElementById('jellyfin-url').value,
      jellyfinApiKey: document.getElementById('jellyfin-api-key').value,
      jellyfinUserId: document.getElementById('jellyfin-user-id').value
    })
  },
  plex: {
    label: 'Plex',
    button: testPlexButton,
    statusElement: plexTestStatus,
    buildPayload: () => ({
      plexUrl: document.getElementById('plex-url').value,
      plexToken: document.getElementById('plex-token').value
    })
  }
};

function setStatus(message, isError = false) {
  settingsStatus.textContent = message;
  settingsStatus.style.color = isError ? '#ff98a3' : '';
}

function setProviderStatus(providerName, message, isError = false) {
  const config = providerTestConfigs[providerName];

  if (!config?.statusElement) {
    return;
  }

  config.statusElement.textContent = message;
  config.statusElement.style.color = isError ? '#ff98a3' : '';
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
  document.getElementById('radarr-api-key').value = '';
  document.getElementById('sonarr-url').value = settings.sonarr.url || '';
  document.getElementById('sonarr-api-key').value = '';
  document.getElementById('emby-url').value = settings.providers.emby.url || '';
  document.getElementById('emby-api-key').value = '';
  document.getElementById('emby-user-id').value = settings.providers.emby.userId || '';
  document.getElementById('jellyfin-url').value = settings.providers.jellyfin.url || '';
  document.getElementById('jellyfin-api-key').value = '';
  document.getElementById('jellyfin-user-id').value = settings.providers.jellyfin.userId || '';
  document.getElementById('plex-url').value = settings.providers.plex.url || '';
  document.getElementById('plex-token').value = '';
  document.getElementById('tmdb-access-token').value = '';
  document.getElementById('selection-count').value = settings.preferences.selectionCount ?? '';
  document.getElementById('watch-mode').value = settings.preferences.watchMode || 'everything';
  document.getElementById('watch-source').value = settings.preferences.watchSource || 'auto';
  document.getElementById('franchise-mode').value = settings.preferences.franchiseMode || 'off';
  document.getElementById('username').value = settings.auth.username || '';

  syncSecretFieldPlaceholders(settings);
  syncProviderStatuses(settings);
}

function syncSecretFieldPlaceholders(settings) {
  updateSecretPlaceholder(
    'radarr-api-key',
    settings.radarr.apiKeyConfigured,
    'Saved key present. Leave blank to keep it.'
  );
  updateSecretPlaceholder(
    'sonarr-api-key',
    settings.sonarr.apiKeyConfigured,
    'Saved key present. Leave blank to keep it.'
  );
  updateSecretPlaceholder(
    'emby-api-key',
    settings.providers.emby.apiKeyConfigured,
    'Saved key present. Leave blank to keep it.'
  );
  updateSecretPlaceholder(
    'jellyfin-api-key',
    settings.providers.jellyfin.apiKeyConfigured,
    'Saved key present. Leave blank to keep it.'
  );
  updateSecretPlaceholder(
    'plex-token',
    settings.providers.plex.tokenConfigured,
    'Saved token present. Leave blank to keep it.'
  );
  updateSecretPlaceholder(
    'tmdb-access-token',
    settings.tmdb.accessTokenConfigured,
    'Saved token present. Leave blank to keep it.'
  );
}

function updateSecretPlaceholder(inputId, isConfigured, configuredPlaceholder) {
  const input = document.getElementById(inputId);

  if (!input) {
    return;
  }

  if (input.dataset.emptyPlaceholder === undefined) {
    input.dataset.emptyPlaceholder = input.placeholder || '';
  }

  input.placeholder = isConfigured ? configuredPlaceholder : input.dataset.emptyPlaceholder;
}

function syncProviderStatuses(settings) {
  syncProviderStatusMessage(
    'emby',
    settings.providers.emby.configured,
    settings.providers.emby.apiKeyConfigured
  );
  syncProviderStatusMessage(
    'jellyfin',
    settings.providers.jellyfin.configured,
    settings.providers.jellyfin.apiKeyConfigured
  );
  syncProviderStatusMessage(
    'plex',
    settings.providers.plex.configured,
    settings.providers.plex.tokenConfigured
  );
}

function syncProviderStatusMessage(providerName, isConfigured, hasSavedSecret) {
  if (isConfigured) {
    setProviderStatus(providerName, 'Saved credentials present. Run a test to verify access.');
    return;
  }

  if (hasSavedSecret) {
    setProviderStatus(
      providerName,
      'A saved secret exists, but the rest of this provider still needs to be completed.'
    );
    return;
  }

  setProviderStatus(providerName, 'Not configured yet.');
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
        tmdbAccessToken: document.getElementById('tmdb-access-token').value,
        selectionCount: document.getElementById('selection-count').value,
        watchMode: document.getElementById('watch-mode').value,
        watchSource: document.getElementById('watch-source').value,
        franchiseMode: document.getElementById('franchise-mode').value,
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
        tmdbAccessToken: document.getElementById('tmdb-access-token').value,
        selectionCount: document.getElementById('selection-count').value,
        watchMode: document.getElementById('watch-mode').value,
        watchSource: document.getElementById('watch-source').value,
        franchiseMode: document.getElementById('franchise-mode').value,
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

async function runProviderTest(providerName) {
  const config = providerTestConfigs[providerName];

  if (!config) {
    return;
  }

  config.button.disabled = true;
  setStatus(`Testing ${config.label} connection...`);
  setProviderStatus(providerName, `Testing ${config.label} connection...`);

  try {
    const response = await fetch(`/api/providers/test/${providerName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(config.buildPayload())
    });
    const result = await response.json();

    if (await handleAuthFailure(response, result)) {
      return;
    }

    if (!response.ok) {
      throw new Error(result.error || `${config.label} test failed.`);
    }

    setStatus(result.message);
    setProviderStatus(providerName, result.message);
  } catch (error) {
    setStatus(error.message, true);
    setProviderStatus(providerName, error.message, true);
  } finally {
    config.button.disabled = false;
  }
}

Object.keys(providerTestConfigs).forEach((providerName) => {
  providerTestConfigs[providerName].button.addEventListener('click', async () => {
    await runProviderTest(providerName);
  });
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
