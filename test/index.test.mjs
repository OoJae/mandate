import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as core from '../src/index.mjs'
import { checkSpokenScope, consentScript, matchScript } from '../src/scope.mjs'
import { mandateHome, ConfigError } from '../src/state-store.mjs'

// Its own small file: importing the package root reaches every core module, and
// the mutation check runs each test file that can reach a mutated module.
test('the package root exports the consent script and its matcher with the scope check', () => {
  assert.equal(core.checkSpokenScope, checkSpokenScope)
  assert.equal(core.consentScript, consentScript)
  assert.equal(core.matchScript, matchScript)
})

test('the package root exports the Mandate home resolver and its ConfigError, so a harness resolves the same home as the CLI', () => {
  assert.equal(core.mandateHome, mandateHome)
  assert.equal(core.ConfigError, ConfigError)
})
