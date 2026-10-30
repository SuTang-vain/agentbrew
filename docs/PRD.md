# Agentbrew 产品需求文档

- 文档状态：Draft v0.14
- 文档目的：定义产品方向、首版需求、执行语义与验收边界
- 适用阶段：M1a–M3 的设计、开发与评审
- 实现语言：TypeScript + Node.js
- 实现状态：M1a、M1b、M2a、M2b-0、M2b-1、M2b-2、M2c 及 M3a 已实现；其余远程交付里程碑仍为设计目标
- 尚未冻结：Provider 通用接口字段；M2a 本地 layer schema v1、Bundle Release schema v1、source registration schema v1/v2、target registry schema v1 已冻结

本文使用“必须”“应”“可”三个要求级别：“必须”表示验收阻塞项，“应”表示无充分理由不得偏离的要求，“可”表示按场景启用的能力。

## 1. 背景与问题定义

AI 编程环境由宿主程序、扩展、skills、MCP、agents、commands、hooks、界面集成和个人偏好共同构成。这些资产分散在 dotfiles、宿主原生配置和插件目录中，并持续独立变化。

个人用户在第二台机器、第二个客户端或第一次升级事故出现后，需要配置管理；团队使用后，进一步需要公共基线、个人私有覆盖、凭据隔离和按人员交付。文件复制只能证明内容落盘，不能证明扩展与宿主兼容，也不能证明运行时已经加载。

现有 chezmoi 配置和更新脚本已经提供“一条命令完成更新”的基本体验。Agentbrew 需要在此基础上解决跨机器、跨用户和跨运行时的一致性，同时避免引入复杂的统一配置语言。

## 2. 产品定位与决策

Agentbrew 是一个本地优先、Git 原生、面向个人与小团队的 AI 工作环境配置与升级工具：

> 用少量声明描述期望使用的 AI 资产，保留原生文件，在每台机器和每个用户环境中独立完成安装、升级与健康验证。

Agentbrew 首先是 Pi/herdr 环境调节与健康控制面，后续依据真实需求扩展其他资产和客户端。其长期价值在于状态、权限、安全执行和运行证据，而不是一次性生成配置或简单封装更新命令。

已确认的产品决策：

1. 独立开发，不 fork、不绑定 Sx；Sx 仅作为设计参考，未来可按需互操作。
2. 从 Pi/herdr 核心闭环起步，逐步扩展 skills、MCP 和其他客户端。
3. 配置按命名资源组合，不做任意原生文件字段级深度合并。
4. 提供个人兼容通道和团队固定通道，本机记录实际版本。
5. 首版支持管理员 SSH 逐用户交付；逐用户连接为默认，高权限切换为显式受信选项。
6. 以单一 CLI 为主要形态，不强制账号、daemon 或控制平台。
7. 同时服务人类和 Agent：模型可以提议，Agentbrew 负责确定性校验与执行，用户负责授权。
8. 首次使用必须先只读检测并解释现状，再由用户选择观察、收养、修复或整理；只有不存在可用配置时才允许 Fresh install，首版不提供 Reset。

## 3. 产品原则

### 3.1 简洁与可理解

- 普通用户日常只需理解 `update`、`diff`、`doctor`。
- 默认输出目标、变更摘要、健康结果和下一步，详细信息按需展开。
- 本地与远程交付复用相同命令、输出和错误语义。
- 明确区分“无需更新”“已取消”“未执行”“已安装但不健康”和“部分完成”。
- Bundle 保持短小可读；本机计划、lock、缓存和健康记录不要求用户编辑。

### 3.2 用户自定义容忍度

- 默认不接管，只有用户明确选择后才提高管理级别。
- 保留原生文件工作流，不要求全面迁移到新 DSL。
- 不受管文件和区域不得修改。
- 自定义配置可以先被观察和验证，再逐步收养和规范化。
- 安全限制不得通过隐蔽自动转换绕过；可执行内容始终按代码处理。

### 3.3 安全默认

- 默认最小权限、显式目标、显式信任和默认脱敏。
- 常规兼容更新不反复确认；权限提升、信任变化、受管内容覆盖和远程批量执行必须确认或预先授权。
- 不以更多弹窗替代安全设计，不以单一 `--yes` 合并绕过不同风险授权。
- 不承诺第三方代码安全，不承诺全局原子升级或无条件回滚。

## 4. 目标用户与核心任务

### 4.1 个人多机用户

同时使用 macOS 与 Linux，希望共享配置意图而不共享宿主路径、精确宿主版本和机器状态，并通过一条命令安全更新。

### 4.2 小团队配置维护者

向成员提供经过评审的公共或内部基线，允许个人私有覆盖，并能解释配置来源、版本选择、漂移和健康结果。

### 4.3 共享服务器用户与运维人员

多名人员在同一台 Linux 服务器使用独立配置。运维人员可以集中触发交付，但产品不集中收集个人私有仓库内容和秘密。

### 4.4 配置浏览者与潜在采用者

查看公共 Bundle、资源说明和适用场景，从公共示例开始而不公开个人私有层。

### 4.5 使用 Agent 的用户

让 Agent 帮助理解、收养和规范化配置，但不授予模型无约束写文件、执行代码或提升权限的能力。

## 5. 范围

### 5.1 首版目标

1. 完成 Pi/herdr 宿主、扩展、插件和相邻原生配置的闭环。
2. 用一条主命令完成来源刷新、解析、升级和健康验证。
3. 消除日常共享配置中的宿主精确版本传递和人工版本抄写。
4. 支持观察、收养、受管和生成四种配置所有权级别。
5. 支持公共、团队、个人和机器配置层的确定性组合。
6. 支持个人兼容通道和团队固定 Release。
7. 支持管理员通过 SSH 向同服务器的多个 Unix 用户交付。
8. 提供稳定、脱敏的结构化状态与结果，为 Agent 接入奠定基础。
9. 提供首次使用只读检测、环境分类、选择性最小安装和初始化后健康验证。

### 5.2 非目标

首版不建设或承诺：

- 通用 Nix、Ansible 或 chezmoi 替代品。
- 覆盖所有 AI 工具字段的统一 DSL。
- 通用公共 Registry、Vault 或全量包管理器。
- API key、Cookie、SSH 私钥等秘密的存储与分发系统。
- live session、聊天历史、工作区文件或运行中任务同步。
- 同一 Unix 账号下不同 Profile 之间的人员安全隔离。
- Web 控制台、复杂 RBAC、计费或企业审计平台。
- 全局事务、所有宿主无条件降级或第三方代码安全证明。
- 通过 Reset、清空或覆盖已有配置来提供所谓的“干净安装”。

## 6. 核心概念

- **命名资源**：具有稳定类型和名称的管理对象，例如 Pi 扩展、herdr 插件或受管文件块。
- **配置层**：公共、团队、个人或机器来源提供的一组资源声明。
- **Bundle**：配置层合并后的期望状态，不是本机状态转储。
- **Bundle Release**：团队评审后的不可变 Bundle 版本，可固定资产版本并记录完整性信息，但不包含机器路径和宿主精确版本。
- **解析计划**：针对明确用户、主机、目标宿主和来源不可变引用生成的执行计划。
- **本机状态**：实际版本、宿主信息、部署快照、资源所有权和健康结果。
- **Provider**：某类资源的检测、安装、移除、升级、验证和恢复实现。
- **目标宿主版本**：本次计划准备达到的宿主版本，可能与当前运行版本不同。
- **健康状态**：运行时实际发现并加载资源后的结果，而非仅检查文件存在。

配置数据必须分为三类：

1. 共享意图：名称、来源、必要约束、通道和覆盖策略。
2. 本机派生结果：解析版本、绝对路径、目标宿主和执行计划。
3. 运行时证据：实际加载状态、失败原因和最近验证时间。

## 7. 功能需求

### FR-01：Pi/herdr 原生闭环（P0）

- 必须支持采用现有 Pi/herdr 配置及 chezmoi 管理的相邻原生文件。
- Pi 侧必须覆盖宿主检测与更新、npm 扩展及相关原生配置。
- herdr 侧必须覆盖插件、配置和 Pi 集成。
- 元数据只描述资源身份、来源、适用范围、更新策略和必要约束。
- 必须能够解释资源的配置层来源、版本选择原因和目标路径。
- skills/MCP 等其他资产通过后续 Provider 增加，首版不重复实现其完整生态。

### FR-02：配置所有权与自定义容忍度（P0）

每个资源或文件区域必须属于以下一种所有权级别：

| 级别 | Agentbrew 行为 | 用户直接编辑 |
|---|---|---|
| 观察 Observe | 只识别、解释和验证，不修改 | 完全允许 |
| 收养 Adopt | 纳入清单、diff 和 doctor，不自动升级或收敛 | 完全允许 |
| 受管 Manage | 管理指定资源或文件块，支持升级、漂移检测和恢复 | 允许，但会形成漂移 |
| 生成 Generate | 文件或文件块由 Agentbrew 完全生成 | 应修改来源而非生成物 |

补充要求：

- 默认采用级别不得高于 Observe；提高级别必须显式选择。
- 不受管文件及文件中的不受管区域不得修改。
- 受管资源必须支持 `compatible`、`fixed`、`manual` 更新策略。
- `manual` 资源可以参与检查，不得被普通 `update` 自动升级。
- 团队策略可以限制个人提高或降低管理级别，但必须给出可解释的冲突结果。
- 团队例外必须能够按资源、用户或机器表达，并支持可选有效期；无例外机制不得强迫用户脱离整个团队基线。

