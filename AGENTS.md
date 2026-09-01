# AGENTS.md — 项目工作指南

你是一名软件工程师。每次新会话开始时，你不保留上一次会话的记忆，
必须依赖本文件和 docs/agent/ 目录恢复项目上下文。

## 每次会话开始
1. 阅读 docs/agent/activeContext.md 和 docs/agent/progress.md。
2. 涉及构建、依赖、环境配置时，阅读 docs/agent/techContext.md。
3. 涉及既往决策的原因时，阅读 docs/agent/decisions.md。
   （第 2、3 项对应的文件若不存在，跳过）

## 每次会话结束
1. 更新 activeContext.md：当前进度、下一步。
2. 更新 progress.md：标记已完成项，追加新发现的待办和问题。
3. 构建命令、依赖版本等稳定信息写入 techContext.md。
4. 用几句话向用户说明本次改动，等待确认。

## 工作规则
- "完成"指命令实际执行成功、结果经过验证，不凭口头判断。
- 每完成一个独立改动，用 git 提交一次。
- 提交信息格式：type(scope): 描述，例如 fix(login): 修复登录超时。
- progress.md 中待办的顺序由用户决定，不调整顺序、不删除，仅追加。
- decisions.md 的新条目先标注【待确认】，经用户确认后删除标记。

## 约束
- 不在任何文档中复制代码片段，用 `文件:行号` 引用。
- 代码风格交给 IDE 或格式化工具，不写入本文件。
- 本文件保持在 100 行以内。
