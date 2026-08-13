import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ModuleComputerIllustration } from '../ModuleComputerIllustration'

describe('ModuleComputerIllustration', () => {
  it('renders the unbranded Mac and 4G module illustration', () => {
    const markup = renderToStaticMarkup(<ModuleComputerIllustration />)

    expect(markup).toContain('aria-label="Mac 通过 Type-C 连接 4G 模块"')
    expect(markup.match(/data-signal-bar="true"/g)).toHaveLength(3)
    expect(markup.match(/data-status-light="true"/g)).toHaveLength(1)
    expect(markup).toContain('data-type-c-connector="true"')
    expect(markup).toContain('data-mac-base="true"')
    expect(markup).not.toContain('<text')
    expect(markup).not.toMatch(/DJI|DIV/)
  })
})