### FR-03：命名资源组合（P0）

- 资源默认以“类型＋名称”标识，来源用于解析和追溯。
- 配置层优先级固定为：公共 < 团队 < 个人 < 机器。
- 支持增加、移除和显式覆盖资源；同名资源没有明确覆盖策略时必须报告冲突。
- 覆盖以完整资源声明为单位，不进行任意 JSON/TOML/YAML 字段深度合并。
- 团队可声明必需资源和禁止资源；个人或机器层不得覆盖必需项或引入禁止项。
- 必需与禁止策略用于交付和冲突校验，不宣称能够抵抗目标用户在本机绕过工具。
- 原生文件只支持整文件资源或带明确所有权的受管块。
- 未知资源类型或缺少必需 Provider 时必须在计划阶段显式失败；可跳过项必须事先具有平台或可选条件，不能静默忽略。

### FR-04：版本通道与本机解析（P0）

#### 个人兼容通道

- 默认记录资源名称、来源和必要兼容约束。
- 根据目标宿主选择最新且能够证明兼容的资产版本。
- 不在 Mac/Linux 或不同用户之间传递 Pi/herdr 宿主精确版本。
- 兼容信息不足时不得把“最新”视为“兼容”：已有健康资源应保持并警告，新必需资源必须阻塞；用户请求的升级因此未完成时，整体结果不得显示为全部成功。

#### 团队固定通道

- 团队通过 Git 评审发布 Bundle Release。
- Release 可以固定插件和资产版本，以复现兼容宿主上的团队资产集合。
- Release 可以声明宿主兼容范围，不得共享宿主精确版本。
- 固定资产与目标宿主不兼容时必须失败，不能静默换成其他版本。
- 当前宿主不在兼容范围时，只有宿主更新策略允许，才可计划升级至范围内版本；否则必须阻塞并说明处理方式。
- Release 可从已验证本机快照生成，只提升资源版本和完整性信息，剥离宿主路径和机器状态。

#### 通道裁决与本机状态

- 生效资源的最高优先级完整声明决定其版本通道，不在不同层之间拼接通道字段。
- 团队必需固定资产不得被个人兼容通道覆盖；非必需资源只有显式覆盖时才可改变通道。
- 普通 `update` 不得把本机精确版本反向写回共享 Bundle。
- 本机状态必须记录实际版本、目标宿主、来源不可变引用和健康结果。
- 本机记录是派生产物，不默认作为跨机共享输入；只有显式发布 Release 才能提升其中允许公开的部分。

### FR-05：Provider 与资产生命周期（P0）

- 必须支持查看、安装、移除、升级和验证受管资源。
- Provider 必须声明能力，不能支持的操作必须返回“不支持”，不能伪装成功。
- Provider 必须区分文件写入、宿主发现和运行时加载。
- Provider 必须声明检查操作是否可能产生副作用；`diff/doctor` 不得调用会修改受管资源的检查方式。
- 运行时加载型检查可能执行被检查代码，必须遵守相同的代码信任策略；无法保证检查方式只读时，必须降级为静态检查并将运行时健康标为未知，不得以“只读检查”名义执行未知代码。
- 外部成熟工具可以作为 Provider 后端，但不得形成不可替换的硬依赖。

### FR-06：漂移、快照与恢复（P0）

- 检查必须能够识别缺失、版本变化、受管内容变化和运行时异常。
- 手工修改受管内容后，未经显式收敛或预先授权不得静默覆盖。
- 生成文件必须具有可验证的所有权标记，不得覆盖同路径非受管内容。
- 每次修改前必须保存必要的本机快照，包括解析计划、实际版本、受管文件备份和最近健康状态。
- 恢复以 Provider 能力为准，不自动在失败时触发全局回滚。
- 部分资源已修改而其他资源失败时，必须给出逐项状态和剩余恢复步骤。
- `restore` 本身也是修改操作，必须重新进行目标、权限和信任检查。
- 宿主降级、上游制品不可用和 live session 状态不属于无条件可恢复范围。

### FR-07：管理员 SSH 多用户交付（P0）

- 必须以独立 Unix 用户作为人员隔离边界。
- 每个用户必须使用独立 HOME、配置、状态、日志、运行时和私有凭据。
- 管理员可以对明确选择的多个 `用户@主机` 目标执行检查、更新和健康验证。
- 控制端只下发操作和目标，不下发一份跨用户复用的解析计划；每个目标必须在本机重新解析。
- 私有仓库必须由目标用户使用自己的凭据获取，控制端不统一拉取后分发。
- 目标之间失败隔离，一个目标失败不得被其他目标成功掩盖。
- 不得通过常驻共享 root 进程集中读取个人私有配置。
- 检测到共享可写宿主环境时，不得让某一用户的更新隐式影响其他用户。

### FR-08：首次使用检测与最小安装（P0）

#### 只读检测与摘要

- `agentbrew init` 必须提供首次使用入口；无参数 `agentbrew` 可以进入相同流程，但在用户明确选择前只能执行只读检测。
- 首次检测必须组合 `inspect/diff/doctor`，识别当前宿主、已有配置、生成内容、集成状态、所有权和可修复项。
- 默认输出必须是聚合摘要，至少说明发现了什么、是否健康、会否修改、可选下一步；逐项差异通过 `--verbose` 查看。
- 首次检测不得自动执行 npm selftest、安装代码、获取锁或写入受管资源。

#### 环境分类

- **无可用配置**：目标不存在可用 Pi 配置，可以进入 Fresh install。
- **已有且健康**：不得强迫用户规范化，直接提供使用、检查或更新选项。
- **已有且可修复**：存在缺失链接、过期集成或可规范化声明，提供分级处理选项。
- **损坏或未知**：只提供诊断、保守修复和人工确认，不得建议通过清空来规避问题。

“目录存在”不等于“已有可用配置”；空目录与含有效配置必须区别处理。无法证明目标为空时，不得按 Fresh install 执行。

#### 已有配置的选择

- **保持现状，仅观察**：不修改，后续只使用 inspect/diff/doctor。
- **收养但不自动更新**：纳入清单和健康检查，不自动升级或收敛。
- **仅修复生成内容**：只修复宿主链接和生成集成，不升级扩展、不改写个人配置。
- **整理并接管**：先展示完整计划和资源选择，用户明确勾选后才规范化。

默认不得预选破坏性最高的“整理并接管”。已有配置不得进入 Reset、清空或全量覆盖流程。

#### 无配置的最小安装

- Fresh install 只能针对明确为空的全新目标目录，首版不提供 Reset。
- 最小结构只包含必要目录、npm manifest、当前宿主对应的 host-link/host-deps 和必要 peer 依赖。
- 不自动创建凭据，不伪造宿主，不默认安装全部插件或第三方资产。
- 检测不到宿主时，必须停止并提供独立安装宿主的选项或人工指引，不能生成表面完整但不可用的环境。
- 必需项和可选项必须分组展示；可选项说明用途、依赖和副作用，不得默认勾选全部可选资产。
- 选择交互应支持简单编号或等价的可访问终端方式，不依赖复杂全屏界面。

#### 执行与退出

- 初始化必须遵循“检测 → 分类 → 选择 → 计划 → 授权 → 加锁与快照 → 选择性 apply → doctor”的顺序。
- `update` 不得替代选择性初始化，因为 update 是完整升级流程，而 init 只能执行用户勾选的最小计划。
- 初始化必须幂等；重复运行不得重复创建资源，中断后不得把未完成状态显示为成功。
- 非交互模式必须显式提供配置分类和资源清单；单一 `--yes` 不得替代资源选择、代码信任或权限授权。
- 用户取消或仅选择观察时，结果必须明确为未修改，不得生成最小结构或触发更新。

### FR-08a：常驻交互工作台（默认只读，P0）

