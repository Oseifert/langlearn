'use strict';

const MOVIE_DECK_ID = 'movie-vocabulary';
const MOVIE_READY = 90;
let moviePathPromise;

function loadMoviePath() {
  moviePathPromise ||= fetch('./movie-path.json?v=99', { cache: 'no-cache' }).then(response => {
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
    const mastered = matches.some(card => isMastered(card.zhEnState || card.meaningState)
      || isMastered(card.enZhState || card.meaningState));
    const card = matches.find(card => card.deckId === MOVIE_DECK_ID && card.id === word.id);
    return { ...word, mastered, known: card?.movieKnowledge?.known ?? mastered, card };
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
  if (title.reading) {
    const vocabulary = el('section');
    const reading = el('section', { hidden: '' });
    const switcher = el('div', { class: 'movie-filters', role: 'group', 'aria-label': 'Movie view' });
    const vocabularyButton = el('button', { class: 'btn ghost', type: 'button', 'aria-pressed': 'true',
      onclick: () => selectView(false) }, 'Vocabulary');
    const readingButton = el('button', { class: 'btn ghost', type: 'button', 'aria-pressed': 'false',
      onclick: () => selectView(true) }, 'Reading');
    let reader;
    function selectView(showReading) {
      if (!showReading) reading.querySelector(':popover-open')?.hidePopover();
      reading.hidden = !showReading;
      vocabulary.hidden = showReading;
      vocabularyButton.setAttribute('aria-pressed', String(!showReading));
      readingButton.setAttribute('aria-pressed', String(showReading));
      if (showReading && !reader) reader = renderMovieReading(reading, title, words);
    }
    switcher.append(vocabularyButton, readingButton);
    root.append(switcher, vocabulary, reading);
    root = vocabulary;
  }
  const summary = el('div', { 'aria-live': 'polite' });
  const batchButton = el('button', { class: 'btn primary', type: 'button', onclick: () => {
    const batch = words.filter(word => !word.known && word.card).slice(0, 20);
    if (batch.length) startStudy(batch);
  } });
  const controls = el('div', { class: 'movie-filters' });
  const list = el('ul', { class: 'movie-list' });
  const undo = el('button', { class: 'movie-undo', type: 'button', disabled: '' }, 'Undo last mark');
  let filter = 'All';
  let lastMark;
  let saving = false;
  for (const label of ['All', 'To study', 'Known']) {
    const button = el('button', { class: 'btn ghost', type: 'button', onclick: () => {
      filter = label;
      show();
    } }, label);
    controls.append(button);
  }
  undo.addEventListener('click', async () => {
    if (lastMark && !saving && await setKnowledge(lastMark.word, lastMark.previous)) lastMark = undefined;
    undo.disabled = !lastMark;
  });

  function startStudy(items) {
    if (!saving) app.go('practice', { movie: true, dir: 'zh2en', queue: items.map(word => word.card) });
  }

  async function setKnowledge(word, known) {
    if (saving || !word.card) return false;
    saving = true;
    const movieKnowledge = { known, updatedAt: Math.max(now(), (word.card.movieKnowledge?.updatedAt || 0) + 1) };
    try {
      const card = { ...word.card, movieKnowledge };
      await DB.putCard(card);
      word.card = card;
      word.known = known ?? word.mastered;
      if (window.YukaSync) YukaSync.scheduleBackup();
      show(word.id);
      return true;
    } catch (error) {
      console.error(error);
      toast('Could not save word status.');
      return false;
    } finally {
      saving = false;
    }
  }

  async function mark(word, known) {
    if (word.known === known) return;
    const previous = word.card?.movieKnowledge?.known ?? null;
    if (await setKnowledge(word, known)) {
      lastMark = { word, previous };
      undo.disabled = false;
    }
  }

  function wordRow(word) {
    const detail = el('span', {}, el('strong', {}, word.pinyin),
      el('span', { class: 'sub' }, word.meaning || 'Definition pending'));
    const status = el('span', { class: word.known ? 'movie-known' : 'movie-status' },
      `${word.known ? 'Known' : 'To study'} · ${word.count}×`);
    const content = !word.known && word.card
      ? el('button', { class: 'movie-word-content', type: 'button', onclick: () => startStudy([word]) }, detail, status)
      : el('div', { class: 'movie-word-content' }, detail, status);
    const action = word.card && el('button', { class: 'movie-mark', type: 'button', 'data-word': word.id,
      'aria-label': `Mark ${word.pinyin} as ${word.known ? 'unfamiliar' : 'known'}`,
      onclick: () => mark(word, !word.known) }, word.known ? 'Mark unfamiliar' : 'Mark known');
    const row = el('li', { class: 'movie-word' }, content, action || null);
    if (word.card) {
      let start;
      row.addEventListener('pointerdown', event => {
        if (event.pointerType !== 'mouse' && !event.target.closest('.movie-mark')) {
          start = { id: event.pointerId, x: event.clientX, y: event.clientY };
        }
      });
      row.addEventListener('pointercancel', () => { start = undefined; });
      row.addEventListener('pointerup', event => {
        if (start?.id !== event.pointerId) return;
        const horizontal = event.clientX - start.x;
        const vertical = event.clientY - start.y;
        start = undefined;
        if (Math.abs(horizontal) < 55 || Math.abs(horizontal) < 1.5 * Math.abs(vertical)) return;
        row.addEventListener('click', click => click.stopImmediatePropagation(), { capture: true, once: true });
        mark(word, horizontal > 0);
      });
    }
    return row;
  }

  function show(focusId) {
    const coverage = movieCoverage(words);
    const unknown = words.filter(word => !word.known);
    const count = Math.min(20, unknown.filter(word => word.card).length);
    summary.replaceChildren(
      el('h3', {}, `${moviePercent(coverage)} known${coverage >= MOVIE_READY ? ' · Ready to watch' : ''}`),
      el('progress', { class: 'movie-progress', max: 100, value: coverage, 'aria-label': 'Estimated dialogue word coverage' }),
      el('p', { class: 'hint' }, `${words.length - unknown.length} of ${words.length} distinct words known. Coverage counts repeated words.`));
    batchButton.hidden = !count;
    batchButton.textContent = `Study ${count} unfamiliar words`;
    for (const control of controls.children) control.setAttribute('aria-pressed', String(control.textContent === filter));
    const items = filter === 'All' ? words : filter === 'Known' ? words.filter(word => word.known) : unknown;
    const focused = focusId && document.activeElement?.dataset.word === focusId;
    list.replaceChildren(...(items.length ? items.map(wordRow) : [el('li', { class: 'hint' }, 'No words in this view.')]));
    if (focused) list.querySelector(`[data-word="${focusId}"]`)?.focus({ preventScroll: true });
  }

  root.append(summary, batchButton, controls,
    el('div', { class: 'movie-mark-help' }, el('p', { class: 'hint' }, 'Swipe right for known, left for unfamiliar, or tap a mark button.'), undo),
    list, movieLink(title.transcriptSource, 'Vocabulary source'));
  show();
}

async function renderMovieReading(root, title, words) {
  root.replaceChildren(el('p', { class: 'hint', role: 'status' }, 'Loading transcript…'));
  let data;
  try {
    const response = await fetch(`./reading/${title.step}.json?v=99`, { cache: 'no-cache' });
    if (!response.ok) throw new Error('Transcript unavailable');
    data = await response.json();
  } catch (error) {
    root.replaceChildren(
      el('p', { class: 'hint', role: 'status' }, 'Could not load the transcript.'),
      el('button', { class: 'btn', type: 'button', onclick: () => renderMovieReading(root, title, words) }, 'Try again'));
    return;
  }

  const vocabulary = new Map(words.map(word => [word.id, word]));
  const byIndex = data.wordIds.map(id => vocabulary.get(id));
  const linesPerPage = 24;
  const pageCount = Math.ceil(data.lines.length / linesPerPage);
  let page = 0;
  const heading = el('h3', { tabindex: '-1' }, 'Pinyin transcript');
  const passage = el('div', { class: 'reading-passage' });
  const top = el('nav', { class: 'reading-pages', 'aria-label': 'Transcript pages' });
  const bottom = el('nav', { class: 'reading-pages', 'aria-label': 'Transcript pages' });
  const definition = el('div', { class: 'reading-definition', popover: 'auto', role: 'status' });
  function showDefinition(button, word) {
    if (definition.matches(':popover-open')) definition.hidePopover();
    definition.replaceChildren(
      el('div', {}, el('strong', { lang: 'zh-Latn' }, word.pinyin), el('div', {}, word.meaning || 'Definition unavailable')),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close definition',
        onclick: () => definition.hidePopover() }, '×'));
    definition.showPopover();
    const anchor = button.getBoundingClientRect();
    const box = definition.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, document.documentElement.clientWidth - box.width - 8));
    const top = anchor.bottom + box.height + 16 < window.innerHeight
      ? anchor.bottom + 6 : Math.max(8, anchor.top - box.height - 6);
    definition.style.left = `${left}px`;
    definition.style.top = `${top}px`;
  }

  function show(next, moveFocus = false) {
    page = next;
    if (definition.matches(':popover-open')) definition.hidePopover();
    for (const controls of [top, bottom]) {
      controls.replaceChildren(
        el('button', { class: 'btn ghost', type: 'button', disabled: page === 0 ? '' : null,
          onclick: () => show(page - 1, true) }, 'Previous'),
        el('span', { role: 'status' }, `Page ${page + 1} of ${pageCount}`),
        el('button', { class: 'btn ghost', type: 'button', disabled: page + 1 >= pageCount ? '' : null,
          onclick: () => show(page + 1, true) }, 'Next'));
    }
    const start = page * linesPerPage;
    passage.replaceChildren(...data.lines.slice(start, start + linesPerPage).map(tokens => {
      const line = el('p', { lang: 'zh-Latn' });
      for (const token of tokens) {
        if (typeof token === 'string') {
          line.append(token, ' ');
          continue;
        }
        const word = byIndex[token];
        if (!word) continue;
        const button = el('button', { class: word.known ? 'reading-word' : 'reading-word unfamiliar',
          type: 'button', onclick: () => showDefinition(button, word) }, word.pinyin);
        line.append(button, ' ');
      }
      return line;
    }));
    if (moveFocus) {
      heading.focus({ preventScroll: true });
      heading.scrollIntoView({ block: 'start' });
    }
  }
  root.replaceChildren(heading, el('p', { class: 'hint' }, 'Highlighted words are unfamiliar. Tap any word for its meaning.'),
    top, passage, bottom, definition, movieLink(title.transcriptSource, 'Transcript source'));
  show(0);
}

for (const button of document.querySelectorAll('#mainTabs button')) {
  button.addEventListener('click', () => {
    if (app.cur().view === button.dataset.view) return;
    app.stack = [{ view: button.dataset.view }];
    render();
  });
}
