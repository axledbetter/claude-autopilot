// src/core/migrate/detector.ts
//
// Runs detection rules against a project root. Returns ALL matching
// rules with their confidence. The init flow uses this:
//   - 1 high-confidence match → auto-select, write stack.md
//   - >1 match OR any non-high → prompt user
//   - 0 matches → fail closed (require --skip-migrate)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DETECTION_RULES, type DetectionRule, type Confidence } from './detector-rules.ts';

export interface DetectionMatch {
  rule: DetectionRule;
  /** Same as rule.confidence — surfaced for the UI's convenience. */
  confidence: Confidence;
}

export interface DetectionOutput {
  matches: DetectionMatch[];
  /** True when we have a single high-confidence match the caller can
   *  auto-select. False when caller should prompt the user. */
  autoSelect: boolean;
  /** True when caller should prompt the user (>1 match, or any non-high). */
  prompt: boolean;
}

function entryExists(projectRoot: string, rel: string): boolean {
  try {
    fs.statSync(path.join(projectRoot, rel));
    return true;
  } catch {
    return false;
  }
}

function fileMatches(projectRoot: string, rel: string, pattern: RegExp): boolean {
  try {
    const content = fs.readFileSync(path.join(projectRoot, rel), 'utf8');
    return pattern.test(content);
  } catch {
    return false;
  }
}

function matchesGlob(projectRoot: string, glob: string): boolean {
  // Handle simple patterns: '*/migrations/0001_*.py'
  // We do depth-2 directory walk for simplicity.
  const parts = glob.split('/');
  if (parts.length < 2) return false;
  const firstStar = parts[0] === '*';
  if (!firstStar) {
    // No leading wildcard; fall back to direct existence
    return entryExists(projectRoot, glob);
  }
  // Depth-1 dirs under projectRoot, then check the rest
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(projectRoot, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return false;
  }
  const remaining = parts.slice(1);
  for (const dir of dirs) {
    const subPath = path.join(projectRoot, dir, ...remaining.slice(0, -1));
    const lastPart = remaining[remaining.length - 1]!;
    // last part may be a glob like 0001_*.py
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(subPath);
    } catch {
      continue;
    }
    const lastRegex = new RegExp('^' + lastPart.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
    if (entries.some(e => lastRegex.test(e))) return true;
  }
  return false;
}

function ruleApplies(rule: DetectionRule, projectRoot: string): boolean {
  for (const r of rule.requireAll) {
    if (!entryExists(projectRoot, r)) return false;
  }
  if (rule.requireAny && rule.requireAny.length > 0) {
    if (!rule.requireAny.some(r => entryExists(projectRoot, r))) return false;
  }
  if (rule.requireGlob && rule.requireGlob.length > 0) {
    if (!rule.requireGlob.every(g => matchesGlob(projectRoot, g))) return false;
  }
  if (rule.contentMatches) {
    if (!fileMatches(projectRoot, rule.contentMatches.file, rule.contentMatches.pattern)) return false;
  }
  if (rule.excludeIf) {
    for (const ex of rule.excludeIf) {
      if (entryExists(projectRoot, ex)) return false;
    }
  }
  return true;
}

export function detect(projectRoot: string): DetectionOutput {
  const matches: DetectionMatch[] = [];
  for (const rule of DETECTION_RULES) {
    if (ruleApplies(rule, projectRoot)) {
      matches.push({ rule, confidence: rule.confidence });
    }
  }
  const highMatches = matches.filter(m => m.confidence === 'high');
  const autoSelect = matches.length === 1 && highMatches.length === 1;
  const prompt = matches.length > 0 && !autoSelect;
  return { matches, autoSelect, prompt };
}
