#!/usr/bin/env tsx
/**
 * Default affected-tests runner — runs the full test suite.
 *
 * Replace this with smarter affected-tests logic for your stack.
 * For example, with Jest you can use --findRelatedTests to scope to
 * files touched on the branch:
 *
 *   const { execFileSync } = require('child_process');
 *   const { getTouchedFiles, resolveMergeBase } = require('./validate/git-utils');
 *   const base = resolveMergeBase();
 *   const files = getTouchedFiles(base);
 *   execFileSync('npx', ['jest', '--findRelatedTests', ...files, '--passWithNoTests'], { stdio: 'inherit' });
 *
 * The --branch flag is passed by phase4-tests.ts but ignored here by default.
 */
import { execFileSync } from 'child_process';

execFileSync('npm', ['test', '--', '--passWithNoTests'], { stdio: 'inherit' });
