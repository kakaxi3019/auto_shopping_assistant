import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import { PLATFORM_CONFIGS, getPlatformConfig, type PlatformConfig } from '@shared/platforms'
import PlatformLogo from './PlatformLogo'

interface SyncStatusData {
  platform: string
  status: string
  error?: string
}

function formatTime(isoStr: string | null): string {
  if (!isoStr) return ''
  try {
    const d = new Date(isoStr)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 1) return '刚刚'
    if (diffMin < 60) return `${diffMin} 分钟前`
    const diffHour = Math.floor(diffMin / 60)
    if (diffHour < 24) return `${diffHour} 小时前`
    const diffDay = Math.floor(diffHour / 24)
    if (diffDay < 30) return `${diffDay} 天前`
    return d.toLocaleDateString('zh-CN')
  } catch {
    return isoStr
  }
}

const SYNC_STEPS = [
  { text: '正在同步历史订单...', icon: '📋' },
  { text: '正在访问订单页面...', icon: '🌐' },
  { text: '等待页面渲染...', icon: '⏳' },
  { text: '正在解析订单数据...', icon: '🔍' },
  { text: '正在保存订单...', icon: '💾' },
]

function getSyncStepIndex(status: string): number {
  for (let i = SYNC_STEPS.length - 1; i >= 0; i--) {
    if (status.includes(SYNC_STEPS[i].text.replace('...', ''))) return i
  }
  return 0
}

