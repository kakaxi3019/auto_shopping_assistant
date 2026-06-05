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

用户的历史订单如下（每行格式：序号. [平台:名称] [价格:金额元] [购买时间:日期] [已排除] 商品名称）：
{orderHistory}

【重要】每个商品的唯一标识就是其前面的序号（如 1、2、3...）。在输出的 orderRef 和 matchedOrders 中，请使用该序号来引用商品。

核心原则：用户说"买XX"，绝大多数情况是想再买之前买过的同类商品，而不是买全新的东西。所以你必须优先从历史订单中寻找匹配。

匹配规则（按优先级和约束排列）：
1. 商品本体匹配（绝对的一票否决条件）：用户要买的东西必须与历史订单商品是同一种商品。判断标准是"商品本身是什么"，而不是"商品名中是否包含用户说的词"，更不是因为价格便宜、购买时间近或购买频次高就强行匹配。如果商品本体不同（例如用户说"买拖鞋"，罩衣不是拖鞋，本体完全不同），置信度必须为 0。只有在本体匹配的前提下，价格、时间、频次才可以作为微调置信度优先级的依据。
2. 关键词包含匹配：用户说的词出现在历史订单商品名中，且商品本体确实是用户要买的东西。例如"牛奶"匹配"蒙牛纯牛奶250ml"，"洗衣液"匹配"蓝月亮洗衣液3kg"
3. 语义关联匹配（仅当用户明确表达关联意图时才适用）：用户说的词与历史订单商品属于同一品类或用途，且用户的需求描述暗示了这种关联。例如用户说"买手机保护的东西"可以匹配"钢化膜"，但用户说"买手机"不应匹配"钢化膜"
4. 对每个匹配的订单，给出置信度（0-100）。为了确保打分的绝对稳定和逻辑一致性，大模型【必须且只能】从以下五个固定的离散档位分值中选择一个作为置信度，严禁输出任何其他数值（如 78, 55 等）：
   - 【95 分】：商品本体、规格、具体型号、品牌与用户要买的完全一致（完全复购）。
   - 【80 分】：属于同类同本体商品，但品牌或具体规格规格与用户想要的有所不同。
   - 【60 分】：属于同品类或高度相关的备选商品，但品牌或属性不完全确定是否符合要求.
   - 【30 分】：弱相关或可能有语义重叠但本体不匹配的商品。
   - 【0 分】：不相关商品。
   * 因子微调规范：在选定上述档位后，可以根据【高频复购】、【购买时间近】以及【价格更便宜】在当前档位基础上微调【+1分】或【-1分】以标识其在同档位中的优先级（例如在同档位同品类下，购买频次更高、时间更近、或价格更便宜的，可以微调 +1分获得更高的展示优先级），但绝对不允许跨越档位区间（例如 80 分微调后可以为 81 分或 79 分，但绝不能变成 60 几分或 90 几分）。
5. 结果个数与稳定性规则（非常重要）：
   - 大模型必须无遗漏地评估历史订单中【所有】商品本体符合用户需求的订单。只要置信度评分大于等于 50 分（即对应 60 分、80 分、95 分档位的商品），就【必须全部完整列出】在 matchedOrders 数组中，严禁因为匹配项较多而随机截断、选择性返回或遗漏。
   - 匹配结果列表 matchedOrders 必须严格按照置信度得分【由高到低】进行排序。最多返回 10 个。
   - 在相同的历史订单和输入指令下，匹配的订单数量及置信度得分必须保持逻辑一致性，每次返回的 items 数量和 matchedOrders 应该恒定。
6. orderRef 字段填写置信度最高的订单序号
7. 宁可少匹配也不要错匹配。如果不确定某个订单是否匹配，不要放入 matchedOrders
8. 置信度低于 50 的商品绝对不要放入 matchedOrders
9. 重要：关键词出现在商品名中 ≠ 商品本体匹配。必须判断"商品本身是什么"，而不是"商品名是否包含关键词"：
   - "篮球鞋"的本体是鞋，不是篮球
   - "篮球护踝"的本体是护踝，不是篮球
   - "篮球裤"的本体是裤子，不是篮球
   - "手机壳"的本体是壳，不是手机
   - "牛奶糖"的本体是糖，不是牛奶
   - "电脑桌"的本体是桌子，不是电脑