- 无子命令、没有 JSON/init/其他执行选项且终端支持 raw mode 时，`agentbrew` 必须进入前台常驻 TUI；`--agent-dir`、`--state-dir` 和 `--layer` 可以指定本次上下文。`--write` 只能用于该无子命令 TTY 入口，不得与子命令、JSON 或 init/其他执行选项组合。非 TTY 裸命令继续输出帮助，非 TTY `--write` 返回用法错误；显式 `init` 和现有脚本调用保持不变。
- 不支持视觉终端的交互环境，普通裸命令使用既有 line-oriented init fallback；`--write` 不可用时必须返回用法错误，不得在 fallback 中隐式写入。`NO_COLOR` 只关闭颜色，不得关闭可用 TUI。
- TUI 是用户前台进程，不是 daemon，不得后台自更新或扩大第 9 节的权限边界。
- 页面固定为 Overview、Targets、Health、Differences、Update preview、Sources 和 Help。Help 必须列出其他真实写操作对应的明确 CLI 命令，不得把预览或远程检查描述为已经执行更新。
- 无论是否传入 `--write`，首屏都只能执行本地只读环境评估，标题显示与 `--version` 同源的 Agentbrew 自身版本，并展示目标、Pi/herdr、环境分类、健康与差异摘要、来源、目标计数和安全边界。启动及普通刷新不得联网 resolve、发起 SSH、写 state、获取 operation lock、执行真实更新或 selftest。
- Health、Differences 和 Sources 必须分别复用 doctor、只读 diff 和 source list 的 CommandResult，不复制版本、健康或来源裁决。Update preview 必须使用独立的 `dryRun=true` context 调用既有 update 流程，不能把 dry-run 或 selftest 状态泄漏到其他页面。
- Health、Differences 和 Sources 首行必须分别显示健康计数、差异数量和来源状态；默认简洁视图保留 FAIL/WARN、DIFF、计划与执行步骤，隐藏常规 PASS 和详细解析证据。`v` 只切换当前结果的简洁/完整视图，不得重新执行操作、联网或写 state；Help 往返及取消预览恢复原页面时保留详情状态。
- Targets 必须区分 unknown、checking、healthy、attention、offline、unavailable 和 error，不得把未检查或离线计入健康。`t` 打开页面，↑/↓ 选择，`r` 只检查当前目标，`v` 展开允许公开的连接和检查详情；结果只保留在会话内，其他目标状态不得被覆盖。远程写操作即使在 `--write` 下也不得开放。
- 显式 layer 始终优先于注册来源；注册来源在每次 TUI 操作前重新读取和校验。绑定损坏时不得使用上一次成功内容，也不得回退原生批量更新。Sources 的 `r` 只能重读本机绑定和已记录 commit，必须提示 `agentbrew source refresh` 才能前进 Git 远端，不得把两者混称。
- 方向键和 Enter 用于导航，PageUp/PageDown 按视口滚动，Home/End 到菜单或结果首尾，`r` 刷新、`Esc` 返回、`q`/Ctrl+C 退出；数字 1–6 保留既有页面映射，Targets 只使用 `t`。同一时刻只允许一个操作，重复按键不得重复启动。只读异步预览或单目标 SSH 检查可以用 Esc 中止并恢复原页面；操作进行中的退出请求必须等待操作 settled 后清理，不得宣称取消或回滚。
- 渲染必须适应 columns/rows 变化，支持内容滚动、长路径中间截断和窄终端单列；不得依赖固定宽度或复杂鼠标操作。溢出提示必须独占显示行，不得覆盖最后一项内容；最大滚动位置必须能读到真正的末行。
- 正常退出、输入结束、启动失败和渲染异常均必须幂等恢复 raw mode、光标和屏幕，移除本次会话监听器并输出简短关闭摘要；关闭摘要必须区分从未尝试写入与已经尝试写入。
- TUI 正常退出返回 0，页面内健康或更新结果不直接改变工作台退出码；显式子命令的结构化结果和退出语义不变，自动化不得依赖交互工作台的页面结果代替结构化命令结果。
- 默认模式不得提供可执行的写入口，不得执行 init、typed-plan apply、真实 update、selftest、source set/refresh/clear、Reset、Agentbrew 自更新或其他写操作。Help 可以说明写命令，但说明本身不得构成授权。
- `--write` 只为本机 target 上成功且包含 Pi 宿主或外部 npm 包版本更新的 resolved Bundle 预览启用 `u apply`，不得授权任何远程写操作。原生预览、失败或阻塞预览、无版本更新及仅修复预览不得从 TUI 直接执行；这些场景继续使用明确的 CLI 命令。
- `u apply` 必须先进入确认页，列出宿主与包的版本变化、计划中的 herdr 集成重建、selftest 不运行以及不可自动回滚；Update now/Cancel 必须固定在包列表之外，长列表滚动时仍同时可见。默认选中 Cancel，Cancel 或 Esc 不得产生写入。
- 确认后必须通过既有 update 流程以 `dryRun=false` 重新解析并复核当前来源和本机状态，预览缓存不得作为执行授权；执行仍须遵守第 8.2 节和第 19 节的授权、加锁、快照及健康验证要求，不得隐式运行 selftest。写入期间不可取消，退出请求等待操作结束；结束后展示真实结果，并在宿主或扩展变化时提示重启 Pi。终端恢复不代表回滚。

### FR-09：Agent 辅助规范化（P0 基础能力，P1 引导流程）

P0 必须提供：

- 稳定、版本化、默认脱敏的结构化输出和退出结果。
- 只读的 `inspect/diff/doctor/explain` 能力。
- 配置收养提案与执行分离；提案本身不得修改受管资源。
- 写操作、代码执行、权限提升和远程交付分别授权。
- Agent 不得批准自己提出的信任变更。

P1 可提供官方 Agent Skill 或引导流程，实现：发现配置、分类所有权、识别疑似秘密、生成最小 Bundle、预览 diff、由用户批准、执行并运行 doctor、生成团队 PR。

模型输出必须视为不可信提案。Agentbrew 必须重新验证资源名称、来源、版本、schema、路径和权限，不能直接执行模型生成的 shell 命令。

### FR-10：团队观测与公共浏览（P1）

- 团队成员可订阅只读团队基线并查看 Release 变更。
- 使用常规 Git 权限和评审，不自建平行账号体系。
- 集中上报必须显式启用，默认只保留本机结果。
- 公共 Bundle 可只读浏览，并展示来源、维护者、支持平台、最近验证状态和安装动作。
- 公共导出不得包含私有仓库地址、私有资源名称、敏感路径、秘密或私有内容。

### FR-11：Provider 扩展（后续）

- skills、MCP、其他客户端和更多原生文件类型依据真实需求逐个增加。
- 新 Provider 必须复用统一的计划、状态、解释、漂移和健康模型。
- 不以支持客户端数量作为首要目标，不要求所有 Provider 具有相同能力。
- 公共 Registry、桌面 App 和 Web 控制台在本地与团队闭环验证后另行评估。

## 8. 命令与执行语义

### 8.1 命令边界

日常命令为 `update`、`diff`、`doctor`，其余为进阶命令。命令名称可调整，语义不得混淆。

| 命令 | 输入与副作用 | 不得执行的行为 |
|---|---|---|
| `init` | 首次只读检测、环境分类和资源选择；确认后生成最小初始化计划并交由 apply 执行 | 默认整理已有配置、直接全量更新、Reset 或在空检测前写入 |
| `update` | 刷新允许的来源元数据，重新解析，执行升级并验证 | 自动升级 `manual` 资源、静默提升权限或替换 Agentbrew 自身 |
| `resolve` | 只读获取 release/npm 元数据，解析目标宿主、兼容资产版本、peer 证据和 integrity | 修改配置、获取锁、执行安装/selftest、把未知元数据当作兼容 |
| `diff` | 使用当前 Bundle 和可用缓存比较期望与实际状态 | 修改受管资源、强制刷新所有来源或执行安装代码 |
| `doctor` | 检查当前实际宿主、加载状态、集成和最近结果 | 修复、升级或改变配置以使其通过 |
| `apply` | 按当前 Bundle、选定 Release、初始化选择和已有解析/缓存选择性收敛 | 主动寻找所有最新兼容版本、扩大用户选择或刷新全部上游 |
| `inspect` | 输出当前实际资源、所有权和健康状态 | 修改受管资源 |
| `explain` | 解释来源、覆盖、版本选择和目标路径 | 修改受管资源 |
| `adopt` | 生成收养或规范化提案 | 默认直接应用提案 |
| `restore` | 按 Provider 能力恢复选定快照 | 无条件降级所有资源或恢复 live session |
| `deploy` | 在明确远程目标上执行指定操作 | 默认操作、默认全目标或复用跨用户解析计划 |

无子命令 `agentbrew` 按 FR-08a 进入默认只读工作台或兼容 fallback，不得因用户未输入子命令而默认写入；工作台真实更新只能经过该节定义的 `--write` 与确认流程，其他写操作继续通过明确 CLI 命令授权。显式 `agentbrew init` 继续提供选择性初始化流程。

“只读”指不修改受管资源；命令可以写入明确的元数据缓存、健康报告和日志，但必须在输出或文档中区分。除 `init` 已确认的最小安装计划外，`apply` 所需缓存或不可变来源不完整时必须阻塞并要求先 `update`，不得暗中刷新。初始化所需宿主或必要来源不完整时，按 FR-08 停止，不得以 update 代替初始化。

### 8.2 统一执行阶段

所有修改命令必须遵循以下阶段：

1. **目标确认**：确定用户、主机、权限模式和操作类型。
2. **来源读取**：读取完整配置层；来源失败时标记计划不完整。
3. **静态校验**：验证 schema、资源类型、Provider、路径、策略和冲突。
4. **本机解析**：确定目标宿主，再针对目标宿主解析资源版本和依赖。
5. **预检与暂存**：检查漂移、信任、权限和空间；下载仅进入缓存并完成完整性验证，不执行安装代码。
6. **计划确认**：展示目标、变更、删除、权限和信任变化，获取所需的独立授权。
7. **加锁、复核与快照**：获取目标用户级排他操作锁，重新验证实际状态和计划前提；若已变化则返回解析阶段，确认未变化后保存必要快照。
8. **执行**：按计划中的不可变来源引用执行，不在中途重新选择更高版本。
9. **验证**：运行与实际目标一致的 doctor。
10. **记录与摘要**：成功和失败均记录逐项结果，返回明确整体状态。

授权后若来源内容、目标身份、权限模式或信任摘要发生变化，必须停止并重新解析、重新确认，不能继续执行旧计划。

### 8.3 更新顺序与依赖

- 必须先确定目标宿主版本，再解析依赖该宿主的扩展。
- 计划升级宿主时，必须先完成宿主更新并验证其基本可执行性，再安装依赖新宿主的扩展。
- 宿主更新失败时，依赖目标宿主版本的后续扩展不得继续安装。
- 相互独立的资源可以继续；有依赖关系的后续步骤必须停止。
- 生成集成必须在其实际依赖的宿主和资源达到预期状态后重建。
- 下载和验证可以先于宿主更新完成，但暂存内容不得提前获得执行机会。

