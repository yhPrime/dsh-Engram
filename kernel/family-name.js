/** 0.34：族名规范化 + 从 action 文本推导具体族（纯函数，可复核）。 */

/**
 * 裸泛词：不能单独当族名（判据是**规范化之后**的整名）。
 * 0.34 拍板口径：「执行/操作/处理/其它动作」这类只有动词、没有对象的宽词拒绝；
 * 0.32 的 16 个宽族名（提交/推送/校验/修复/编写/验收/恢复/注册/沉淀/分类/部署/分析/整理/配置/执行/其它动作）
 * 同样不能作为新族名——它们正是这次要拆掉的存量宽族。
 */
export const GENERIC_FAMILY_NAMES = Object.freeze([
  '执行', '操作', '处理', '其它动作', '其它', '杂项', '干活',
  '校验', '验收', '分析', '整理', '编写', '提交', '推送', '注册', '还原', '测试',
  '修复', '恢复', '沉淀', '分类', '部署', '配置',
])

/** 族名长度上限（码点）：1–12 字短名词。 */
export const FAMILY_NAME_MAX_CHARS = 12

/**
 * 0.38：族名里禁止的零宽/不可见字符（在原始串上判，NFKC 会吃掉一部分）。
 * 覆盖 \p{Cf}（零宽空格/BOM/双向控制符…）、\p{Default_Ignorable_Code_Point}（Hangul Filler/变体选择符…）、U+2800 盲文空白。
 */
export const FAMILY_INVISIBLE_RE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/u

/**
 * 同义归一表：命令/工具写法 → 规范中文族名（键必须已经是归一后的形态：小写、单空格）。
 * 只收**语义唯一**的映射；「推送」「校验」这类裸词不在表里，交给泛词拒绝。
 */
export const FAMILY_ALIASES = Object.freeze({
  'git push': 'git 推送',
  'git commit': 'git 提交',
  'git tag': 'git 打标签',
  'git clone': 'git 克隆',
  'git status': 'git 查看',
  'git diff': 'git 查看',
  'git log': 'git 查看',
  'git show': 'git 查看',
  'git add': 'git 操作',
  'git stash': 'git 操作',
  'git checkout': 'git 操作',
  'git switch': 'git 操作',
  'git merge': 'git 操作',
  'git rebase': 'git 操作',
  'git pull': 'git 操作',
  'git fetch': 'git 操作',
  'git remote': 'git 操作',
  'git subtree': '发布构建',
  'git archive': '发布构建',
  'npm test': '跑测试',
  'npm run test': '跑测试',
  'pnpm test': '跑测试',
  'yarn test': '跑测试',
  'node --test': '跑测试',
  'npm install': '安装依赖',
  'npm i': '安装依赖',
  'pnpm install': '安装依赖',
  'yarn install': '安装依赖',
  'npm pack': '打包发布',
  'npm run build': '构建产物',
  'pnpm build': '构建产物',
  'yarn build': '构建产物',
  'dsh plugin': '安装插件',
  'skills sync': '同步技能',
})

/**
 * 机械归一 + 同义归一：NFKC、trim、折叠空白、拉丁小写、中文之间的多余空格去掉；
 * 最后按别名表折到规范族名。中文本身不变。
 *
 * 「只差大小写/空格」必须折成同一个键（0.34 唯一性拍板）：
 * `跑 测试` / `跑测试` → `跑测试`，`GIT  PUSH` → `git 推送`。
 */
export function normalizeFamilyName(raw) {
  let text = String(raw === undefined || raw === null ? '' : raw).normalize('NFKC').trim()
  if (text === '') return ''
  text = text.replace(/\s+/gu, ' ').toLowerCase()
  // 中文之间的空格没有语义（「跑 测试」「改 文档」），折掉才能保证族键唯一；
  // 拉丁词与中文之间的空格保留（git 推送 / 改 react 页面）。
  text = text.replace(/(?<=[\p{Script=Han}]) +(?=[\p{Script=Han}])/gu, '')
  return FAMILY_ALIASES[text] || text
}

/** 规范化后是否是裸泛词（空名不算泛词，由调用方单独报「不能为空」）。 */
export function isGenericFamilyName(raw) {
  const name = normalizeFamilyName(raw)
  return name !== '' && GENERIC_FAMILY_NAMES.includes(name)
}

