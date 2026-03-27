import { Menu } from 'lucide-react';
import { Outlet } from 'react-router';
import logoSvg from '../../assets/logo.svg';
import { useUiStore } from '../../stores/ui';
import { MobileSidebar, Sidebar } from './sidebar';

export function AppLayout() {
  const { setMobileSidebar } = useUiStore();

  return (
    <div className="flex h-screen bg-background">
      {/* Desktop sidebar - hidden below md */}
      <Sidebar />

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile header - visible below md */}
        <header className="flex items-center gap-3 border-b border-surface-0/50 bg-mantle px-4 py-3 md:hidden">
          <button
            type="button"
            aria-label="Open navigation menu"
            className="flex h-9 w-9 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-surface-0/60 hover:text-foreground"
            onClick={() => setMobileSidebar(true)}
          >
            <Menu className="h-4 w-4" aria-hidden="true" />
          </button>
          <img src={logoSvg} alt="" className="h-6 w-6" />
          <span className="text-sm font-semibold tracking-tight text-foreground">HashHive</span>
        </header>

        <main className="flex-1 overflow-auto px-4 py-4 sm:px-6 sm:py-5 lg:px-8 lg:py-6">
          <Outlet />
        </main>
      </div>

      {/* Mobile sidebar drawer */}
      <MobileSidebar />
    </div>
  );
}
