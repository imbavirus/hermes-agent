import { describe, expect, it } from 'vitest'

import { preferTypedBundledPlugin } from './plugins'

describe('preferTypedBundledPlugin', () => {
  it('keeps plugin.tsx when a folder also ships plugin.js', () => {
    expect(
      preferTypedBundledPlugin([
        '../plugins/hermes-bots/plugin.js',
        '../plugins/hermes-bots/plugin.tsx',
        '../plugins/radio/plugin.js'
      ])
    ).toEqual(['../plugins/hermes-bots/plugin.tsx', '../plugins/radio/plugin.js'])
  })

  it('does not drop a js-only plugin', () => {
    expect(preferTypedBundledPlugin(['../plugins/radio/plugin.js'])).toEqual(['../plugins/radio/plugin.js'])
  })
})