/** 由具体动作文本推导族名；认不出返回 ''（由调用方决定未分族/删除）。 */
export function specificFamilyOf(actionText) {
  const text = String(actionText === undefined || actionText === null ? '' : actionText).trim()
  if (text === '') return ''
  const lower = text.toLowerCase()
  // 命令/工具优先
  if (/git\s+push/.test(lower)) return 'git 推送'
  if (/git\s+commit/.test(lower)) return 'git 提交'
  if (/git\s+tag/.test(lower)) return 'git 打标签'
  if (/git\s+subtree|git\s+archive/.test(lower)) return '发布构建'
  if (/git\s+clone/.test(lower)) return 'git 克隆'
  if (/git\s+(status|diff|log|show)\b/.test(lower)) return 'git 查看'
  if (/git\s+(add|stash|checkout|switch|merge|rebase|pull|fetch|remote)\b/.test(lower)) return 'git 操作'
  if (/npm\s+(run\s+)?test|node\s+--test|npm\s+test/.test(lower)) return '跑测试'
  if (/npm\s+(install|i)\b|pnpm\s+install|yarn\s+install/.test(lower)) return '安装依赖'
  if (/npm\s+pack/.test(lower)) return '打包发布'
  if (/npm\s+run\s+build|pnpm\s+build|\bbuild\b/.test(lower)) return '构建产物'
  if (/asar/.test(lower)) return '解析 asar'
  if (/get-content|readfile|\bcat\s/.test(lower)) return '读取文件'
  if (/set-content|writefile|\bwrite\s/.test(lower)) return '写入文件'
  if (/move-item|move\s/.test(lower)) return '移动文件'
  if (/copy-item|copy\s/.test(lower)) return '复制文件'
  if (/remove-item|\brm\s|\bdel\s/.test(lower)) return '删除文件'
  if (/new-item|mkdir/.test(lower)) return '新建目录'
  if (/select-string|\bgrep\b|\brg\s/.test(lower)) return '搜索文本'
  if (/test-path/.test(lower)) return '检查路径'
  if (/start-process|electron/.test(lower)) return '启动程序'
  if (/workflow/.test(lower)) return '跑 workflow'
  if (/dsh\s+plugin|plugin\s+add/.test(lower)) return '安装插件'
  if (/skills\s+sync|sync\s+--into/.test(lower)) return '同步技能'
  if (/provider|adapter/.test(lower)) return '改 provider'
  if (/rename\s/.test(lower)) return '重命名目录'
  if (/断言|测试用例/.test(lower)) return '写断言'
  if (/探针|probe/.test(lower)) return '跑探针'
  if (/进程/.test(lower)) return '检查进程'
  if (/\block\b|锁/.test(lower)) return '改锁'
  if (/缓存|cache/.test(lower)) return '改缓存'
  if (/日志|log\b/.test(lower)) return '看日志'
  if (/realpath|路径/.test(lower)) return '改路径'
  if (/机制|流程/.test(lower)) return '改设计'
  if (/脚本|script/.test(lower)) return '写脚本'
  if (/迁移|migrate/.test(lower)) return '迁移数据'
  // 中文动作
  if (/修复|修\s*bug|hotfix|\bfix\b/.test(lower)) return '修复报错'
  if (/复现/.test(lower)) return '复现缺陷'
  if (/定位|排查|诊断/.test(lower)) return '定位问题'
  if (/验收/.test(lower)) return '验收产物'
  if (/校验|验证|对拍|回归/.test(lower)) return '跑校验'
  if (/编写|撰写|写文档|改文档|写教案|写计划/.test(lower)) return '编写文档'
  if (/生成|产出|导出/.test(lower)) return '生成产物'
  if (/整理|清理|归档/.test(lower)) return '整理目录'
  if (/沉淀|技能/.test(lower)) return '沉淀技能'
  if (/提交/.test(lower)) return '提交改动'
  if (/推送|上传/.test(lower)) return '推送发布'
  if (/注册|安装/.test(lower)) return '安装注册'
  if (/部署|发布|上线/.test(lower)) return '部署发布'
  if (/配置|设置/.test(lower)) return '修改配置'
  if (/恢复|回滚|还原/.test(lower)) return '回滚恢复'
  if (/分类|归类/.test(lower)) return '分类整理'
  if (/分析|调研/.test(lower)) return '分析调研'
  if (/对比|比较/.test(lower)) return '对比结果'
  if (/统计|计算/.test(lower)) return '统计结果'
  if (/转换|格式/.test(lower)) return '转换格式'
  if (/阅读|查看|读懂/.test(lower)) return '阅读资料'
  if (/确认|核对/.test(lower)) return '核对结果'
  if (/建立|创建|新建/.test(lower)) return '新建产物'
  if (/补充|补全|扩展/.test(lower)) return '补充内容'
  if (/改|修改|调整|优化|重构/.test(lower)) {
    if (/ppt|课件|教案|文档|页面|文案/.test(lower)) return '改文档'
    return '改代码'
  }
  // 明确有可执行步骤但认不出：返回 ''，由调用方落未分族，不删。
  return ''
}

/** 是否“完全无动作信息”（只在这种情况下允许删）。 */
export function hasNoActionInfo(actionText) {
  const text = String(actionText === undefined || actionText === null ? '' : actionText).trim()
  // 只删真正没有动作信息的行：空、纯标点/空白。
  // 有文字（含短句）但规则认不出的，一律落「未分族」待模型归类，不误删。
  return text === '' || !/[\p{L}\p{N}]/u.test(text)
}
