# CardVault · Full · Anima 世界书

这是完整功能版源码，基于用户提供的 `card-main` 源码修改。

## 顶部三个页面

- **角色卡库**：保留上传、AI 分类、批量管理、自动导入酒馆等原功能。
- **游玩备份**：保留角色 PNG、完整角色 JSON、聊天 JSONL、绑定世界书等原有归档 / 恢复功能。
- **Anima世界书**：新增独立页面，用于保存当前聊天绑定的 Chat Lorebook，并可恢复到任意当前聊天。

## Anima 世界书保存方式

Anima 教程中的总结保存到“聊天世界书”，不是角色世界书。本版本直接读取 SillyTavern 当前聊天的 `chatMetadata.world_info`，将完整世界书 JSON 保存到 SillyTavern 当前站点的 IndexedDB。

保存记录按：

`角色 + 聊天 + 聊天世界书`

区分。同一角色不同聊天不会互相覆盖。恢复时会：

1. 把完整 JSON 写回 SillyTavern 世界书；
2. 将该世界书设置为当前聊天的 Chat Lorebook；
3. 不修改角色卡自身的角色世界书绑定。

> IndexedDB 属于 SillyTavern 站点数据。卸载 / 重装这个扩展不会主动删除它；如果手动清理浏览器站点数据或换域名，则本地保险箱数据可能丢失。

## AI 分类持久化

从 1.2.3 开始，**CardVault 云端是两个版本共享分类的主存储**。Full + Anima 会把当前账号的全部分类打包成一张内部 JSON 角色卡：

`__CardVault_AI_Classification_DB__card2`

然后通过现有 `/api/cards/import` 保存到 CardVault。这个方案不需要修改 CardVault 后端源码。插件自己的卡库列表会自动隐藏这张内部数据卡。

同时仍保留 SillyTavern `extension_settings` 与 `localStorage` 作为本机镜像/迁移来源。第一次运行 1.2.3 时，如果本机已有 244 张等旧分类而云端还没有，Full + Anima 会自动把它们迁移到 CardVault。

Import-Only 只通过 GET 读取这张云端内部数据卡并显示分类，不负责写入。这样即使删除/重装插件、换浏览器或换设备，只要连接的是同一个 CardVault 账号且这张内部数据卡仍在，分类就可以恢复。

> 不要在 CardVault 网站后台手动删除名称以 `__CardVault_AI_Classification_DB__` 开头的内部数据卡；删除它会失去云端分类主副本。

## 安装

将本目录作为 SillyTavern 第三方扩展仓库根目录，至少保留：

```text
manifest.json
index.js
style.css
settings.html
```

然后通过 SillyTavern 的“扩展 → 安装扩展”使用 Git 仓库 URL 安装。

## 版本

### 1.2.3：分类真正同步到 CardVault + 悬浮球半隐藏吸边

- AI 分类现在会打包进一张插件内部数据角色卡 `__CardVault_AI_Classification_DB__card2` 并通过现有 `/api/cards/import` 上传到 CardVault；无需修改 CardVault 后端源码。
- 插件卡库自动隐藏这张内部数据卡；服务器里已有分类会在启动/刷新卡库时合并回来。
- 第一次安装 1.2.3 时，Full+Anima 会把当前酒馆里已有的分类自动迁移到 CardVault 云端，无需重新分类 244 张卡。
- Import-Only 只读取该云端分类数据库，不写入、不修改云端。
- 悬浮球松手后吸进屏幕边缘约 50%，只露出半个球，减少遮挡。


- Full + Anima: `1.2.3`
- 基础源码：用户提供的 CardVault Standalone `1.1.2`

### 1.2.2：修复跨版本分类读取 + 强制吸边

- **只有 Full + Anima 负责永久写入**：分类同时写入 SillyTavern 共享设置命名空间和 localStorage 镜像。
- **Import-Only 实时读取同一共享库**：不再依赖一次性内存缓存，切换版本后可直接显示 Full + Anima 已完成的分类。
- 悬浮球改为 0px 贴边，保存左右 `side` 而不是旧横坐标；加入移动端窗口级 `pointerup` 兜底和二次布局复算，拖动松手后强制吸附到最近左右边缘。
