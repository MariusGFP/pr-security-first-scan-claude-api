import './globals.css';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Claude Dashboard',
  description: 'Mac Mini M4 — Claude Automation Dashboard',
};

const navItems = [
  { href: '/', label: 'Dashboard', icon: '📊' },
  { href: '/repos', label: 'Repositories', icon: '📁' },
  { href: '/reviews', label: 'Reviews', icon: '🔍' },
  { href: '/security', label: 'Security Scan', icon: '🔒' },
  { href: '/logs', label: 'Logs', icon: '📋' },
  { href: '/settings', label: 'Settings', icon: '⚙️' },
  { href: '/updates', label: 'Updates', icon: '🔄' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body className="flex min-h-screen">
        {/* Sidebar */}
        <aside className="w-56 bg-[#0d0d0d] border-r border-[#262626] flex flex-col fixed h-full">
          <div className="p-4 border-b border-[#262626]">
            <h1 className="text-lg font-bold text-claude-400">Claude Dashboard</h1>
            <p className="text-xs text-[#666] mt-1">Mac Mini M4</p>
          </div>

          <nav className="flex-1 p-2">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-[#a0a0a0] hover:text-white hover:bg-[#1a1a1a] transition-colors"
              >
                <span>{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            ))}
          </nav>

          <div className="p-4 border-t border-[#262626]">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-xs text-[#666]">Server aktiv</span>
            </div>
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 ml-56 p-6">
          {children}
        </main>
      </body>
    </html>
  );
}
