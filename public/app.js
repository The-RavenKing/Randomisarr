const spinButton = document.getElementById('spin-button');
const includeMoviesCheckbox = document.getElementById('include-movies');
const includeShowsCheckbox = document.getElementById('include-shows');
const watchModeSelect = document.getElementById('watch-mode');
const libraryFilterSection = document.getElementById('library-filter-section');
const librarySourceNote = document.getElementById('library-source-note');
const allLibrariesCheckbox = document.getElementById('all-libraries');
const libraryOptions = document.getElementById('library-options');
const wheelCanvas = document.getElementById('canvas');
const statusMessage = document.getElementById('status-message');
const resultModal = document.getElementById('result-modal');
const resultTitle = document.getElementById('result-title');
const resultType = document.getElementById('result-type');
const resultPoster = document.getElementById('result-poster');
const resultEmptyPoster = document.getElementById('result-empty-poster');
const closeResultButton = document.getElementById('close-result');
const muteButton = document.getElementById('mute-button');
const logoutButton = document.getElementById('logout-button');

const SEGMENT_COLORS = ['#722F37', '#222226', '#1A2421', '#2F343B', '#8B7355'];
const SPIN_DURATION_SECONDS = 6;
const SPIN_TURNS = 10;
const SEGMENT_TEXT_MAX_LENGTH = 14;
const WHEEL_TEXT_COLOR = '#ffffff';
const MAX_VISUAL_SEGMENTS = 25;
const BASE_CANVAS_SIZE = 400;
const AUDIO_MUTED_STORAGE_KEY = 'randomisarr_tick_muted';
const tickSound = new Audio('/tick.wav');
tickSound.preload = 'auto';
tickSound.volume = 0.28;

let wheel = null;
let currentItems = [];
let availableLibraries = [];
let activeLibraryProvider = null;
let lastTickTimestamp = 0;
let lastTickSegmentNumber = null;
let isTickMuted = window.localStorage.getItem(AUDIO_MUTED_STORAGE_KEY) === 'true';

function truncateTitle(title, maxLength = SEGMENT_TEXT_MAX_LENGTH) {
  if (title.length <= maxLength) {
    return title;
  }

  return `${title.slice(0, maxLength - 3)}...`;
}

function setStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.style.color = isError ? '#ff98a3' : '';
}

function updateMuteButton() {
  muteButton.textContent = isTickMuted ? 'Tick Sound Off' : 'Tick Sound On';
  muteButton.setAttribute('aria-pressed', String(isTickMuted));
}

function hideResult() {
  resultModal.classList.add('hidden');
}

function showResult(winner) {
  resultTitle.textContent = winner.title;
  resultType.textContent = winner.type === 'movie' ? 'Movie' : 'TV Show';

  if (winner.posterUrl) {
    resultPoster.src = winner.posterUrl;
    resultPoster.alt = `${winner.title} poster`;
    resultPoster.classList.remove('hidden');
    resultEmptyPoster.classList.add('hidden');
  } else {
    resultPoster.removeAttribute('src');
    resultPoster.alt = '';
    resultPoster.classList.add('hidden');
    resultEmptyPoster.classList.remove('hidden');
  }

  resultModal.classList.remove('hidden');
}

function buildSegments(items) {
  return items.map((item, index) => ({
    fillStyle: SEGMENT_COLORS[index % SEGMENT_COLORS.length],
    textFillStyle: WHEEL_TEXT_COLOR,
    text: truncateTitle(item.title)
  }));
}

function playTickSound() {
  if (isTickMuted) {
    return;
  }

  const now = Date.now();

  if (now - lastTickTimestamp > 60) {
    tickSound.currentTime = 0;
    tickSound.play().catch(() => console.log('Audio play prevented by browser'));
    lastTickTimestamp = now;
  }
}

async function primeTickSound() {
  if (isTickMuted) {
    return;
  }

  const originalVolume = tickSound.volume;

  try {
    tickSound.volume = 0;
    tickSound.currentTime = 0;
    await tickSound.play();
    tickSound.pause();
    tickSound.currentTime = 0;
  } catch {
    // Ignore autoplay restrictions here; actual ticks will still try to play during the spin.
  } finally {
    tickSound.volume = originalVolume;
  }
}

function resetTickState() {
  lastTickTimestamp = 0;
  lastTickSegmentNumber = null;
}

function handleWheelAnimationFrame() {
  if (!wheel || typeof wheel.getIndicatedSegmentNumber !== 'function') {
    return;
  }

  const currentSegmentNumber = wheel.getIndicatedSegmentNumber();

  if (!currentSegmentNumber || currentSegmentNumber === lastTickSegmentNumber) {
    return;
  }

  lastTickSegmentNumber = currentSegmentNumber;
  playTickSound();
}

