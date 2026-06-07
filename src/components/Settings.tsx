import { useState, useEffect } from 'react'
import { api } from '../lib/api'

type LlmProvider = 'openai' | 'anthropic'
type SettingsTab = 'model' | 'payment'

interface ProviderSettings {
  apiKey: string
  baseUrl: string
  model: string
}

const PROVIDER_CONFIG: Record<LlmProvider, { label: string; defaultModel: string; defaultBaseUrl: string; keyPlaceholder: string }> = {
  openai: { label: 'OpenAI', defaultModel: 'gpt-4o-mini', defaultBaseUrl: 'https://api.openai.com/v1', keyPlaceholder: 'sk-...' },
  anthropic: { label: 'Anthropic', defaultModel: 'claude-sonnet-4-20250514', defaultBaseUrl: 'https://api.anthropic.com', keyPlaceholder: 'sk-ant-...' },
}

const SETTING_KEYS: Record<LlmProvider, { apiKey: string; baseUrl: string; model: string }> = {
  openai: { apiKey: 'openai_api_key', baseUrl: 'openai_base_url', model: 'openai_model' },
  anthropic: { apiKey: 'anthropic_api_key', baseUrl: 'anthropic_base_url', model: 'anthropic_model' },
}

export default function Settings({ activePage }: { activePage?: string }) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('model')
  const [provider, setProvider] = useState<LlmProvider>('openai')
  const [providerSettings, setProviderSettings] = useState<Record<LlmProvider, ProviderSettings>>({
    openai: { apiKey: '', baseUrl: '', model: '' },
    anthropic: { apiKey: '', baseUrl: '', model: '' },
  })
  const [saved, setSaved] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<{ success: boolean; message: string } | null>(null)
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [fetchingModels, setFetchingModels] = useState(false)

  const [autoPayLimit, setAutoPayLimit] = useState('200')
  const [paymentMode, setPaymentMode] = useState('cart_only')
  const [paymentSaved, setPaymentSaved] = useState(false)
  const [priceProtectionThreshold, setPriceProtectionThreshold] = useState('15')
  const [doNotDisturb, setDoNotDisturb] = useState(false)
  const [autoSaveOrders, setAutoSaveOrders] = useState(false)

  const current = providerSettings[provider]



  const loadSettings = async () => {
    const p = await api.getSetting('llm_provider')
    const loaded: Record<LlmProvider, ProviderSettings> = {
      openai: { apiKey: '', baseUrl: '', model: '' },
      anthropic: { apiKey: '', baseUrl: '', model: '' },
    }

    for (const [prov, keys] of Object.entries(SETTING_KEYS) as [LlmProvider, typeof SETTING_KEYS.openai][]) {
      const key = await api.getSetting(keys.apiKey)
      const url = await api.getSetting(keys.baseUrl)
      const m = await api.getSetting(keys.model)
      if (key) loaded[prov].apiKey = key
      if (url) loaded[prov].baseUrl = url
      if (m) loaded[prov].model = m
    }

    setProviderSettings(loaded)
    const activeProvider = (p === 'anthropic' || p === 'openai') ? p : provider
    if (p === 'anthropic' || p === 'openai') setProvider(p)

    const limit = await api.getSetting('pay_free_limit')
    const mode = await api.getSetting('payment_mode')
    const threshold = await api.getSetting('price_protection_threshold')
    if (limit) setAutoPayLimit(limit)
    if (mode && typeof mode === 'string') setPaymentMode(mode)
    if (threshold) setPriceProtectionThreshold(String(Math.round(parseFloat(threshold) * 100)))

    const dnd = await api.getSetting('do_not_disturb')
    if (dnd === 'true') setDoNotDisturb(true)

    const autoSave = await api.getSetting('auto_save_orders')
    if (autoSave === 'true') setAutoSaveOrders(true)

    // 加载完成后，如果当前选中的 provider 已经配置了 api key，主动拉取一次可用模型
    const currentKeyVal = loaded[activeProvider].apiKey
    if (currentKeyVal) {
      setFetchingModels(true)
      try {
        const result = await api.fetchModels() as { success: boolean; models?: string[]; error?: string }
        if (result.success && result.models && result.models.length > 0) {
          const modelsList = result.models
          setAvailableModels(modelsList)
          if (!loaded[activeProvider].model || !modelsList.includes(loaded[activeProvider].model)) {
            const defaultModel = modelsList[0]
            loaded[activeProvider].model = defaultModel
            setProviderSettings({ ...loaded })
            await api.setSetting(SETTING_KEYS[activeProvider].model, defaultModel)
          }
        }
      } catch {
        // ignore
      } finally {
        setFetchingModels(false)
      }
    }
  }

  useEffect(() => {
    loadSettings()
  }, [])

  useEffect(() => {
    if (activePage === 'settings') {
      loadSettings()
    }
  }, [activePage])

  const updateCurrent = (field: keyof ProviderSettings, value: string) => {
    setProviderSettings(prev => ({
      ...prev,
      [provider]: { ...prev[provider], [field]: value },
    }))
    setVerifyResult(null)
    if (field !== 'model') {
      setAvailableModels([])
    }
  }

  const handleProviderChange = async (newProvider: LlmProvider) => {
    setProvider(newProvider)
    setVerifyResult(null)
    setAvailableModels([])
    await api.setSetting('llm_provider', newProvider)

    // 如果已经配置了 API Key，切换时静默加载可用模型以直接展示下拉框
    const savedSettings = providerSettings[newProvider]
    if (savedSettings.apiKey) {
      setFetchingModels(true)
      try {
        const result = await api.fetchModels() as { success: boolean; models?: string[]; error?: string }
        if (result.success && result.models && result.models.length > 0) {
          const modelsList = result.models
          setAvailableModels(modelsList)
          if (!savedSettings.model || !modelsList.includes(savedSettings.model)) {
            const defaultModel = modelsList[0]
            setProviderSettings(prev => ({
              ...prev,
              [newProvider]: { ...prev[newProvider], model: defaultModel }
            }))
            await api.setSetting(SETTING_KEYS[newProvider].model, defaultModel)
          }
        }
      } catch {
        // ignore
      } finally {
        setFetchingModels(false)
      }
    }
  }

  const handleSaveAndVerify = async () => {
    if (!current.apiKey) {
      setVerifyResult({ success: false, message: '请先填写 API Key' })
      return
    }

    let modelToSave = current.model
    if (!modelToSave && availableModels.length > 0) {
      modelToSave = availableModels[0]
      updateCurrent('model', modelToSave)
    }

    const keys = SETTING_KEYS[provider]
    // 1. 保存当前基础设置到数据库中
    await api.setSetting('llm_provider', provider)
    await api.setSetting(keys.apiKey, current.apiKey)
    await api.setSetting(keys.baseUrl, current.baseUrl)
    await api.setSetting(keys.model, modelToSave)

    setVerifying(true)
    setVerifyResult(null)
    setSaved(false)

    try {
      // 2. 验证连接
      const result = await api.verifyLlm() as { success: boolean; error?: string }
      if (result.success) {
        setVerifyResult({ success: true, message: '连接成功，配置已保存！' })
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)

        // 3. 验证成功后自动获取可用模型以更新下拉列表
        setFetchingModels(true)
        const modelsResult = await api.fetchModels() as { success: boolean; models?: string[]; error?: string }
        if (modelsResult.success && modelsResult.models && modelsResult.models.length > 0) {
          const models = modelsResult.models
          setAvailableModels(models)
          if (!models.includes(current.model)) {
            const defaultModel = models[0]
            setProviderSettings(prev => ({
              ...prev,
              [provider]: { ...prev[provider], model: defaultModel },
            }))
            await api.setSetting(keys.model, defaultModel)
          }
        }
      } else {
        setVerifyResult({ success: false, message: result.error || '验证失败' })
      }
    } catch (e) {
      setVerifyResult({ success: false, message: e instanceof Error ? e.message : '验证出错' })
    } finally {
      setVerifying(false)
      setFetchingModels(false)
    }
  }

  const handlePaymentSave = async () => {
    const limit = parseFloat(autoPayLimit)
    if (isNaN(limit) || limit < 0) {
      return
    }
    const thresholdVal = parseFloat(priceProtectionThreshold)
    const thresholdDecimal = isNaN(thresholdVal) ? 0.15 : Math.max(0, Math.min(100, thresholdVal)) / 100
    await api.setSetting('pay_free_limit', String(limit))
    await api.setSetting('payment_mode', paymentMode)
    await api.setSetting('price_protection_threshold', String(thresholdDecimal))
    await api.setSetting('do_not_disturb', doNotDisturb ? 'true' : 'false')
    await api.setSetting('auto_save_orders', autoSaveOrders ? 'true' : 'false')
    setPaymentSaved(true)
    setTimeout(() => setPaymentSaved(false), 2000)
  }

  const currentConfig = PROVIDER_CONFIG[provider]

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-800 mb-6">设置</h2>

      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setActiveTab('model')}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
            activeTab === 'model'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          模型设置
        </button>
        <button
          onClick={() => setActiveTab('payment')}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
            activeTab === 'payment'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          支付设置
        </button>
      </div>

      {activeTab === 'model' && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 max-w-lg space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              AI 模型提供商
            </label>
            <div className="space-y-2">
              {(Object.entries(PROVIDER_CONFIG) as [LlmProvider, typeof PROVIDER_CONFIG.openai][]).map(([key, config]) => (
                <button
                  key={key}
                  onClick={() => handleProviderChange(key)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg border-2 text-left transition-colors ${
                    provider === key
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-200 bg-white hover:border-gray-300'
                  }`}
                >
                  <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                    provider === key ? 'border-blue-500' : 'border-gray-300'
                  }`}>
                    {provider === key && <div className="w-2 h-2 rounded-full bg-blue-500" />}
                  </div>
                  <div className="flex-1">
                    <span className={`text-sm font-medium ${provider === key ? 'text-blue-700' : 'text-gray-700'}`}>
                      {config.label}
                    </span>
                    {providerSettings[key].apiKey && (
                      <span className="ml-2 text-sm text-gray-400">已配置</span>
                    )}
                  </div>
                  {provider === key && (
                    <span className="px-2 py-0.5 bg-blue-500 text-white text-sm rounded-full font-medium">
                      使用中
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              API Key
            </label>
            <input
              type="password"
              value={current.apiKey}
              onChange={(e) => updateCurrent('apiKey', e.target.value)}
              placeholder={currentConfig.keyPlaceholder}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              API Base URL
            </label>
            <input
              type="text"
              value={current.baseUrl}
              onChange={(e) => updateCurrent('baseUrl', e.target.value)}
              placeholder={currentConfig.defaultBaseUrl}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <p className="text-sm text-gray-400 mt-1">留空使用默认地址，或填入兼容的第三方地址</p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-sm font-medium text-gray-700">
                模型
              </label>
              {fetchingModels && (
                <span className="text-xs text-blue-600 animate-pulse">正在获取可用模型...</span>
              )}
            </div>
            {availableModels.length > 0 ? (
              <select
                value={current.model}
                onChange={async (e) => {
                  const newModel = e.target.value
                  updateCurrent('model', newModel)
                  const keys = SETTING_KEYS[provider]
                  await api.setSetting(keys.model, newModel)
                }}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white cursor-pointer"
              >
                {availableModels.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <div>
                <input
                  type="text"
                  value={current.model}
                  onChange={(e) => updateCurrent('model', e.target.value)}
                  placeholder={currentConfig.defaultModel}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <p className="text-sm text-gray-400 mt-1">
                  {provider === 'openai' ? '常用: gpt-4o-mini, gpt-4o, gpt-3.5-turbo' : '常用: claude-sonnet-4-20250514, claude-3-5-sonnet-20241022, claude-3-haiku-20240307'}
                </p>
              </div>
            )}
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleSaveAndVerify}
              disabled={verifying || !current.apiKey}
              className={`w-full px-4 py-2.5 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2 ${
                verifying 
                  ? 'bg-blue-400 cursor-not-allowed' 
                  : !current.apiKey 
                    ? 'bg-gray-300 cursor-not-allowed' 
                    : saved 
                      ? 'bg-green-600 hover:bg-green-700' 
                      : 'bg-blue-600 hover:bg-blue-700'
              }`}
            >
              {verifying ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  正在保存并验证连接...
                </>
              ) : saved ? (
                '已保存并验证成功 ✓'
              ) : (
                '保存并验证连接'
              )}
            </button>
          </div>

          {verifyResult && (
            <div className={`px-4 py-3 rounded-lg text-sm ${
              verifyResult.success
                ? 'bg-green-50 text-green-700 border border-green-200'
                : 'bg-red-50 text-red-600 border border-red-200'
            }`}>
              {verifyResult.success ? '✓ ' : '✗ '}{verifyResult.message}
            </div>
          )}
        </div>
      )}

      {activeTab === 'payment' && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 max-w-lg space-y-5">
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-1">支付模式</h3>
            <p className="text-sm text-gray-400 mb-4">控制购买流程中自动化的程度</p>
          </div>

          <div className="space-y-3">
            <label
              className={`flex items-start gap-3 px-4 py-3 rounded-lg border-2 cursor-pointer transition-colors ${
                paymentMode === 'auto_pay'
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
            >
              <div className={`w-4 h-4 mt-0.5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                paymentMode === 'auto_pay' ? 'border-blue-500' : 'border-gray-300'
              }`}>
                {paymentMode === 'auto_pay' && <div className="w-2 h-2 rounded-full bg-blue-500" />}
              </div>
              <div className="flex-1" onClick={() => setPaymentMode('auto_pay')}>
                <div className="flex items-center gap-2">
                  <span className="text-sm">💳</span>
                  <span className={`text-sm font-medium ${paymentMode === 'auto_pay' ? 'text-blue-700' : 'text-gray-700'}`}>
                    自动支付
                  </span>
                </div>
                <p className={`text-sm mt-1 ${paymentMode === 'auto_pay' ? 'text-blue-500' : 'text-gray-400'}`}>
                  全自动完成：选规格→购买→结算→支付，无需人工干预
                </p>
                {paymentMode === 'auto_pay' && (
                  <div className="mt-3 pt-3 border-t border-blue-200 space-y-3" onClick={(e) => e.stopPropagation()}>
                    <div>
                      <label className="block text-sm font-medium text-blue-700 mb-1.5">
                        安全限额
                      </label>
                      <div className="relative">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={autoPayLimit}
                          onChange={(e) => setAutoPayLimit(e.target.value)}
                          placeholder="200"
                          className="w-full px-3 py-2 border border-blue-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent pr-8 bg-white"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">元</span>
                      </div>
                      <p className="text-sm text-blue-400 mt-1.5">
                        低于此金额自动完成支付，超过此金额会暂停并要求您确认
                      </p>
                    </div>
                    <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                      <p className="text-sm text-amber-700">
                        <span className="font-medium">提示：</span>自动支付需在支付宝中开通小额免密支付功能，否则即使金额低于限额也无法自动完成支付
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </label>

            <label
              className={`flex items-start gap-3 px-4 py-3 rounded-lg border-2 cursor-pointer transition-colors ${
                paymentMode === 'checkout_only'
                  ? 'border-amber-500 bg-amber-50'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
            >
              <div className={`w-4 h-4 mt-0.5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                paymentMode === 'checkout_only' ? 'border-amber-500' : 'border-gray-300'
              }`}>
                {paymentMode === 'checkout_only' && <div className="w-2 h-2 rounded-full bg-amber-500" />}
              </div>
              <div onClick={() => setPaymentMode('checkout_only')}>
                <div className="flex items-center gap-2">
                  <span className="text-sm">📋</span>
                  <span className={`text-sm font-medium ${paymentMode === 'checkout_only' ? 'text-amber-700' : 'text-gray-700'}`}>
                    确认金额后支付
                  </span>
                </div>
                <p className={`text-sm mt-1 ${paymentMode === 'checkout_only' ? 'text-amber-500' : 'text-gray-400'}`}>
                  自动选规格和结算，但支付前弹出确认窗口，需手动确认金额后付款
                </p>
              </div>
            </label>

            <label
              className={`flex items-start gap-3 px-4 py-3 rounded-lg border-2 cursor-pointer transition-colors ${
                paymentMode === 'cart_only'
                  ? 'border-green-500 bg-green-50'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
            >
              <div className={`w-4 h-4 mt-0.5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                paymentMode === 'cart_only' ? 'border-green-500' : 'border-gray-300'
              }`}>
                {paymentMode === 'cart_only' && <div className="w-2 h-2 rounded-full bg-green-500" />}
              </div>
              <div onClick={() => setPaymentMode('cart_only')}>
                <div className="flex items-center gap-2">
                  <span className="text-sm">🛒</span>
                  <span className={`text-sm font-medium ${paymentMode === 'cart_only' ? 'text-green-700' : 'text-gray-700'}`}>
                    仅加购
                  </span>
                </div>
                <p className={`text-sm mt-1 ${paymentMode === 'cart_only' ? 'text-green-500' : 'text-gray-400'}`}>
                  只加入购物车，不结算不支付，适合需要批量选购后统一结算
                </p>
              </div>
            </label>
          </div>

          <div className="border-t border-gray-100 pt-4">
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              价格保护阈值
            </label>
            <div className="relative max-w-[200px]">
              <input
                type="number"
                min="0"
                max="100"
                step="1"
                value={priceProtectionThreshold}
                onChange={(e) => setPriceProtectionThreshold(e.target.value)}
                placeholder="15"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent pr-8"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">%</span>
            </div>
            <p className="text-sm text-gray-400 mt-1.5">
              自动支付模式下，当前价格较上次购买价上涨超过此比例时自动拦截，转交人工确认
            </p>
          </div>

          <div className="border-t border-gray-100 pt-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm">🔕</span>
                  <label className="text-sm font-medium text-gray-700">
                    免打扰模式
                  </label>
                </div>
                <p className="text-sm text-gray-400 mt-1">
                  开启后，任务完成或失败时不弹出系统通知
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={doNotDisturb}
                onClick={() => setDoNotDisturb(!doNotDisturb)}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                  doNotDisturb ? 'bg-blue-600' : 'bg-gray-200'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    doNotDisturb ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </div>

          <div className="border-t border-gray-100 pt-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm">💾</span>
                  <label className="text-sm font-medium text-gray-700">
                    自动同步最新订单
                  </label>
                </div>
                <p className="text-sm text-gray-400 mt-1">
                  开启后，购买成功时自动在后台同步并将订单保存至本地历史订单中
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoSaveOrders}
                onClick={() => setAutoSaveOrders(!autoSaveOrders)}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                  autoSaveOrders ? 'bg-blue-600' : 'bg-gray-200'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    autoSaveOrders ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </div>

          <button
            onClick={handlePaymentSave}
            className="w-full px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            {paymentSaved ? '已保存 ✓' : '保存支付设置'}
          </button>
        </div>
      )}
    </div>
  )
}
