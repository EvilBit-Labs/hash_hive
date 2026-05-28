import { Menu } from 'lucide-react'
import { Outlet } from 'react-router'

import logoSvg from '../../assets/logo.svg'
import { useUiStore } from '../../stores/ui'
import { ConnectionIndicator } from './connection-indicator'
import { EventsProvider } from './events-provider'
import { MobileSidebar, Sidebar } from './sidebar'

export function AppLayout() {
  const setMobileSidebar = useUiStore((s) => s.setMobileSidebar)

  return (
    <EventsProvider>
      <div className="bg-background flex h-screen">
        {/* Desktop sidebar - hidden below md */}
        <Sidebar />

        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Mobile header - visible below md */}
          <header className="border-surface-0/50 bg-mantle flex items-center gap-3 border-b px-4 py-3 md:hidden">
            <button
              type="button"
              aria-label="Open navigation menu"
              className="text-muted-foreground hover:bg-surface-0/60 hover:text-foreground flex h-9 w-9 items-center justify-center rounded transition-colors"
              onClick={() => setMobileSidebar(true)}
            >
              <Menu className="h-4 w-4" aria-hidden="true" />
            </button>
            <img src={logoSvg} alt="" className="h-6 w-6" />
            <span className="text-foreground text-sm font-semibold tracking-tight">HashHive</span>
            <div className="ml-auto">
              <ConnectionIndicator />
            </div>
          </header>

          <main className="flex-1 overflow-auto px-4 py-4 sm:px-6 sm:py-5 lg:px-8 lg:py-6">
            <Outlet />
          </main>
        </div>

        {/* Mobile sidebar drawer */}
        <MobileSidebar />
      </div>
    </EventsProvider>
  )
}
