# Movie path data

The 41 titles follow [Hanzimatic's published path to Nirvana in Fire](https://hanzimatic.com/blog/posts/chinese-media-difficulty-and-learning-paths/).

Step 1 uses all 509 dialogue rows from the [Lazy Chinese episode deck](https://hanzimatic.com/decks/lazy-chinese-advanced-chinese-mother-daugher-relationships). The app ships a frequency table derived from those rows. Jieba segments the Chinese text into words. Counts include Han-script tokens and exclude punctuation, Latin text, and standalone numerals. Pinyin comes from the existing flashcard data or pypinyin, with manual corrections. English glosses use existing flashcards, manual glosses, and [CC-CEDICT](https://www.mdbg.net/chinese/dictionary?page=cc-cedict), which is licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The frequency table contains no transcript lines. Chinese word forms are stored as internal matching keys for the existing flashcards.

Coverage divides the count of mastered word occurrences by the total count. A mastered score in either meaning direction counts. Repeated words contribute each time they occur. Estimates may differ from Hanzimatic because the segmenter and learner profile differ.

Steps 2–4 use creator-provided Simplified Chinese captions. Each source starts near the beginning of its video, ends with the closing dialogue, and has consecutive cue numbers.

| Step | Source | Caption cues |
| --- | --- | ---: |
| 2 | [Lazy Chinese subtitle file](https://cdn.lazychinese.com/srt/ePPGcoepGGE.srt) | 414 |
| 3 | [Xiaogua Chinese episode and transcript](https://www.xiaoguachinese.com/watch?slug=you-met-me-at-a-very-chinese-time-in-my-life-upper-intermediate) | 493 |
| 4 | [Xiaogua Chinese episode and transcript](https://www.xiaoguachinese.com/watch?slug=sasas-vlog-finding-my-past-in-beijing-lower-intermediate) | 172 |

Repeated vocabulary across steps retains the same card ID, so review progress and manual marks carry forward. A few episode-specific names were kept together during segmentation. Generated pronunciations and glosses are provisional where words have multiple readings or senses.

The Reading view for steps 1–4 references existing vocabulary entries in subtitle order. It uses the same segmentation and counts as coverage, with non-Han punctuation and text retained for readability. Definitions and familiarity come from the movie vocabulary and local review profile.

Steps 5–7 also have Reading and vocabulary. Step 5 uses [Xiaogua Chinese’s transcript](https://www.xiaoguachinese.com/watch?slug=our-real-stories-we-were-not-treated-the-same-as-men-intermediate) (594 cues). Step 6 uses [Lazy Chinese’s captions](https://cdn.lazychinese.com/srt/vHh45E1FKXI.srt) (242 cues through the closing sign-off). Step 7 uses a [Simplified Chinese subtitle track](https://2.assrt.net/xml/sub/650/650355.xml) for the 2018 Mandarin release (1,388 cues). The source track can differ from subtitles served by a streaming provider.
