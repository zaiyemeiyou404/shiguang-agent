# 桌面前端功能等价验收清单

基准规格：`docs/superpowers/specs/2026-09-17-frontend-backend-parity-design.md`

## 自动化覆盖

| 能力 | 自动化证据 | 当前结果 |
| --- | --- | --- |
| 事件强类型与旧数据降级 | `electron/event-contracts.test.ts` | 通过 |
| 工具调用/结果配对、事件去重和排序 | `ui/src/features/activity/activity-model.test.ts` | 通过 |
| 响应、思考和工具卡渲染 | `ui/src/features/activity/ActivityFeed.test.tsx` | 通过 |
| 审批预览规范化 | `ui/src/features/approvals/approval-model.test.ts` | 通过 |
| 审批卡允许/拒绝及防重复状态 | `ui/src/features/approvals/ApprovalCard.test.tsx` | 通过 |
| 主进程实时订阅释放与通道隔离 | `electron/run-event-subscriptions.test.ts` | 通过 |
| 快照与直播合并、切换运行清理 | `ui/src/hooks/useRunActivity.test.tsx` | 通过 |
| 会话快照加载及陈旧请求隔离 | `ui/src/hooks/useSessionWorkspace.test.tsx` | 通过 |
| 输入框键盘发送和纯附件发送 | `ui/src/features/composer/Composer.test.tsx` | 通过 |
| 运行恢复和产物操作入口 | `ui/src/features/run/RunInspector.test.tsx` | 通过 |
| 核心运行时回归 | `npm test` | 121 项通过 |

## 桌面手工验收

- [ ] 创建项目、工作区和会话，确认标题显示当前项目/工作区。
- [ ] 发送普通消息和仅附件消息，失败时确认草稿与附件仍保留。
- [ ] 观察助手响应、思考过程以及成对的工具调用/结果卡。
- [ ] 在对话内和“确认”页分别通过、拒绝一次操作，确认按钮不可重复提交。
- [ ] 快速切换两个运行，确认没有跨运行事件；关闭详情后重新打开状态一致。
- [ ] 取消正在运行的任务，对失败运行执行重试和分支。
- [ ] 在运行检查器中复制、打开、定位产物并跳转到所属运行。
- [ ] 使用失败卡写入修复提示并继续运行。
- [ ] 搜索、固定、重命名、归档、恢复和删除会话。
- [ ] 新增、复制、重命名、删除 Provider，测试连接并保存设置。
- [ ] 重启桌面应用，确认会话、运行、产物、固定项、草稿和设置按预期恢复。

## 安全检查

- 修改型文件操作继续受当前会话工作区限制。
- 绝对路径读取继续服从操作系统权限。
- 终端命令始终需要确认，并明确提示工作目录不是完整文件系统沙箱。
- 全局 `workspaceRoot` 仅作旧版本迁移兼容，不改变现有会话绑定范围。