### 8.4 删除与来源不完整

只有同时满足以下条件才可删除资源：

1. 配置层读取完整，没有来源失败。
2. 删除出现在明确计划中。
3. 资源属于 Agentbrew 的受管或生成所有权。
4. 资源不是 Observe 或 Adopt；`manual` 资源只能由用户针对该资源显式请求删除，不能因自动收敛而被删除。
5. 删除不违反团队必需策略或依赖约束。

来源不完整时，可以经用户确认继续与缺失层无关的非删除升级，但不得进行依赖完整快照的删除性收敛，整体结果必须标记为部分完成。

### 8.5 并发控制

- 同一用户的 `init/update/apply/restore` 在实际写入前必须使用排他操作锁；init 的只读检测阶段不得提前持有锁。
- 远程目标与本地操作的锁必须覆盖同一实际状态，不能形成本地和 SSH 同时写入。
- `diff/inspect/doctor` 必须基于一致快照，遇到正在修改的状态时报告“检查期间状态变化”，不得输出伪一致结果。
- 多目标部署按目标独立加锁；共享运行时还需独立的全局协调，首版默认拒绝用户级更新共享可写宿主。

### 8.6 整体结果与退出语义

- **成功**：所有必需操作完成，必需资源健康；允许无变化成功。
- **已取消**：用户在修改前拒绝计划，没有受管资源变化；必须使用独立结果，不得被自动化视为成功更新。
- **未执行**：授权不足、预检失败或计划不成立，没有受管资源变化。
- **部分完成**：部分独立资源成功，但至少一项失败、被阻塞或来源不完整。
- **已安装但不健康**：安装动作完成，但运行时验证失败。
- **失败**：目标无法执行、关键宿主失败或整体计划无法成立。

已取消、未执行、部分完成、已安装但不健康和失败必须返回非零退出结果；输出不得只显示聚合成功数量。任何非零结果都必须说明是否已经发生修改，避免调用方误判副作用。

## 9. SSH 权限与交付模型

### 9.1 默认：逐用户连接

- 控制端使用目标账号授权的 SSH 连接。
- 私有 Git 凭据、秘密和运行时状态只存在于目标用户环境。
- 产品不要求控制端拥有目标主机 root 权限。
- 控制端清单只保存目标别名、公开连接信息和交付策略，不保存私有配置内容。

### 9.2 可选：高权限统一切换

- 管理员通过高权限账号登录，再切换到目标用户执行。
- 该模式必须逐目标显式启用，并在计划中持续标记权限提升。
- 主机 root/sudo 管理员属于信任边界；产品不得声称能够防止其读取用户文件。
- 公共引导与私有执行必须分离，读取私有来源和修改用户配置前应切换至目标用户。
- 即使在高权限模式下，产品也不主动汇总、导出或记录用户私有内容和秘密。

### 9.3 多目标交付

1. 明确操作和目标，不默认选择全部主机或用户。
2. 各目标独立完成解析、授权策略检查、快照、执行和 doctor。
3. 控制端默认只接收目标别名、状态、错误类别和允许公开的资源信息。
4. 任一目标失败不影响其他目标结果的真实性；聚合退出结果必须反映所有必需目标。
5. 并发目标数量必须可控，不能因共享凭据、缓存或运行时形成隐式耦合。

## 10. 安全、信任与隐私要求

- 普通安装和更新不得要求 root；权限提升必须逐目标显式启用。
- 单一 `--yes` 不得同时跳过目标确认、代码信任确认和权限提升确认；非交互环境必须分别预先授权。
- 秘密通过钥匙串、环境变量或秘密管理器引用，不进入 Bundle 和 Git。
- 私有凭据不得进入共享缓存、命令行参数、控制端清单或部署日志。
- 私有状态目录默认仅目标用户可访问。
- 所有写入必须限制在声明的目标根目录内；拒绝路径穿越、异常绝对路径和越界符号链接。
- 公共和团队 Bundle 首版只允许类型化安装动作，不提供无约束的通用 `run` 字段。
- 类型化动作只限制安装器行为，不代表被安装代码安全；扩展、插件、hook 等可执行内容均按代码处理。
- 团队固定 Release 必须记录可用的来源不可变引用和内容哈希；个人兼容通道也必须执行上游完整性检查。
- 首次来源、可执行内容或信任摘要变化必须按策略重新授权；普通文本变更不得成为绕过代码信任的通道。
- 个人本地脚本只有显式启用后才可执行，私有仓库不自动等于高权限信任。
- 外部调用使用结构化参数，不把 Bundle、用户名、路径或资源名称拼接成未转义 shell 命令。
- Agentbrew 自身更新必须显式触发并验证可信发布制品，不得后台静默替换可执行文件。
- 健康报告和结构化输出默认脱敏，不能依赖用户事后清理秘密。
- 公共配置可阅读不等于可自动执行；产品不宣称证明第三方扩展代码本身安全。

## 11. 人类与 Agent 交互要求

- 默认摘要必须让使用者能够回答：操作对象是谁、将改变什么、是否成功、是否健康、下一步是什么。
- 常规兼容更新不反复询问；高风险确认必须说明原因、范围和拒绝方式。
- 任何修改命令都遵循相同的计划、确认、执行和结果结构。
- 结构化输出必须具有 schema 版本，不能随显示文案变化而破坏自动化。
- Agent 默认只能读取脱敏状态并生成提案，不得直接获得秘密、写权限或权限提升。
- Agent 提出的配置必须经过与人类配置相同的静态校验、信任检查、计划和 doctor。
- Agent 不得自行批准其提案，也不得通过修改结构化输出宣称执行成功。
- Agent 接入不得增加普通人类用户必须理解的日常命令数量。

## 12. 验收场景

### AC-01：个人 Mac/Linux 协同

同一 Bundle 在两类机器上分别解析目标宿主和兼容扩展，不修改共享宿主精确版本，实际版本仅写入本机状态。

### AC-02：所有权与自定义配置

同一环境中同时存在 Observe、Adopt、Manage 和 Generate 资源。普通更新只修改符合策略的 Manage/Generate 内容，其他资源保持可读、可检查但不被改写。

### AC-03：团队固定 Release 与个人覆盖

团队 Release 与个人资源按优先级组合；必需固定项不可被兼容通道覆盖，非必需项只有显式覆盖才能改变通道。

### AC-04：从健康快照生成 Release

维护者生成 Release 时，工具提取允许公开的资源版本和完整性信息，剥离宿主路径、私有来源和机器状态。

### AC-05：目标宿主与更新顺序

计划升级宿主和扩展时，扩展针对目标宿主解析；宿主更新失败后，依赖新宿主的扩展不执行，结果明确显示失败或部分完成，并如实记录宿主是否已经发生变化。

### AC-06：固定资源不兼容

团队固定资产与目标宿主不兼容时，不静默选择其他版本；根据宿主策略给出允许的宿主升级计划或阻塞原因。

### AC-07：文件成功但运行时失败

资源文件已经写入但运行时加载失败时，结果为“已安装但不健康”，返回非零结果并记录已发生的修改。

### AC-08：漂移与恢复

受管内容出现手工修改时先显示漂移；未经批准不覆盖。恢复快照前重新检查目标、权限和信任，不能恢复的项明确列出。

### AC-09：私有来源不可用

来源失败时禁止依赖完整快照的删除性收敛，不误判资源已删除；继续执行的非删除升级必须标记整体部分完成。

### AC-10：同服务器两名用户

Alice 与 Bob 使用不同私有 Bundle，各自独立解析、加锁、执行和验证，不共享配置、凭据、进程和可写运行时。

### AC-11：两种 SSH 权限模式

逐用户连接不需要 root；高权限模式明确展示权限提升。两种模式产生等价用户级结果，私有内容不进入控制端日志。

### AC-12：并发与运行中变化

同一用户两个修改命令不能并发写入；检查期间状态变化会被报告。授权后来源引用、目标或信任摘要变化时，旧计划停止执行。

### AC-13：可执行内容信任变化

扩展、插件、hook 或可执行动作发生未经批准的变化时，该资源在执行前被阻止，普通文本更新不能绕过代码信任。

### AC-14：路径与命令注入防护

路径穿越、越界符号链接、异常绝对路径和 shell 特殊字符不会造成越界写入或额外命令执行。

### AC-15：日志与自更新安全

测试秘密和私有路径不出现在默认日志、结构化输出和远程摘要中；普通检查与更新不静默替换 Agentbrew 自身。

### AC-16：Agent 辅助规范化

Agent 能将散乱配置整理为所有权明确的收养提案，但不能直接应用、批准信任变更或读取秘密；用户批准后由 Provider 执行并通过 doctor 验证。

### AC-17：简洁交互

无风险常规更新只显示简洁计划与结果；高风险操作在同一说明中展示目标、原因、范围和拒绝方式，不通过连续泛化确认消耗用户注意力。首次检测默认显示聚合摘要，逐项 diff 只在 --verbose 中展开。

### AC-18：无配置的最小安装

在没有可用配置但存在可用 Pi 宿主的目标上，用户只勾选基础结构和 herdr 集成。init 仅创建所选最小内容，不创建凭据、不安装未选插件，并在结束后 doctor。缺少宿主时不得生成伪健康环境。

### AC-19：已有配置的选择

分别选择仅观察、收养、仅修复生成内容和整理接管。前三种不得执行全量升级或改写个人配置；第四种只能修改用户明确勾选且已出现在计划中的资源。

