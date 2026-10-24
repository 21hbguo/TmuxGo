// 逗号分隔的名单类环境变量解析集中在这里：仓库里没有统一的 env 模块（各 lib 直接读
// process.env），但「读哪个变量」属于组装根的职责，lib 只接收已解析的数组，
// 这样 lib 可测、也能被不同入口（index.ts / 测试）喂不同值。

/** 逗号分隔名单 → 去空白、丢空项、去重（保持声明顺序，方便日志与断言对齐） */
export function parseNameList(raw: string | undefined | null): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const name = part.trim()
    if (name) seen.add(name)
  }
  return [...seen]
}
