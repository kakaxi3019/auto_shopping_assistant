interface PlatformLogoProps {
  platformKey: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export default function PlatformLogo({ platformKey, size = 'md', className = '' }: PlatformLogoProps) {
  const sizeClasses = {
    sm: 'w-7 h-7 rounded-lg',
    md: 'w-12 h-12 rounded-xl shadow-sm',
    lg: 'w-16 h-16 rounded-2xl shadow-md',
  }
  const containerClass = `flex items-center justify-center overflow-hidden flex-shrink-0 select-none ${sizeClasses[size]} ${className}`

  if (platformKey === 'taobao') {
    return (
      <div className={`${containerClass} bg-[#FF5000] border border-orange-500/20`}>
        {/* 淘宝经典优化版：使用极其干净利落的线条，绘制淘宝经典的“大微笑 + 购物包包”拟人化图形，杜绝拼字乱码感 */}
        <svg className="text-white" style={{ width: size === 'sm' ? '18px' : size === 'md' ? '30px' : '40px', height: size === 'sm' ? '18px' : size === 'md' ? '30px' : '40px' }} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
          {/* 包包提手 */}
          <path d="M35 32V25C35 16.5 41.5 12 50 12C58.5 12 65 16.5 65 25V32" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/>
          {/* 购物包身剪影 */}
          <path d="M20 32H80C85 32 88 36 87 41L80 81C79 86 74 90 69 90H31C26 90 21 86 20 81L13 41C12 36 15 32 20 32Z" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="8" strokeLinejoin="round"/>
          {/* 标志性的可爱微笑曲线 */}
          <path d="M32 54C40 64 60 64 68 54" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/>
          {/* 可爱的眼睛 */}
          <circle cx="38" cy="45" r="5.5" fill="currentColor"/>
          <circle cx="62" cy="45" r="5.5" fill="currentColor"/>
        </svg>
      </div>
    )
  }

  if (platformKey === 'jd') {
    return (
      <div className={`${containerClass} bg-[#E1251B] border border-red-500/20`}>
        {/* 京东经典：京东红背景，加上一只由极简圆弧构成、带有红色项圈的银白色科技小狗 Joy 的侧面大脑袋剪影 */}
        <svg className="text-white" style={{ width: size === 'sm' ? '18px' : size === 'md' ? '30px' : '40px', height: size === 'sm' ? '18px' : size === 'md' ? '30px' : '40px' }} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
          {/* 银色小狗大脸底色 */}
          <path d="M30 65C30 46 42 30 62 30C78 30 86 40 86 54C86 67 74 74 62 74" fill="#F3F4F6" stroke="#E5E7EB" strokeWidth="3" strokeLinejoin="round"/>
          {/* 垂下的耳朵 */}
          <path d="M40 33C40 33 28 44 28 58C28 67 34 71 38 67V33Z" fill="#D1D5DB" stroke="#9CA3AF" strokeWidth="2" strokeLinejoin="round"/>
          {/* 亮黑色大鼻子 */}
          <circle cx="86" cy="51" r="7" fill="#111827"/>
          {/* 小眼睛 */}
          <circle cx="64" cy="46" r="4.5" fill="#111827"/>
          {/* 经典的红色项圈 */}
          <path d="M40 70C48 77 58 75 63 71" stroke="#EF4444" strokeWidth="6.5" strokeLinecap="round"/>
          {/* 项圈上的小金扣 */}
          <circle cx="53" cy="74" r="3" fill="#FBBF24"/>
        </svg>
      </div>
    )
  }

  if (platformKey === 'pdd') {
    return (
      <div className={`${containerClass} bg-[#E02E24] border border-red-600/20`}>
        {/* 拼多多经典：拼多多标志红背景，中间是用多种明亮色块和白心组成的多彩拼接爱心（完美还原其心形拼图神髓） */}
        <svg className="text-white" style={{ width: size === 'sm' ? '18px' : size === 'md' ? '30px' : '40px', height: size === 'sm' ? '18px' : size === 'md' ? '30px' : '40px' }} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
          {/* 爱心主包围框 */}
          <path d="M12 35C12 20 28 12 50 32C72 12 88 20 88 35C88 60 50 88 50 88C50 88 12 60 12 35Z" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="7.5" strokeLinejoin="round"/>
          {/* 左侧黄色拼块 */}
          <path d="M26 31C29 23 37 21 43 27L33 41Z" fill="#FFC72C"/>
          {/* 右侧粉色拼块 */}
          <path d="M74 31C71 23 63 21 57 27L67 41Z" fill="#FF4E88"/>
          {/* 中间纯白核心拼块 */}
          <path d="M50 33L36 50H64L50 33Z" fill="currentColor"/>
          {/* 底部暖金拼块 */}
          <path d="M50 81L36 62H64L50 81Z" fill="#FF9E1B"/>
          {/* 左下小白圆形拼块 */}
          <circle cx="28" cy="53" r="8" fill="currentColor"/>
          {/* 右下粉红圆形拼块 */}
          <circle cx="72" cy="53" r="8" fill="#FF4E88"/>
        </svg>
      </div>
    )
  }

  // 默认未知平台降级
  return (
    <div className={`${containerClass} bg-gray-100 text-gray-500 border border-gray-200`}>
      <span className="font-bold uppercase text-[10px] tracking-tighter">{platformKey.substring(0, 2)}</span>
    </div>
  )
}