10. 关键词验证（非常重要）：匹配时必须验证用户说的商品关键词是否出现在商品名中。不能仅因为以下原因就匹配不相关的商品：
   - 目标人群相同（如用户说"买拖鞋"，"可孚医用耳温枪儿童用"不匹配，虽然都是儿童用品，但耳温枪不是拖鞋，且"拖鞋"不出现在商品名中）
   - 使用场景相关（如用户说"买拖鞋"，"防滑地垫"不匹配，虽然都与防滑有关）
   - 品类相邻（如用户说"买拖鞋"，"棉袜"不匹配，虽然都是脚部穿戴物）
   正确做法：用户说"买拖鞋"时，只有商品名中包含"拖鞋"或商品本体确实是拖鞋的才匹配

排除规则（非常重要）：
- 标记为 [已排除] 的订单表示用户不想再买该特定订单的商品，绝对不能放入 matchedOrders 中
- [已排除] 是针对具体订单的，不是针对整个品类。如果同类商品有多个订单，只有标记了 [已排除] 的那个不能匹配，其他未排除的同品类订单仍然可以正常匹配
- 如果用户要买的商品所有相关订单都已被排除，不要用其他语义关联的商品来替代。例如用户说"买篮球"，如果所有篮球订单都已排除，则不应匹配"篮球鞋"，应让 matchedOrders 留空
- 已排除的商品仅作为上下文参考，帮助理解用户意图，避免错误匹配

输出规则：
- name 字段：使用用户的原始描述（如用户说"买牛奶"则填"牛奶"，说"买手机贴膜"则填"手机贴膜"）
- orderRef 字段：置信度最高的匹配订单的序号（整数）
- matchedOrders 字段：所有相关订单的列表，按置信度从高到低排列，最多10个
- platform 字段：从置信度最高的匹配订单中获取对应的平台标识

输出格式为 JSON，包含 items 数组，每个元素包含：
- name: 用户的原始商品描述（字符串）
- quantity: 数量（整数，默认1）
- sku: 规格/型号（可选字符串）
- orderRef: 置信度最高的匹配订单序号（整数，即历史订单前面的数字编号）
- platform: 平台名称（字符串，如 taobao、jd、pdd）
- matchedOrders: 匹配订单数组，每个元素包含 orderRef（整数，即序号）和 confidence（0-100整数）

示例：
历史订单：
1. [平台:淘宝] 蒙牛纯牛奶250ml*12
2. [平台:淘宝] 蓝月亮洗衣液3kg
3. [平台:京东] [已排除] 安踏静音篮球篮筐
4. [平台:淘宝] 专柜正品adidas新款男子运动鞋
5. [平台:淘宝] 伊利纯牛奶250ml*16
6. [平台:淘宝] 蒙牛纯牛奶250ml*24
7. [平台:淘宝] 安踏篮球鞋男款
8. [平台:淘宝] 斯伯丁篮球7号
9. [平台:淘宝] LP768篮球护踝运动防护

输入："再买一箱牛奶"
输出：{"items":[{"name":"牛奶","quantity":1,"orderRef":1,"platform":"taobao","matchedOrders":[{"orderRef":1,"confidence":95},{"orderRef":6,"confidence":81},{"orderRef":5,"confidence":80}]}]}
说明：序号1是蒙牛纯牛奶，序号6也是蒙牛纯牛奶（量更大），序号5是伊利纯牛奶（品牌不同）

输入："买两箱牛奶和一双鞋"
输出：{"items":[{"name":"牛奶","quantity":2,"orderRef":1,"platform":"taobao","matchedOrders":[{"orderRef":1,"confidence":95},{"orderRef":6,"confidence":81},{"orderRef":5,"confidence":80}]},{"name":"鞋","quantity":1,"orderRef":4,"platform":"taobao","matchedOrders":[{"orderRef":4,"confidence":80}]}]}

输入："买一个篮球"
输出：{"items":[{"name":"篮球","quantity":1,"orderRef":8,"platform":"taobao","matchedOrders":[{"orderRef":8,"confidence":80}]}]}
注意：只匹配商品本体是篮球的(序号8)。序号3已排除，序号7篮球鞋不是篮球，序号9护踝不是篮球，都不匹配

输入："买一双篮球鞋"
输出：{"items":[{"name":"篮球鞋","quantity":1,"orderRef":7,"platform":"taobao","matchedOrders":[{"orderRef":7,"confidence":95}]}]}

输入："买一个新手机"
输出：{"items":[{"name":"新手机","quantity":1}]}

