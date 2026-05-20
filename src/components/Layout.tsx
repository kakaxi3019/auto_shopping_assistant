import type { ReactNode } from 'react'

type Page = 'shopping' | 'scheduled' | 'orders' | 'account' | 'settings'

interface LayoutProps {
  children: ReactNode
  currentPage: Page
  onNavigate: (page: Page) => void
}

const navItems: { key: Page; label: string; icon: string }[] = [
  { key: 'shopping', label: '智能购物', icon: '🛒' },
  { key: 'scheduled', label: '定时任务', icon: '⏰' },
  { key: 'orders', label: '历史订单', icon: '📦' },
  { key: 'account', label: '平台账号管理', icon: '👤' },
  { key: 'settings', label: '设置', icon: '⚙️' },
]

export default function Layout({ children, currentPage, onNavigate }: LayoutProps) {
  return (
    <div className="flex h-screen bg-gray-50">
      <aside className="w-56 bg-white border-r border-gray-100 flex flex-col">
        <div className="px-6 py-5 border-b border-gray-100">
          <h1 className="text-lg font-bold text-gray-800">🛍️ 购物助手</h1>
          <p className="text-sm text-gray-400 mt-0.5">说一声，帮你买</p>
        </div>
        <nav aria-label="主导航" className="flex-1 px-3 py-4 space-y-1">
          {navItems.map((item) => (
            <button
              key={item.key}
              onClick={() => onNavigate(item.key)}
              aria-current={currentPage === item.key ? 'page' : undefined}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                currentPage === item.key
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              }`}
            >
              <span className="text-base" aria-hidden="true">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="px-4 py-3 border-t border-gray-100">
          <p className="text-sm text-gray-400">v0.2.0</p>
        </div>
      </aside>

      <main className="flex-1 overflow-auto p-6">{children}</main>
    </div>
  )
}