### AC-20：健康、损坏与未知目标

健康已有配置不得被强迫重新整理。损坏或未知目标不得进入 Fresh install 或 Reset；用户取消或仅观察时，目标内容保持不变。

### AC-21：选择性执行与非交互初始化

非交互 init 缺少明确分类或资源清单时必须停止，单一 --yes 不得补足这些授权。所有修改都限于所选计划，重复 init 不产生重复资源，中断不得被记录为成功。

### AC-22：常驻工作台与显式更新

支持视觉终端的裸 `agentbrew` 进入可导航工作台，首屏不创建 state/lock、不联网解析、不执行更新或 selftest。用户能够查看 Health、Differences、Sources 和 Update preview 的 dry-run，损坏注册来源不得回退原生更新；连续刷新和重复确认不得并发启动操作。默认模式没有可执行的写入口，说明写命令不会触发授权或修改。

结果首屏显示领域摘要并隐藏常规 PASS/详细证据，FAIL/WARN 和差异仍可发现；`v` 展开已有结果而不重新查询。PageUp/PageDown、Home/End 可导航长结果，最大滚动位置能看到末行；Sources 的本地 re-read 不会触发 Git refresh。

`agentbrew --write` 仅对无子命令的支持视觉 TTY 有效。成功且包含宿主或 npm 包版本更新的 resolved Bundle 预览可以通过 `u apply` 进入确认页；原生、失败、阻塞、无版本更新和仅修复预览没有 TUI apply 入口。确认页默认 Cancel，且 Update now/Cancel 在长包列表滚动时始终同时可见；取消或 Esc 不产生写入。确认后重新解析并复核当前来源和本机状态，不执行 selftest，写入期间不可取消，结束后展示实际结果并按需提示重启 Pi。

正常退出、输入结束及终端异常均恢复终端；关闭摘要不得把已尝试写入误报为未修改。非 TTY、JSON 和显式子命令行为保持兼容，页面健康或更新结果不替代显式命令的结构化结果与退出码。

## 13. 成功指标

- 首次使用者能否在不阅读开发文档的情况下说明当前状态、可选动作及其副作用。
- 首次检测与最小安装所需步骤数、默认输出条目数和错误分类次数。
- 用户选择仅观察或取消时发生受管修改的次数，目标必须为零。
- 新机器从 Bundle 到健康运行所需的人工步骤数。
- 日常升级所需命令数、确认次数和手工版本字段数。
- Observe/Adopt 模式下可被发现并验证的现有配置比例。
- 团队 Release 从健康快照生成时仍需手工填写的字段数。
- 运行时失败被 doctor 发现的覆盖情况。
- 用户能否正确理解目标、变更结果、健康状态和下一步。
- 同服务器用户之间是否发生配置、凭据或升级状态串扰。
- 越界写入、未授权执行、误提升权限和日志泄密是否被默认策略阻止。
- Agent 提案经校验后被拒绝的错误类型，以及用户完成规范化所需的人工修改量。

## 14. 建设顺序

### M1a：个人 Pi/herdr 纵向闭环

实现所有权基础、Pi/herdr Provider、本机解析、一条命令更新、排他锁、状态记录、受管集成重建和 doctor。先证明核心价值，不建设团队平台。

### M1b：首次使用检测与最小安装

实现 init 只读检测、环境分类、聚合摘要、已有配置分级选择、可选资源勾选、Fresh install、选择性 apply、非交互约束和初始化后 doctor。不得通过全量 update 或 Reset 代替该流程。

### M2：资源组合与双版本通道

- **M2a 已实现**：本地公共/团队/个人/机器层、命名资源完整覆盖、删除与策略校验、漂移解释、选择性 Bundle plan/apply、结构化收养提案，以及 fixed/manual 原生更新保护。
- **M2b-0 已实现**：Pi 原生 release 通道、npm 逐版本 peer/integrity 元数据、目标宿主与最新兼容资产只读解析，以及 macOS/Linux 结果验证。
- **M2b-1 已实现**：显式或注册 Bundle 复用同一不可变解析，完成宿主先行、精确扩展安装、锁内复核、状态记录和最终 doctor；每 target 来源注册及日常命令入口已实现。
- **M2b-2 已实现**：固定 Release、Pi managed installer 制品绑定、健康证据发布、团队例外和 Git 来源不可变缓存与刷新；执行合同见第 21 节。

### M2c：常驻交互工作台（默认只读，已实现）

- 裸 `agentbrew` 在支持视觉交互的终端进入前台 TUI，提供 Overview、Health、Differences、Update preview、Sources 和 Help；复用统一来源与 CommandResult，支持刷新、滚动、resize、防重入和可靠终端恢复。非 TTY、JSON 和显式子命令保持兼容。
- Health/Differences/Sources 使用领域摘要，默认隐藏常规 PASS 和详细证据，`v` 在不重新执行操作的情况下展开详情。PageUp/PageDown/Home/End 支持长列表导航，滚动状态行不覆盖末行；Sources 的 `r re-read` 与显式 `source refresh` 明确区分。
- Help 是非破坏性覆盖层，Esc 返回原页面并复用缓存结果；数字键直达页面，窗口化菜单显示位置指示。元数据预览按请求显示进度与已用时间，Esc 可中止在途只读预览并恢复原页面。
- 会话内缓存最近一次成功的预览并显示其年龄，`r` 强制重新解析；缓存不落盘，其键包含 layer 哈希、本机指纹与 ownership，任一变化即失效。预览页明确区分 ready、up-to-date、repairs planned 与 update 计数；无注册来源时解释如何获得可解析计划，而不是仅展示 native 步骤模板。
- `agentbrew --write` 只为成功且包含宿主或 npm 包版本更新的 resolved Bundle 预览开放 `u apply`。确认页列出宿主与包的版本变化、计划中的 herdr 集成重建、selftest 不运行和不可自动回滚，Update now/Cancel 固定可见且默认选中 Cancel；确认后重新解析并复核当前状态，不得把预览缓存当作授权。写入期间不可取消，结束后展示结果并在需要时提示重启 Pi。
- 未传 `--write` 时不得提供可执行的写入口；Help 中的写命令说明不构成授权。即使传入 `--write`，也只有前项确认的 resolved Bundle update 可以写入；init、typed-plan apply、selftest、source set/refresh/clear、Reset、Agentbrew 自更新等其他操作仍不得从 TUI 执行。

### M3：管理员 SSH 多用户交付

- **M3a 已实现**：local/SSH 目标注册、Overview 目标摘要、Targets 页面，以及 CLI/TUI 显式单目标只读检查；脱敏证据仅存于当前会话，启动不连接 SSH，不开放远程更新。
- **M3b 待实现**：单目标远程聚焦、独立 diff/resolve/update preview 与显式更新；必须复用目标端解析、锁和 doctor，不得复用控制端计划。
- **M3c 待实现**：明确选择的多目标 Deploy、高权限显式切换、受控并发、失败隔离和共享运行时保护。

### M4：按需求扩展生态

增加 Agent 引导流程、skills/MCP Provider、公共配置浏览及外部管理器互操作。网站或 Registry 另行评估。

## 15. 设计参考边界

从 Sx 参考共享声明与本机 lock 分离、明确身份与来源、Provider 适配、失败隔离及本机历史；不复制精确版本包作为唯一资产模型、通用 Vault/Registry、过多作用域、全客户端覆盖和托管产品路径。

Agentbrew 的差异化不是“比 Sx 多支持两个客户端”，而是：

> 共享配置意图，本机解析兼容版本，完成真实升级，并验证 Pi/herdr 运行时确实可用。

模型能力增强可以降低配置理解和迁移成本，但不能替代这些确定性状态、安全边界与运行证据。

## 16. 待技术验证问题

- Pi 扩展的宿主兼容信息可从哪些元数据可靠获得，缺失时如何落地保守策略。
- herdr 插件与 Pi 集成的真实加载检查命令及无副作用验证方式。
- 现有 `file:host-link`、host-deps 等方式如何抽象为 Provider 能力而不暴露机器路径。
- 团队固定 Release 中哪些资源必须固定，哪些可继续使用兼容范围。
- Pi/herdr 各自的恢复边界，以及宿主降级是否仅作为显式高级操作。
- 外部工具自身可能产生的缓存、遥测或状态写入如何识别，避免把“只读检查”误述为零副作用。
- Bundle Release schema 和 Provider 通用接口应通过后续纵向原型冻结；M2a 本地 layer schema 的兼容演进不得改变既有失败关闭语义。

## 17. M2a 本地配置层执行契约

### 17.1 输入与优先级

M2a 使用显式本地路径，不自动发现或拉取配置：

```bash
agentbrew explain \
  --layer public=./layers/public.json \
  --layer team=./layers/team.json \
  --layer personal=./layers/personal.json \
  --layer machine=./layers/machine.json
```

每种层最多出现一次，参数顺序不影响固定的 public < team < personal < machine 优先级。文件必须是普通 JSON 文件且不超过 1 MiB；读取失败、未知字段、未知 Provider 和不安全资源标识均失败关闭。

```json
{
  "schemaVersion": 1,
  "kind": "agentbrew-layer",
  "layer": "personal",
  "resources": {
    "npm:pi-subagents": {
      "source": { "type": "npm", "spec": "^0.84.0" },
      "update": "compatible"
    },
    "herdr.pi-integration": { "update": "manual" }
  },
  "override": ["npm:pi-subagents"],
  "remove": ["npm:unused-extension"]
}
```

