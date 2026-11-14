import { forwardRef } from 'react'
import { Link, Outlet } from '@tanstack/react-router'
import { Sidebar } from '@cloudflare/kumo/components/sidebar'
import { Toasty } from '@cloudflare/kumo/components/toast'
import { type LinkComponentProps, LinkProvider } from '@cloudflare/kumo/utils'
import { SessionRegistryProvider } from '~/hooks/use-session-registry'
import { useKeyboardAwareHeight } from '~/hooks/use-keyboard-aware-height'
import { SessionSidebar } from './session-sidebar'

/**
 * Kumo's links, the sidebar's included, navigate through the router. The
 * router takes a query as `search`, not as part of `to`, so it is split off.
 * Only an exact match counts as current: otherwise the router marks `/team`
 * current on `/team?ticket=T-1` too, overriding the sidebar's own marking.
 */
const RouterLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(({ href, ...props }, ref) => {
  const [to = '/', query] = (href ?? '/').split('?', 2)

  return <Link ref={ref} activeOptions={{ exact: true }} {...props} to={to} search={query ? Object.fromEntries(new URLSearchParams(query)) : undefined} />
})

RouterLink.displayName = 'RouterLink'

/** Every page: the sessions sidebar beside the routed page. */
export function AppShell() {
  // The shell renders the height this hook tracks, so the composer stays above iOS's keyboard.
  useKeyboardAwareHeight()

  return (
    <LinkProvider component={RouterLink}>
      <Toasty>
        <SessionRegistryProvider>
          {/* A fixed height lets the sidebar fill it; each page scrolls inside. */}
          <Sidebar.Provider collapsible="offcanvas" className="h-[var(--app-height,100dvh)] overflow-hidden">
            <SessionSidebar />
            <div className="flex h-[var(--app-height,100dvh)] min-w-0 flex-1 flex-col">
              <Outlet />
            </div>
          </Sidebar.Provider>
        </SessionRegistryProvider>
      </Toasty>
    </LinkProvider>
  )
}
