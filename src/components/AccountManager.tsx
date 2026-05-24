import { useState, useEffect } from 'react'
import { api } from '../lib/api'

interface SyncStatusData {
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

export default function AccountManager() {
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

    const unsubscribe = api.onSyncStatusUpdate((data) => {
      const statusData = data as SyncStatusData
      if (statusData.error) {
        setSyncStatus(`❌ ${statusData.status}: ${statusData.error}`)
      } else {
        setSyncStatus(statusData.status)
      }
    })

    return unsubscribe
  }, [])

  const checkStatus = async () => {
    try {
      const result = await api.getAccountStatus('taobao')
      setLoggedIn(result.loggedIn)
      setCookieAge(result.cookieAge ?? null)
    } catch {
      setLoggedIn(false)
    }
  }

  const loadSyncInfo = async () => {
    try {
      const [time, count] = await Promise.all([
        api.getSetting('last_sync_time'),
        api.getOrderCount('taobao'),
      ])
      setLastSyncTime(time)
      setOrderCount(count)
    } catch { /* ignore */ }
  }

  const handleLogin = async () => {
    setLoggingIn(true)
    setLoginError('')
    try {
      const result = await api.login('taobao')
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
      await api.logout('taobao')
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
      const result = await api.syncOrders('taobao', timeRange)
      if (result.success) {
        setSyncResult(`✅ 同步成功：共 ${result.count} 条订单已保存到本地数据库`)
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
      const result = await api.clearOrders('taobao')
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

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-800 mb-6">账号管理</h2>

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 max-w-lg">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-12 h-12 bg-orange-100 rounded-xl flex items-center justify-center text-2xl" aria-hidden="true">
            🛒
          </div>
          <div>
            <h3 className="font-medium text-gray-900">淘宝</h3>
            <p className="text-sm text-gray-500">
              状态：
              <span className={loggedIn ? 'text-green-600' : 'text-gray-400'}>
                {loggedIn === null ? '检查中...' : loggedIn ? '已登录' : '未登录'}
              </span>
              {loggedIn && cookieAge && (
                <span className="text-gray-400 ml-2">({cookieAge})</span>
              )}
            </p>
          </div>
        </div>

        <div className="space-y-3">
          {loggedIn === null ? (
            <div className="w-full px-4 py-2.5 bg-gray-50 text-gray-400 text-sm font-medium rounded-lg text-center">
              检查登录状态...
            </div>
          ) : loggedIn ? (
            <button
              onClick={handleLogout}
              className="w-full px-4 py-2.5 bg-red-50 text-red-600 text-sm font-medium rounded-lg hover:bg-red-100 transition-colors"
            >
              退出登录
            </button>
          ) : (
            <button
              onClick={handleLogin}
              disabled={loggingIn}
              className="w-full px-4 py-2.5 bg-orange-500 text-white text-sm font-medium rounded-lg hover:bg-orange-600 disabled:opacity-50 transition-colors"
            >
              {loggingIn ? '请在弹出的浏览器中扫码登录...' : '登录淘宝'}
            </button>
          )}

          {loginError && (
            <p className="text-sm text-red-500 bg-red-50 rounded-md px-3 py-2">{loginError}</p>
          )}

          <div className="border-t border-gray-100 pt-3 mt-3">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-gray-600">历史订单</span>
              <div className="flex items-center gap-3 text-sm text-gray-400">
                {orderCount > 0 && <span>{orderCount} 条</span>}
                {lastSyncTime && <span>上次同步: {formatTime(lastSyncTime)}</span>}
              </div>
            </div>

            <div className="flex items-center gap-1.5 mb-3 flex-wrap">
              {[
                { key: 'all', label: '全部' },
                { key: 'week', label: '近一周' },
                { key: 'month', label: '近一月' },
                { key: 'quarter', label: '近三月' },
                { key: 'halfYear', label: '近半年' },
                { key: 'year', label: '近一年' },
              ].map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setSyncTimeRange(opt.key)}
                  className={`px-2.5 py-1 text-sm rounded-md transition-colors ${
                    syncTimeRange === opt.key
                      ? 'bg-blue-100 text-blue-700 font-medium'
                      : 'bg-gray-50 text-gray-500 hover:bg-gray-100'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleSyncOrders}
                disabled={syncing || !loggedIn}
                className="flex-1 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {syncing ? '同步中...' : '同步历史订单'}
              </button>
              {syncing && (
                <button
                  onClick={() => api.cancelSync('taobao')}
                  className="px-4 py-2.5 bg-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-300 transition-colors"
                >
                  取消
                </button>
              )}
            </div>

            {syncing && syncStatus && (
              <div className="mt-3 bg-blue-50 rounded-lg p-3">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  <span className="text-sm text-blue-700">{syncStatus}</span>
                </div>
                <div className="flex gap-1">
                  {SYNC_STEPS.map((step, i) => (
                    <div
                      key={i}
                      className={`h-1.5 flex-1 rounded-full transition-colors ${
                        i <= currentStep ? 'bg-blue-500' : 'bg-blue-200'
                      }`}
                      title={step.text}
                    />
                  ))}
                </div>
              </div>
            )}

            {syncResult && !syncing && (
              <p className={`text-sm rounded-md px-3 py-2 mt-2 ${
                syncResult.startsWith('✅') ? 'text-green-700 bg-green-50' :
                syncResult.startsWith('❌') ? 'text-red-500 bg-red-50' :
                'text-gray-700 bg-gray-50'
              }`}>
                {syncResult}
              </p>
            )}
          </div>

          {orderCount > 0 && !syncing && (
            <div className="border-t border-gray-100 pt-3">
              {showClearConfirm ? (
                <div className="bg-red-50 rounded-lg p-3">
                  <p className="text-sm text-red-700 mb-2">确定要清除所有 {orderCount} 条订单数据吗？此操作不可恢复。</p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleClearOrders}
                      className="flex-1 px-3 py-1.5 bg-red-500 text-white text-sm rounded-md hover:bg-red-600 transition-colors"
                    >
                      确认清除
                    </button>
                    <button
                      onClick={() => setShowClearConfirm(false)}
                      className="flex-1 px-3 py-1.5 bg-white text-gray-600 text-sm rounded-md border border-gray-200 hover:bg-gray-50 transition-colors"
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setShowClearConfirm(true)}
                  className="w-full px-4 py-2 bg-red-50 text-red-600 text-sm rounded-lg hover:bg-red-100 transition-colors"
                >
                  清除同步数据
                </button>
              )}
            </div>
          )}

          <div className="text-sm text-gray-400 mt-2 px-1">
            💡 同步操作会在后台自动访问淘宝订单页面，抓取历史订单并保存到本地。
            同步后即可输入"买牛奶"等指令复购之前买过的商品。
          </div>
        </div>
      </div>
    </div>
  )
}