- 同一资源再次声明必须显式列入 `override`；覆盖替换完整声明，不做字段深合并。
- `remove` 是显式 tombstone；删除后重新声明同样需要 `override`。
- `required` 与 `forbidden` 只允许 team 层。高优先级层不得覆盖或删除团队必需项，也不得使禁止项最终生效。
- M2a 支持外部 npm 包和既有 herdr Pi 集成。Pi 宿主及 `@earendil-works/pi-*` host-deps 保持本机派生，不得通过共享 layer 固定或传递。
- npm 只接受精确、`^` 或 `~` semver 约束；`fixed` 必须是精确 semver。M2a 不接受 URL、tag、任意 `run`、脚本或未类型化安装动作。
- 共享声明不提升本机所有权。任何 Bundle 写入仍需本机 `--mode manage`、逐项资源选择和计划复核。

### 17.2 解释与收养

`explain` 输出最终声明、获胜层、覆盖/删除历史、团队必需状态和目标位置。`adopt` 从现有配置生成独立的 personal-layer 文件，默认使用 `manual`，不推断兼容范围：

```bash
agentbrew adopt \
  --resource npm:pi-subagents \
  --output ./personal.proposed.json
```

提案以 `0600` 和排他新建方式写入，不能覆盖已有文件。它不修改 npm manifest、ownership、herdr 集成或本机 state；只有用户随后显式将其作为 layer 输入并创建计划，才可能进入执行流程。无法证明为便携 npm 约束的本地来源不会被自动转换。

### 17.3 选择性计划与执行

```bash
agentbrew diff \
  --layer personal=./personal.json \
  --mode manage \
  --resource npm:pi-subagents \
  --plan-out ./bundle-plan.json

agentbrew apply --plan ./bundle-plan.json
```

- 计划只包含所选且实际存在差异的资源，支持设置 npm 声明、删除具有 tombstone 的 npm 声明、确保 herdr 集成三类动作。
- `plan-out` 只写新计划并返回 `not-executed`；计划不接受任意命令，也不代表已经获得执行结果。
- apply 重新读取同一来源并核对 SHA-256、目标、manifest、package-lock、ownership、宿主/链接和集成前提。任何漂移或篡改都在受管写入前停止。
- 写入前使用目标排他锁，再次复核并保存 manifest、package-lock、链接、集成和计划快照。
- npm 使用 `--ignore-scripts --legacy-peer-deps`；Bundle apply 不更新宿主、不运行 selftest，也不顺带收敛未选资源。成功后才记录所选资源的 Manage/Generate ownership。
- doctor 同时检查声明与已安装包 manifest；精确、`^`、`~` 范围内的实际版本必须满足约束。该静态检查不声称扩展已被运行时加载，加载仍需显式 selftest。

### 17.4 M2a 原生 update 保护与历史边界

在 M2a 中，存在 Bundle 声明漂移时，普通 `update` 停止并指向选择性计划。fixed/manual 包已经安装时，由于 `pi update --all` 无法排除它们，M2a 返回 `not-executed`，不得先批量升级再声称策略成立。compatible 声明一致且本机 ownership 允许时，保留原生更新并在结束后复查健康。M2b-1 的 Bundle 执行路径已由第 19 节替代这一限制。

M2a 的 `fixed` 是本机严格声明策略，不是团队固定 Release；来源文件哈希用于本机计划复核，不替代上游制品完整性或签名。远程 Git 刷新、Release 发布和 Pi 宿主制品绑定按第 21 节实现；通用 herdr 插件安装、herdr 集成删除、签名和可恢复格式仍未实现，不得以成功输出推断。

## 18. M2b-0 真实元数据解析契约

### 18.1 只读命令与来源

```bash
agentbrew resolve \
  --layer public=./public.json \
  --resource npm:pi-subagents \
  --verbose
```

`resolve` 至少需要一个显式 layer，`--resource` 可重复限定范围。它只读取 Pi 原生 `https://pi.dev/api/latest-version` release 通道和 npm registry JSON，不读取 npm 凭据、不下载或执行包代码、不创建 state、不获取锁，也不执行 Pi/npm/herdr 更新或 selftest。`PI_OFFLINE=1` 必须在网络访问前返回未执行。

元数据客户端使用 Node 内置 fetch、HTTPS、重定向拒绝、超时和响应大小限制；测试只允许显式 loopback HTTP 或 fetch double。包名和精确版本在构造 URL 前校验，HTTP 状态和响应错误不得泄露响应秘密。

目标宿主的 release 与 manifest 因数据依赖保持串行；各 compatible 资源的 packument 只依赖已确定的宿主版本，必须以有界并发（默认最多 4 个在途请求）发起，使延迟取决于最慢请求而非总和。并发不得改变评估顺序：报告中的资源和错误仍按资源 ID 排序，单个资源失败只影响该资源。

调用方可通过 `AbortSignal` 取消在途请求。取消与超时必须可区分，且取消不得写入 state、获取锁或触发任何受管步骤；交互式预演应在取消后恢复原视图并明确提示未执行。

### 18.2 目标宿主与资产选择

1. 校验 release 的精确 semver 和包身份。release 较新时作为目标宿主；相同或较旧时保持当前宿主，不计划降级。
2. 读取目标宿主的精确 registry manifest，提取内部 Pi 依赖和 `dist.integrity`。宿主需要更新而 manifest/integrity 不可用时必须阻塞。
3. compatible 资源按 semver 从新到旧检查 packument，必须同时满足 Bundle 约束、所有可识别 Pi peer 约束和 integrity 要求；最新候选不兼容时可回退到较旧兼容候选。
4. fixed/manual 只评估当前安装版本，不寻找升级版本。
5. peer 映射使用目标宿主或其精确内部 Pi 依赖。支持的 range 包括 exact、`^`、`~`、`*`、比较运算符、空格 AND 和 `||`；x-range、连字符范围、tag、URL 及其他不理解的形式必须标为 unknown。

解析输出包含 current/target version、update/keep/unknown/blocked 动作、peer 证据、integrity 和原因。metadata 兼容性是执行前的静态证据，不等于上游制品已验证、宿主绝对兼容或运行时加载成功。

### 18.3 unknown、ready 与 complete

- 没有 Pi peer、peer 映射缺失、range 不支持或本机包不可信时不得选择该候选。
- 新团队必需资源遇到 unknown 必须 blocked；已有健康资源可以保持并警告。
- 目标宿主需要变化且任一现有资源 unknown 时，`ready=false`，后续宿主更新必须保持阻塞。
- 来源错误使解析不完整；即使没有来源错误，`ready` 仍要求没有 blocked，且宿主变化时没有 unknown。
- `complete=false` 表示存在 unknown 或来源错误；它是完整性信号，不能单独被解释为可执行授权。

只读诊断可以在 unknown 警告下成功返回；必需项、来源错误或明确不兼容导致无法形成可信结果时必须失败。普通 `update` 在 M2b-0 仍保持既有执行顺序和保护，不展示或执行这套新计划。M2b-1 必须复用同一解析结果完成宿主先行、按不可变版本执行和最终 doctor，不能另行发明版本选择逻辑。

## 19. M2b-1 不可变解析执行契约

### 19.1 入口与授权边界

```bash
agentbrew update --layer public=./public.json --dry-run
agentbrew update --layer public=./public.json
```

- 带显式或注册 layer 的 `update` 必须调用第 18 节同一 `resolveConfiguration`，不得另写版本选择逻辑。dry-run 展示目标宿主、每个资源的 current/target version、update/keep/unknown 动作及后续步骤，不写 state、不获取锁、不执行 Pi/npm/herdr 更新或 selftest。
- `PI_OFFLINE=1` 在元数据请求前返回未执行。来源错误、blocked、宿主变化伴随 unknown、非 managed 宿主的跨版本更新均在受管写入前停止。
- Bundle 声明漂移继续指向选择性 plan/apply。所有 Bundle npm 资源必须具有本机 Manage/Generate ownership；所有本机受管外部 npm 包必须具有有效 Bundle 声明，防止 npm 顺带升级未解析资源。共享 Bundle 不提升本机 ownership。
- 没有显式或注册 layer 的 `update` 暂时保留 M1a 原生 `pi update --all` 兼容路径，不声称获得目标宿主解析或 fixed/manual Bundle 策略保证。不得从 CWD 自动发现、拼接或加载私人配置来代替显式授权；注册入口及优先级按第 20 节执行。

### 19.2 解析、锁与快照

1. 在锁外完成本机预检和元数据解析，记录宿主、manifest、生成链接、package-lock 以及 Bundle 当前安装包 manifest 的稳定指纹。
2. 获取目标排他锁后重新读取 Bundle、ownership 和指纹。任何来源或本机状态变化都必须使旧计划失效，不得在网络等待期间提前持有或释放一个名义上的写锁。
3. 写入前保存 `last-resolution.json` 和 `last-snapshot.json`。前者包含来源哈希、稳定指纹及完整解析报告；后者包含 Pi manifest、package-lock、宿主/链接和 herdr 状态。
4. 成功和失败均写 `last-result.json` 并释放锁。计划前提失效属于未执行；执行后的失败必须根据实际证据标记 failed/partial/unhealthy，并说明 changes 是否为 none、observed 或 unknown。

### 19.3 宿主与内部依赖顺序

