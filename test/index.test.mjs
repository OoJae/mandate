import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as core from '../src/index.mjs'
import { checkSpokenScope, consentScript, matchScript } from '../src/scope.mjs'

// Its own small file: importing the package root reaches every core module, and
// the mutation check runs each test file that can reach a mutated module.
test('the package root exports the consent script and its matcher with the scope check', () => {
  assert.equal(core.checkSpokenScope, checkSpokenScope)
  assert.equal(core.consentScript, consentScript)
  assert.equal(core.matchScript, matchScript)
})
