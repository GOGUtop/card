# Changelog

## 1.2.2

- 永久 AI 分类新增 SillyTavern `extension_settings` 独立共享命名空间，并继续保留 localStorage 镜像。
- Full + Anima 分类结果可被 Import-Only 直接读取；旧 localStorage 分类会自动迁移/合并。
- 悬浮球改为 0px 真正贴边，保存左右 side；新增移动端窗口级 pointerup/pointercancel 兜底与布局后二次吸边。

## 1.2.1

- Full + Anima 成为永久 AI 分类唯一写入端，并继续使用共享持久键，卸载 / 重装不清除。
- 永久分类合并时按 `classifiedAt` 选择较新结果，避免旧扩展设置覆盖较新的共享结果。
- 悬浮球松手后自动吸附到最近的左 / 右边缘，并保存吸边位置。

## 1.2.0

- 新增第三个顶部页面：`Anima世界书`。
- 可保存当前聊天绑定的 Chat Lorebook 到 IndexedDB。
- 可查看、导出、删除、恢复 Anima 世界书备份。
- 恢复时写回世界书并绑定到当前聊天，不改角色世界书。
- AI 分类新增 localStorage 持久镜像；卸载 / 重装插件不主动清除已有分类。
- 保留原角色卡库与游玩备份全部功能。