- 仅当 `host.action === "update"` 时执行 `pi update --self`；Bundle 执行路径不得调用 `pi update --all` 或让 Pi 重新选择扩展版本。当前仅支持 managed Pi 的跨版本更新。
- 原生命令成功后重新发现宿主，要求实际包版本等于计划版本，并要求 `pi --version` 返回同一版本。宿主命令失败、版本不符或基本执行检查失败时，所有扩展和集成写入必须停止。
- 宿主保持不变时也验证实际版本和基本可执行性，不因 release 较旧而计划降级。
- 从真实目标宿主派生内部 Pi 依赖集合，逐项验证真实包版本满足解析时 registry manifest 的约束，再协调本机 `file:host-link`、`file:host-deps/*` 及生成链接。新增/替换的集合与元数据不符时停止后续扩展。
- 内部 Pi 精确版本和绝对路径只存在于本机派生状态，不得写回共享 Bundle。

### 19.4 精确 npm 执行与 lockfile 语义

执行前必须形成覆盖**全部本机直接外部依赖**的精确版本集合：upgrade 使用解析目标版本，keep/fixed/manual/unknown 使用已验证的当前版本。任何声明中的包缺少可保留或可安装的精确版本时，不得形成执行计划。

1. 在本机 state 下的随机临时目录生成暂存 manifest，将上述直接依赖全部固定为精确版本；Pi 内部依赖继续使用指向真实目标宿主的 `file:host-link` 和 `file:host-deps/*`。暂存目录不得复用用户已有目录。
2. 在暂存目录运行 `npm install --package-lock-only --ignore-scripts --legacy-peer-deps`，不得执行生命周期脚本。解析得到的 lockfile 必须为 lockfileVersion 3，并包含每个直接外部包的精确版本和 registry integrity；upgrade 的 integrity 必须与第 18 节解析证据一致。
3. 将 lockfile 根声明恢复为共享 manifest 的语义化约束，并按 npm 的规范顺序序列化。保存 `last-install-plan.json` 和 `last-package-lock.plan.json`；前者记录直接资源精确版本和 lock SHA-256，后者保存完整本机安装计划。它们均不得反向改写共享 Bundle。
4. 将复核后的 lock 写入目标 npm 目录，再运行 `npm install --ignore-scripts --legacy-peer-deps`。安装后要求共享 manifest 逐字不变、实际 lock 与计划的 JSON 结构相等；允许 npm 仅规范化对象键顺序，但版本、integrity、路径或依赖内容变化必须失败。逐项核对所有直接包实际 manifest、精确版本、lock 条目和 host links；任何实质变化或版本偏移均停止 herdr/selftest 等依赖步骤并记录部分完成。
5. 目标已经满足精确版本且无需修复宿主链接时，不运行 npm 安装，只验证保留版本和链接。暂存目录在成功或失败后均清理，操作锁和 `last-result.json` 语义不变。

不得退回逐包 `npm install --no-save`：真实 npm 实验表明，它可能提升未指定的直接依赖并留下过期 lockfile。当前方案利用 npm 对 lock integrity 的校验验证外部 registry 制品；Pi 宿主制品绑定和固定 Release 的跨机语义按第 21 节实现，签名和可恢复格式不属于当前保证。

### 19.5 保留、验证与未完成入口

- fixed/manual 只评估并保留兼容的当前版本，不再因为不能使用原生批量更新而一律拒绝。宿主变化时其 peer unknown 仍阻塞宿主。
- 宿主不变时，已有 unknown 资源可以保持并显示跳过，但未完成的升级使整体结果为 partial，不得聚合为 success。
- 前置步骤成功后才允许重建受管 herdr 集成、运行显式 selftest 和执行最终 doctor。runtime load 未显式验证时继续标为 unknown。
- 远程 Git 刷新、固定 Release 和 Pi 宿主制品绑定按第 21 节纳入执行闭环；restore、SSH、通用 herdr 插件和 skills/MCP Provider 不在本执行闭环内。

## 20. M2b-1 来源注册与日常命令契约

### 20.1 命令与边界

```bash
agentbrew source set --layer public=./public.json --layer personal=./personal.json
agentbrew source list
agentbrew update
agentbrew diff
agentbrew doctor
agentbrew source clear
```

- 每个 Pi target 最多存在一份完整来源绑定，保存在该 target 的本机 `stateDir/sources.json`。`source set` 必须以本次完整 layer 列表原子替换旧绑定，不做隐式追加或跨文件合并。
- 注册只减少重复输入，不授予 Manage/Generate ownership，不修改共享 layer 或受管资源，不执行 Pi/npm/herdr、doctor 或 selftest，不读取 Git 凭据、拉取仓库或发现 CWD/chezmoi/私人配置。
- `source list` 无 action 时作为默认，仅读取绑定及 layer；`source clear` 验证绑定后在锁内删除。malformed 绑定不得通过 clear 静默清除，只能人工检查或以有效的新绑定完整替换。
- `source set/clear` 与 update 共用 target operation lock；成功和失败均释放锁，并区分本机状态变化与受管资源未变化。

### 20.2 本机 schema v1

```json
{
  "schemaVersion": 1,
  "kind": "agentbrew-source-registration",
  "target": { "agentDir": "/home/alice/.pi/agent" },
  "layers": [
    { "layer": "public", "file": "/home/alice/config/public.json", "sha256": "<64-lowercase-hex>" },
    { "layer": "personal", "file": "/home/alice/config/personal.json", "sha256": "<64-lowercase-hex>" }
  ],
  "inputHash": "<64-lowercase-hex>"
}
```

- layer 顺序固定 public < team < personal < machine，每种最多一个，至少一个；file 必须是规范化绝对路径。哈希来自注册时 `loadBundle` 的完整校验结果。
- 状态文件最大 64 KiB，必须是普通非 symlink 文件，以 `0600` 原子写入；target 必须与当前 `agentDir` 完全一致。未知字段、重复/乱序层、无效哈希、目标不符或损坏 JSON 均失败关闭。
- 绑定是本机派生状态，不作为跨机共享输入，不包含凭据。绝对路径只允许在本机输出和状态中使用。

### 20.3 优先级与内容变化

- `inspect/diff/doctor/update/resolve/explain` 在无显式 `--layer` 时读取注册；有显式 `--layer` 时只使用本次输入且不读取或改写注册。`init/adopt/apply` 不隐式加载注册，typed plan 继续携带自己的来源。
- 注册后每次命令重新读取并校验当前 layer 内容。`source list` 对合法编辑报告 changed，对缺失、无效或不可读内容报告 error；注册哈希是编辑溯源信息，不阻止本机正常修改 layer。
- 注册存在但绑定或 layer 无效时，update 返回 `not-executed`，只读命令返回 `failed`。不得因注册损坏而回退原生批量更新。只有明确无绑定或 `source clear` 后才使用既有原生兼容路径。
- 输出和 JSON 应注明本次来源为 explicit 或 registered，避免用户误认实际配置输入。

### 20.4 并发与计划失效

- 原生和 resolved update 均把 `sources.json` 原始内容指纹纳入锁前前提，并在 operation lock 内重新计算。绑定被替换、清除、改写或变为不可读时，旧计划必须停止，即使旧 layer 文件本身没有变化。
- `source set` 在锁内重新校验本次 layer，防止等待锁期间以已变化内容注册；`source clear` 在锁内复核绑定身份与指纹，防止删除新绑定。
- 显式 `--layer` 的单次执行不依赖注册指纹；typed plan 的 sourceHash 和复核规则独立于注册。注册变化不得提升 ownership 或授权任意原生更新。

## 21. M2b-2 Release、制品、健康发布与远程来源执行契约

### 21.1 Bundle Release schema v1

Release 是 team 层的一种输入，仍通过 `--layer team=<file>` 使用，不改变 public < team < personal < machine 的优先级和普通 `agentbrew-layer` schema v1。

```json
{
  "schemaVersion": 1,
  "kind": "agentbrew-release",
  "layer": "team",
  "release": "team-2026-10",
  "host": { "compatible": ">=1.4.0 <2.0.0" },
  "resources": {
    "npm:pi-subagents": {
      "source": { "type": "npm", "spec": "0.84.0", "integrity": "sha512-<base64-digest>" },
      "update": "fixed"
    }
  },
  "required": ["npm:pi-subagents"],
  "forbidden": [],
  "verification": { "runtimeLoad": "unknown" },
  "exceptions": [
    {
      "resource": "npm:pi-subagents",
      "users": ["alice"],
      "machines": ["mac-dev"],
      "allow": "override",
      "expiresAt": "2027-01-01T00:00:00Z"
    }
  ]
}
```

- `release` 必须是受限字符的安全标识。`host.compatible` 可省略；存在时必须为受支持的非精确范围，禁止传递宿主精确版本。
- Release npm 资源可以使用 compatible/manual；Release 固定项必须使用精确 spec、fixed 和 sha512 integrity。普通 layer 的 fixed/manual 不改变既有本地保留语义，也不要求 integrity。
- Release pin 复用统一 `resolveConfiguration`：读取精确 registry manifest，验证包身份、Pi peer 和 integrity。当前版本不同或缺失时计划精确安装，相同则保留；不兼容或证据不符必须 blocked，不得选择其他版本。
- `host.compatible` 存在时，当前宿主在范围内而 release channel 新版本超出范围则保持当前；当前宿主不在范围内时，只有 release channel 能提供范围内更新才允许宿主先行，否则阻塞且不降级。
- `verification.runtimeLoad` 只能是 `unknown` 或 `passed`，分别表示静态健康证据和显式 selftest 已通过；它不构成第三方代码安全证明。

