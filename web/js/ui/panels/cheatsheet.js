// The script syntax cheat sheet. Two kinds of thing are kept visibly apart:
//   SYNTAX       goes inside a line of text (a marker, a time, a {tag} on a word)
//   INSTRUCTION  is a line of its own that starts with :: or @ and changes a whole scene (or the whole script)
// Every example is a button: click it to copy. "Add to script" appends a ready-made sample.

import { h, icon } from '../dom.js';
import { FX_NAMES, DECO_NAMES } from '../../kinetic.js';

const SYNTAX = 'syntax';
const INSTR = 'instruction';

// [kind, what you type, what it does]
const SECTIONS = [
  { title: 'Every line', note: 'A line is  [time] marker text {tags}  and the time and marker can come in either order.', rows: [
    [SYNTAX, '[0:12.5] Hello world', 'Show this line from 0:12.5'],
    [SYNTAX, '[0:12.5-0:15] Hello world', 'Show it from 0:12.5 until 0:15, then fade it out'],
    [SYNTAX, '# Big title', 'Title (largest text)'],
    [SYNTAX, '## Smaller heading', 'Sub-heading'],
    [SYNTAX, '- A bullet point', 'Bullet (1. 2. also work)'],
    [SYNTAX, '> A quote', 'Quote, with  -- Author  on the next line'],
    [SYNTAX, '(quietly)', 'Text in brackets is shown small and dim'],
  ] },
  { title: 'Scenes', note: 'A scene is one screen of text. Each scene keeps its own time and fades out by itself, so text never pops away when the next scene starts.', rows: [
    [SYNTAX, '(blank line)', 'Starts a new scene. This is the usual way to separate stanzas'],
    [SYNTAX, '---', 'Also starts a new scene (handy when you want to be explicit)'],
    [SYNTAX, '+++', 'Keep the same scene across a blank line: put it on its own line next to the blank line'],
    [SYNTAX, '# Heading', 'An untimed # also starts a new scene (outlines only)'],
  ] },
  { title: 'Words', note: 'Put these on single words, or wrap several words in [ ].', rows: [
    [SYNTAX, '**word**', 'Emphasise a word (CAPS and numbers are picked up automatically)'],
    [SYNTAX, '<b>bold</b>  <i>italic</i>', 'Bold / italic (looks only, no highlight)'],
    [SYNTAX, '<u>underline</u>  <s>strike</s>', 'Underline / strike-through'],
    [SYNTAX, 'word{big}  word{small}', 'Bigger or smaller word'],
    [SYNTAX, 'word{color=#ff3d71}', 'Colour one word (accent, dim, fg also work)'],
    [SYNTAX, '[two words]{size=1.6 color=accent}', 'Apply tags to a group of words'],
    [SYNTAX, 'word{delay=.4}', 'Make that word arrive 0.4 s later'],
    [SYNTAX, 'word{motion=pop}', 'How that word arrives: pop rise drop slideL slideR zoom flip tilt fade type spin stretch swing bounce'],
    [SYNTAX, 'col|laps|ing', 'Syllables appear one by one (col|laps~.6|ing = pause 0.6 s,  col^1.6|laps = bigger syllable)'],
  ] },
  { title: 'Word effects (keep moving)', note: 'Add one or several to a word, a line, or a whole scene. Combine with +.  Tune with amp (strength, 1 = normal) and speed.', rows: [
    [SYNTAX, 'word{shake}', 'Quick random jitter'],
    [SYNTAX, 'word{fx=bounce+rainbow}', 'Several effects at once'],
    [SYNTAX, 'word{fx=wave amp=2 speed=1.5}', 'Stronger and faster'],
    [SYNTAX, '[whole line of words]{wave}', 'Same effect on every word in the brackets'],
    [SYNTAX, 'A line of text {wave}', 'Tags at the end of a line apply to the whole line'],
    [INSTR, '::fx wave', 'Every word in this scene waves (::amp 1.5  ::speed 2 tune it)'],
    [INSTR, '@fx breathe', 'Every word in the whole script (put at the top)'],
    [SYNTAX, 'word{fx=none}', 'Switch effects off for one word'],
  ], chips: [['Effects', FX_NAMES.map((n) => `{${n}}`)]] },
  { title: 'Decorations (off by default)', note: 'Lines, frames and highlights drawn around a scene’s text. Nothing is drawn unless you ask.', rows: [
    [INSTR, '::deco bar', 'A line beside the text'],
    [INSTR, '::deco underline+brackets', 'Combine with +'],
    [INSTR, '::deco box color=#ffcc00 w=2', 'Set the colour and thickness (w = 0.3 to 6)'],
    [INSTR, '::deco none', 'Remove it from this scene'],
    [INSTR, '@deco rules', 'Every scene (put at the top). Also set in Look → Text → Decoration'],
  ], chips: [['Decorations', DECO_NAMES]] },
  { title: 'Scene instructions', note: 'Each goes on its own line inside the scene, before or after its text.', rows: [
    [INSTR, '::dur 4', 'Scene length in seconds'],
    [INSTR, '::out 0.6', 'How long its text takes to fade out (default 0.35,  ::out cut = no fade)'],
    [INSTR, '::trans push', 'How the next scene comes in: cut fade push zoom wipe bars cover slices'],
    [INSTR, '::layout stack', 'center left stack bigword diagonal split list quote stat'],
    [INSTR, '::reveal word', 'auto, word (one by one across the line) or line (all at once)'],
    [INSTR, '::emph color', 'How the key word is highlighted: color, bar or none'],
    [INSTR, '::style retro', 'Use another look for this scene'],
    [INSTR, '::bg #123456', 'Scene background'],
  ] },
  { title: 'Placement', note: 'A 3 × 3 board: columns A B C, rows 1 2 3.', rows: [
    [INSTR, '::at B2', 'Put the scene in that cell (A1-B2 spans cells; left, top-right, lower-third also work)'],
    [INSTR, '::align left', 'left, center or right'],
    [SYNTAX, 'A line {at=C3}', 'Send one line to a spot'],
    [SYNTAX, 'word{at=A1 size=1.6}', 'Send one word to a spot'],
  ] },
  { title: 'Whole script', note: 'At the very top, one per line.', rows: [
    [INSTR, '@pack punchy', 'Overall look (punchy, smooth, retro …)'],
    [INSTR, '@energy 0.7', 'Calm (0) to punchy (1)'],
    [INSTR, '@seed 7', 'A different random arrangement'],
  ] },
];