function PlatformCard({ platform }: { platform: PlatformConfig }) {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState('')
  const [syncStatus, setSyncStatus] = useState('')
  const [loggingIn, setLoggingIn] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null)
  const [orderCount, setOrderCount] = useState(0)
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [cookieAge, setCookieAge] = useState<string | null>(null)
  const [syncTimeRange, setSyncTimeRange] = useState<string>('all')

  useEffect(() => {
    checkStatus()
    loadSyncInfo()
  }, [platform.key])

  useEffect(() => {
    const unsubscribe = api.onSyncStatusUpdate((data) => {
      const statusData = data as SyncStatusData
      if (statusData.platform === platform.key) {
        if (statusData.error) {
          setSyncStatus(`❌ ${statusData.status}: ${statusData.error}`)
        } else {
          setSyncStatus(statusData.status)
        }
      }
    })

    return unsubscribe
  }, [platform.key])

  const checkStatus = async () => {
    try {
      const result = await api.getAccountStatus(platform.key)
      setLoggedIn(result.loggedIn)
      setCookieAge(result.cookieAge ?? null)
    } catch {
      setLoggedIn(false)
    }
  }

  const loadSyncInfo = async () => {
    try {
      const [time, count] = await Promise.all([
        api.getSetting(`last_sync_time_${platform.key}`),
        api.getOrderCount(platform.key),
      ])
      setLastSyncTime(time)
      setOrderCount(count)
    } catch { /* ignore */ }
  }

  const handleLogin = async () => {
    setLoggingIn(true)
    setLoginError('')
    try {
      const result = await api.login(platform.key)
      if (result.success) {
        setLoggedIn(true)
        setLoginError('')
        checkStatus()
      } else {
        setLoginError(result.error || '登录失败')
      }
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : '登录出错')
    } finally {
      setLoggingIn(false)
    }
  }

  const handleLogout = async () => {
    try {
      await api.logout(platform.key)
      setLoggedIn(false)
      setCookieAge(null)
      setSyncResult('')
    } catch { /* ignore */ }
  }

  const handleSyncOrders = async () => {
    setSyncing(true)
    setSyncResult('')
    setSyncStatus('正在同步历史订单...')

    let timeRange: { beginTime?: string; endTime?: string } | undefined
    if (syncTimeRange !== 'all') {
      const now = new Date()
      const daysMap: Record<string, number> = { week: 7, month: 30, quarter: 90, halfYear: 180, year: 365 }
      const days = daysMap[syncTimeRange]
      if (days) {
        const begin = new Date(now.getTime() - days * 86400000)
        const pad = (n: number) => String(n).padStart(2, '0')
        timeRange = {
          beginTime: `${begin.getFullYear()}-${pad(begin.getMonth() + 1)}-${pad(begin.getDate())}`,
          endTime: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
        }
      }
    }

    try {
      const result = await api.syncOrders(platform.key, timeRange)
      if (result.success) {
        setSyncResult(`✅ 同步成功：共 ${result.count} 条订单已保存`)
        loadSyncInfo()
      } else {
        setSyncResult(`❌ 同步失败: ${result.error}`)
      }
    } catch (e) {
      setSyncResult(`❌ 同步出错: ${e}`)
    } finally {
      setSyncing(false)
    }
  }

  const handleClearOrders = async () => {
    try {
      const result = await api.clearOrders(platform.key)
      if (result.success) {
        setSyncResult(`已清除 ${result.count} 条订单数据`)
        setOrderCount(0)
        setLastSyncTime(null)
        setShowClearConfirm(false)
      }
    } catch (e) {
      setSyncResult(`❌ 清除失败: ${e}`)
    }
  }

  const currentStep = getSyncStepIndex(syncStatus)

  // 映射登录按钮的背景色
  const getLoginBtnClass = () => {
    if (platform.key === 'taobao') return 'bg-orange-500 hover:bg-orange-600 focus:ring-orange-200'
    if (platform.key === 'jd') return 'bg-red-500 hover:bg-red-600 focus:ring-red-200'
    return 'bg-pink-500 hover:bg-pink-600 focus:ring-pink-200'
  }

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 flex flex-col justify-between hover:border-gray-200 hover:shadow-md transition-all h-full">
      <div>
        {/* 头部：包含平台信息和 Cookie 有效期占位 */}
        <div className="flex items-center justify-between mb-6 h-12">
          <div className="flex items-center gap-4">
            <PlatformLogo platformKey={platform.key} size="md" />
            <div>
              <h3 className="font-semibold text-gray-900 text-lg">{platform.name}</h3>
              <p className="text-sm text-gray-500">
                状态：
                <span className={loggedIn ? 'text-green-600 font-medium' : 'text-gray-400'}>
                  {loggedIn === null ? '检查中...' : loggedIn ? '已登录' : '未登录'}
                </span>
              </p>
            </div>
          </div>
          <div className="h-7 flex items-center">
            {loggedIn && cookieAge ? (
              <span className="text-xs bg-gray-50 text-gray-400 px-2.5 py-1 rounded-full border border-gray-100">{cookieAge}</span>
            ) : (
              <span className="text-xs px-2.5 py-1 invisible">Placeholder</span>
            )}
          </div>
        </div>

        <div className="space-y-4">
          {/* 登录按钮区：固定高度 */}
          <div className="h-10">
            {loggedIn === null ? (
              <div className="w-full px-4 py-2 bg-gray-50 text-gray-400 text-sm font-medium rounded-lg text-center">
                检查登录状态...
              </div>
            ) : loggedIn ? (
              <button
                onClick={handleLogout}
                className="w-full px-4 py-2 bg-red-50 text-red-600 text-sm font-medium rounded-lg hover:bg-red-100 transition-colors focus:outline-none focus:ring-2 focus:ring-red-100"
              >
                退出登录
              </button>
            ) : (
              <button
                onClick={handleLogin}
                disabled={loggingIn}
                className={`w-full px-4 py-2 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors focus:outline-none focus:ring-2 ${getLoginBtnClass()}`}
              >
                {loggingIn ? '请在弹出的浏览器中登录...' : `登录${platform.name}`}
              </button>
            )}
          </div>

          {/* 登录错误展示区：固定高度占位以防抖动 */}
          <div className="h-6">
            {loginError ? (
              <p className="text-xs text-red-500 bg-red-50 rounded-md px-3 py-1 border border-red-100 truncate">{loginError}</p>
            ) : (
              <div className="invisible h-px" />
            )}
          </div>

          {/* 订单同步板块 */}
          <div className="border-t border-gray-100 pt-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-gray-700">订单同步</span>
              <div className="flex flex-col items-end text-xs text-gray-400 h-8 justify-center leading-normal">
                {orderCount > 0 ? (
                  <span className="font-medium text-gray-500">{orderCount} 条本地订单</span>
                ) : (
                  <span className="text-gray-300">暂无本地订单</span>
                )}
                {lastSyncTime ? (
                  <span>上次同步: {formatTime(lastSyncTime)}</span>
                ) : (
                  <span className="text-gray-300">从未同步</span>
                )}
              </div>
            </div>

            {/* 同步时间区间选择按钮：使用 Grid 布局完美排列两行 */}
            <div className="grid grid-cols-3 gap-1.5 mb-4">
              {[
                { key: 'all', label: '全部' },
                { key: 'week', label: '一周' },
                { key: 'month', label: '一月' },
                { key: 'quarter', label: '三月' },
                { key: 'halfYear', label: '半年' },
                { key: 'year', label: '一年' },
              ].map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setSyncTimeRange(opt.key)}
                  className={`px-2 py-1 text-xs rounded transition-colors text-center ${
                    syncTimeRange === opt.key
                      ? 'bg-blue-50 text-blue-600 border border-blue-200/50 font-medium'
                      : 'bg-gray-50 text-gray-500 hover:bg-gray-100 border border-transparent'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* 同步操作按钮：固定高度 */}
            <div className="h-10 flex gap-2">
              <button
                onClick={handleSyncOrders}
                disabled={syncing || !loggedIn}
                className="flex-1 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:hover:bg-blue-600 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-100"
              >
                {syncing ? '同步中...' : '同步历史订单'}
              </button>
              {syncing && (
                <button
                  onClick={() => api.cancelSync(platform.key)}
                  className="px-4 py-2 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200 transition-colors focus:outline-none focus:ring-2 focus:ring-gray-100"
                >
                  取消
                </button>
              )}
            </div>

            {syncing && syncStatus && (
              <div className="mt-3 bg-blue-50/50 border border-blue-100/50 rounded-lg p-3">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-3.5 h-3.5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  <span className="text-xs text-blue-700">{syncStatus}</span>
                </div>
                <div className="flex gap-1">
                  {SYNC_STEPS.map((step, i) => (
                    <div
                      key={i}
                      className={`h-1 flex-1 rounded-full transition-colors ${
                        i <= currentStep ? 'bg-blue-500' : 'bg-blue-100'
                      }`}
                      title={step.text}
                    />
                  ))}
                </div>
              </div>
            )}

            {syncResult && !syncing && (
              <p className={`text-xs rounded-md px-3 py-2 mt-2 border ${
                syncResult.startsWith('✅') ? 'text-green-700 bg-green-50 border-green-100' :
                syncResult.startsWith('❌') ? 'text-red-600 bg-red-50 border-red-100' :
                'text-gray-700 bg-gray-50 border-gray-100'
              }`}>
                {syncResult}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* 清除本地订单常驻控制区，无订单时置灰，避免卡片底部出现高矮不一致 */}
      <div className="border-t border-gray-100 pt-3 mt-4">
        {showClearConfirm ? (
          <div className="bg-red-50/50 border border-red-100 rounded-lg p-2.5 flex flex-col gap-2">
            <p className="text-[11px] text-red-700 font-medium leading-relaxed">确认清除本地订单？清除后将无法自动复购。</p>
            <div className="flex gap-2">
              <button
                onClick={handleClearOrders}
                className="flex-1 py-1 bg-red-500 text-white text-xs font-medium rounded hover:bg-red-600 transition-colors"
              >
                确认清除
              </button>
              <button
                onClick={() => setShowClearConfirm(false)}
                className="flex-1 py-1 bg-white text-gray-600 text-xs font-medium rounded border border-gray-200 hover:bg-gray-50 transition-colors"
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => orderCount > 0 && setShowClearConfirm(true)}
            disabled={orderCount === 0 || syncing}
            className="w-full py-2 bg-gray-50 text-gray-500 disabled:text-gray-300 disabled:bg-gray-50/30 text-xs font-medium rounded-lg hover:bg-gray-100 disabled:hover:bg-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-gray-100"
          >
            {orderCount > 0 ? '清除同步数据' : '暂无本地订单数据'}
          </button>
        )}
      </div>
    </div>
  )
}

export default function AccountManager() {
  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-6">
        <h2 className="text-xl font-bold text-gray-900 mb-1">多平台账号管理</h2>
        <p className="text-sm text-gray-500">
          通过同步各购物平台的历史订单，可以让 AI 自动在正确的平台上匹配并帮你完成一键“再买一单”或配置定时购买。
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 items-stretch">
        {PLATFORM_CONFIGS.map((config) => (
          <PlatformCard key={config.key} platform={config} />
        ))}
      </div>
    </div>
  )
}