function createWheel(items, onFinished) {
  wheelCanvas.width = BASE_CANVAS_SIZE;
  wheelCanvas.height = BASE_CANVAS_SIZE;

  return new Winwheel({
    canvasId: 'canvas',
    numSegments: items.length,
    outerRadius: 180,
    innerRadius: 40,
    textFontFamily: 'Inter',
    textFontSize: 11,
    textFontWeight: '500',
    textFillStyle: WHEEL_TEXT_COLOR,
    textAlignment: 'outer',
    textOrientation: 'horizontal',
    textMargin: 10,
    lineColor: 'rgba(255, 255, 255, 0.1)',
    lineWidth: 1,
    strokeStyle: 'rgba(255, 255, 255, 0.1)',
    pointerAngle: 0,
    responsive: true,
    segments: buildSegments(items),
    animation: {
      type: 'spinToStop',
      duration: SPIN_DURATION_SECONDS,
      spins: SPIN_TURNS,
      easing: 'Power2.easeOut',
      stopAngle: 0,
      callbackAfter: handleWheelAnimationFrame,
      callbackFinished: () => {
        resetTickState();
        onFinished();
      }
    }
  });
}

function calculateStopAngle(winwheel, winningIndex) {
  const segment = winwheel.segments[winningIndex + 1];

  if (!segment) {
    throw new Error('Unable to calculate a stop angle for the winning segment.');
  }

  const midpoint = (segment.startAngle + segment.endAngle) / 2;
  return midpoint % 360;
}

async function fetchSettings() {
  const response = await fetch('/api/settings');
  const payload = await response.json();

  if (payload.requiresLogin) {
    window.location.href = '/login.html';
    return null;
  }

  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load app settings.');
  }

  return payload.settings;
}

async function fetchLibraries() {
  const response = await fetch('/api/libraries');
  const payload = await response.json();

  if (payload.requiresLogin) {
    window.location.href = '/login.html';
    return null;
  }

  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load libraries.');
  }

  return payload;
}

function renderLibraryOptions(providerUsed, libraries, warnings = []) {
  availableLibraries = libraries || [];
  activeLibraryProvider = providerUsed || null;
  libraryOptions.innerHTML = '';

  if (!availableLibraries.length) {
    libraryFilterSection.classList.add('hidden');
    librarySourceNote.textContent = providerUsed
      ? `No selectable libraries returned from ${providerUsed}.`
      : 'No provider libraries available.';

    if (warnings.length) {
      setStatus(`Library filter unavailable. ${warnings.join(' ')}`, true);
    }

    return;
  }

  libraryFilterSection.classList.remove('hidden');
  librarySourceNote.textContent = `Source: ${providerUsed}`;
  allLibrariesCheckbox.checked = true;

  availableLibraries.forEach((library) => {
    const label = document.createElement('label');
    label.className = 'toggle toggle-compact';
    label.dataset.mediaTypes = (library.mediaTypes || []).join(',');

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = library.id;
    input.className = 'library-option-checkbox';

    input.addEventListener('change', () => {
      if (input.checked) {
        allLibrariesCheckbox.checked = false;
      }

      const hasSpecificSelection = libraryOptions.querySelector(':checked');

      if (!hasSpecificSelection) {
        allLibrariesCheckbox.checked = true;
      }
    });

    const span = document.createElement('span');
    span.textContent = library.name;

    const badge = document.createElement('span');
    badge.className = 'library-badge';
    badge.textContent =
      library.mediaTypes?.length === 1
        ? library.mediaTypes[0] === 'movie'
          ? 'Movies'
          : 'TV'
        : 'Mixed';

    const content = document.createElement('div');
    content.className = 'library-option-content';
    content.append(span, badge);

    label.append(input, content);
    libraryOptions.appendChild(label);
  });

  syncLibraryVisibility();
}

function getSelectedLibraryIds() {
  if (allLibrariesCheckbox.checked) {
    return [];
  }

  return Array.from(libraryOptions.querySelectorAll('input[type="checkbox"]:checked')).map(
    (input) => input.value
  );
}

