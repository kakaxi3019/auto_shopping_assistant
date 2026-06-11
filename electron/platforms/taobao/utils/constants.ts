import { join } from 'path'
import { app } from 'electron'

export const ORDER_API_URL = 'https://buyertrade.taobao.com/trade/itemlist/asyncBought.htm'
// 新版订单详情页（trade.tmall.com），页面上有「再买一单」按钮，当前使用此版本
export const ORDER_DETAIL_URL = 'https://trade.tmall.com/detail/orderDetail.htm?bizOrderId='
// 旧版订单详情页（buyertrade.taobao.com），已废弃，页面结构已变化，不再包含「再买一单」入口，勿使用
export const ORDER_DETAIL_ALT_URL = 'https://buyertrade.taobao.com/trade/detail/trade_item_detail.htm?bizOrderId='
export const SEARCH_URL = 'https://s.taobao.com/search?page=1&q='
export const HEARTBEAT_URL = 'https://www.taobao.com'
export const TAOBAO_CART_URL = 'https://cart.taobao.com/cart.htm'

export const APP_ICON = app.isPackaged
  ? join(process.resourcesPath, 'app-icon', 'auto_shopping_app_icon.png')
  : join(__dirname, '../build/auto_shopping_app_icon.png')

export const TAOBAO_PRELOAD = join(__dirname, '../../../preload-taobao.js')

export const CHROME_UA = (() => {
  const electronVer = process.versions.chrome || '131.0.0.0'
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${electronVer} Safari/537.36`
})()

export const TIMEOUTS = {
  OPERATION: 1800000,
  CONFIRMATION: 30 * 60 * 1000,
  PAGE_LOAD: 30000,
  SEARCH_LOAD: 30000,
  SEARCH_POLL: 30000,
  SEARCH_WINDOW: 600000,
  CHECKOUT_NAV: 30000,
  HEARTBEAT_INTERVAL: 5 * 60 * 1000,
  HEARTBEAT_LOAD: 30000,
  COOKIE_DEBOUNCE: 1500,
  COOKIE_MIN_INTERVAL: 1500,
  COOKIE_REVERSE_MIN_INTERVAL: 1000,
  SCHEDULED_CHECK: 60000,
} as const

export const WINDOW_SIZES = {
  SHOP: { width: 1280, height: 800 },
  CONFIRMATION: { width: 1100, height: 800 },
  VERIFICATION: { width: 900, height: 700 },
  SMALL: { width: 500, height: 600 },
} as const

export const KEYWORDS = {
  OFF_SHELF: ['已下架', '商品已下架', '宝贝不存在', '商品不存在', '已失效', '商品已失效', '已卖完', '暂时缺货', '该商品已下架', '商品已售罄', '此商品已下架', '页面不存在', '无法购买'],
  CART_SUCCESS: ['已加入购物车', '添加成功', '成功加入', '加入成功', '已添加至购物车'],
  CART_ERROR: ['不能购买', '无法购买', '已下架', '已失效', '已售罄', '宝贝不存在', '商品不存在', '已卖完', '缺货', '不能买了', '无法加购', '加购失败', '添加失败', '操作失败'],
  REBUY_BUTTONS: ['再买一单', '再次购买', '再来一单', '重新购买', '去购买', '立即购买', '再次下单', '追加购买', '复购', '一键复购', '再次下单', '继续购买', '买过', '还买'],
  CART_BUTTONS: ['加入购物车', '加购'],
  BUY_BUTTONS: ['领券购买', '立即购买', '马上抢', '立刻购买', '去购买'],
  LOGIN: ['登录', '注册', '扫码'],
  PAY_SUCCESS: ['支付成功', '交易成功', '订单已支付', '付款成功'],
  CAPTCHA_HINTS: ['请拖动', '滑块', '请完成验证'],
} as const
