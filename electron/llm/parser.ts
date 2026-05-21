import OpenAI from 'openai'
import type { ParsedShoppingItem } from '../../shared/types/platform.types'
import type { Database } from '../db/database'

const PLATFORM_LABEL: Record<string, string> = {
  taobao: '淘宝',
  jd: '京东',
  pdd: '拼多多',
}

const SYSTEM_PROMPT = `你是一个购物指令解析助手。用户会输入自然语言的购物需求，你需要解析出结构化的购物清单。

输出格式为 JSON，包含 items 数组，每个元素包含：
- name: 商品名称（字符串）
- quantity: 数量（整数，默认1）
- sku: 规格/型号（可选字符串）
- platform: 平台名称（可选字符串，如 taobao、jd、pdd 等）

示例：
输入："买两箱牛奶和一袋洗衣液"
输出：{"items":[{"name":"牛奶","quantity":2},{"name":"洗衣液","quantity":1}]}

输入："三包抽纸，两瓶可乐"
输出：{"items":[{"name":"抽纸","quantity":3},{"name":"可乐","quantity":2}]}

只输出 JSON，不要输出其他任何内容。`

const SYSTEM_PROMPT_WITH_HISTORY = `你是一个购物指令解析助手。用户会输入自然语言的购物需求，你需要解析出结构化的购物清单，并从用户的历史订单中找到所有相关的商品。

用户的历史订单如下（每行格式：序号. [ID:数字] [平台:名称] 商品名称）：
{orderHistory}

核心原则：用户说"买XX"，绝大多数情况是想再买之前买过的同类商品，而不是买全新的东西。所以你必须优先从历史订单中寻找匹配。

匹配规则（按优先级排列）：
1. 关键词包含匹配：用户说的词出现在历史订单商品名中，即为匹配。例如"篮球"匹配"安踏静音篮筐"，"牛奶"匹配"蒙牛纯牛奶250ml"
2. 语义关联匹配：用户说的词与历史订单商品属于同一品类或用途。例如"拖鞋"匹配"夏季防滑居家凉拖"，"手机贴膜"匹配"钢化膜"、"AR无纹膜"
3. 必须找出历史订单中所有与用户需求相关的商品，不要只返回一个
4. 对每个匹配的订单，给出置信度（0-100），表示该订单与用户需求的匹配程度：
   - 90-100：完全匹配，商品就是用户要的
   - 70-89：高度相关，同类商品的不同规格/品牌
   - 50-69：可能相关，同品类但不确定是否是用户想要的
   - 30-49：弱相关，可能不是用户想要的
   - 0-29：不太相关
5. orderRef 字段填写置信度最高的订单 ID
6. 只有当历史订单中确实没有任何相关商品时，matchedOrders 才留空

输出规则：
- name 字段：使用用户的原始描述（如用户说"买牛奶"则填"牛奶"，说"买手机贴膜"则填"手机贴膜"）
- orderRef 字段：置信度最高的匹配订单 ID
- matchedOrders 字段：所有相关订单的列表，按置信度从高到低排列，最多10个
- platform 字段：从置信度最高的匹配订单中获取对应的平台标识

输出格式为 JSON，包含 items 数组，每个元素包含：
- name: 用户的原始商品描述（字符串）
- quantity: 数量（整数，默认1）
- sku: 规格/型号（可选字符串）
- orderRef: 置信度最高的匹配订单 ID（整数）
- platform: 平台名称（字符串，如 taobao、jd、pdd）
- matchedOrders: 匹配订单数组，每个元素包含 orderRef（整数）和 confidence（0-100整数）

示例：
历史订单：
1. [ID:5] [平台:淘宝] 蒙牛纯牛奶250ml*12
2. [ID:8] [平台:淘宝] 蓝月亮洗衣液3kg
3. [ID:12] [平台:京东] 安踏静音篮球篮筐
4. [ID:15] [平台:淘宝] 专柜正品adidas新款男子运动鞋
5. [ID:20] [平台:淘宝] 伊利纯牛奶250ml*16
6. [ID:25] [平台:淘宝] 蒙牛纯牛奶250ml*24

输入："再买一箱牛奶"
输出：{"items":[{"name":"牛奶","quantity":1,"orderRef":5,"platform":"taobao","matchedOrders":[{"orderRef":5,"confidence":95},{"orderRef":25,"confidence":85},{"orderRef":20,"confidence":70}]}]}

输入："买两箱牛奶和一双鞋"
输出：{"items":[{"name":"牛奶","quantity":2,"orderRef":5,"platform":"taobao","matchedOrders":[{"orderRef":5,"confidence":95},{"orderRef":25,"confidence":85},{"orderRef":20,"confidence":70}]},{"name":"鞋","quantity":1,"orderRef":15,"platform":"taobao","matchedOrders":[{"orderRef":15,"confidence":90}]}]}

输入："买一个篮球"
输出：{"items":[{"name":"篮球","quantity":1,"orderRef":12,"platform":"jd","matchedOrders":[{"orderRef":12,"confidence":90}]}]}

输入："买一个新手机"
输出：{"items":[{"name":"新手机","quantity":1}]}

只输出 JSON，不要输出其他任何内容。`