输入："买一双拖鞋"
历史订单：
1. [平台:淘宝] 上市品牌】可孚医用耳温枪儿童用
2. [平台:淘宝] Babycare儿童防水棉拖鞋
3. [平台:淘宝] 儿童亚麻拖鞋男女童宝宝棉麻布拖
输出：{"items":[{"name":"拖鞋","quantity":1,"orderRef":2,"platform":"taobao","matchedOrders":[{"orderRef":2,"confidence":95},{"orderRef":3,"confidence":81}]}]}
注意：序号1耳温枪不匹配，虽然都是"儿童"用品，但商品本体是耳温枪不是拖鞋，且"拖鞋"不出现在商品名中

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
    let url = this.db.getSetting(this.getSettingKey('base_url')) || ''
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
          headers: endpoint.headers as unknown as Record<string, string>,
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

    console.log(`[LlmParser] Raw parsed items from LLM (before correction): ${JSON.stringify(items)}`)
    try {
      const { appendFileSync } = require('fs');
      const { join } = require('path');
      const { app } = require('electron');
      const logFile = join(app.getPath('userData'), 'preview-debug.log');
      appendFileSync(logFile, `[LlmParser] Raw parsed items from LLM (before correction): ${JSON.stringify(items)}\n`, 'utf-8');
    } catch (err) {}

    // 获取用于构建 Prompt 的历史订单列表，以便进行行号和实际 ID 的映射纠错
    const orders = this.db.getAllOrders(100, 0).filter(o => o.productName)

    for (const item of items) {
      if (item.orderRef) {
        item.orderRef = this.correctOrderRef(item.orderRef, orders)
      }

      if (item.matchedOrders) {
        item.matchedOrders = item.matchedOrders.map(match => {
          if (match.orderRef) {
            return { ...match, orderRef: this.correctOrderRef(match.orderRef, orders) }
          }
          return match
        })
      }

      if (item.orderRef) {
        const order = this.db.getOrderById(item.orderRef)
        if (order && order.productName && (!item.name || item.name.trim().length === 0)) {
          item.name = order.productName
        }
      }
    }

    return items
  }

  /**
   * 将大模型返回的序号（行号）映射回真实的数据库 ID。
   * 
   * 由于 Prompt 中只展示序号（1, 2, 3...）而不展示真实数据库 ID，
   * 大模型返回的 orderRef 就是序号，需要通过 orders 数组映射回真实 ID。
   * 这从根本上避免了大模型截断大数字 ID（如 10439 → 439）的问题。
   */
  private correctOrderRef(ref: number, orders: any[]): number {
    if (!ref || ref <= 0) return ref
    
    // 核心逻辑：大模型返回的是序号（1-based index），直接映射到 orders 数组
    if (ref <= orders.length) {
      const realOrder = orders[ref - 1]
      if (realOrder) {
        console.log(`[LlmParser] Mapped line number ${ref} → database ID ${realOrder.id} ("${realOrder.productName?.substring(0, 20)}...")`)
        return realOrder.id
      }
    }
    
    // 兜底：如果返回的数字超过了 orders 范围，可能是模型幻觉
    // 尝试查找是否有真实 ID 与之匹配（向后兼容）
    const exactMatch = orders.find((o: any) => o.id === ref)
    if (exactMatch) {
      console.log(`[LlmParser] Direct ID match for ${ref} ("${exactMatch.productName?.substring(0, 20)}...")`)
      return ref
    }
    
    // 最后的兜底：尝试后缀匹配（防止极端情况下的 ID 截断）
    const refStr = String(ref)
    if (refStr.length >= 2) {
      const suffixMatch = orders.find((o: any) => String(o.id).endsWith(refStr))
      if (suffixMatch) {
        console.log(`[LlmParser] Fallback suffix match: ${ref} → database ID ${suffixMatch.id}`)
        return suffixMatch.id
      }
    }
    
    console.warn(`[LlmParser] Could not resolve orderRef ${ref} to any known order`)
    return ref
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
        const excluded = (o as any).unavailable ? ' [已排除]' : ''
        const priceStr = o.price ? ` [价格:${o.price}元]` : ''
        const dateStr = o.purchasedAt ? ` [购买时间:${o.purchasedAt}]` : ''
        // 不再暴露真实数据库 ID，只用序号（i+1）作为唯一标识
        // 这从根本上避免了大模型截断大数字 ID 的问题
        return `${i + 1}. [平台:${platLabel}]${priceStr}${dateStr}${excluded} ${o.productName}`
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
      temperature: 0,
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
        temperature: 0,
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
          ? ((item.matchedOrders || item.matched_orders) as Record<string, unknown>[]).map((m) => {
            return {
              orderRef: Number(m.orderRef || m.order_ref || m.orderId || m.order_id || 0),
              confidence: Math.min(100, Math.max(0, Number(m.confidence || m.score || 50))),
            }
          }).filter((m: { orderRef: number }) => m.orderRef > 0)
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