团队例外只允许对指定 team-required 且已声明资源进行完整声明覆盖：

- `users` 或 `machines` 至少提供一个；同一字段内 OR，两类同时存在时 AND。`allow` 只能为 `override`。
- 例外通过本次显式 `--user`、`--machine` 匹配；过期、主体不匹配或缺少主体时失效。
- 高优先级层仍必须显式 `override`。例外不允许删除必需项、绕过 forbidden、授予本机 ownership 或隐式选择其他版本。
- `explain` 输出 applied、expired 或 subject-mismatch 状态，不把主体身份写入 Release。

### 21.2 Pi managed installer 制品绑定

真实 resolved update 需要升级 managed Pi 宿主时，必须在扩展和 herdr 步骤前完成以下验证：

1. 读取目标版本的 installer `package.json` 和 `package-lock.json`，验证 installer 名称、版本、宿主精确依赖、lockfileVersion 3 和 root 声明。
2. 验证所有 registry 条目的精确版本、resolved URL 和 integrity。对安装器 lock 中缺少 integrity 的内部 `@earendil-works/pi-*` 包，读取对应精确 registry manifest，要求 tarball URL 一致并补入 sha512 integrity；其他缺失或无效 integrity 的制品必须失败关闭。
3. 将受审文件哈希及内部包证据写入本机 `last-pi-install-plan.json`。该证据表示制品绑定，不表示签名、证明来源可信度或运行时安全。
4. 通过随机 loopback 端口向本次 `pi update --self` 子进程提供完全相同的受审文件，仅覆盖子进程 `PI_INSTALLER_API_BASE`，使原生 `npm ci --ignore-scripts` 按受审 integrity 校验实际下载制品。服务在成功或失败后均关闭，operation lock 持续覆盖异步更新、后续步骤和 doctor。
5. 如果目标 release 已存在且无法通过本次受审安装建立证据，必须失败关闭并给出人工检查指引，不得自动删除、重命名或直接激活缓存 release。

dry-run 不读取或写入安装计划、不启动安装器服务、不获取锁。制品准备、版本不符或原生更新失败时，不得继续扩展安装或 herdr 集成。

### 21.3 从健康证据发布 Release

```bash
agentbrew release create \
  --layer team=./team.json \
  --output ./team-release.json \
  --host-range ">=1.4.0 <2.0.0" \
  --selftest
```

- 发布只接受一个显式普通 team layer；不得从注册、personal、machine 或已有 Release 输入隐式导出，避免泄露私有来源和覆盖项。
- 必须存在该 target 上同一 team-only 输入的成功 resolved update。`last-resolution.json`、`last-result.json`、来源哈希、目标、当前宿主、实际安装包和 lock 必须相互一致，解析必须 ready 且 complete。
- 发布前再次运行 doctor。未传 `--selftest` 时只能发布 `runtimeLoad: "unknown"` 的静态证据；显式 selftest 通过后才能写 `passed`。健康失败、证据过期或版本偏移不得输出 Release。
- 输出只包含 team 资源的实际精确版本和 registry integrity，转化为 fixed pin；剥离宿主精确版本、host.dir、agentDir、指纹、个人来源和机器状态。`--host-range` 省略时不生成宿主范围。
- 输出必须排他新建且权限为 `0600`，不得覆盖文件，不修改共享输入或受管资源。

### 21.4 Git 来源注册与刷新

```bash
agentbrew source set --git team=https://github.com/example/config.git#layers/team.json
agentbrew source refresh
agentbrew update --dry-run
agentbrew update
```

- `--git` 支持 HTTPS、SSH 和显式绝对本地仓库路径，格式为 `layer=repository#relative/path`。首版跟踪远端 HEAD 并记录完整 commit；HTTPS 凭据、相对仓库路径、仓库内绝对路径、路径穿越和非 blob 输入必须拒绝。
- source registration schema v2 在 v1 layer 条目上增加可选 `git: { url, path, ref: "HEAD", commit }`，v1 仍可读取。schema v2 的 Git 条目必须具有完整 40 位小写 commit。
- 每个 Git layer 缓存为该 target 私有 state 下的 `<layer>-<commit>.json`，权限 `0600`。按 commit 版本化缓存保证刷新失败时旧绑定仍指向旧完整内容；成功验证完整 Bundle 后才原子替换绑定。
- `source refresh` 只修改本机缓存与绑定，不修改受管资源。真实 `update` 在统一 `updateCommand` 内先刷新注册 Git 来源，CLI 和 TUI 行为一致；dry-run 只使用已注册 commit，并在结构化结果中提示 `agentbrew source refresh`，不写 state 或获取锁。
- 显式 layer 永远不隐式刷新。`inspect/diff/doctor/resolve/source list` 不自动刷新；`PI_OFFLINE=1` 在 Git 网络访问前停止。刷新失败不得回退原生批量更新或把旧缓存描述为刷新成功。
- Git 凭据只由目标用户自己的 Git 配置提供。禁止共享跨用户缓存、集中收集私有 layer 内容或在日志中输出凭据。

### 21.5 多目标与用户隔离边界

- M2b-2 的本地多 target 测试只能证明默认 HOME、agentDir、state、缓存和锁可以隔离，不能证明已经完成 SSH 交付或 Unix 人员安全边界。
- 默认 state 按 agentDir 派生；显式让多个 target 共用 `--state-dir` 会共享 lock、source 和 result 文件，多用户部署必须禁止。人员隔离必须使用独立 Unix 用户、HOME、agentDir、stateDir 和私有凭据。
- 单端管理多端在架构上采用控制端逐用户 SSH 调用目标 Agentbrew，各目标独立读取、解析、加锁、执行和 doctor；不得下发跨用户复用的解析计划或集中读取私有配置。
- M3 远程更新必须要求 resolved + managed Pi，禁止原生批量更新和共享可写宿主。selftest、代码信任、权限提升和远程批量执行分别授权，高权限切换不能声称阻止 root 读取用户文件。

## 22. M3a 只读目标注册与单目标检查契约

### 22.1 Target registry schema v1

控制端隐式提供 `local`，远程目标来自 `AGENTBREW_TARGETS_FILE`，未设置时读取 `$XDG_CONFIG_HOME/agentbrew/targets.json` 或 `$HOME/.config/agentbrew/targets.json`。

```json
{
  "schemaVersion": 1,
  "kind": "agentbrew-targets",
  "targets": [
    { "id": "linux-dev", "connection": { "type": "ssh", "destination": "alice@build.example.com" } }
  ]
}
```

- 清单缺失表示 local-only。文件必须是普通非 symlink JSON，最大 64 KiB、最多 64 个远程目标；未知字段、重复或保留别名、非法 destination、损坏内容必须失败关闭，不得静默回退。
- destination 只允许单个安全的 SSH 用户/主机形式，不允许空白、控制字符、选项或任意命令字段。自定义端口和高级选项由目标用户自己的 SSH config 提供，凭据不得进入清单。
- `agentbrew target list` 只读取清单。`agentbrew target check <id>` 必须要求明确 id，未知目标失败，不默认检查全部目标。

### 22.2 只读检查与脱敏证据

本机检查复用 `evaluateEnvironment`。SSH 检查只通过参数数组执行 `ssh -T -o BatchMode=yes -o ConnectTimeout=8 -- <destination> agentbrew init --json`，不得经过本地 shell，不得提示密码或自动提升权限。

- 目标端 `init --json` 只执行评估，不运行 update、selftest、source refresh、安装或写锁。其正常只读退出可以是 0 或 `not-executed` 对应的 6；必须验证结构化结果，不能仅凭退出码宣称成功或离线。
- 控制端严格校验 schema、command、assessment、checks、differences 和 herdr 字段。结果只裁剪为 id、连接类型、状态、分类、Pi/herdr 公开版本、健康/差异计数、checkedAt 和错误类别。
- 原始 stdout/stderr、远程 agentDir、manifest、个人 layer、私有路径和凭据不得进入摘要、日志或持久化状态。transport、agentbrew-unavailable、remote-check、protocol、local 错误必须可区分。
- 检查不获取 operation lock，不写 targets/state/result。TUI 证据只保留在会话内；CLI 输出同样只含公开摘要。

### 22.3 Targets 交互与状态

- 首屏只读取本地清单并显示目标计数，远程初始为 unknown；启动及普通 Overview 刷新不得自动 SSH。
- `t` 打开 Targets，↑/↓ 选择，`r` 只检查选中项，`v` 展开允许的连接和检查详情。数字 1–6 必须保留原页面，不因新增菜单改变。
- 检查中保留列表并标记 checking，同一时刻只允许一个操作。Esc 中止在途只读进程并恢复检查前状态；q 等待 settled 后恢复终端。其他目标不得因单目标成功、失败或取消而改变状态。
- 状态必须区分 unknown、checking、healthy、attention、offline、unavailable、error；offline 和 unavailable 不计入 healthy。会话结果重新打开 Targets 可复用，但新会话不得沿用为当前健康。
- `--write` 下 Targets 仍只有检查能力，页面必须显示 `no remote updates`。本阶段 Enter 不得进入仍使用本机 Context 的假远程页面。

### 22.4 本阶段非目标与后续门槛

M3a 不实现远程聚焦 diff/update、远程 apply、批量 Deploy、sudo/root 切换、目标清单 TUI 编辑或持久健康缓存。后续 M3b/M3c 必须分别设计并验证目标独立解析、授权、锁、快照、doctor、失败隔离和共享运行时保护，不得由只读检查成功推断远程更新已授权或可用。