function syncLibraryVisibility() {
  const includeMovies = includeMoviesCheckbox.checked;
  const includeShows = includeShowsCheckbox.checked;
  let visibleCount = 0;
  let checkedVisibleCount = 0;

  libraryOptions.querySelectorAll('.toggle-compact').forEach((option) => {
    const mediaTypes = (option.dataset.mediaTypes || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const matchesMovies = includeMovies && mediaTypes.includes('movie');
    const matchesShows = includeShows && mediaTypes.includes('show');
    const isVisible = matchesMovies || matchesShows;
    const checkbox = option.querySelector('input[type="checkbox"]');

    option.classList.toggle('hidden', !isVisible);
    checkbox.disabled = !isVisible;

    if (!isVisible) {
      checkbox.checked = false;
    } else {
      visibleCount += 1;

      if (checkbox.checked) {
        checkedVisibleCount += 1;
      }
    }
  });

  libraryFilterSection.classList.toggle('hidden', visibleCount === 0);

  if (visibleCount > 0 && checkedVisibleCount === 0) {
    allLibrariesCheckbox.checked = true;
  }
}

async function fetchSpinData(includeMovies, includeShows, watchMode, selectedLibraryIds) {
  const params = new URLSearchParams({
    includeMovies: String(includeMovies),
    includeShows: String(includeShows),
    watchMode
  });

  if (selectedLibraryIds.length > 0) {
    params.set('selectedLibraries', selectedLibraryIds.join(','));
    if (activeLibraryProvider) {
      params.set('selectedLibraryProvider', activeLibraryProvider);
    }
  }

  const response = await fetch(`/api/spin?${params.toString()}`);
  const payload = await response.json();

  if (payload.requiresLogin) {
    window.location.href = '/login.html';
    return null;
  }

  if (!response.ok) {
    throw new Error(payload.error || 'Failed to fetch a spin result.');
  }

  const winningIndex = Number.isInteger(payload.winningIndex)
    ? payload.winningIndex
    : Number(payload.winning_index);

  if (
    !Array.isArray(payload.items) ||
    payload.items.length === 0 ||
    payload.items.length > MAX_VISUAL_SEGMENTS
  ) {
    throw new Error('The backend returned an invalid wheel payload.');
  }

  if (!Number.isInteger(winningIndex) || winningIndex < 0 || winningIndex >= payload.items.length) {
    throw new Error('The backend returned an invalid winning index.');
  }

  if (!payload.winner) {
    throw new Error('The backend did not return the selected winner.');
  }

  payload.winningIndex = winningIndex;
  return payload;
}

async function handleSpin() {
  const includeMovies = includeMoviesCheckbox.checked;
  const includeShows = includeShowsCheckbox.checked;
  const watchMode = watchModeSelect.value;
  const selectedLibraryIds = getSelectedLibraryIds();

  if (!includeMovies && !includeShows) {
    alert('Select at least one library before spinning.');
    return;
  }

  spinButton.disabled = true;
  hideResult();
  setStatus('Fetching libraries and latest drand beacon...');

  try {
    await primeTickSound();
    const payload = await fetchSpinData(includeMovies, includeShows, watchMode, selectedLibraryIds);

    if (!payload) {
      return;
    }

    const { items, winningIndex, beacon, filter, warnings, winner, totalPoolSize, wheelSize } = payload;

    currentItems = items;
    resetTickState();
    wheel = createWheel(items, () => {
      showResult(winner);
      setStatus(`Stopped on "${winner.title}". drand beacon: ${beacon.randomness.slice(0, 12)}...`);
      spinButton.disabled = false;
    });

    const stopAngle = calculateStopAngle(wheel, winningIndex);
    wheel.animation.stopAngle = stopAngle;
    wheel.draw();

    const filterLabel =
      filter?.watchMode === 'unwatched'
        ? ` Unwatched only${filter.watchProviderUsed ? ` via ${filter.watchProviderUsed}` : ''}.`
        : ' Everything mode.';
    const libraryLabel =
      filter?.librarySourceUsed && selectedLibraryIds.length > 0
        ? ` Libraries filtered: ${selectedLibraryIds.length}.`
        : '';
    const poolLabel =
      totalPoolSize > wheelSize
        ? ` Winner selected from ${totalPoolSize} titles, visual wheel shows ${wheelSize}.`
        : ` Pool size: ${totalPoolSize}.`;
    const warningLabel = warnings?.length ? ` Warnings: ${warnings.join(' ')}` : '';

    setStatus(
      `Spinning ${wheelSize} visual segments. Beacon locked: ${beacon.randomness.slice(0, 16)}...${filterLabel}${libraryLabel}${poolLabel}${warningLabel}`
    );
    wheel.startAnimation();
  } catch (error) {
    setStatus(error.message, true);
    spinButton.disabled = false;
  }
}

spinButton.addEventListener('click', handleSpin);
closeResultButton.addEventListener('click', hideResult);
muteButton.addEventListener('click', () => {
  isTickMuted = !isTickMuted;
  tickSound.muted = isTickMuted;
  window.localStorage.setItem(AUDIO_MUTED_STORAGE_KEY, String(isTickMuted));
  updateMuteButton();
});
logoutButton.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
});
allLibrariesCheckbox.addEventListener('change', () => {
  if (allLibrariesCheckbox.checked) {
    libraryOptions
      .querySelectorAll('input[type="checkbox"]')
      .forEach((input) => {
        input.checked = false;
      });
  }
});
includeMoviesCheckbox.addEventListener('change', syncLibraryVisibility);
includeShowsCheckbox.addEventListener('change', syncLibraryVisibility);

async function init() {
  try {
    tickSound.muted = isTickMuted;
    updateMuteButton();
    const settings = await fetchSettings();

    if (!settings) {
      return;
    }

    watchModeSelect.value = settings.preferences.watchMode || 'everything';
    const libraryPayload = await fetchLibraries();

    if (libraryPayload) {
      renderLibraryOptions(
        libraryPayload.providerUsed,
        libraryPayload.libraries,
        libraryPayload.warnings
      );
    }

    setStatus('Ready to fetch titles from your libraries.');
  } catch (error) {
    setStatus(error.message, true);
  }
}
resultModal.addEventListener('click', (event) => {
  if (event.target === resultModal) {
    hideResult();
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    hideResult();
  }
});

init();