const ANTHROPIC_MODELS = [
  'claude-sonnet-4-20250514',
  'claude-3-7-sonnet-20250219',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229',
  'claude-3-haiku-20240307',
]

export class LlmParser {
  private db: Database
  private openaiClient: OpenAI | null = null
  private cachedProvider: string | null = null

  constructor(db: Database) {
    this.db = db
  }

  private getProvider(): string {
    return this.db.getSetting('llm_provider') || 'openai'
  }

  private getSettingKey(field: string): string {
    const provider = this.getProvider()
    if (provider === 'anthropic') return `anthropic_${field}`
    return `openai_${field}`
  }

  private getApiKey(): string {
    const key = this.db.getSetting(this.getSettingKey('api_key'))
    if (!key) throw new Error('请先在设置中配置 API Key')
    return key
  }

  private getBaseUrl(): string {
    let url = this.db.getSetting(this.getSettingKey('base_url'))
    if (url && !/^https?:\/\//i.test(url)) {
      url = 'https://' + url
    }
    return url
  }

  private getModel(): string {
    const model = this.db.getSetting(this.getSettingKey('model'))
    if (model) return model
    return this.getProvider() === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o-mini'
  }

  private getOpenAIClient(): OpenAI {
    const provider = this.getProvider()
    if (this.openaiClient && this.cachedProvider === provider) {
      return this.openaiClient
    }
    const apiKey = this.getApiKey()
    const baseUrl = this.getBaseUrl()
    this.openaiClient = new OpenAI({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    })
    this.cachedProvider = provider
    return this.openaiClient
  }

  resetClient() {
    this.openaiClient = null
    this.cachedProvider = null
  }

  async verify(): Promise<{ success: boolean; error?: string }> {
    const provider = this.getProvider()
    try {
      if (provider === 'anthropic') {
        return await this.verifyAnthropic()
      }
      return await this.verifyOpenAI()
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async fetchModels(): Promise<{ success: boolean; models?: string[]; error?: string }> {
    const provider = this.getProvider()
    try {
      if (provider === 'anthropic') {
        return await this.fetchAnthropicModels()
      }
      return await this.fetchOpenAIModels()
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  private async fetchAnthropicModels(): Promise<{ success: boolean; models?: string[]; error?: string }> {
    const apiKey = this.getApiKey()
    let baseUrl = this.getBaseUrl() || 'https://api.anthropic.com'
    baseUrl = baseUrl.replace(/\/+$/, '')

    const endpoints = [
      { url: `${baseUrl}/v1/models`, headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } },
      { url: `${baseUrl}/models`, headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } },
      { url: `${baseUrl}/v1/models`, headers: { 'Authorization': `Bearer ${apiKey}` } },
      { url: `${baseUrl}/models`, headers: { 'Authorization': `Bearer ${apiKey}` } },
    ]

    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint.url, {
          method: 'GET',
          headers: endpoint.headers,
        })

        if (response.ok) {
          const data = await response.json()
          const models = (data.data as Array<{ id: string }>)?.map(m => m.id).sort() || []
          if (models.length > 0) {
            return { success: true, models }
          }
        }
      } catch {
        continue
      }
    }

