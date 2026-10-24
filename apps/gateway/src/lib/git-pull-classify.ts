// /git/pull 失败分类：只看仓库状态，不看 git 文案。
//
// 为什么必须这么写：git 的错误文案随版本和大区变（zh_CN 下 "fatal: 需要指定如何调和偏离的分支。"
// 在英文环境是 "fatal: Need to specify how to reconcile divergent branches"），
// 拼字符串判断会在换机器/换 locale 时静默失效；而仓库状态（porcelain v2 的 branch.upstream /
// branch.ab、u 行、rev-parse MERGE_HEAD/REBASE_HEAD）在哪个 locale 下都一样。
//
// 分类目标：把「用户能自己处理一步」的失败结构化成 200/409，把真正的故障（网络、权限、
// 远端不存在）留成 500 原样上报——不能让可操作失败伪装成服务端错误。

export interface PullFailureState {
  /** porcelain v2 的 `u ` 行：存在未合并路径（pull/merge/rebase 冲突都会留） */
  unmerged: boolean
  ahead: number
  behind: number
  /** `# branch.upstream` 缺失即没有跟踪分支，pull 无从谈起 */
  upstream: string | null
  /** 分离 HEAD（rebase 进行中也是分开头，调用方要先用 inProgress 区分） */
  detached: boolean
  /** 有任何工作区改动（含未跟踪）：脏树只在与「远端有更新」同时出现时才当成可操作失败 */
  dirty: boolean
}

export type PullFailureVerdict =
  | { kind: 'conflicts' }
  | { kind: 'diverged'; ahead: number; behind: number }
  | { kind: 'rebase-in-progress' }
  | { kind: 'merge-in-progress' }
  | { kind: 'detached-head' }
  | { kind: 'no-upstream' }
  | { kind: 'dirty-tree' }

export function parsePullFailureState(stdout: string): PullFailureState {
  const state: PullFailureState = {
    unmerged: false,
    ahead: 0,
    behind: 0,
    upstream: null,
    detached: false,
    dirty: false,
  }
  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd()
    if (!line) continue
    if (line.startsWith('# branch.upstream ')) {
      state.upstream = line.slice('# branch.upstream '.length)
    } else if (line.startsWith('# branch.head ')) {
      state.detached = line.slice('# branch.head '.length) === '(detached)'
    } else if (line.startsWith('# branch.ab ')) {
      const match = /\+(-?\d+)\s+(-?\d+)/.exec(line)
      if (match) {
        state.ahead = Number(match[1])
        state.behind = Math.abs(Number(match[2]))
      }
    } else if (line.startsWith('u ')) {
      state.unmerged = true
      state.dirty = true
    } else if (!line.startsWith('#')) {
      // 1/2/? 记录都代表工作区有东西，注意 porcelain v2 以 '?' 标记未跟踪
      state.dirty = true
    }
  }
  return state
}

/**
 * 判定顺序有语义，别随手调换：
 * 1. 未合并路径优先——这是 pull 冲突，前端已按 conflicts 字段提示「去解决冲突」；
 *    进行中的 rebase 也常有未合并路径，同样一句话能处理掉，所以不必再细分。
 * 2. rebase/merge 未完成排在分叉前面：此时 branch.ab 往往也是 +N -N，
 *    按分叉弹「选 rebase 还是 merge」会把用户带进死路（git 只会再回一句「先结束当前操作」）。
 * 3. 分叉按前端弹层契约返回 ahead/behind。
 * 4. 分离 HEAD / 无跟踪分支 / 脏树是配置与工作区层面的可操作问题。
 */
export function classifyPullFailure(
  state: PullFailureState,
  inProgress: { rebase: boolean; merge: boolean },
  // 请求里显式给了 remote/branch 时 pull 不依赖跟踪分支，缺 upstream 不再算可操作失败
  options: { explicitTarget?: boolean } = {},
): PullFailureVerdict | null {
  if (state.unmerged) return { kind: 'conflicts' }
  if (inProgress.rebase) return { kind: 'rebase-in-progress' }
  if (inProgress.merge) return { kind: 'merge-in-progress' }
  if (state.ahead > 0 && state.behind > 0) return { kind: 'diverged', ahead: state.ahead, behind: state.behind }
  if (state.detached) return { kind: 'detached-head' }
  if (!state.upstream && !options.explicitTarget) return { kind: 'no-upstream' }
  // 脏树只在「远端确实有更新」时才算可操作：behind=0 时 pull 没什么可拉，
  // 失败原因多半是网络/权限，按脏树报会掩盖真实错误。
  if (state.dirty && state.behind > 0) return { kind: 'dirty-tree' }
  return null
}
