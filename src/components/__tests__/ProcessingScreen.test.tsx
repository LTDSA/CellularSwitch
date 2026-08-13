import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProcessingScreen } from '../ProcessingScreen'

describe('ProcessingScreen', () => {
  it('announces progress changes without exposing the decorative spinner', () => {
    const markup = renderToStaticMarkup(
      <ProcessingScreen operation="modify" step="waiting-reboot" />,
    )

    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-live="polite"')
    expect(markup).toContain('aria-atomic="true"')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('正在等待模块重启')
  })
})
