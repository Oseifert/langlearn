'use strict';

const MOVIE_DECK_ID = 'movie-vocabulary';
const MOVIE_READY = 90;
let moviePathPromise;

function loadMoviePath() {
  moviePathPromise ||= fetch('./movie-path.json').then(response => {
    if (!response.ok) throw new Error('Could not load the watchlist');
    return response.json();
  }).catch(error => {
    moviePathPromise = undefined;
    throw error;
  });
  return moviePathPromise;
}

async function seedMovieCards() {
  const path = await loadMoviePath();
  const words = new Map(path.flatMap(title => (title.words || []).map(word => [word.id, word])));
  if (!words.size) return;
  await DB.putDeck({ id: MOVIE_DECK_ID, title: 'Movie vocabulary' });
  await DB.addMissingCards([...words.values()].filter(word => word.meaning)
    .map(word => makeCardRecord({ ...word, front: word.pinyin }, MOVIE_DECK_ID)));
}

function moviePinyinKey(pinyin) {
  return (pinyin || '').normalize('NFC').toLowerCase().replace(/[\s'’·-]/g, '');
}

function movieVocabulary(cards, path) {
  const readings = new Map();
  const byHanzi = new Map();
  const byPinyin = new Map();
  for (const word of path.flatMap(title => title.words || [])) {
    const key = moviePinyinKey(word.pinyin);
    if (!readings.has(key)) readings.set(key, new Set());
    readings.get(key).add(word.hanzi);
  }
  for (const card of cards) {
    const hanzi = (card.hanzi || '').trim();
    const key = moviePinyinKey(card.pinyin || card.front);
    if (hanzi && key) {
      if (!readings.has(key)) readings.set(key, new Set());
      readings.get(key).add(hanzi);
    }
    const index = hanzi ? byHanzi : byPinyin;
    const identity = hanzi || key;
    if (!identity) continue;
    if (!index.has(identity)) index.set(identity, []);
    index.get(identity).push(card);
  }
  return word => {
    const key = moviePinyinKey(word.pinyin);
    const matches = [...(byHanzi.get(word.hanzi) || [])];
    if (readings.get(key)?.size === 1) matches.push(...(byPinyin.get(key) || []));
    const known = matches.some(card => isMastered(card.zhEnState || card.meaningState)
      || isMastered(card.enZhState || card.meaningState));
    const card = matches.find(card => card.deckId === MOVIE_DECK_ID && card.id === word.id);
    return { ...word, known, card };
  };
}

function movieCoverage(words) {
  const total = words.reduce((sum, word) => sum + word.count, 0);
  const known = words.reduce((sum, word) => sum + (word.known ? word.count : 0), 0);
  return total ? 100 * known / total : null;
}

function moviePercent(value) {
  return Math.floor(value * 10) / 10 + '%';
}

function renderMainTabs(view) {
  const isMovies = view === 'movies' || view === 'movie' || app.cur().params?.movie;
  const tabs = $('#mainTabs');
  tabs.hidden = view !== 'home' && !isMovies;
  for (const button of tabs.querySelectorAll('button')) {
    const current = isMovies ? button.dataset.view === 'movies' : button.dataset.view === 'home';
    button.setAttribute('aria-pressed', String(current));
  }
}

async function renderMovies(root, step) {
  $('#title').textContent = 'Movies';
  const frame = app.cur();
  let path, cards;
  try {
    [path, cards] = await Promise.all([loadMoviePath(), DB.allCards()]);
  } catch (error) {
    if (app.cur() === frame) root.append(el('p', { class: 'hint' }, 'Could not load the watchlist. Try again when online.'));
    return;
  }
  if (app.cur() !== frame) return;
  const resolveWord = movieVocabulary(cards, path);
  if (step) {
    const title = path.find(entry => entry.step === step);
    if (title) renderMovieDetail(root, title, resolveWord);
    return;
  }
  root.append(el('p', { class: 'hint' }, 'Follow the 41 steps to Nirvana in Fire. A title is ready at 90% estimated word coverage.'));
  const list = el('ol', { class: 'movie-list' });
  for (const title of path) {
    const coverage = movieCoverage((title.words || []).map(resolveWord));
    const status = coverage === null ? 'Coverage pending' : `${moviePercent(coverage)} known`;
    list.append(el('li', {},
      el('button', { class: 'deck movie-entry', type: 'button', onclick: () => app.go('movie', { step: title.step }) },
        el('span', { class: 'movie-step' }, title.step),
        el('span', {}, el('strong', {}, title.title),
          el('span', { class: 'sub' }, status, coverage >= MOVIE_READY ? ' · Ready to watch' : '')))));
  }
  root.append(list, movieLink('https://hanzimatic.com/blog/posts/chinese-media-difficulty-and-learning-paths/', 'Original learning path'));
}

function movieLink(url, label) {
  return el('a', { class: 'movie-link', href: url, target: '_blank', rel: 'noopener noreferrer' }, label);
}

function renderMovieDetail(root, title, resolveWord) {
  const words = (title.words || []).map(resolveWord);
  const coverage = movieCoverage(words);
  root.append(el('h2', { class: 'movie-title' }, title.title), el('p', { class: 'hint' }, `Step ${title.step} of 41`));
  if (title.video) root.append(movieLink(title.video, title.video.includes('youtube.com') ? 'Watch on YouTube' : 'Open episode'));
  if (coverage === null) {
    root.append(el('p', { class: 'hint' }, 'Coverage pending. Word counts are needed for this title.'));
    return;
  }
  const unknown = words.filter(word => !word.known);
  const study = unknown.filter(word => word.card);
  root.append(
    el('h3', {}, `${moviePercent(coverage)} known${coverage >= MOVIE_READY ? ' · Ready to watch' : ''}`),
    el('progress', { class: 'movie-progress', max: 100, value: coverage, 'aria-label': 'Estimated dialogue word coverage' }),
    el('p', { class: 'hint' }, `${words.length - unknown.length} of ${words.length} distinct words known. Coverage counts repeated words and uses mastery in either meaning direction.`));
  if (study.length) {
    const batch = study.slice(0, 20);
    root.append(el('button', { class: 'btn primary', type: 'button',
      onclick: () => app.go('practice', { movie: true, dir: 'zh2en', queue: batch.map(word => word.card) }) },
    `Study ${batch.length} unfamiliar words`));
  }
  const controls = el('div', { class: 'movie-filters' });
  const list = el('ul', { class: 'movie-list' });
  const filters = [
    ['All', words],
    ['To study', unknown],
    ['Known', words.filter(word => word.known)],
  ];
  for (const [label, items] of filters) {
    const button = el('button', { class: 'btn ghost', type: 'button', onclick: () => show(button, items) }, label);
    controls.append(button);
  }
  function show(button, items) {
    for (const control of controls.children) control.setAttribute('aria-pressed', String(control === button));
    const rows = items.map(word => {
      const detail = el('span', {},
        el('strong', {}, word.pinyin),
        el('span', { class: 'sub' }, word.meaning || 'Definition pending'));
      const status = el('span', { class: word.known ? 'movie-known' : 'movie-status' },
        `${word.known ? 'Known' : 'To study'} · ${word.count}×`);
      const studyable = !word.known && word.card;
      return el('li', {}, studyable
        ? el('button', { class: 'movie-word', type: 'button',
          onclick: () => app.go('practice', { movie: true, dir: 'zh2en', queue: [word.card] }) }, detail, status)
        : el('div', { class: 'movie-word' }, detail, status));
    });
    list.replaceChildren(...(rows.length ? rows : [el('li', { class: 'hint' }, 'No words in this view.')]));
  }
  root.append(controls, list, movieLink(title.transcriptSource, 'Vocabulary source'));
  show(controls.firstElementChild, words);
}

for (const button of document.querySelectorAll('#mainTabs button')) {
  button.addEventListener('click', () => {
    if (app.cur().view === button.dataset.view) return;
    app.stack = [{ view: button.dataset.view }];
    render();
  });
}