const EXAMPLE = `@deco none

[0:01] # Fast & loud
[0:02] **BOUNCE**{bounce} and shake{shake}
::layout stack
---
[0:06-0:10] This line has {wave} every word
::deco underline color=accent
---
[0:11] a quiet one{breathe}
::out 1`;

async function copy(text, toast) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: '0' } }); document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ } ta.remove();
  }
  toast?.('Copied', 1400);
}

export function cheatSheet({ toast, insert }) {
  const snippet = (code) => h('button.cs-code', { type: 'button', title: 'Click to copy', 'aria-label': `Copy: ${code}`, onclick: () => copy(code, toast) }, h('code', code), icon('content_copy'));
  const section = (sec) => h('section.cs-sec',
    h('h4', sec.title), sec.note ? h('p.cs-note', sec.note) : null,
    h('div.cs-rows', sec.rows.map(([kind, code, what]) => h('div.cs-row', { class: kind },
      h('span.cs-kind', { title: kind === SYNTAX ? 'Goes inside a line of text' : 'A line of its own that starts with :: or @' }, kind === SYNTAX ? 'Syntax' : 'Instruction'),
      snippet(code), h('span.cs-what', what)))),
    ...(sec.chips ?? []).map(([label, items]) => h('div.cs-chips', h('span.cs-chip-label', `${label} (click to copy)`), ...items.map((n) => h('button.cs-chip', { type: 'button', onclick: () => copy(n, toast) }, n)))));
  const everything = () => SECTIONS.map((s) => `${s.title.toUpperCase()}\n${s.rows.map(([k, c, w]) => `  ${c}    — ${w}${k === INSTR ? '  [instruction]' : ''}`).join('\n')}`).join('\n\n');
  return h('details.script-help', h('summary', 'Syntax cheat sheet'),
    h('div.cs',
      h('div.cs-legend', h('span.cs-kind.syntax', 'Syntax'), ' goes inside a line of your text.  ', h('span.cs-kind.instruction', 'Instruction'), ' is a line of its own starting with ', h('code', '::'), ' (this scene) or ', h('code', '@'), ' (whole script).'),
      h('div.row',
        h('button.btn.tonal', { type: 'button', onclick: () => copy(EXAMPLE, toast) }, icon('content_copy'), 'Copy example'),
        insert ? h('button.btn.text', { type: 'button', onclick: () => insert(EXAMPLE) }, icon('add'), 'Add example to script') : null,
        h('button.btn.text', { type: 'button', onclick: () => copy(everything(), toast) }, icon('content_copy'), 'Copy this sheet')),
      ...SECTIONS.map(section)));
}
