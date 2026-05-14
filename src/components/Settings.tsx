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

const PAYMENT_PLATFORMS = [
  { value: 'taobao', label: '淘宝/天猫' },
]

export default function Settings() {
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

  const [payFreeEnabled, setPayFreeEnabled] = useState(false)
  const [payFreeLimit, setPayFreeLimit] = useState('200')
  const [payFreePlatform, setPayFreePlatform] = useState('taobao')
  const [paymentSaved, setPaymentSaved] = useState(false)

  const current = providerSettings[provider]

  useEffect(() => {
    loadSettings()
  }, [])

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
    if (p === 'anthropic' || p === 'openai') setProvider(p)

    const limit = await api.getSetting('pay_free_limit')
    const platform = await api.getSetting('pay_free_platform')
    const enabled = await api.getSetting('pay_free_enabled')
    if (limit) setPayFreeLimit(limit)
    if (platform) setPayFreePlatform(platform)
    setPayFreeEnabled(enabled === 'true')
  }

  const updateCurrent = (field: keyof ProviderSettings, value: string) => {
    setProviderSettings(prev => ({
      ...prev,
      [provider]: { ...prev[provider], [field]: value },
    }))
    setVerifyResult(null)
    setAvailableModels([])
  }

  const handleProviderChange = async (newProvider: LlmProvider) => {
    setProvider(newProvider)
    setVerifyResult(null)
    setAvailableModels([])
    await api.setSetting('llm_provider', newProvider)
  }

  const handleSave = async () => {
    const keys = SETTING_KEYS[provider]
    await api.setSetting(keys.apiKey, current.apiKey)
    await api.setSetting(keys.baseUrl, current.baseUrl)
    await api.setSetting(keys.model, current.model)
    setSaved(true)
    setVerifyResult(null)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleVerify = async () => {
    if (!current.apiKey) {
      setVerifyResult({ success: false, message: '请先填写 API Key' })
      return
    }

    const keys = SETTING_KEYS[provider]
    await api.setSetting('llm_provider', provider)
    await api.setSetting(keys.apiKey, current.apiKey)
    await api.setSetting(keys.baseUrl, current.baseUrl)
    await api.setSetting(keys.model, current.model)

    setVerifying(true)
    setVerifyResult(null)
    try {
      const result = await api.verifyLlm() as { success: boolean; error?: string }
      if (result.success) {
        setVerifyResult({ success: true, message: '连接成功，配置有效！' })
        handleFetchModels()
      } else {
        setVerifyResult({ success: false, message: result.error || '验证失败' })
      }
    } catch (e) {
      setVerifyResult({ success: false, message: e instanceof Error ? e.message : '验证出错' })
    } finally {
      setVerifying(false)
    }
  }

  const handleFetchModels = async () => {
    if (!current.apiKey) return
    setFetchingModels(true)
    try {
      const keys = SETTING_KEYS[provider]
      await api.setSetting('llm_provider', provider)
      await api.setSetting(keys.apiKey, current.apiKey)
      await api.setSetting(keys.baseUrl, current.baseUrl)

      const result = await api.fetchModels() as { success: boolean; models?: string[]; error?: string }
      if (result.success && result.models) {
        if (result.models.length > 0 && !result.models.includes(current.model)) {
          setProviderSettings(prev => ({
            ...prev,
            [provider]: { ...prev[provider], model: result.models![0] },
          }))
        }
        setAvailableModels(result.models)
      }
    } catch {
      // ignore
    } finally {
      setFetchingModels(false)
    }
  }

  const handlePaymentSave = async () => {
    const limit = parseFloat(payFreeLimit)
    if (isNaN(limit) || limit < 0) {
      return
    }
    await api.setSetting('pay_free_enabled', String(payFreeEnabled))
    await api.setSetting('pay_free_limit', String(limit))
    await api.setSetting('pay_free_platform', payFreePlatform)
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
                      <span className="ml-2 text-xs text-gray-400">已配置</span>
                    )}
                  </div>
                  {provider === key && (
                    <span className="px-2 py-0.5 bg-blue-500 text-white text-xs rounded-full font-medium">
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
            <p className="text-xs text-gray-400 mt-1">留空使用默认地址，或填入兼容的第三方地址</p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-sm font-medium text-gray-700">
                模型
              </label>
              {current.apiKey && (
                <button
                  onClick={handleFetchModels}
                  disabled={fetchingModels}
                  className="text-xs text-blue-600 hover:text-blue-700 disabled:opacity-50"
                >
                  {fetchingModels ? '获取中...' : availableModels.length > 0 ? '刷新模型列表' : '获取可用模型'}
                </button>
              )}
            </div>
            {availableModels.length > 0 ? (
              <select
                value={current.model}
                onChange={(e) => updateCurrent('model', e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
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
                <p className="text-xs text-gray-400 mt-1">
                  {provider === 'openai' ? '常用: gpt-4o-mini, gpt-4o, gpt-3.5-turbo' : '常用: claude-sonnet-4-20250514, claude-3-5-sonnet-20241022, claude-3-haiku-20240307'}
                </p>
              </div>
            )}
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleSave}
              className="flex-1 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
            >
              {saved ? '已保存 ✓' : '保存设置'}
            </button>
            <button
              onClick={handleVerify}
              disabled={verifying || !current.apiKey}
              className="flex-1 px-4 py-2.5 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {verifying ? '验证中...' : '验证连接'}
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
            <h3 className="text-sm font-medium text-gray-700 mb-1">免密支付</h3>
            <p className="text-xs text-gray-400 mb-4">开启后，订单金额低于设定值时自动免密支付；关闭则所有订单均需手动支付</p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm font-medium text-gray-700">启用免密支付</span>
              <p className="text-xs text-gray-400 mt-0.5">关闭后所有订单均需手动确认支付</p>
            </div>
            <button
              onClick={() => setPayFreeEnabled(!payFreeEnabled)}
              role="switch"
              aria-checked={payFreeEnabled}
              aria-label="启用免密支付"
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                payFreeEnabled ? 'bg-blue-600' : 'bg-gray-200'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  payFreeEnabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {payFreeEnabled && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  免密支付金额上限（元）
                </label>
                <div className="relative">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={payFreeLimit}
                    onChange={(e) => setPayFreeLimit(e.target.value)}
                    placeholder="200"
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent pr-8"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">元</span>
                </div>
                <p className="text-xs text-gray-400 mt-1">低于此金额的订单将自动免密支付</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  免密支付平台
                </label>
                <div className="space-y-2">
                  {PAYMENT_PLATFORMS.map(p => (
                    <label
                      key={p.value}
                      className={`flex items-center gap-3 px-4 py-3 rounded-lg border-2 cursor-pointer transition-colors ${
                        payFreePlatform === p.value
                          ? 'border-blue-500 bg-blue-50'
                          : 'border-gray-200 bg-white hover:border-gray-300'
                      }`}
                    >
                      <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                        payFreePlatform === p.value ? 'border-blue-500' : 'border-gray-300'
                      }`}>
                        {payFreePlatform === p.value && <div className="w-2 h-2 rounded-full bg-blue-500" />}
                      </div>
                      <span className={`text-sm font-medium ${payFreePlatform === p.value ? 'text-blue-700' : 'text-gray-700'}`}>
                        {p.label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                <p className="text-xs text-amber-700">
                  <span className="font-medium">提示：</span>免密支付需要在对应平台已开通小额免密支付功能。如果未开通，即使金额低于设定值也无法自动完成支付。
                </p>
              </div>
            </>
          )}

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
