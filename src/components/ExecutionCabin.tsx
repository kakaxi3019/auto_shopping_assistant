import { useRef, useEffect, useImperativeHandle, forwardRef, useCallback, useState } from 'react'

interface ExecutionCabinProps {
  expanded: boolean
  mode: 'auto' | 'interactive'
  statusText: string
  step: number
  totalSteps: number
  needsUserAction: boolean
  onExpand: () => void
  onCollapse: () => void
  onConfirmAction: () => void
  onRejectAction: () => void
  confirmActionLoading: boolean
}

export interface ExecutionCabinHandle {
  drawFrame: (base64Jpeg: string) => void
}

const ExecutionCabin = forwardRef<ExecutionCabinHandle, ExecutionCabinProps>(
  (
    {
      expanded,
      mode,
      statusText,
      step,
      totalSteps,
      needsUserAction,
      onExpand,
      onCollapse,
      onConfirmAction,
      onRejectAction,
      confirmActionLoading,
    },
    ref
  ) => {
    // 全局前端调试日志，自动通过 bridge 回传主进程，记录于 debug-exclude.log
    const feLog = useCallback((message: string) => {
      console.log(`[FE-DIAG] ${message}`)
      if (window.api && (window.api as any).cabinLog) {
        try { (window.api as any).cabinLog(message) } catch {}
      }
    }, [])

    const webviewRef = useRef<any>(null)
    const [webviewElement, setWebviewElement] = useState<any>(null)
    const [paymentInfo, setPaymentInfo] = useState<{ amount: number; paymentMode: string } | null>(null)
    const [webviewReady, setWebviewReady] = useState(false)
    const [preloadPath, setPreloadPath] = useState<string>('')

    // 兼容原有的 drawFrame 方法，使其不报错但什么都不做
    const drawFrame = useCallback((base64Jpeg: string) => {
      // 截图流已废弃，直接使用 webview 原生渲染
    }, [])

    useImperativeHandle(ref, () => ({ drawFrame }), [drawFrame])

    // 使用 Callback Ref 动态捕获 webview DOM 节点，以解决 React 异步挂载 Ref 还是 null 的经典 Bug
    const webviewCallbackRef = useCallback((node: any) => {
      if (node !== null) {
        feLog(`webviewCallbackRef node 捕获成功，设置 webviewRef 实例`)
        webviewRef.current = node
        setWebviewElement(node)
      } else {
        feLog(`webviewCallbackRef node 捕获为 null`)
      }
    }, [feLog])

    // 监听 webview 坐标发送到主进程，用于物理窗口 overlay（作为降级或兼容）
    const sendCabinBounds = useCallback(() => {
      const webview = webviewRef.current || webviewElement
      if (!webview) return
      const rect = webview.getBoundingClientRect()
      const scaleFactor = window.devicePixelRatio || 1
      window.api.cabinSetCabinBounds({
        x: Math.round(rect.x * scaleFactor),
        y: Math.round(rect.y * scaleFactor),
        width: Math.round(rect.width * scaleFactor),
        height: Math.round(rect.height * scaleFactor),
      })
    }, [webviewElement])

    useEffect(() => {
      if (!expanded) return
      sendCabinBounds()
    }, [expanded, mode, sendCabinBounds])

    useEffect(() => {
      if (!expanded) return
      const handleResize = () => sendCabinBounds()
      window.addEventListener('resize', handleResize)
      return () => window.removeEventListener('resize', handleResize)
    }, [expanded, sendCabinBounds])

    // 核心：设置 webview 事件监听，依赖于真实的 webviewElement 实例
    useEffect(() => {
      feLog(`设置 webview 监听的 useEffect 触发. webviewElement 存在 = ${!!webviewElement}`)
      if (!webviewElement) return
      const webview = webviewElement

      const handleDomReady = () => {
        feLog(`webview dom-ready 触发`)
        setWebviewReady(true)
        try {
          const url = webview.getURL()
          feLog(`webview 当前加载 URL: ${url}`)
          window.api.cabinReportNavigation(url)
        } catch (e) {
          feLog(`webview 获取当前 URL 失败: ${e}`)
        }
      }

      webview.addEventListener('dom-ready', handleDomReady)

      const handleWillPreventUnload = (event: any) => {
        feLog(`webview will-prevent-unload 触发，强制继续导航以阻止原生 beforeunload 弹框`)
        event.preventDefault()
      }

      webview.addEventListener('will-prevent-unload', handleWillPreventUnload)

      const handleNavigate = () => {
        try {
          const url = webview.getURL()
          feLog(`webview 触发导航事件, URL: ${url}`)
          window.api.cabinReportNavigation(url)
        } catch (e) {
          feLog(`webview 导航事件获取 URL 失败: ${e}`)
        }
      }

      webview.addEventListener('did-navigate', handleNavigate)
      webview.addEventListener('did-navigate-in-page', handleNavigate)

      // 监听主进程指令并在 webview 中执行
      feLog(`正在注册主进程 cabin:command 监听`)
      const unsubscribeCommand = window.api.onCabinCommand(async (cmd) => {
        const { id, type, payload } = cmd
        feLog(`收到主进程指令: id=${id}, type=${type}, payload=${JSON.stringify(payload)}`)
        try {
          if (type === 'navigate') {
            feLog(`正在调用 webview.loadURL: ${payload.url}`)
            webview.loadURL(payload.url, {
              httpReferrer: payload.referrer || 'https://trade.taobao.com/trade/itemlist/list_bought_items.htm'
            }).catch((loadErr: any) => {
              const errCode = loadErr?.errno || loadErr?.code || ''
              if (errCode === -3 || String(loadErr).includes('ERR_ABORTED')) {
                feLog(`webview.loadURL 遇到 ERR_ABORTED（导航被新请求中断，属正常行为）`)
              } else {
                feLog(`webview.loadURL 异常: ${loadErr}`)
              }
            })
            window.api.cabinSendCommandResult(id, { success: true })
          } else if (type === 'execute_js') {
            feLog(`正在调用 webview.executeJavaScript, script 长度: ${payload.script ? payload.script.length : 0}`)
            const res = await webview.executeJavaScript(payload.script)
            feLog(`webview.executeJavaScript 执行完毕, 成功`)
            window.api.cabinSendCommandResult(id, { success: true, data: res })
          } else if (type === 'simulate_click') {
            const { x, y } = payload
            feLog(`正在执行原生物理模拟点击注入: x=${x}, y=${y}`)
            
            const cx = Math.round(x)
            const cy = Math.round(y)

            // 1. 鼠标进入 webview
            webview.sendInputEvent({ type: 'mouseEnter', x: cx, y: cy })
            await new Promise(r => setTimeout(r, 30))

            // 2. 鼠标移动到目标位置（模拟真实轨迹）
            webview.sendInputEvent({ type: 'mouseMove', x: cx, y: cy })
            await new Promise(r => setTimeout(r, 60))

            // 3. 鼠标按下
            webview.sendInputEvent({ 
              type: 'mouseDown', 
              x: cx, 
              y: cy, 
              button: 'left', 
              clickCount: 1 
            })
            await new Promise(r => setTimeout(r, 80 + Math.floor(Math.random() * 40)))

            // 4. 鼠标弹起
            webview.sendInputEvent({ 
              type: 'mouseUp', 
              x: cx, 
              y: cy, 
              button: 'left', 
              clickCount: 1 
            })
            await new Promise(r => setTimeout(r, 30))
            
            feLog(`原生物理模拟点击注入成功完成! isTrusted=true`)
            window.api.cabinSendCommandResult(id, { success: true })
          } else {
            feLog(`收到未知指令类型: ${type}`)
            window.api.cabinSendCommandResult(id, { success: false, error: `Unknown command type: ${type}` })
          }
        } catch (err) {
          feLog(`执行指令报错! id=${id}, err=${err}`)
          window.api.cabinSendCommandResult(id, { success: false, error: String(err) })
        }
      })

      return () => {
        feLog(`清理 webview 监听的 useEffect 资源，取消 command 监听`)
        unsubscribeCommand()
        webview.removeEventListener('dom-ready', handleDomReady)
        webview.removeEventListener('will-prevent-unload', handleWillPreventUnload)
        webview.removeEventListener('did-navigate', handleNavigate)
        webview.removeEventListener('did-navigate-in-page', handleNavigate)
      }
    }, [webviewElement, feLog])

    // 监听支付状态
    useEffect(() => {
      const unsubscribePayment = window.api.onCabinPaymentInfo((info) => {
        setPaymentInfo(info)
      })
      return () => {
        unsubscribePayment()
      }
    }, [])

    // 异步获取专属的 Webview Preload 拦截脚本绝对路径
    useEffect(() => {
      if (window.api && (window.api as any).cabinGetPreloadPath) {
        (window.api as any).cabinGetPreloadPath()
          .then((path: string) => {
            feLog(`成功获取操作舱专属 preload 脚本绝对路径: ${path}`)
            setPreloadPath(path)
          })
          .catch((err: any) => {
            feLog(`获取 preload 脚本路径失败: ${err}`)
          })
      }
    }, [feLog])



    return (
      <div className="relative w-full h-full rounded-xl border border-gray-200 overflow-hidden transition-all duration-300 bg-gray-900 flex flex-col">
        {/* 支付金额安全确认条 */}
        {paymentInfo && (
          <div className="absolute top-0 inset-x-0 z-50 bg-gradient-to-r from-amber-600 to-amber-700 text-white px-4 py-2 flex items-center justify-between shadow-md border-b border-amber-500/20 animate-pulse">
            <div className="flex items-center gap-2">
              <span className="text-base">🛡️</span>
              <span className="text-sm font-semibold tracking-wide">
                安全支付确认：订单金额 <span className="text-lg font-bold text-yellow-300">¥{paymentInfo.amount.toFixed(2)}</span> 
                {paymentInfo.paymentMode === 'checkout_only' ? ' (当前为手动确认模式)' : ' (免密支付额度超限)'}
              </span>
            </div>
            <span className="text-xs bg-amber-800/60 px-2 py-0.5 rounded-full border border-amber-400/20">
              请确认无误后在下方完成支付
            </span>
          </div>
        )}

        {/* 核心 Webview 容器 */}
        <div className="relative flex-1 w-full h-full min-h-[400px]">
          {preloadPath ? (
            <webview
              ref={webviewCallbackRef}
              src="about:blank"
              partition="persist:taobao"
              preload={preloadPath}
              style={{ width: '100%', height: '100%', border: 'none', background: '#f9fafb' }}
              userAgent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900 text-gray-400 gap-3 z-30">
              <span className="w-8 h-8 border-4 border-t-transparent border-blue-500 rounded-full animate-spin" />
              <span className="text-xs font-medium tracking-wide">正在初始化安全沙箱操作舱...</span>
            </div>
          )}

          {/* 自动模式下的透明防干扰防点击遮罩 */}
          {mode === 'auto' && (
            <div className="absolute inset-0 z-40 bg-transparent cursor-not-allowed" />
          )}

          {/* 状态与步骤指示器 (自动模式浮层) */}
          {mode === 'auto' && (
            <div className="absolute top-3 left-3 z-50 bg-black/75 backdrop-blur-md text-white text-xs px-3 py-1.5 rounded-full shadow-lg border border-white/10 flex items-center gap-2 max-w-[85%] truncate">
              <span className="inline-block w-2 h-2 bg-blue-500 rounded-full animate-ping" />
              <span className="font-medium text-blue-200">自动执行中:</span>
              <span className="text-gray-300">{statusText}</span>
              <span className="text-gray-400 ml-1">({step}/{totalSteps})</span>
            </div>
          )}

          {/* 交互模式指示器 */}
          {mode === 'interactive' && (
            <div className="absolute top-3 left-3 z-50 bg-amber-600/90 backdrop-blur-md text-white text-xs px-3 py-1.5 rounded-full shadow-lg border border-amber-500/20 flex items-center gap-2">
              <span className="inline-block w-2 h-2 bg-yellow-300 rounded-full animate-bounce" />
              <span className="font-semibold text-yellow-100">请接管操作:</span>
              <span className="text-amber-100">{statusText}</span>
            </div>
          )}
        </div>

        {/* 交互状态下的人工确认底栏 */}
        {mode === 'interactive' && (
          <div className="bg-gray-100 border-t border-gray-200 p-3 flex items-center justify-between gap-4 z-40">
            <div className="text-xs text-gray-500 flex items-center gap-1.5">
              <span>💡</span>
              <span>请在上方操作舱内完成验证、选择规格或确认付款，完成后点击右侧按钮</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={onConfirmAction}
                disabled={confirmActionLoading}
                className="px-5 py-2 text-sm font-semibold text-white bg-green-600 hover:bg-green-700 transition-colors rounded-lg disabled:opacity-50 disabled:cursor-not-allowed shadow-sm flex items-center gap-1.5"
              >
                {confirmActionLoading ? (
                  <>
                    <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    处理中...
                  </>
                ) : (
                  '✓ 我已完成'
                )}
              </button>
              <button
                onClick={onRejectAction}
                disabled={confirmActionLoading}
                className="px-5 py-2 text-sm font-semibold text-white bg-red-500 hover:bg-red-600 transition-colors rounded-lg disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
              >
                ✗ 无法完成
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }
)

ExecutionCabin.displayName = 'ExecutionCabin'

export default ExecutionCabin
