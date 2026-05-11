// tests/cli/dashboard/missing-package.test.ts
//
// Unit tests for the missing-package detector. The classifier MUST only return
// true when the missing specifier matches the package name exactly — transitive
// deps of the package should NOT cause us to instruct the user to install the
// outer package.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isMissingOptionalPackageError,
  extractMissingSpecifier,
  SUPABASE_INSTALL_HINT,
} from '../../../src/cli/dashboard/missing-package.ts';

function makeErr(message: string, code: 'ERR_MODULE_NOT_FOUND' | 'MODULE_NOT_FOUND' | string = 'ERR_MODULE_NOT_FOUND'): Error {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

describe('missing-package: isMissingOptionalPackageError', () => {
  it('MP1: ERR_MODULE_NOT_FOUND with matching specifier → true', () => {
    const err = makeErr(
      "Cannot find package '@supabase/supabase-js' imported from /tmp/x.js",
    );
    assert.equal(isMissingOptionalPackageError(err, '@supabase/supabase-js'), true);
  });

  it('MP2: ERR_MODULE_NOT_FOUND for a transitive dep → false', () => {
    // Supabase's transitive deps shouldn't trigger our install-hint for supabase.
    const err = makeErr(
      "Cannot find package '@supabase/postgrest-js' imported from /tmp/x.js",
    );
    assert.equal(
      isMissingOptionalPackageError(err, '@supabase/supabase-js'),
      false,
      'transitive miss must NOT falsely match the outer package',
    );
  });

  it('MP3: ERR_MODULE_NOT_FOUND with no extractable specifier → false', () => {
    const err = makeErr('Cannot find package — bad format');
    assert.equal(isMissingOptionalPackageError(err, '@supabase/supabase-js'), false);
  });

  it('MP4: non-MODULE_NOT_FOUND error → false', () => {
    const err = makeErr("Cannot find package '@supabase/supabase-js'", 'SOME_OTHER_CODE');
    assert.equal(isMissingOptionalPackageError(err, '@supabase/supabase-js'), false);
  });

  it('MP5: CJS-style "Cannot find module" with matching specifier → true', () => {
    const err = makeErr("Cannot find module '@supabase/supabase-js'", 'MODULE_NOT_FOUND');
    assert.equal(isMissingOptionalPackageError(err, '@supabase/supabase-js'), true);
  });

  it('MP6: non-Error input → false', () => {
    assert.equal(isMissingOptionalPackageError('string-not-error', '@supabase/supabase-js'), false);
    assert.equal(isMissingOptionalPackageError(undefined, '@supabase/supabase-js'), false);
    assert.equal(isMissingOptionalPackageError({}, '@supabase/supabase-js'), false);
  });
});

describe('missing-package: extractMissingSpecifier', () => {
  it('extracts ESM-style specifier', () => {
    assert.equal(
      extractMissingSpecifier("Cannot find package 'foo' imported from x"),
      'foo',
    );
  });
  it('extracts CJS-style specifier by default', () => {
    assert.equal(extractMissingSpecifier("Cannot find module 'bar'"), 'bar');
  });
  it('returns undefined when CJS form is disabled and message is CJS', () => {
    assert.equal(extractMissingSpecifier("Cannot find module 'bar'", false), undefined);
  });
});

describe('missing-package: SUPABASE_INSTALL_HINT', () => {
  it('contains the exact install command users will run', () => {
    assert.ok(SUPABASE_INSTALL_HINT.includes('npm install @supabase/supabase-js'));
  });
});
