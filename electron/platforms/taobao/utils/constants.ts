export const ORDER_API_URL = 'https://buyertrade.taobao.com/trade/itemlist/asyncBought.htm'

export const APP_ICON = require('path').join(__dirname, '../build/auto_shopping_app_icon.png')

export const CHROME_UA = (() => {
  const electronVer = process.versions.chrome || '131.0.0.0'
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${electronVer} Safari/537.36`
})()
