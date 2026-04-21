import { makeDeclarativeParser } from './declarative-base.ts';

export const cursorAdapter = makeDeclarativeParser({
  name: 'cursor',
  author: 'cursor[bot]',
  severityMap: {
    critical: /\bhigh\b|\bcritical\b/i,
    warning: /\bmedium\b|\bwarning\b/i,
  },
  dismissalKeywords: ['false positive', 'not an issue', 'intentional', 'wontfix'],
});

export default cursorAdapter;