    return { success: true, models: ANTHROPIC_MODELS }
  }

  private async fetchOpenAIModels(): Promise<{ success: boolean; models?: string[]; error?: string }> {
    const apiKey = this.getApiKey()
    let baseUrl = this.getBaseUrl() || 'https://api.openai.com/v1'
    baseUrl = baseUrl.replace(/\/+$/, '')

    const endpoints = [`${baseUrl}/models`, `${baseUrl}/v1/models`]

    for (const url of endpoints) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiKey}` },
        })

        if (response.ok) {
          const data = await response.json()
          const models = (data.data as Array<{ id: string }>)?.map(m => m.id).sort() || []
          if (models.length > 0) {
            return { success: true, models }
          }
        }
      } catch {
        continue
      }
    }

    return { success: false, error: '无法获取模型列表，请检查 Base URL 和 API Key' }
  }

  private async verifyOpenAI(): Promise<{ success: boolean; error?: string }> {
    const apiKey = this.getApiKey()
    let baseUrl = this.getBaseUrl() || 'https://api.openai.com/v1'
    baseUrl = baseUrl.replace(/\/+$/, '')
    if (!baseUrl.endsWith('/v1') && !baseUrl.includes('/v1/')) {
      baseUrl += '/v1'
    }

    const model = this.getModel()

    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    })

    if (!response.ok) {
      const errorText = await response.text()
      return { success: false, error: `API 验证失败 (${response.status}): ${errorText}` }
    }

    const data = await response.json()
    const models = data.data as Array<{ id: string }> | undefined
    if (models && !models.some(m => m.id === model)) {
      return { success: false, error: `模型 "${model}" 不存在，请检查模型名称` }
    }

    return { success: true }
  }

  private async verifyAnthropic(): Promise<{ success: boolean; error?: string }> {
    const apiKey = this.getApiKey()
    let baseUrl = this.getBaseUrl() || 'https://api.anthropic.com'
    baseUrl = baseUrl.replace(/\/+$/, '')

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.getModel(),
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    if (response.ok) {
      return { success: true }
    }
    const errorText = await response.text()
    return { success: false, error: `Anthropic API 错误 (${response.status}): ${errorText}` }
  }

  async parse(instruction: string): Promise<ParsedShoppingItem[]> {
    const provider = this.getProvider()
    const systemPrompt = this.buildSystemPrompt()
    let items: ParsedShoppingItem[]
    if (provider === 'anthropic') {
      items = await this.parseWithAnthropic(instruction, systemPrompt)
    } else {
      items = await this.parseWithOpenAI(instruction, systemPrompt)
    }

    for (const item of items) {
      if (item.orderRef) {
        const order = this.db.getOrderById(item.orderRef)
        if (order && order.productName && (!item.name || item.name.trim().length === 0)) {
          item.name = order.productName
        }
      }
    }

    return items
  }

  private buildSystemPrompt(): string {
    const orders = this.db.getAllOrders(100, 0)
    if (!orders || orders.length === 0) {
      return SYSTEM_PROMPT
    }
    const orderLines = orders
      .filter(o => o.productName)
      .map((o, i) => {
        const platLabel = PLATFORM_LABEL[o.platform] || o.platform || '未知平台'
        return `${i + 1}. [ID:${o.id}] [平台:${platLabel}] ${o.productName}`
      })
    if (orderLines.length === 0) {
      return SYSTEM_PROMPT
    }
    const historyStr = orderLines.join('\n')
    return SYSTEM_PROMPT_WITH_HISTORY.replace('{orderHistory}', historyStr)
  }

  private async parseWithOpenAI(instruction: string, systemPrompt: string): Promise<ParsedShoppingItem[]> {
    const client = this.getOpenAIClient()
    const response = await client.chat.completions.create({
      model: this.getModel(),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: instruction },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    })

    const content = response.choices[0]?.message?.content
    if (!content) throw new Error('LLM 返回为空')
    return this.parseContent(content)
  }

  private async parseWithAnthropic(instruction: string, systemPrompt: string): Promise<ParsedShoppingItem[]> {
    const apiKey = this.getApiKey()
    let baseUrl = this.getBaseUrl() || 'https://api.anthropic.com'
    baseUrl = baseUrl.replace(/\/+$/, '')

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.getModel(),
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: instruction }],
        temperature: 0.1,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Anthropic API 错误 (${response.status}): ${errorText}`)
    }

    const data = await response.json()
    const content = data.content?.[0]?.text
    if (!content) throw new Error('Anthropic 返回为空')
    return this.parseContent(content)
  }

  private parseContent(content: string): ParsedShoppingItem[] {
    try {
      const jsonStr = this.extractJson(content)
      const parsed = JSON.parse(jsonStr)
      const items = Array.isArray(parsed) ? parsed : parsed.items || parsed.shopping_list || [parsed]
      return items.map((item: Record<string, unknown>) => {
        const matchedOrders = Array.isArray(item.matchedOrders || item.matched_orders)
          ? (item.matchedOrders || item.matched_orders).map((m: Record<string, unknown>) => ({
              orderRef: Number(m.orderRef || m.order_ref || m.orderId || m.order_id || 0),
              confidence: Math.min(100, Math.max(0, Number(m.confidence || m.score || 50))),
            })).filter((m: { orderRef: number }) => m.orderRef > 0)
          : undefined
        return {
          name: String(item.name || item.product || item.item || ''),
          quantity: Number(item.quantity || item.qty || item.count || 1),
          sku: item.sku ? String(item.sku) : undefined,
          platform: item.platform ? String(item.platform) : undefined,
          orderRef: item.orderRef || item.order_ref || item.orderId || item.order_id
            ? Number(item.orderRef || item.order_ref || item.orderId || item.order_id)
            : undefined,
          matchedOrders,
        }
      })
    } catch {
      throw new Error(`LLM 返回格式解析失败: ${content}`)
    }
  }

  private extractJson(text: string): string {
    let trimmed = text.trim()

    const thinkEnd = trimmed.indexOf('</think')
    if (thinkEnd !== -1) {
      const afterThink = trimmed.substring(thinkEnd)
      const closeAngle = afterThink.indexOf('>')
      if (closeAngle !== -1) {
        trimmed = trimmed.substring(thinkEnd + closeAngle + 1).trim()
      }
    }

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { JSON.parse(trimmed); return trimmed } catch { /* continue */ }
    }
    const lastBrace = trimmed.lastIndexOf('}')
    if (lastBrace !== -1) {
      let depth = 0
      for (let i = lastBrace; i >= 0; i--) {
        if (trimmed[i] === '}') depth++
        else if (trimmed[i] === '{') depth--
        if (depth === 0) {
          const candidate = trimmed.slice(i, lastBrace + 1)
          try { JSON.parse(candidate); return candidate } catch { break }
        }
      }
    }
    const lastBracket = trimmed.lastIndexOf(']')
    if (lastBracket !== -1) {
      let depth = 0
      for (let i = lastBracket; i >= 0; i--) {
        if (trimmed[i] === ']') depth++
        else if (trimmed[i] === '[') depth--
        if (depth === 0) {
          const candidate = trimmed.slice(i, lastBracket + 1)
          try { JSON.parse(candidate); return candidate } catch { break }
        }
      }
    }
    return trimmed
  }
}
