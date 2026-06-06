export interface PlatformConfig {
  key: string
  name: string
  icon: string
  color: string
  bgColor: string
  borderColor: string
  hoverBgColor: string
  domains: string[]
  searchUrlTemplate: string
}

export const PLATFORM_CONFIGS: PlatformConfig[] = [
  {
    key: 'taobao',
    name: '淘宝',
    icon: '🛒',
    color: 'text-orange-600',
    bgColor: 'bg-orange-50',
    borderColor: 'border-orange-100',
    hoverBgColor: 'hover:bg-orange-100/50',
    domains: ['taobao.com', 'tmall.com'],
    searchUrlTemplate: 'https://s.taobao.com/search?q=${keyword}'
  },
  {
    key: 'jd',
    name: '京东',
    icon: '📦',
    color: 'text-red-600',
    bgColor: 'bg-red-50',
    borderColor: 'border-red-100',
    hoverBgColor: 'hover:bg-red-100/50',
    domains: ['jd.com', 'jd.hk'],
    searchUrlTemplate: 'https://search.jd.com/Search?keyword=${keyword}'
  },
  {
    key: 'pdd',
    name: '拼多多',
    icon: '🏷️',
    color: 'text-pink-600',
    bgColor: 'bg-pink-50',
    borderColor: 'border-pink-100',
    hoverBgColor: 'hover:bg-pink-100/50',
    domains: ['pinduoduo.com', 'yangkeduo.com'],
    searchUrlTemplate: 'https://mobile.yangkeduo.com/search_result.html?search_key=${keyword}'
  }
]

export function getPlatformConfig(key: string): PlatformConfig | undefined {
  return PLATFORM_CONFIGS.find(p => p.key === key)
}
